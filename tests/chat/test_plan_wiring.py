"""W1.T3 — ``plan.update`` wired through the real chat capability.

Drives ``ChatOrchestrator`` (same fixtures as ``tests.chat.test_chat_agent``)
through the shared fake ``stream_model`` seam: the model requests ``plan.update``
in a tool round, then answers. Asserts the end-to-end wiring:

* success → ``run.plan`` holds the validated full-table replacement, the
  ``plan.updated {count, done_count}`` audit event lands, and the model sees the
  「计划已更新(N 项,M 完成)」 observation;
* invalid input (code-gate violation) → the model gets a tool ERROR observation
  it can retry from, ``run.plan`` is UNCHANGED, and NO ``plan.updated`` event is
  appended — the run still completes ready (the gate never fails the run).

``plan.update`` is a native (non-MCP) tool, so a plain ``ConnectedErpGateway``
that never sees the call is enough — no gateway call is expected.

J1 PlanGate note: since J1, a run may not end while its plan still has
pending/in_progress items (the gate nudges the model instead). These wiring
fixtures therefore model a DISCIPLINED model — it completes its plan (or builds
an already-done table) before answering — so the wiring assertions stay pure
plan.update coverage; the gate's own behavior lives in tests/chat/test_plan_gate
and tests/gates/test_gate_plan_gate.
"""
from __future__ import annotations

import json
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


class ConnectedErpGateway:
    """Connected ERP gateway — plan.update is native, so call_tool never fires."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")
        self.calls = []

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - must not run
        self.calls.append((tool_name, arguments))
        raise AssertionError("plan.update must not reach the ERP connector")


def _engine(stream_model) -> QueryEngine:
    return QueryEngine(
        settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=stream_model)
    )


def _plan_then_answer_stream(items) -> FakeStreamModel:
    return FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_plan",
                            name="plan.update",
                            arguments={"items": items},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
            [
                ModelChunk("text_delta", text="计划已建立,开始执行。"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )


def _orchestrator(*, stream, gateway=None) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=_engine(stream),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )


def _run(orchestrator):
    return orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我分析上月费用并做成网页报告",
        template_id="analyze",
    )


def _tool_observation(stream: FakeStreamModel) -> dict:
    """The plan.update tool observation the model saw on its second turn."""
    second_turn_messages = stream.requests[1].messages
    tool_messages = [m for m in second_turn_messages if m.get("role") == "tool"]
    assert len(tool_messages) == 1
    return json.loads(tool_messages[0]["content"])


# --- success: run.plan replaced, audit event, success observation --------------


def test_plan_update_writes_run_plan_and_audits_count():
    items = [
        {"id": "1", "title": "分析上月费用", "status": "done"},
        {"id": "2", "title": "生成网页报告", "status": "in_progress"},
        {"id": "3", "title": "交付用户", "status": "pending"},
    ]
    # J1 discipline: the model updates the plan to all-done BEFORE answering
    # (an unfinished plan would now draw a PlanGate nudge instead of ready).
    done_items = [dict(item, status="done") for item in items]
    stream = FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_plan_1", name="plan.update", arguments={"items": items}
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_plan_2",
                            name="plan.update",
                            arguments={"items": done_items},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
            [
                ModelChunk("text_delta", text="计划已建立,开始执行。"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    orchestrator = _orchestrator(stream=stream)

    run = _run(orchestrator)

    assert run.status == "ready"
    assert run.assistant_message == "计划已建立,开始执行。"
    # Full-table replacement landed on the run (the LAST table wins).
    assert run.plan == done_items

    # One plan.updated audit event per update with count/done_count AND the
    # normalized items list (W1.T4a: the FE plan rail reads items to render a
    # LIVE checklist — count/done_count alone can't). items mirror run.plan.
    plan_events = [e for e in run.audit_events if e.type == "plan.updated"]
    assert len(plan_events) == 2
    assert plan_events[0].payload == {"count": 3, "done_count": 1, "items": items}
    assert plan_events[1].payload == {"count": 3, "done_count": 3, "items": done_items}

    # Full audit trail: tool rounds carry plan.updated (not mcp.tool.called),
    # and a disciplined model never trips the J1 gate (zero plan.gate.*).
    assert [e.type for e in run.audit_events] == [
        "chat.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "plan.updated",
        "model.call.started",
        "model.call.completed",
        "plan.updated",
        "model.call.started",
        "model.call.completed",
        "chat.response.generated",
    ]

    # The model saw the Chinese success observation (first update: 1 done).
    observation = _tool_observation(stream)
    assert observation["ok"] is True
    assert observation["message"] == "计划已更新（3 项，1 完成）"


def test_plan_update_is_a_native_tool_no_connector_call():
    items = [{"id": "1", "title": "步骤", "status": "done"}]
    gateway = ConnectedErpGateway()
    orchestrator = _orchestrator(stream=_plan_then_answer_stream(items), gateway=gateway)

    run = _run(orchestrator)

    assert run.status == "ready"
    assert gateway.calls == []


def test_plan_update_is_model_visible():
    stream = _plan_then_answer_stream([{"id": "1", "title": "步骤", "status": "done"}])
    orchestrator = _orchestrator(stream=stream)

    _run(orchestrator)

    tools = {t["name"]: t for t in stream.requests[0].tools}
    assert "plan.update" in tools
    assert tools["plan.update"]["description"] == (
        "维护当前任务的执行计划清单。多步任务开始时先建计划；每完成一步立即更新状态。"
    )


# --- invalid input: error observation, run.plan untouched, no audit event -------


def test_invalid_plan_returns_error_observation_and_leaves_run_plan_empty():
    # 21 items violates the ≤20 code gate.
    too_many = [{"id": str(n), "title": f"步骤{n}", "status": "pending"} for n in range(21)]
    stream = _plan_then_answer_stream(too_many)
    orchestrator = _orchestrator(stream=stream)

    run = _run(orchestrator)

    # The gate never fails the run — the model gets an error it can retry from.
    assert run.status == "ready"
    # Run state untouched: no plan written, no plan.updated audit event.
    assert run.plan == []
    assert not any(e.type == "plan.updated" for e in run.audit_events)

    # The model saw a tool ERROR observation (non-empty Chinese message).
    observation = _tool_observation(stream)
    assert observation["ok"] is False
    assert observation["error"]


def test_duplicate_ids_are_rejected_as_error_observation():
    dupes = [
        {"id": "x", "title": "一", "status": "pending"},
        {"id": "x", "title": "二", "status": "done"},
    ]
    stream = _plan_then_answer_stream(dupes)
    orchestrator = _orchestrator(stream=stream)

    run = _run(orchestrator)

    assert run.status == "ready"
    assert run.plan == []
    observation = _tool_observation(stream)
    assert observation["ok"] is False
