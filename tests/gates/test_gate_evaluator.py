"""J2 · Evaluator judgment-layer gate (eval-first, the RED).

A code-judged gate for the Judgment round, slice J2 (Evaluator): before a chat
run is declared done, a judgment layer verifies the completion claim — a cheap
rule prefilter decides whether to spend a judge; an independent-context LLM judge
(fed CODE-GENERATED runtime facts the agent cannot fabricate) returns a
closed-set verdict through a strict code gate; a bounded auto-continuation tries
to close a real gap; and an honest flag is raised when the gap survives. The
evaluation itself is ALWAYS fail-open — a judge outage never fails or hangs a run.

Three deterministic scenarios drive the L3a background path (fake engine model +
injected fake judge, no network — same fixture shape as ``test_gate_continue``):

* ① the loop CLOSES a gap: the model finishes with a bare completion claim and
  ZERO tool calls → the rule layer triggers → the (fake) judge returns
  ``false_completion`` (conf 0.9) → an evaluator nudge is injected → a
  continuation round runs (the model does the real work + a proper final) → the
  SECOND evaluation returns ``achieved`` → terminal ``ready`` with a
  ``run.evaluation.verdict {category:"achieved"}`` on the second round; the frame
  ``seq`` stays strictly contiguous across the continuation.
* ② a stubborn gap: the judge keeps returning ``false_completion`` → after
  ``max_continuations=1`` the run finalizes ``ready`` WITH a
  ``run.evaluation.flagged {gaps}`` (honest flag, never an infinite loop, never a
  blocked terminal).
* ③ a judge outage: the judge returns malformed JSON → the code gate fails open →
  ``run.evaluation.skipped`` and the run reaches ``ready`` normally.

This gate must stay green in every later slice.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)

# Substring of the evaluator continuation nudge injected as a user turn.
_EVAL_NUDGE_MARKER = "评估发现未达成"


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused
        raise AssertionError("this gate never dispatches an ERP tool")


class _FakeJudge:
    """A scripted independent-context judge — one raw model string per call.

    Signature matches what the orchestrator invokes off the event loop
    (``judge(system_prompt, user_content) -> str | None``); every call is
    captured so the gate can assert the CODE-GENERATED runtime facts reached the
    judge (the agent cannot fabricate them). Runs out → ``None`` (a judge outage).
    """

    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, system_prompt: str, user_content: str) -> str | None:
        self.calls.append((system_prompt, user_content))
        return self._responses.pop(0) if self._responses else None


class _ClaimThenCompleteModel(FakeStreamModel):
    """Bare completion claim first (zero tools), real work after the nudge.

    Before the evaluator nudge: a tool-free final that only CLAIMS completion —
    the ``claim_no_tools`` rule trigger. After the nudge: a proper final that
    delivers, so the second evaluation can bless it ``achieved``.
    """

    def respond(self, request: ModelRequest) -> ModelResponse:
        last_user = _last_user(request)
        if _EVAL_NUDGE_MARKER in last_user:
            return ModelResponse(
                assistant_message="报告已生成并交付,请查收。", tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message="任务已办妥。", tool_calls=[], finish_reason="stop"
        )


class _AlwaysClaimModel(FakeStreamModel):
    """Always finishes with the same bare completion claim (zero tools).

    Stubborn: even the continuation only re-claims completion, so the judge keeps
    finding the same gap and the run must be honestly flagged (never looped).
    """

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message="任务已办妥。", tool_calls=[], finish_reason="stop"
        )


def _last_user(request: ModelRequest) -> str:
    last = ""
    for message in request.messages:
        if message.get("role") == "user":
            last = str(message.get("content") or "")
    return last


def _orchestrator(store: SQLiteRunStore, model: FakeStreamModel, judge: _FakeJudge) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=model)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=store,
        evaluator_judge=judge,
    )


async def _replay(manager: BackgroundRunManager, run_id: str, from_seq: int = 0) -> list[dict]:
    return [frame async for frame in manager.subscribe(run_id, from_seq=from_seq)]


def _eval_events(run) -> list[tuple[str, dict]]:
    return [
        (event.type, event.payload)
        for event in run.audit_events
        if event.type.startswith("run.evaluation.")
    ]


# --- ① close a gap: false_completion -> nudge -> continuation -> achieved ------


async def _run_scenario_close_gap(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    judge = _FakeJudge(
        [
            json.dumps({"category": "false_completion", "confidence": 0.9, "gaps": ["报告未生成"]}),
            json.dumps({"category": "achieved", "confidence": 0.95, "gaps": []}),
        ]
    )
    model = _ClaimThenCompleteModel()
    chat = _orchestrator(store, model, judge)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我做上月费用分析并生成报告。",
    )
    run_id = run.id
    task = manager.get_task(run_id)
    assert task is not None
    await task

    finished = chat.get_run(run_id)
    assert finished.status == "ready"
    # The continuation actually ran (the model was called twice: first claim +
    # one evaluator continuation) and the SECOND evaluation blessed it achieved.
    assert len(model.requests) == 2
    assert len(judge.calls) == 2

    eval_events = _eval_events(finished)
    types = [t for t, _ in eval_events]
    # started (round 0) -> verdict false_completion -> started (round 1) -> verdict achieved
    assert types == [
        "run.evaluation.started",
        "run.evaluation.verdict",
        "run.evaluation.started",
        "run.evaluation.verdict",
    ]
    first_verdict = eval_events[1][1]
    assert first_verdict["category"] == "false_completion"
    assert first_verdict["continuation_index"] == 0
    second_verdict = eval_events[3][1]
    assert second_verdict["category"] == "achieved"
    assert second_verdict["continuation_index"] == 1
    assert not any(t == "run.evaluation.flagged" for t, _ in eval_events)

    # The continuation model SAW the evaluator nudge as a user turn (KV-cache red
    # line: the nudge rides messages, never the system prompt).
    second_users = [
        m.get("content") for m in model.requests[1].messages if m.get("role") == "user"
    ]
    assert any(_EVAL_NUDGE_MARKER in (c or "") for c in second_users)

    # The delivered answer is the FIRST segment's PLUS the补办 delta. The nudge
    # asks for a delta ("已完成部分不要重做"), so overwriting ``assistant_message``
    # per segment makes the already-delivered work vanish from the answer area,
    # from the thread history, and from the judge's next read.
    assert "任务已办妥。" in (finished.assistant_message or "")
    assert "报告已生成并交付,请查收。" in (finished.assistant_message or "")

    # The judge was fed CODE-GENERATED runtime facts (the agent cannot fabricate).
    assert "[runtime_facts]" in judge.calls[0][1]
    # ... and the RE-judge read the stitched answer, not the delta alone.
    assert "任务已办妥。" in judge.calls[1][1]
    assert "报告已生成并交付,请查收。" in judge.calls[1][1]

    # Frame seq strictly contiguous across the whole run incl. the continuation.
    frames = await _replay(manager, run_id)
    seqs = [frame["seq"] for frame in frames]
    assert seqs == list(range(1, seqs[-1] + 1))
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"]["status"] == "ready"


def test_gate_evaluator_closes_gap_then_reaches_ready(tmp_path):
    asyncio.run(_run_scenario_close_gap(tmp_path))


# --- ② stubborn gap: bounded continuation then honest flag --------------------


async def _run_scenario_flag(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    gap = json.dumps({"category": "false_completion", "confidence": 0.9, "gaps": ["报告仍未生成"]})
    judge = _FakeJudge([gap, gap, gap])  # keeps finding the same gap
    model = _AlwaysClaimModel()
    chat = _orchestrator(store, model, judge)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我做上月费用分析并生成报告。",
    )
    run_id = run.id
    await manager.get_task(run_id)

    finished = chat.get_run(run_id)
    # Honest flag, NOT a failure — the work was delivered; the flag is metadata.
    assert finished.status == "ready"

    eval_events = _eval_events(finished)
    types = [t for t, _ in eval_events]
    # Exactly ONE continuation: round 0 verdict false_completion -> continue ->
    # round 1 still not achieved but continuations spent -> flagged.
    assert types == [
        "run.evaluation.started",
        "run.evaluation.verdict",
        "run.evaluation.started",
        "run.evaluation.flagged",
    ]
    # Bounded: exactly one evaluator continuation (2 model calls, 2 judge calls).
    assert len(model.requests) == 2
    assert len(judge.calls) == 2

    flagged = eval_events[3][1]
    assert flagged["gaps"] == ["报告仍未生成"]

    frames = await _replay(manager, run_id)
    seqs = [frame["seq"] for frame in frames]
    assert seqs == list(range(1, seqs[-1] + 1))
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"]["status"] == "ready"


def test_gate_evaluator_stubborn_gap_flags_after_one_continuation(tmp_path):
    asyncio.run(_run_scenario_flag(tmp_path))


# --- ③ judge outage: malformed JSON -> skipped, ready normally ----------------


async def _run_scenario_skipped(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    judge = _FakeJudge(["这不是合法的 JSON,只是一句废话。"])  # code gate must reject
    model = _AlwaysClaimModel()
    chat = _orchestrator(store, model, judge)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我做上月费用分析并生成报告。",
    )
    run_id = run.id
    await manager.get_task(run_id)

    finished = chat.get_run(run_id)
    # Fail-open: a bad judge output never fails or blocks the run.
    assert finished.status == "ready"
    assert finished.assistant_message == "任务已办妥。"

    eval_events = _eval_events(finished)
    types = [t for t, _ in eval_events]
    assert types == ["run.evaluation.started", "run.evaluation.skipped"]
    # No continuation was spawned on a skipped verdict.
    assert len(model.requests) == 1
    assert len(judge.calls) == 1
    assert not any(t == "run.evaluation.verdict" for t, _ in eval_events)

    frames = await _replay(manager, run_id)
    seqs = [frame["seq"] for frame in frames]
    assert seqs == list(range(1, seqs[-1] + 1))
    assert frames[-1]["type"] == "done"


def test_gate_evaluator_malformed_judge_output_skips_fail_open(tmp_path):
    asyncio.run(_run_scenario_skipped(tmp_path))
