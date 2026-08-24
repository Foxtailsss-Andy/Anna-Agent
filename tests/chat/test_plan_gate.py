"""J1 · PlanGate unit tests (chat capability layer).

Exercises the deterministic in-loop守门 directly on ``ChatCapabilityHandler``:
the run may not end while the model's own plan still has unfinished
(``pending``/``in_progress``) items. The gate lives entirely in
``on_assistant_final`` (the engine's existing nudge hook) — no engine change.

Coverage:

* the fire-count cap (at most 2 fires per segment, then honest fall-through);
* nudge title truncation (>3 pending items → first 3 listed + 「等N项」);
* per-segment counter reset + L4a interlock (a resumed run gets a fresh handler
  → counter resets with the segment; the continue segment itself is DORMANT —
  it already opens under ``CHAT_CONTINUE_NUDGE`` and the L4a gate pins
  continue → ready, so PlanGate must not re-suspend a user-continued run);
* the ``max_turns`` interplay — a plan-gated run whose nudge rounds spend the
  turn budget lands in ``awaiting_continue`` (L4a suspend), NOT an infinite
  nudge loop;
* zero-noise when idle — no plan, or an all-done plan, emits NO ``plan.gate.*``.

The first four assert new behavior (RED before J1); the idle test also guards
the zero-cost-when-idle invariant that must hold in every state.
"""
from __future__ import annotations

from pathlib import Path

from services.chat.app.capability import ChatCapabilityHandler
from services.chat.app.orchestrator import (
    MAX_CHAT_MODEL_TOOL_ROUNDS,
    ChatOrchestrator,
)
from services.chat.app.schemas import ChatRun
from services.reimbursement.app.audit import AuditService
from services.runtime.app.chat_tool_registry import ChatToolRegistry
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import (
    ModelResponse,
    ModelToolCall,
)
from services.runtime.app.skill_loader import LoadedSkill, SkillLoader
from tests.support.engine_fakes import FakeStreamModel


# --- direct-handler helpers (no engine, no network) ---------------------------


def _skill() -> LoadedSkill:
    return LoadedSkill(
        id="chat",
        name="Chat",
        version="1",
        path=Path("skills/chat/SKILL.md"),
        content="",
        content_hash="h",
        allowed_tools=[],
        forbidden_tools=[],
        frontmatter={},
    )


def _handler(
    plan: list[dict], *, resume_messages: list[dict] | None = None
) -> ChatCapabilityHandler:
    """A chat handler bound to a run carrying ``plan`` — enough to drive the gate.

    ``on_assistant_final`` / the gate touch only ``run`` and ``audit``; the other
    deps (tool_registry/skill) are never reached, so a minimal
    wiring is sufficient and keeps the gate under a true unit test.
    ``resume_messages`` mirrors ``_prepare_resume`` (L4a): non-``None`` marks the
    handler as a continue-segment handler.
    """
    run = ChatRun(
        id="chat_run_test",
        workspace_id="demo",
        actor_user_id="u_demo",
        message="做一个多步任务",
        thread_id="chat_run_test",
        status="generating",
        plan=plan,
    )
    return ChatCapabilityHandler(
        skill=_skill(),
        run=run,
        tool_registry=ChatToolRegistry(),
        audit=AuditService(),
        hash_payload=lambda payload: "h",
        chat_skill_id="chat",
        template_label="通用对话",
        template_instruction="直接回答用户问题。",
        resume_messages=resume_messages,
    )


def _fired(handler: ChatCapabilityHandler) -> list[dict]:
    return [
        e.payload for e in handler.run.audit_events if e.type == "plan.gate.fired"
    ]


# --- fire-count cap -----------------------------------------------------------


def test_plan_gate_fires_at_most_twice_then_exhausts_honestly():
    handler = _handler(
        [
            {"id": "1", "title": "步骤一", "status": "pending"},
            {"id": "2", "title": "步骤二", "status": "in_progress"},  # counts as unfinished
        ]
    )

    n1 = handler.on_assistant_final("差不多了")  # fire 1
    n2 = handler.on_assistant_final("还是这样")  # fire 2
    n3 = handler.on_assistant_final("就这样吧")  # fires exhausted → None → finalize

    assert n1 is not None and n2 is not None
    assert n3 is None
    # Two fires (1 then 2), both reporting the 2 unfinished items.
    assert _fired(handler) == [
        {"pending_count": 2, "fire_index": 1},
        {"pending_count": 2, "fire_index": 2},
    ]
    # Exactly one exhausted event, then the honest fall-through to ready.
    exhausted = [e for e in handler.run.audit_events if e.type == "plan.gate.exhausted"]
    assert len(exhausted) == 1
    assert exhausted[0].payload == {"pending_count": 2}
    assert handler.run.status == "ready"
    assert handler.run.assistant_message == "就这样吧"


# --- nudge title truncation ---------------------------------------------------


def test_plan_gate_nudge_lists_three_titles_then_summarizes_the_rest():
    titles = ["登录页设计", "接口联调", "回归测试", "灰度发布", "文档更新"]
    handler = _handler(
        [{"id": str(i), "title": t, "status": "pending"} for i, t in enumerate(titles, 1)]
    )

    nudge = handler.on_assistant_final("我先停一下")

    assert nudge is not None
    # First three titles are named; the 4th/5th are folded into 等N项 (N = total).
    assert "登录页设计" in nudge
    assert "接口联调" in nudge
    assert "回归测试" in nudge
    assert "灰度发布" not in nudge
    assert "文档更新" not in nudge
    assert "等5项" in nudge
    # The exact code-generated nudge uses Chinese punctuation throughout.
    assert nudge == (
        "计划中还有未完成项：登录页设计、接口联调、回归测试等5项。"
        "请继续完成并用 plan.update 更新状态；若某项实际无法完成，请把它改为说明并更新计划。"
    )
    # The fired audit still reports the TRUE pending total, not the truncated 3.
    assert _fired(handler) == [{"pending_count": 5, "fire_index": 1}]


def test_plan_gate_nudge_lists_all_titles_when_three_or_fewer():
    handler = _handler(
        [
            {"id": "1", "title": "甲", "status": "pending"},
            {"id": "2", "title": "乙", "status": "in_progress"},
        ]
    )

    nudge = handler.on_assistant_final("暂停")

    assert nudge == (
        "计划中还有未完成项：甲、乙。"
        "请继续完成并用 plan.update 更新状态；若某项实际无法完成，请把它改为说明并更新计划。"
    )
    assert "等" not in nudge  # no summary tail when 3 or fewer remain


# --- per-segment counter reset + L4a continue-segment interlock ----------------


def test_resumed_segment_resets_the_counter_and_stays_dormant():
    plan = [{"id": "1", "title": "唯一步骤", "status": "pending"}]

    # Segment 1: exhaust the gate (2 fires then honest fall-through).
    seg1 = _handler(plan)
    assert seg1.on_assistant_final("一") is not None
    assert seg1.on_assistant_final("二") is not None
    assert seg1.on_assistant_final("三") is None  # exhausted this segment

    # L4a continue: _prepare_resume constructs a FRESH handler, so the per-segment
    # counter resets with the segment (per-run state on the handler)…
    seg2 = _handler(plan, resume_messages=[{"role": "user", "content": "继续"}])
    assert seg2._plan_gate_fires == 0
    # …and the continue segment itself is deliberately DORMANT: it already opens
    # under CHAT_CONTINUE_NUDGE, and the L4a gate (tests/gates/test_gate_continue)
    # pins continue → ready — PlanGate must not re-suspend a user-continued run.
    # The final passes straight through: run finalizes, zero plan.gate.* audit.
    assert seg2.on_assistant_final("续跑收尾。") is None
    assert seg2.run.status == "ready"
    assert seg2.run.assistant_message == "续跑收尾。"
    assert not any(e.type.startswith("plan.gate") for e in seg2.run.audit_events)


# --- zero-noise when idle -----------------------------------------------------


def test_no_plan_gate_events_when_plan_absent_or_all_done():
    # No plan at all → single finalize, zero plan.gate.* audit.
    empty = _handler([])
    assert empty.on_assistant_final("直接回答") is None
    assert empty.run.status == "ready"
    assert not any(e.type.startswith("plan.gate") for e in empty.run.audit_events)

    # Every item done → also zero plan.gate.* audit (no pending remains).
    done = _handler(
        [
            {"id": "1", "title": "步骤一", "status": "done"},
            {"id": "2", "title": "步骤二", "status": "done"},
        ]
    )
    assert done.on_assistant_final("都完成了") is None
    assert done.run.status == "ready"
    assert not any(e.type.startswith("plan.gate") for e in done.run.audit_events)


# --- max_turns interplay (through the real orchestrator, sync path) ------------


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused here
        raise AssertionError("this test never dispatches an ERP tool")


class _BurnThenFinalModel(FakeStreamModel):
    """Keeps a plan pending, spending the ``max_turns`` budget with tool rounds,
    then returns a tool-free final on the LAST allowed turn — so the gate fires
    right at the boundary and the nudge cannot buy another round.
    """

    def respond(self, request):
        # len(self.requests) is the current 1-based call number (appended first).
        if len(self.requests) < MAX_CHAT_MODEL_TOOL_ROUNDS:
            return ModelResponse(
                assistant_message=None,
                tool_calls=[
                    ModelToolCall(
                        id="p",
                        name="plan.update",
                        arguments={
                            "items": [
                                {"id": "1", "title": "推进任务", "status": "in_progress"}
                            ]
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="就先到这里。", tool_calls=[], finish_reason="stop"
        )


def _orchestrator(fake: FakeStreamModel) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )


def test_plan_gated_run_that_exhausts_turns_suspends_not_loops_forever():
    fake = _BurnThenFinalModel()
    orchestrator = _orchestrator(fake)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="推进一个多步任务。",
    )

    # Nudge rounds count toward max_turns; when the budget runs out mid-nudge the
    # L4a suspend takes over — a resumable pause, NOT an endless nudge loop.
    assert run.status == "awaiting_continue"
    assert run.suspended_messages is not None
    assert any(e.type == "run.suspended" for e in run.audit_events)
    # The gate fired once at the boundary; it never reached fire-exhaustion.
    fired = [e for e in run.audit_events if e.type == "plan.gate.fired"]
    assert len(fired) == 1
    assert not any(e.type == "plan.gate.exhausted" for e in run.audit_events)
