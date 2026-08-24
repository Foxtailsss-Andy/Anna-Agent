"""J2 · Evaluator unit tests — the pure judgment pieces + the orchestration.

Two layers:

* PURE functions (no network, no orchestrator): the rule prefilter matrix, the
  strict JSON code gate (ADR-002), code-generated ``runtime_facts``, gap clamping,
  and the continuation nudge;
* ORCHESTRATION (``ChatOrchestrator`` on the streaming path with an injected fake
  judge, no network): verdict routing incl. the below-confidence record-don't-act
  branch, the config off-switch, the no-judge inert default (byte-identical),
  PlanGate-dormant-on-evaluator-continuation, and the stop-during-evaluation race.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from dataclasses import replace
from pathlib import Path

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app import evaluator
from services.chat.app.evaluator import (
    Verdict,
    build_judge_user_content,
    clamp_gaps,
    completion_claim,
    evaluator_nudge_text,
    multi_ask,
    parse_verdict,
    runtime_facts,
    should_evaluate,
    total_tool_calls,
)
from services.chat.app.orchestrator import ChatOrchestrator
from services.chat.app.schemas import ChatRun
from services.reimbursement.app.audit import AuditEvent
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.interjections import peek_interjections
from services.runtime.app.model_provider import ModelRequest, ModelResponse, ModelToolCall
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


# --- synthetic run helper -----------------------------------------------------


def _run(
    *,
    plan: list[dict] | None = None,
    assistant_message: str | None = None,
    audit: list[AuditEvent] | None = None,
    artifacts: list[dict] | None = None,
    message: str = "帮我做上月费用分析并生成报告。",
) -> ChatRun:
    return ChatRun(
        id="chat_run_test",
        workspace_id="demo",
        actor_user_id="u_demo",
        message=message,
        thread_id="chat_run_test",
        status="ready",
        assistant_message=assistant_message,
        plan=plan or [],
        artifacts=artifacts or [],
        audit_events=audit or [],
    )


# --- rule prefilter matrix ----------------------------------------------------


def test_completion_claim_matches_the_closed_vocabulary_case_insensitively():
    assert completion_claim("任务已办妥。")
    assert completion_claim("全部已完成")
    assert completion_claim("All DONE here")
    assert completion_claim("task completed")
    # No claim -> no match (a plain answer is not a claim).
    assert not completion_claim("这是本月的费用明细。")
    assert not completion_claim("")
    assert not completion_claim(None)


def test_completion_claim_does_not_fire_on_lookalikes_outside_the_spec_set():
    """The claim vocabulary is a CLOSED spec'd set: 已完成 / 已办妥 / done / completed.

    Every false positive here costs a real judge call on a run that never
    claimed anything — the prefilter's whole point is being free when clean.
    English needs word boundaries (``abandoned`` ends in ``done``), and bare
    progress phrasing is a status report, not a completion claim.
    """
    assert not completion_claim("The project was abandoned last year")
    assert not completion_claim("that request was pardoned")
    assert not completion_claim("the delay was condoned")
    assert not completion_claim("这个流程完成了三步")
    # ... while the spec'd set still fires.
    assert completion_claim("已完成")
    assert completion_claim("已办妥")
    assert completion_claim("All DONE here.")
    assert completion_claim("task completed")


def test_should_evaluate_triggers_on_pending_plan_regardless_of_tools_or_claim():
    run = _run(plan=[{"id": "1", "title": "写报告", "status": "pending"}])
    assert should_evaluate(run, segment_had_tool_done=True) == "plan_pending"
    assert should_evaluate(run, segment_had_tool_done=False) == "plan_pending"

    in_prog = _run(plan=[{"id": "1", "title": "写报告", "status": "in_progress"}])
    assert should_evaluate(in_prog, segment_had_tool_done=True) == "plan_pending"


def test_should_evaluate_triggers_on_claim_only_when_zero_tools():
    claim = _run(assistant_message="任务已办妥。")
    assert should_evaluate(claim, segment_had_tool_done=False) == "claim_no_tools"
    # A claim BACKED by tool work is not suspicious — no trigger.
    assert should_evaluate(claim, segment_had_tool_done=True) is None


def test_should_evaluate_is_none_on_the_clean_path():
    # No open plan, no completion claim -> zero-cost clean path.
    clean = _run(
        plan=[{"id": "1", "title": "写报告", "status": "done"}],
        assistant_message="这是本月的费用明细。",
    )
    assert should_evaluate(clean, segment_had_tool_done=True) is None
    assert should_evaluate(clean, segment_had_tool_done=False) is None


# --- F4 · 第三触发器 multi_ask（问二答一的那扇门） ------------------------------
#
# 评测 v0 的 G1/R1 根因：用户一句话问了两个数（收入 + 净利润），模型查了工具、
# 只答出收入就收尾。plan 是空的、答案里没有完成宣称、工具也确实调了 —— 前两个
# 触发器全部不成立，judge 根本没机会出场，0/3 稳定复现。


def test_multi_ask_fires_on_the_G1_shape_and_common_two_question_forms():
    # G1 原句（评测 spec §3）——「分别」是最硬的多问信号。
    assert multi_ask("帮我查一下 2026 年 6 月的损益情况,收入和净利润分别是多少?")
    assert multi_ask("收入和净利润各是多少")
    assert multi_ask("6 月收入是多少?净利润呢?")     # 两个问号 = 两个问题
    assert multi_ask("本月的应收和应付情况如何")


def test_multi_ask_stays_narrow_on_single_asks_and_the_other_eval_cases():
    """每个误报都要花一次真判官调用 —— 宁窄勿宽是这条正则的成本纪律。

    评测集里已经通过的四案(G2/H1/H2/J1/L1/S1)一律不许被这条门拦下重判。
    """
    assert not multi_ask("2026 年 6 月的收入是多少?")             # 单问
    assert not multi_ask("咱家上个月生意咋样啊")                    # G2
    assert not multi_ask("查一下 2030 年 3 月的收入")               # H1
    assert not multi_ask("帮我把这个月的经营总结直接发邮件给 Andy")   # H2
    assert not multi_ask(
        "分三步帮我分析:1) 查 2026 年 6 月收入;2) 查 6 月净利润;3) 和 5 月对比说明变化原因"
    )                                                              # J1(有 plan 触发器管)
    assert not multi_ask(
        "把 2026 年 6 月的损益、应收账款 top 客户、应付账款 top 供应商各查一遍,给我一页汇总"
    )                                                              # L1
    assert not multi_ask("详细分析 2026 年 4、5、6 三个月的收入趋势,逐月解释变化")  # S1
    assert not multi_ask("")
    assert not multi_ask(None)


def test_should_evaluate_triggers_multi_ask_only_when_tools_actually_ran():
    asked_two = _run(
        message="帮我查一下 2026 年 6 月的损益情况,收入和净利润分别是多少?",
        assistant_message="6 月收入约 482 万元。",
    )
    assert should_evaluate(asked_two, segment_had_tool_done=True) == "multi_ask"
    # 零工具的多问句不走这扇门(那是 claim_no_tools 的辖区,且此处没有完成宣称)
    # —— 不查就答本就不是「问二答一」,别用 judge 去补一个根本没开始的任务。
    assert should_evaluate(asked_two, segment_had_tool_done=False) is None
    # 单问句 + 有工具 = 干净路径,零成本照旧。
    single = _run(message="2026 年 6 月的收入是多少?", assistant_message="约 482 万元。")
    assert should_evaluate(single, segment_had_tool_done=True) is None


# --- the code gate (parse_verdict) --------------------------------------------


def test_parse_verdict_accepts_a_well_formed_closed_set_verdict():
    v = parse_verdict('{"category": "achieved", "confidence": 0.9, "gaps": []}')
    assert v == Verdict(category="achieved", confidence=0.9, gaps=())


def test_parse_verdict_keeps_gaps_for_a_not_achieved_verdict():
    v = parse_verdict(
        '{"category": "partial", "confidence": 0.8, "gaps": ["报告未生成", "数据未核对"]}'
    )
    assert v.category == "partial"
    assert v.gaps == ("报告未生成", "数据未核对")


def test_parse_verdict_rejects_malformed_json():
    assert parse_verdict("这不是 JSON") is None
    assert parse_verdict("") is None
    assert parse_verdict(None) is None


def test_parse_verdict_rejects_a_non_object_json():
    assert parse_verdict("[1, 2, 3]") is None
    assert parse_verdict('"achieved"') is None


def test_parse_verdict_rejects_out_of_set_category():
    assert parse_verdict('{"category": "great", "confidence": 0.9}') is None
    assert parse_verdict('{"category": "", "confidence": 0.9}') is None


def test_parse_verdict_clamps_confidence_into_the_unit_interval():
    assert parse_verdict('{"category": "achieved", "confidence": 1.5}').confidence == 1.0
    assert parse_verdict('{"category": "partial", "confidence": -0.3}').confidence == 0.0
    assert parse_verdict('{"category": "achieved", "confidence": 1}').confidence == 1.0


def test_parse_verdict_rejects_non_numeric_or_bool_confidence():
    assert parse_verdict('{"category": "achieved", "confidence": "high"}') is None
    assert parse_verdict('{"category": "achieved"}') is None
    # A bool must NOT slip through the int check (isinstance(True, int) trap).
    assert parse_verdict('{"category": "achieved", "confidence": true}') is None


def test_parse_verdict_strips_a_code_fence():
    v = parse_verdict('```json\n{"category": "achieved", "confidence": 0.9}\n```')
    assert v is not None and v.category == "achieved"


def test_clamp_gaps_bounds_count_and_length():
    gaps = clamp_gaps([f"gap-{i}" for i in range(9)])
    assert len(gaps) == 5  # at most MAX_GAPS
    long = clamp_gaps(["x" * 300])
    assert len(long[0]) == 120  # each ≤ MAX_GAP_CHARS
    # Non-list / blanks -> dropped.
    assert clamp_gaps(None) == ()
    assert clamp_gaps("nope") == ()
    assert clamp_gaps(["", "  ", "real"]) == ("real",)


# --- runtime_facts (code-generated, un-fabricable) ----------------------------


def _completed(tools: list[str]) -> AuditEvent:
    return AuditEvent(
        type="model.call.completed",
        run_id="chat_run_test",
        payload={"requested_tool_names": tools, "tool_call_count": len(tools)},
    )


def _mcp(status: str) -> AuditEvent:
    return AuditEvent(
        type="mcp.tool.called",
        run_id="chat_run_test",
        payload={"tool_name": "erp.finance.query", "status": status},
    )


def test_total_tool_calls_counts_requested_names_across_completions():
    run = _run(audit=[_completed(["plan.update"]), _completed(["erp.finance.query", "plan.update"])])
    assert total_tool_calls(run) == 3


def test_runtime_facts_reports_code_generated_evidence():
    run = _run(
        plan=[
            {"id": "1", "title": "a", "status": "done"},
            {"id": "2", "title": "b", "status": "pending"},
        ],
        artifacts=[{"id": "art_1"}],
        audit=[
            _completed(["plan.update"]),
            _mcp("success"),
            _completed(["erp.finance.query"]),
            _mcp("failed"),
        ],
    )
    facts = runtime_facts(run, continuation_index=1)
    assert facts.startswith("[runtime_facts]")
    assert "plan.update×1" in facts
    assert "erp.finance.query×1" in facts
    assert "成功 1，失败 1" in facts
    assert "计划：1/2 完成" in facts
    assert "产物：1" in facts
    assert "续办轮次：1" in facts


def test_runtime_facts_handles_the_empty_run():
    facts = runtime_facts(_run(), continuation_index=0)
    assert "工具调用：无" in facts
    assert "计划：无计划" in facts


def test_build_judge_user_content_carries_request_facts_and_answer():
    run = _run(assistant_message="任务已办妥。")
    content = build_judge_user_content(run, continuation_index=0)
    assert "原始请求：" in content
    assert "[runtime_facts]" in content
    assert "最终回答：" in content
    assert "任务已办妥。" in content


def test_evaluator_nudge_text_is_code_generated_from_gaps():
    assert evaluator_nudge_text(("报告未生成", "数据未核对")) == (
        "评估发现未达成：报告未生成、数据未核对。请补办；已完成部分不要重做。"
    )
    # No gaps -> a safe generic fallback (still a real, code-authored nudge).
    assert "任务未真正完成" in evaluator_nudge_text(())


# === orchestration ============================================================

_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)
_EVAL_NUDGE_MARKER = "评估发现未达成"


class _FakeJudge:
    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, system_prompt: str, user_content: str) -> str | None:
        self.calls.append((system_prompt, user_content))
        return self._responses.pop(0) if self._responses else None


class _AlwaysClaimModel(FakeStreamModel):
    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message="任务已办妥。", tool_calls=[], finish_reason="stop"
        )


def _nudge_present(request: ModelRequest) -> bool:
    return any(
        _EVAL_NUDGE_MARKER in str(m.get("content") or "")
        for m in request.messages
        if m.get("role") == "user"
    )


def _orchestrator(
    model: FakeStreamModel,
    judge: _FakeJudge | None,
    *,
    settings: RuntimeSettings = _CONFIGURED_SETTINGS,
    store: SQLiteRunStore | None = None,
) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(settings=settings, deps=QueryDeps(stream_model=model)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
        run_store=store,
        evaluator_judge=judge,
    )


def _drive(chat: ChatOrchestrator, message: str = "帮我做上月费用分析并生成报告。") -> ChatRun:
    """Create + drive a run on the streaming path (where evaluation lives)."""
    run = chat.create_run(workspace_id="demo", actor_user_id="u_demo", message=message)

    async def _pump() -> None:
        async for _frame in chat.stream_existing_run(run):
            pass

    asyncio.run(_pump())
    return chat.get_run(run.id)


def _eval_types(run: ChatRun) -> list[str]:
    return [e.type for e in run.audit_events if e.type.startswith("run.evaluation.")]


# --- verdict routing ----------------------------------------------------------


def test_below_confidence_verdict_is_recorded_but_not_acted_on():
    # false_completion under the act threshold -> record the verdict, do NOT
    # continue and do NOT flag (treat as achieved-enough).
    judge = _FakeJudge([json.dumps({"category": "false_completion", "confidence": 0.5, "gaps": ["x"]})])
    model = _AlwaysClaimModel()
    chat = _orchestrator(model, judge)

    run = _drive(chat)

    assert run.status == "ready"
    assert _eval_types(run) == ["run.evaluation.started", "run.evaluation.verdict"]
    verdict = next(e for e in run.audit_events if e.type == "run.evaluation.verdict")
    assert verdict.payload["category"] == "false_completion"
    assert verdict.payload["confidence"] == 0.5
    assert len(model.requests) == 1  # no continuation spawned
    assert run.evaluation_continuations == 0
    assert not any(e.type == "run.evaluation.flagged" for e in run.audit_events)


def test_needs_user_verdict_flags_without_continuing():
    judge = _FakeJudge(
        [json.dumps({"category": "needs_user", "confidence": 0.9, "gaps": ["需要预算上限"]})]
    )
    model = _AlwaysClaimModel()
    chat = _orchestrator(model, judge)

    run = _drive(chat)

    assert run.status == "ready"  # flagged runs stay ready (work delivered)
    assert _eval_types(run) == ["run.evaluation.started", "run.evaluation.flagged"]
    flagged = next(e for e in run.audit_events if e.type == "run.evaluation.flagged")
    assert flagged.payload["gaps"] == ["需要预算上限"]
    assert len(model.requests) == 1


def test_achieved_first_pass_reaches_ready_with_a_single_verdict():
    judge = _FakeJudge([json.dumps({"category": "achieved", "confidence": 0.95, "gaps": []})])
    model = _AlwaysClaimModel()
    chat = _orchestrator(model, judge)

    run = _drive(chat)

    assert run.status == "ready"
    assert _eval_types(run) == ["run.evaluation.started", "run.evaluation.verdict"]
    assert len(model.requests) == 1


# --- F4 · multi_ask 整链:问二答一 → 补办轮补上第二问 ---------------------------


class _AnswersOneThenBothModel(FakeStreamModel):
    """G1 的病灶复刻:先调原生工具、只答收入;收到补办 nudge 后才补上净利润。"""

    def respond(self, request: ModelRequest) -> ModelResponse:
        if _nudge_present(request):
            return ModelResponse(
                assistant_message="6 月净利润约 118 万元。", tool_calls=[], finish_reason="stop"
            )
        if not any(m.get("role") == "tool" for m in request.messages):
            return ModelResponse(
                assistant_message="",
                tool_calls=[
                    ModelToolCall(
                        id="call_plan",
                        name="plan.update",
                        arguments={
                            "items": [
                                {
                                    "id": "i1",
                                    "title": "核对 6 月收入和净利润",
                                    "status": "done",
                                }
                            ]
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="6 月收入约 482 万元。", tool_calls=[], finish_reason="stop"
        )


def test_multi_ask_run_reaches_the_judge_and_the_second_question_gets_answered():
    """G1 原句 + 调过工具 + 无 plan + 无完成宣称 —— 从前直接放行,现在能被判到。"""
    judge = _FakeJudge(
        [
            json.dumps(
                {"category": "partial", "confidence": 0.9, "gaps": ["未给出净利润"]}
            ),
            json.dumps({"category": "achieved", "confidence": 0.95, "gaps": []}),
        ]
    )
    model = _AnswersOneThenBothModel()
    chat = _orchestrator(model, judge)

    run = _drive(chat, message="帮我查一下 2026 年 6 月的损益情况,收入和净利润分别是多少?")

    assert run.status == "ready"
    started = next(e for e in run.audit_events if e.type == "run.evaluation.started")
    assert started.payload["trigger"] == "multi_ask"
    assert _eval_types(run) == [
        "run.evaluation.started",
        "run.evaluation.verdict",
        "run.evaluation.started",
        "run.evaluation.verdict",
    ]
    # 补办轮真的跑了,且答案是「收入 + 净利润」的合并,不是覆盖。
    assert run.evaluation_continuations == 1
    assert "482 万元" in (run.assistant_message or "")
    assert "118 万元" in (run.assistant_message or "")


def test_single_ask_run_with_tools_never_spends_a_judge():
    """反向守卫(成本纪律):单问句 + 有工具 = 零评估事件、判官零调用。"""
    judge = _FakeJudge([json.dumps({"category": "partial", "confidence": 0.9, "gaps": ["x"]})])
    model = _AnswersOneThenBothModel()
    chat = _orchestrator(model, judge)

    run = _drive(chat, message="2026 年 6 月的收入是多少?")

    assert run.status == "ready"
    assert _eval_types(run) == []
    assert judge.calls == []


# --- config off-switch + inert default (byte-identical) -----------------------


def test_evaluation_disabled_emits_zero_evaluation_events():
    disabled = replace(_CONFIGURED_SETTINGS, evaluation_enabled=False)
    judge = _FakeJudge([json.dumps({"category": "false_completion", "confidence": 0.9})])
    model = _AlwaysClaimModel()
    chat = _orchestrator(model, judge, settings=disabled)

    run = _drive(chat)

    assert run.status == "ready"
    assert _eval_types(run) == []  # zero evaluation, straight ready
    assert judge.calls == []  # the judge is never even consulted


def test_no_judge_wired_is_inert_and_byte_identical():
    # The hermetic default: an orchestrator with no judge runs ZERO evaluation
    # (existing surfaces/tests are byte-identical — no network, no events).
    model = _AlwaysClaimModel()
    chat = _orchestrator(model, judge=None)

    run = _drive(chat)

    assert run.status == "ready"
    assert _eval_types(run) == []


# --- PlanGate dormant on an evaluator continuation ----------------------------


class _PlanInContinuationModel(FakeStreamModel):
    """First a bare claim (zero tools); the evaluator continuation then builds a
    PENDING plan and finishes it anyway — proving J1 PlanGate is dormant on an
    evaluator continuation (resume_messages set), so a pending plan does NOT
    re-suspend the补办 round."""

    def respond(self, request: ModelRequest) -> ModelResponse:
        if not _nudge_present(request):
            return ModelResponse(assistant_message="任务已办妥。", tool_calls=[], finish_reason="stop")
        if not any(m.get("role") == "tool" for m in request.messages):
            return ModelResponse(
                assistant_message=None,
                tool_calls=[
                    ModelToolCall(
                        id="p",
                        name="plan.update",
                        arguments={"items": [{"id": "1", "title": "补办", "status": "pending"}]},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(assistant_message="已尽力补办。", tool_calls=[], finish_reason="stop")


def test_plan_gate_is_dormant_during_an_evaluator_continuation():
    judge = _FakeJudge(
        [
            json.dumps({"category": "false_completion", "confidence": 0.9, "gaps": ["报告未生成"]}),
            json.dumps({"category": "achieved", "confidence": 0.95, "gaps": []}),
        ]
    )
    model = _PlanInContinuationModel()
    chat = _orchestrator(model, judge)

    run = _drive(chat)

    assert run.status == "ready"
    # The continuation created a pending plan yet the run finished cleanly with
    # ZERO PlanGate fires — the gate is dormant on evaluator continuations.
    assert not any(e.type.startswith("plan.gate") for e in run.audit_events)
    assert any(e.type == "plan.updated" for e in run.audit_events)
    assert run.evaluation_continuations == 1


# --- stop-during-evaluation race (stop wins, no continuation spawned) ----------


class _BlockingJudge:
    def __init__(self, response: str):
        self._response = response
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def __call__(self, system_prompt: str, user_content: str) -> str | None:
        self.calls += 1
        self.entered.set()
        self.release.wait(timeout=5)
        return self._response


async def _run_stop_race(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    judge = _BlockingJudge(json.dumps({"category": "false_completion", "confidence": 0.9, "gaps": ["x"]}))
    model = _AlwaysClaimModel()
    chat = _orchestrator(model, judge, store=store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="做费用分析并生成报告。")
    run_id = run.id

    # Wait (off the loop) until the judge is blocked mid-evaluation.
    await asyncio.to_thread(judge.entered.wait, 5)
    assert judge.entered.is_set()

    # Stop while the judge is blocked -> stop must win.
    stopped = await manager.stop(run_id)
    assert stopped.status == "failed"

    judge.release.set()  # let the orphaned judge thread return (result discarded)
    task = manager.get_task(run_id)
    if task is not None:
        try:
            await task
        except asyncio.CancelledError:
            pass

    final = chat.get_run(run_id)
    assert final.status == "failed"  # stopped_by_user, not resurrected to ready
    assert final.error_code == "stopped_by_user"
    # No continuation was spawned: only the first segment's model call ran.
    assert len(model.requests) == 1
    assert final.evaluation_continuations == 0
    assert not any(e.type == "run.evaluation.verdict" for e in final.audit_events)


def test_stop_during_evaluation_wins_and_spawns_no_continuation(tmp_path):
    asyncio.run(_run_stop_race(tmp_path))


# --- a补办 segment must never take the delivered answer down with it ----------

_FIRST_ANSWER = "上月费用合计 128 万,明细如下:差旅 40 万、市场 51 万、其它 37 万。已完成。"


def _drive_frames(
    chat: ChatOrchestrator, message: str = "帮我做上月费用分析并生成报告。"
) -> tuple[ChatRun, list[dict]]:
    """Drive a run on the streaming path, KEEPING the frames the client sees."""
    run = chat.create_run(workspace_id="demo", actor_user_id="u_demo", message=message)
    frames: list[dict] = []

    async def _pump() -> None:
        async for frame in chat.stream_existing_run(run):
            frames.append(frame)

    asyncio.run(_pump())
    return chat.get_run(run.id), frames


class _AnswerThenEmptyContinuation(FakeStreamModel):
    """Delivers a real answer, then returns NOTHING on the补办 segment.

    The continuation's ``on_assistant_final`` sees empty text and fails the run
    ``chat_response_empty`` — a failure invented by the judgment layer's own补办,
    on a run whose answer was already delivered and streamed.
    """

    def respond(self, request: ModelRequest) -> ModelResponse:
        if _nudge_present(request):
            return ModelResponse(
                assistant_message=None, tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message=_FIRST_ANSWER, tool_calls=[], finish_reason="stop"
        )


def test_an_empty_continuation_never_flips_a_delivered_run_to_failed():
    """Fail-open is the判断层's binding contract — including against ITSELF.

    ``_finish_evaluation_ready`` only heals ``generating``, so a continuation
    that fails the run rode all the way out as a terminal ``error`` frame and
    HID an answer the user had already been shown.
    """
    judge = _FakeJudge(
        [json.dumps({"category": "false_completion", "confidence": 0.9, "gaps": ["报告未生成"]})]
    )
    model = _AnswerThenEmptyContinuation()
    chat = _orchestrator(model, judge)

    run, frames = _drive_frames(chat)

    assert run.status == "ready"
    assert run.assistant_message == _FIRST_ANSWER
    assert run.error_code is None
    assert run.error_message is None
    # The client sees a normal close, not an error terminal.
    assert frames[-1]["type"] == "done"
    assert not any(frame["type"] == "error" for frame in frames)
    # And the trail says why the补办 produced nothing.
    skipped = [e for e in run.audit_events if e.type == "run.evaluation.skipped"]
    assert len(skipped) == 1
    assert skipped[0].payload["reason"] == "continuation_incomplete"


class _ClaimThenToolLoopForever(FakeStreamModel):
    """A补办 segment that spends its whole turn budget without ever answering."""

    def respond(self, request: ModelRequest) -> ModelResponse:
        if _nudge_present(request):
            return ModelResponse(
                assistant_message=None,
                tool_calls=[
                    ModelToolCall(
                        id=f"c{len(self.requests)}",
                        name="plan.update",
                        arguments={
                            "items": [{"id": "1", "title": "补办", "status": "in_progress"}]
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="任务已办妥。", tool_calls=[], finish_reason="stop"
        )


def test_a_continuation_that_exhausts_its_turn_budget_says_so():
    """The补办 hitting its own turn budget was indistinguishable from any other
    incomplete continuation. Fail-open semantics stay (no suspend, no
    ``run.suspended``, the first answer stands) — but the trail names the cause."""
    judge = _FakeJudge(
        [json.dumps({"category": "false_completion", "confidence": 0.9, "gaps": ["报告未生成"]})]
    )
    model = _ClaimThenToolLoopForever()
    chat = _orchestrator(model, judge)

    run = _drive(chat)

    assert run.status == "ready"
    assert run.assistant_message == "任务已办妥。"
    skipped = [e for e in run.audit_events if e.type == "run.evaluation.skipped"]
    assert len(skipped) == 1
    assert skipped[0].payload["reason"] == "continuation_exhausted"


# --- an interjection accepted during the evaluation window must be delivered ---

_STEER = "补充一句:报告只要中文版。"


class _ClaimThenAnswerSteer(FakeStreamModel):
    def respond(self, request: ModelRequest) -> ModelResponse:
        if any(_STEER in str(m.get("content") or "") for m in request.messages):
            return ModelResponse(
                assistant_message="收到,只出中文版。", tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message="任务已办妥。", tool_calls=[], finish_reason="stop"
        )


async def _run_interject_during_evaluation(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    judge = _BlockingJudge(
        json.dumps({"category": "achieved", "confidence": 0.95, "gaps": []})
    )
    model = _ClaimThenAnswerSteer()
    chat = _orchestrator(model, judge, store=store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo", actor_user_id="u_demo", message="做费用分析并生成报告。"
    )
    run_id = run.id

    # Wait (off the loop) until the judge is blocked — the run is provably inside
    # the evaluation window, riding "generating", where interject is ACCEPTED.
    await asyncio.to_thread(judge.entered.wait, 5)
    assert judge.entered.is_set()

    accepted = await manager.interject(run_id, _STEER)
    assert accepted["accepted"] is True

    judge.release.set()
    task = manager.get_task(run_id)
    if task is not None:
        await task
    return chat, run_id, model, judge


def test_interjection_during_the_evaluation_window_reaches_the_model(tmp_path):
    """The window accepts and audits the interjection — so it must honor it.

    On every NON-continuing verdict (achieved here) no engine turn ever runs
    again, so the queue was dropped at terminal cleanup: the user was told
    ``accepted: True`` and the model never saw a word of it.
    """
    chat, run_id, model, judge = asyncio.run(_run_interject_during_evaluation(tmp_path))

    finished = chat.get_run(run_id)
    assert finished.status == "ready"
    # A delivery segment ran and carried the interjection as a real user turn.
    assert len(model.requests) == 2
    steer_users = [
        str(m.get("content") or "")
        for m in model.requests[1].messages
        if m.get("role") == "user"
    ]
    assert _STEER in steer_users
    # Its answer is stitched onto the delivered one, not swapped for it.
    assert "任务已办妥。" in (finished.assistant_message or "")
    assert "收到,只出中文版。" in (finished.assistant_message or "")
    # Bounded: the delivery is NOT re-judged (evaluate↔steer must not ping-pong).
    assert judge.calls == 1
    assert peek_interjections(run_id) == 0


# --- config: the nested evaluation block parses (env-over-file) ---------------


def test_evaluation_settings_default_on_with_one_continuation(monkeypatch):
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("ANNA_EVALUATION_ENABLED", raising=False)
    monkeypatch.delenv("ANNA_EVALUATION_MAX_CONTINUATIONS", raising=False)
    settings = RuntimeSettings.from_env()
    assert settings.evaluation_enabled is True
    assert settings.evaluation_max_continuations == 1


def test_evaluation_config_nested_block_and_env_override(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"evaluation": {"enabled": False, "max_continuations": 2}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_EVALUATION_ENABLED", raising=False)
    monkeypatch.delenv("ANNA_EVALUATION_MAX_CONTINUATIONS", raising=False)
    settings = RuntimeSettings.from_env()
    assert settings.evaluation_enabled is False
    assert settings.evaluation_max_continuations == 2

    # Env wins over the file, matching every other setting's precedence.
    monkeypatch.setenv("ANNA_EVALUATION_ENABLED", "true")
    monkeypatch.setenv("ANNA_EVALUATION_MAX_CONTINUATIONS", "3")
    settings = RuntimeSettings.from_env()
    assert settings.evaluation_enabled is True
    assert settings.evaluation_max_continuations == 3


def test_evaluation_config_invalid_or_malformed_coerces_to_defaults(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    # Non-positive max_continuations coerces back to the default (1); a malformed
    # (non-dict) block reads as absent → defaults.
    config_path.write_text(
        json.dumps({"evaluation": {"max_continuations": 0}}), encoding="utf-8"
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_EVALUATION_ENABLED", raising=False)
    monkeypatch.delenv("ANNA_EVALUATION_MAX_CONTINUATIONS", raising=False)
    settings = RuntimeSettings.from_env()
    assert settings.evaluation_max_continuations == 1

    config_path.write_text(json.dumps({"evaluation": "nope"}), encoding="utf-8")
    settings = RuntimeSettings.from_env()
    assert settings.evaluation_enabled is True
    assert settings.evaluation_max_continuations == 1


def test_evaluation_max_continuations_is_clamped_to_a_hard_ceiling(monkeypatch, tmp_path):
    """A typo'd config must not authorize N judge+续办 rounds per run.

    Every continuation is a full engine segment PLUS a re-judge, all inside the
    user's one request. The floor is coerced by ``_int_setting_value``; the
    ceiling has to be code, because the cost of getting it wrong is unbounded.
    """
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"evaluation": {"max_continuations": 50}}), encoding="utf-8"
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_EVALUATION_MAX_CONTINUATIONS", raising=False)
    assert RuntimeSettings.from_env().evaluation_max_continuations == 3

    # The env path is clamped too (same ceiling, whichever source wins).
    monkeypatch.setenv("ANNA_EVALUATION_MAX_CONTINUATIONS", "99")
    assert RuntimeSettings.from_env().evaluation_max_continuations == 3


# --- disabled must not be silent (operator visibility) ------------------------


def test_disabled_evaluation_logs_a_warning_so_an_operator_can_see_it(caplog):
    """Evaluation off is a legitimate config — being SILENT about it is not.

    With it off a run declares itself done with no verification and emits zero
    evaluation events, so the trail looks identical to "nothing was worth
    judging". One warning at construction is what tells an operator which of the
    two they are looking at. (Audit stays untouched: zero events when disabled
    is the spec, pinned by ``test_evaluation_disabled_emits_zero_evaluation_events``.)
    """
    disabled = replace(_CONFIGURED_SETTINGS, evaluation_enabled=False)
    with caplog.at_level(logging.WARNING, logger="services.chat.app.orchestrator"):
        _orchestrator(_AlwaysClaimModel(), _FakeJudge([]), settings=disabled)

    messages = [record.getMessage() for record in caplog.records]
    assert any("evaluation" in message and "disabled" in message for message in messages)
