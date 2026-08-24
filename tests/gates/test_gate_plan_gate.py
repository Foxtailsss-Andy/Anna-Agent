"""J1 · PlanGate smoke gate (eval-first, the RED).

A code-judged gate for the Judgment round, slice J1 (PlanGate): the chat agent
may not end its turn while its OWN plan still has unfinished items — a
deterministic, in-loop守门. It is the executable acceptance criterion the
implementation must turn green — written and committed BEFORE any production
change.

Three deterministic scenarios (fake model, no network), each driven through the
synchronous ``ChatOrchestrator.start_run`` (same fixture shape as
``tests.gates.test_gate_thread_continuity``):

* Scenario A — the gate FIRES: the model builds a 3-item plan (1 done, 2
  pending), then produces a tool-free final while 2 items remain pending. The
  loop must NOT end there — a nudge is injected as a user turn and the model
  gets another round; the fake then completes the items + a final → terminal
  ``ready``; audit carries ``plan.gate.fired {pending_count: 2, fire_index: 1}``.
* Scenario B — honest fall-through: a stubborn model never completes the plan
  and keeps producing tool-free finals. After exactly 2 fires the gate lets it
  through (never an infinite loop): terminal ``ready``, audit carries
  ``plan.gate.exhausted`` and EXACTLY 2 ``plan.gate.fired`` events.
* Scenario C — zero-cost when idle: a run with NO plan produces a single
  tool-free final → single-pass ``ready`` with ZERO ``plan.gate.*`` events.

This gate must stay green in every later slice.
"""
from pathlib import Path

from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)


class _ConnectedErpGateway:
    """A connected ERP gateway so chat preflight passes (plan.update is native)."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused here
        raise AssertionError("this gate never dispatches an ERP tool")


def _text_final(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


def _plan_call(items: list[dict]) -> list[ModelChunk]:
    return [
        ModelChunk(
            "final",
            tool_calls=(
                ModelToolCall(id="call_plan", name="plan.update", arguments={"items": items}),
            ),
            finish_reason="tool_calls",
        )
    ]


def _orchestrator(fake: FakeStreamModel) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )


_PLAN_TWO_PENDING = [
    {"id": "1", "title": "分析上月数据", "status": "done"},
    {"id": "2", "title": "撰写报告", "status": "pending"},
    {"id": "3", "title": "交付用户", "status": "pending"},
]
_PLAN_ALL_DONE = [
    {"id": "1", "title": "分析上月数据", "status": "done"},
    {"id": "2", "title": "撰写报告", "status": "done"},
    {"id": "3", "title": "交付用户", "status": "done"},
]


def test_gate_plan_gate_fires_then_completes_reaches_ready():
    """Scenario A — the gate blocks a premature finish, nudges, and the model finishes."""
    fake = FakeStreamModel(
        [
            _plan_call(_PLAN_TWO_PENDING),
            _text_final("先给你一个初步结论。"),  # 2 pending remain → gate FIRES
            _plan_call(_PLAN_ALL_DONE),  # nudged round completes the plan
            _text_final("三步全部完成,报告已交付。"),  # plan done → passes → ready
        ]
    )
    orchestrator = _orchestrator(fake)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我做上月费用分析并交付报告。",
    )

    # The loop did NOT end at the premature final — the nudge bought another round,
    # so the model was called all four scripted times.
    assert run.status == "ready"
    assert run.assistant_message == "三步全部完成,报告已交付。"
    assert len(fake.requests) == 4

    # The gate fired exactly once, with the pending count and 1-based fire index.
    fired = [e for e in run.audit_events if e.type == "plan.gate.fired"]
    assert len(fired) == 1
    assert fired[0].payload == {"pending_count": 2, "fire_index": 1}
    # It completed honestly, so it never exhausted.
    assert not any(e.type == "plan.gate.exhausted" for e in run.audit_events)

    # The nudge was injected as a user turn the NEXT model call actually saw.
    third_call_users = [
        m.get("content")
        for m in fake.requests[2].messages
        if m.get("role") == "user"
    ]
    assert any("计划中还有未完成项" in (c or "") for c in third_call_users)


def test_gate_plan_gate_stubborn_model_falls_through_after_two_fires():
    """Scenario B — a model that never completes is let through after 2 fires."""
    fake = FakeStreamModel(
        [
            _plan_call(_PLAN_TWO_PENDING),
            _text_final("我觉得可以了。"),  # gate FIRES (fire_index 1)
            _text_final("就先这样吧。"),  # gate FIRES (fire_index 2)
            _text_final("确实先交付这些。"),  # fires exhausted → honest fall-through
        ]
    )
    orchestrator = _orchestrator(fake)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我做上月费用分析并交付报告。",
    )

    # Honest fall-through: the run is allowed to finish rather than loop forever.
    assert run.status == "ready"
    assert run.assistant_message == "确实先交付这些。"

    # Exactly two fires, indices 1 then 2, then a single exhausted event.
    fired = [e for e in run.audit_events if e.type == "plan.gate.fired"]
    assert len(fired) == 2
    assert [e.payload["fire_index"] for e in fired] == [1, 2]
    exhausted = [e for e in run.audit_events if e.type == "plan.gate.exhausted"]
    assert len(exhausted) == 1
    assert exhausted[0].payload == {"pending_count": 2}


def test_gate_plan_gate_is_zero_cost_when_there_is_no_plan():
    """Scenario C — no plan → single-pass ready, zero plan.gate.* events."""
    fake = FakeStreamModel([_text_final("这是对你问题的直接回答。")])
    orchestrator = _orchestrator(fake)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="今天天气怎么样?",
    )

    assert run.status == "ready"
    assert len(fake.requests) == 1  # single pass — no extra nudge round
    assert not any(e.type.startswith("plan.gate") for e in run.audit_events)
