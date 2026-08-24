"""W1.T2 — the engine emits AUTHORITATIVE ``step`` process events.

The streaming agent loop now emits a ``{"type": "step", ...}`` frame at three
authoritative moments — BEFORE each model call (``analyze``), BEFORE each tool
dispatch (``tool``), and BEFORE the final answer (``deliver``) — so a surface no
longer has to GUESS "what is the agent doing now" from other frame types. The
frame's ``intent`` is a code-generated label from the handler's optional
``humanize_step`` hook (never model prose — ADR-002).

Emission is GATED on the handler defining ``humanize_step`` (the same
``getattr`` opt-in pattern as ``on_tool_batch``): a handler WITHOUT the hook
produces ZERO step frames, so the four non-chat surfaces — whose handlers do not
implement it — and every pre-W1 test stay byte-for-byte unaffected (the domain
orchestrators forward every non-swallowed engine event as-is, so a produced step
would leak into their SSE — gating keeps them from being produced at all).
"""
from __future__ import annotations

import asyncio

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import AgentLoop, Outcome
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelRequest, ModelToolCall
from tests.support.engine_fakes import BareFakeStreamModel as FakeStreamModel


_TOOL = {"name": "erp.finance.query", "description": "", "input_schema": {"type": "object"}}


class StepAwareHandler:
    """A minimal handler that OPTS IN to step frames via ``humanize_step``.

    ``humanize_step`` returns deterministic, greppable labels so the test can
    assert the exact ``intent`` the loop stamped on each phase.
    """

    def __init__(self):
        self.dispatched: list[ModelToolCall] = []
        self.final_messages: list[str | None] = []

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[_TOOL])

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        self.dispatched.append(tool_call)
        return {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": tool_call.name,
            "content": "obs",
        }

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        self.final_messages.append(assistant_message)
        return None

    def humanize_step(self, phase: str, tool_call: ModelToolCall | None = None) -> str:
        if phase == "tool" and tool_call is not None:
            return f"tool:{tool_call.name}"
        return f"phase:{phase}"


class NoHookHandler:
    """The same three protocol methods, but WITHOUT the ``humanize_step`` hook."""

    def __init__(self):
        self.final_messages: list[str | None] = []

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[_TOOL])

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        return {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": tool_call.name,
            "content": "obs",
        }

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        self.final_messages.append(assistant_message)
        return None


def _run(handler, stream):
    events: list[dict] = []
    outcome = Outcome()

    async def _drive() -> None:
        async for event in AgentLoop().run(
            QueryConfig(run_id="run-1", skill_id="s", tools=[_TOOL]),
            handler,
            QueryDeps(stream_model=stream),
            run_id="run-1",
            audit_events=[],
            settings=RuntimeSettings(),
            outcome=outcome,
        ):
            events.append(event)

    asyncio.run(_drive())
    return events, outcome


def _two_turn_stream():
    """Turn 1 streams text then requests a tool; turn 2 streams the final answer."""
    tc = ModelToolCall(id="c1", name="erp.finance.query", arguments={"q": 1})
    stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="think"),
                ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
            ],
            [
                ModelChunk("text_delta", text="answer"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    return tc, stream


# --- 1. authoritative step sequence (CORE) ----------------------------------


def test_engine_emits_step_frames_in_authoritative_order():
    handler = StepAwareHandler()
    tc, stream = _two_turn_stream()

    events, outcome = _run(handler, stream)

    # The step SUBSEQUENCE across the 2 turns: analyze(1) -> tool(1) ->
    # analyze(2) -> deliver(2), each carrying humanize_step's intent verbatim.
    steps = [
        (e["phase"], e["turn"], e["tool"], e["intent"])
        for e in events
        if e["type"] == "step"
    ]
    assert steps == [
        ("analyze", 1, None, "phase:analyze"),
        ("tool", 1, "erp.finance.query", "tool:erp.finance.query"),
        ("analyze", 2, None, "phase:analyze"),
        ("deliver", 2, None, "phase:deliver"),
    ]

    # Placement is authoritative: the tool step precedes its own tool_start, and
    # the deliver step precedes the terminal done.
    types = [e["type"] for e in events]
    tool_step_i = next(
        i for i, e in enumerate(events) if e["type"] == "step" and e["phase"] == "tool"
    )
    assert tool_step_i < types.index("tool_start")
    deliver_i = next(
        i for i, e in enumerate(events) if e["type"] == "step" and e["phase"] == "deliver"
    )
    assert deliver_i < types.index("done")

    # Steps are purely additive — the run still completes normally.
    assert handler.dispatched == [tc]
    assert outcome.value.status == "completed"
    assert outcome.value.turns == 2


# --- 2. gating: no hook -> no step frames -----------------------------------


def test_handler_without_humanize_step_emits_no_step_frames():
    handler = NoHookHandler()
    _tc, stream = _two_turn_stream()

    events, outcome = _run(handler, stream)

    # A handler that does not opt in produces ZERO step frames — this is what
    # keeps the four non-chat surfaces (and every pre-W1 test) unaffected.
    assert [e for e in events if e["type"] == "step"] == []
    # Everything else is unchanged: the run completes exactly as before.
    assert events[-1]["type"] == "done"
    assert outcome.value.status == "completed"


# --- 3. StepEvent contract + protocol-level default label -------------------


def test_step_event_serializes_to_the_wire_frame():
    from services.runtime.app.engine.capability import StepEvent

    frame = StepEvent(
        phase="tool", intent="正在查询 ERP 财务数据", tool="erp.finance.query", turn=1
    ).as_frame()

    assert frame == {
        "type": "step",
        "phase": "tool",
        "intent": "正在查询 ERP 财务数据",
        "tool": "erp.finance.query",
        "turn": 1,
    }


def test_default_humanize_step_returns_sensible_chinese_labels():
    from services.runtime.app.engine.capability import default_humanize_step

    assert default_humanize_step("analyze") == "正在思考"
    assert default_humanize_step("deliver") == "正在组织回答"
    assert default_humanize_step("compact") == "正在压缩上下文"
    tc = ModelToolCall(id="c1", name="erp.finance.query", arguments={})
    assert default_humanize_step("tool", tc) == "正在调用 erp.finance.query"
