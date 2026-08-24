"""J2 判断力轮 · Evaluator — the judgment layer that verifies a completion claim.

Before a chat run is declared done, this layer asks: did the agent ACTUALLY do
what the user asked? It is built from five converging sources (WorkBuddy #1/#6,
Anthropic generator-evaluator, Weng 七瓶颈之首, CC verification subagent, GrokBuild
laziness/skeptic) and follows the round's binding contract:

1. a CHEAP rule prefilter (pure code, zero cost when clean) decides whether to
   spend a judge at all — evaluate only when the run's plan still has open items,
   OR the final answer CLAIMS completion while the segment ran ZERO tools, OR
   (F4) the USER asked for two or more things and the segment DID run tools;
2. an independent-context LLM judge (防续写, GrokBuild蓝图) returns a closed-set
   verdict — two messages, no tools, ≤512 tokens, 60s timeout — fed
   CODE-GENERATED ``[runtime_facts]`` the agent cannot fabricate;
3. a strict CODE GATE (ADR-002) turns the model's text into DATA: JSON parse,
   closed-set category, confidence clamp — ANY failure → verdict skipped;
4. the verdict never becomes an instruction, and the evaluation ALWAYS fails
   open — a judge outage must never fail or hang a run.

This module owns the PURE pieces (prompt constant, prefilter, runtime-fact
generation, the code gate, the judge builder). The orchestration (emit audit,
drive a bounded continuation, re-judge, flag) lives in ``ChatOrchestrator`` where
the run + engine live.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Callable

import httpx

from services.chat.app.schemas import ChatRun
from services.runtime.app.concurrency import shared_model_call_bucket
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import (
    ModelProviderError,
    ModelRequest,
    OpenAICompatibleModelProvider,
)

# --- closed set + thresholds (ADR-002 code gate) ------------------------------

# The four verdict categories the judge may return — a CLOSED set the code gate
# enforces (anything else → skipped).
VERDICT_CATEGORIES = frozenset({"achieved", "false_completion", "partial", "needs_user"})

# Act on a not-achieved verdict (auto-continue) only at or above this confidence;
# below it, record the verdict but do not act (treat as achieved-enough).
CONFIDENCE_ACT_THRESHOLD = 0.7

# ``flagged {gaps}`` is code-clamped: at most this many gaps, each truncated to
# this many characters (the judge output is DATA, bounded before it is stored).
MAX_GAPS = 5
MAX_GAP_CHARS = 120

# Judge single-shot budget — mirrors autocompact's summary call (a short bounded
# aux completion on the current main model, fewer retries than a main call).
JUDGE_MAX_TOKENS = 512
JUDGE_MAX_ATTEMPTS = 2

# A completion CLAIM in the final answer (case-insensitive). Half of the cheap
# rule trigger: a claim with ZERO tool calls this segment is worth a judge.
#
# A CLOSED, spec'd set — every false positive spends a real judge call on a run
# that claimed nothing, which defeats the prefilter's whole purpose (free when
# clean). Two disciplines hold it there: word boundaries on the English words
# (unbounded ``done`` matches abandoned / pardoned / condoned), and no bare
# progress phrasing (``完成了三步`` is a status report, not a completion claim).
_CLAIM_REGEX = re.compile(r"已完成|已办妥|\b(?:done|completed)\b", re.IGNORECASE)

# The user asked for TWO OR MORE things in one message — the OTHER half of the
# rule layer's third trigger (F4). Evaluation v0 evidence (G1, reproduced 3/3):
# 「收入和净利润分别是多少?」— the agent queried the tool, answered the revenue,
# and stopped. No plan, no completion claim, tools DID run, so neither existing
# trigger fired and the judge never got to look.
#
# Same closed-set discipline as ``_CLAIM_REGEX``, and the same cost logic —
# every false positive spends a real judge call — so each alternative demands an
# EXPLICIT multi-ask marker, and the wildcards are length-bounded and stop at
# clause punctuation (an unbounded ``和.+?多少`` would span whole sentences and
# fire on any message that happens to contain 和 … 多少):
#
#   分别 / 各是 / 各为        — "respectively / each is", the hardest signal;
#   和…(多少|如何|怎样)       — "A 和 B 是多少", two quantities in one clause;
#   、…(多少|情况)            — an enumerated list ending in a quantity/status ask;
#   ?…?                      — two question marks = two questions.
_MULTI_ASK_REGEX = re.compile(
    r"分别"
    r"|各[是为]"
    r"|和[^,,。;;?？!!]{0,12}?(?:多少|如何|怎样)"
    r"|、[^。;;?？!!]{0,20}?(?:多少|情况)"
    r"|[?？][^?？]*[?？]"
)


# The judge prompt is a MODULE CONSTANT (never model-authored). It fixes the
# closed output set and demands JSON-only — the judge's reply is parsed as DATA,
# never executed as an instruction (ADR-002).
EVALUATOR_SYSTEM_PROMPT = (
    "你是一个独立的完成度评审员。给定用户的原始请求、系统运行时的客观事实"
    "（[runtime_facts]，由代码生成、智能体无法伪造），以及智能体的最终回答，"
    "判断该回答是否真正完成了用户请求。只依据事实判断，不臆测未发生的工作。\n"
    "只输出一个 JSON 对象，不要任何解释、前后缀或代码块围栏。字段：\n"
    '- "category"：必须是 achieved | false_completion | partial | needs_user 之一。'
    "achieved=已真正完成；false_completion=声称完成但实际未做到；partial=部分完成"
    "仍有明确缺口；needs_user=缺少用户输入无法继续。\n"
    '- "confidence"：0 到 1 之间的小数，表示你对该判断的把握。\n'
    '- "gaps"：字符串数组，列出尚未完成的具体缺口（achieved 时为空数组）。\n'
    '示例：{"category":"partial","confidence":0.8,"gaps":["报告未生成"]}'
)


@dataclass(frozen=True)
class Verdict:
    """The judge's decision AFTER the code gate — pure data, never an instruction.

    ``gaps`` is a tuple (immutable) already clamped by ``parse_verdict``.
    """

    category: str
    confidence: float
    gaps: tuple[str, ...] = ()


# --- rule prefilter (pure code, zero cost when clean) -------------------------


def completion_claim(text: str | None) -> bool:
    """True when the final answer CLAIMS completion (the claim half of the rule)."""
    return bool(_CLAIM_REGEX.search(text or ""))


def multi_ask(text: str | None) -> bool:
    """True when the USER's message asks for two or more things (F4's half)."""
    return bool(_MULTI_ASK_REGEX.search(text or ""))


def _plan_has_open_items(plan: list[dict]) -> bool:
    return any(item.get("status") in ("pending", "in_progress") for item in plan)


def should_evaluate(run: ChatRun, *, segment_had_tool_done: bool) -> str | None:
    """Decide whether to spend a judge, returning the TRIGGER or ``None``.

    Zero-cost when clean — no condition holds → ``None`` and the caller goes
    straight to ready with NO evaluation events. The three triggers:

    * ``"plan_pending"`` — the run's plan still has ``pending``/``in_progress``
      items (the claim of "done" is contradicted by the agent's own plan);
    * ``"claim_no_tools"`` — the final answer matches the completion-claim regex
      while the segment dispatched ZERO tools (a suspiciously effortless "done");
    * ``"multi_ask"`` (F4) — the USER asked for two or more things and the
      segment DID dispatch tools. This is the G1/R1 hole: real work happened, no
      plan was ever made, nothing was claimed — so the first two triggers stay
      silent while half the question goes unanswered. It opens a door to the
      EXISTING judge (whose prompt already asks "did this actually complete the
      user's request?") and the existing bounded continuation; zero new
      machinery. Requires tools BECAUSE a no-tool multi-ask never started the
      job — that is a different failure, and sending a judge to "finish" it would
      just pay for a second opinion on nothing.
    """
    if _plan_has_open_items(run.plan):
        return "plan_pending"
    if not segment_had_tool_done and completion_claim(run.assistant_message):
        return "claim_no_tools"
    if segment_had_tool_done and multi_ask(run.message):
        return "multi_ask"
    return None


# --- code-generated runtime facts (the agent cannot fabricate these) ----------


def tool_call_counts(run: ChatRun) -> dict[str, int]:
    """Per-tool dispatch counts, read from the model.call.completed audit trail.

    ``requested_tool_names`` on each completed model call is exactly the batch the
    loop dispatched that turn — code-recorded governance evidence, not model prose.
    """
    counts: dict[str, int] = {}
    for event in run.audit_events:
        if event.type == "model.call.completed":
            for name in event.payload.get("requested_tool_names") or []:
                counts[str(name)] = counts.get(str(name), 0) + 1
    return counts


def total_tool_calls(run: ChatRun) -> int:
    return sum(tool_call_counts(run).values())


def _mcp_ok_fail(run: ChatRun) -> tuple[int, int]:
    ok = fail = 0
    for event in run.audit_events:
        if event.type == "mcp.tool.called":
            status = event.payload.get("status")
            if status == "success":
                ok += 1
            elif status == "failed":
                fail += 1
    return ok, fail


def _elapsed_seconds(run: ChatRun) -> int:
    events = run.audit_events
    if len(events) < 2:
        return 0
    try:
        first = datetime.fromisoformat(events[0].created_at)
        last = datetime.fromisoformat(events[-1].created_at)
    except (ValueError, TypeError):
        return 0
    return max(0, int((last - first).total_seconds()))


def runtime_facts(run: ChatRun, *, continuation_index: int) -> str:
    """A CODE-GENERATED ``[runtime_facts]`` block the judge treats as ground truth.

    Everything here is derived from the run's own audit trail / state — tool
    dispatch counts, MCP success/failure, plan progress, artifact count, wall
    time, continuation round. The agent authored none of it, so it cannot lie the
    judge into a false "achieved".
    """
    counts = tool_call_counts(run)
    if counts:
        tools = "、".join(f"{name}×{count}" for name, count in counts.items())
    else:
        tools = "无"
    ok, fail = _mcp_ok_fail(run)
    plan_total = len(run.plan)
    plan_done = sum(1 for item in run.plan if item.get("status") == "done")
    plan_line = f"{plan_done}/{plan_total} 完成" if plan_total else "无计划"
    return (
        "[runtime_facts]\n"
        f"工具调用：{tools}\n"
        f"MCP 调用：成功 {ok}，失败 {fail}\n"
        f"计划：{plan_line}\n"
        f"产物：{len(run.artifacts)}\n"
        f"耗时：{_elapsed_seconds(run)} 秒\n"
        f"续办轮次：{continuation_index}"
    )


def build_judge_user_content(run: ChatRun, *, continuation_index: int) -> str:
    """Assemble the judge's SINGLE user message: request + facts + final answer.

    Deliberately NOT the whole transcript (v1 cost discipline) — the original
    request, the code-generated facts, and the final answer are enough for a
    completion judgment.
    """
    return (
        f"原始请求：\n{run.message}\n\n"
        f"{runtime_facts(run, continuation_index=continuation_index)}\n\n"
        f"最终回答：\n{run.assistant_message or ''}"
    )


# --- the code gate (ADR-002): model text -> DATA, or skipped ------------------


def _strip_code_fence(text: str) -> str:
    """Drop a leading ```/```json fence and trailing ``` if the model added one."""
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def clamp_gaps(gaps: Any) -> tuple[str, ...]:
    """Code-clamp the judge's gaps: ≤``MAX_GAPS`` items, each ≤``MAX_GAP_CHARS``.

    Non-list / empty → ``()``. Blank items dropped. This bounds what can ever be
    stored on ``run.evaluation.flagged`` regardless of what the model returned.
    """
    if not isinstance(gaps, list):
        return ()
    clamped: list[str] = []
    for gap in gaps[:MAX_GAPS]:
        text = str(gap).strip()
        if text:
            clamped.append(text[:MAX_GAP_CHARS])
    return tuple(clamped)


def parse_verdict(raw: str | None) -> Verdict | None:
    """Strict code gate: parse the judge's text into a ``Verdict``, or ``None``.

    ANY failure → ``None`` (the caller emits ``run.evaluation.skipped``, fail-open):
    non-JSON, non-object, category outside the closed set, or a non-numeric
    confidence. ``confidence`` is clamped to ``[0, 1]``; ``gaps`` is code-clamped.
    A bool is explicitly NOT a valid confidence (``isinstance(True, int)`` trap).
    """
    if not raw:
        return None
    try:
        data = json.loads(_strip_code_fence(raw.strip()))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    category = data.get("category")
    if category not in VERDICT_CATEGORIES:
        return None
    confidence = data.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return None
    confidence = max(0.0, min(1.0, float(confidence)))
    return Verdict(
        category=str(category),
        confidence=confidence,
        gaps=clamp_gaps(data.get("gaps")),
    )


# --- continuation nudge (code-generated, rides messages — KV-cache red line) ---


def evaluator_nudge_text(gaps: tuple[str, ...] | list[str]) -> str:
    """The补办 nudge injected as a USER message on an evaluator continuation.

    Code-generated (ADR-002), joined from the clamped gaps. It rides the messages
    list — NEVER the system prompt — so the KV-cache prefix stays stable.
    """
    listed = "、".join(gaps) if gaps else "任务未真正完成"
    return f"评估发现未达成：{listed}。请补办；已完成部分不要重做。"


# --- the judge call (mirrors autocompact._build_summarize exactly) ------------

Judge = Callable[[str, str], "str | None"]


def build_judge(
    settings: RuntimeSettings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Judge:
    """A single-shot independent-context judge on the CURRENT main model.

    Mirrors ``autocompact._build_summarize`` EXACTLY: an
    ``OpenAICompatibleModelProvider`` single-shot (no tools, bounded output,
    fewer retries) that goes STRAIGHT through the provider — NOT through
    ``stream_model`` / the engine — so it is structurally immune to compaction /
    concurrency-bucket recursion. It STILL takes the shared L5 model-call bucket
    (autocompact does the same): the judge is a real provider call and must not be
    a side door around the process-wide rate gate. Sync-blocking is safe — the
    orchestrator invokes this OFF the event loop (``asyncio.to_thread``). Returns
    the raw assistant text (DATA for the code gate) or ``None`` on any provider
    failure (fail-open — a judge outage is never fatal). The provider's own 60s
    timeout bounds a hung judge call.
    """
    judge_settings = replace(
        settings,
        model_reasoning_effort=None,  # a verdict needs no deep-thinking budget
        model_max_tokens=JUDGE_MAX_TOKENS,
    )
    provider = OpenAICompatibleModelProvider(
        judge_settings, transport=transport, max_attempts=JUDGE_MAX_ATTEMPTS
    )

    def judge(system_prompt: str, user_content: str) -> str | None:
        request = ModelRequest(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            tools=[],
        )
        shared_model_call_bucket(settings).acquire()
        try:
            import asyncio

            response = asyncio.run(provider.create_response(request))
        except ModelProviderError:
            return None
        return (response.assistant_message or "").strip() or None

    return judge
