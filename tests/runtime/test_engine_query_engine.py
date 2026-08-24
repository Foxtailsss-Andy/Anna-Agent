"""Tests for the thin QueryEngine assembly (engine layer, T6).

``QueryEngine`` is the platform-engine entry point: it snapshots ``RuntimeSettings``
and injectable ``QueryDeps`` once at construction, then forwards ``AgentLoop``'s
live event stream to any caller (SSE route, test, programmatic driver).

These tests drive ``QueryEngine.run(...)`` with small fakes — the same
``FakeHandler`` / ``FakeStreamModel`` pattern used in ``test_engine_agent_loop``
— and cover:

1. Forwarding (no tools): events flow through unchanged.
2. Outcome exposure: caller-owned ``Outcome`` populated correctly after drain.
3. Tool round forwarded: multi-turn stream with tool events.
4. Default deps wiring: ``production_deps()`` wires the real ``stream_model``.
5. Internal-outcome path: omitting the ``outcome`` arg still works cleanly.
"""
from __future__ import annotations

import asyncio
import warnings

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import Outcome
from services.runtime.app.engine.capability import (
    LoopOutcome,
    ModelChunk,
)
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine, SingleCallResult
from services.runtime.app.engine.streaming_model import stream_model as real_stream_model
from services.runtime.app.model_provider import ModelRequest, ModelToolCall
from tests.support.engine_fakes import BareFakeStreamModel as FakeStreamModel


# --- fakes ------------------------------------------------------------------


class FakeHandler:
    """Scripted ``CapabilityHandler`` matching the style from test_engine_agent_loop."""

    def __init__(self, *, tools=None):
        self.tools = tools if tools is not None else [_TOOL]
        self.dispatched: list[ModelToolCall] = []
        self.final_messages: list[str | None] = []

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(
            messages=[{"role": "user", "content": "hi"}],
            tools=list(self.tools),
        )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        self.dispatched.append(tool_call)
        return {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": tool_call.name,
            "content": "obs",
        }

    def on_assistant_final(self, assistant_message: str | None) -> None:
        self.final_messages.append(assistant_message)


# FakeStreamModel is the shared BareFakeStreamModel (tests/support/engine_fakes):
# scripts only, zero governance side effects — these tests assert pure engine
# forwarding against unconfigured RuntimeSettings.

_TOOL = {"name": "erp.finance.query", "description": "", "input_schema": {"type": "object"}}


# --- driver helpers ---------------------------------------------------------


def _run_engine(engine: QueryEngine, config: QueryConfig, handler: FakeHandler,
                outcome: Outcome | None = None) -> list[dict]:
    """Drain ``QueryEngine.run`` to completion, collecting every event dict."""
    events: list[dict] = []

    async def _drive() -> None:
        async for event in engine.run(
            config,
            handler,
            run_id="run-qe-1",
            audit_events=[],
            outcome=outcome,
        ):
            events.append(event)

    asyncio.run(_drive())
    return events


def _config(**overrides) -> QueryConfig:
    base = {"run_id": "run-qe-1", "skill_id": "skill-qe-1", "tools": [_TOOL]}
    base.update(overrides)
    return QueryConfig(**base)


def _tool_call(**overrides) -> ModelToolCall:
    base = {"id": "c1", "name": "erp.finance.query", "arguments": {"q": 1}}
    base.update(overrides)
    return ModelToolCall(**base)


# --- 1. Forwarding (no tools) -----------------------------------------------


def test_forwarding_no_tools_yields_text_deltas_then_done():
    """QueryEngine forwards text_delta events and the done terminal, in order."""
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="hel"),
                ModelChunk("text_delta", text="lo"),
                ModelChunk("text_delta", text=" world"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )
    outcome = Outcome()

    events = _run_engine(engine, _config(), FakeHandler(), outcome)

    deltas = [e for e in events if e["type"] == "text_delta"]
    assert [e["text"] for e in deltas] == ["hel", "lo", " world"]
    # All deltas before done.
    done_index = next(i for i, e in enumerate(events) if e["type"] == "done")
    assert all(i < done_index for i, e in enumerate(events) if e["type"] == "text_delta")
    assert events[-1] == {"type": "done", "turns": 1}


# --- 2. Outcome exposure ----------------------------------------------------


def test_outcome_populated_after_drain():
    """Caller-owned Outcome holds the structured LoopOutcome after draining."""
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="the answer"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )
    outcome = Outcome()

    _run_engine(engine, _config(), FakeHandler(), outcome)

    assert outcome.value == LoopOutcome(
        status="completed",
        final_message="the answer",
        turns=1,
    )


# --- 3. Tool round forwarded ------------------------------------------------


def test_tool_round_forwarded_events_and_dispatch_called():
    """Multi-turn: tool_start/tool_done events forwarded, dispatch_tool invoked."""
    tc = _tool_call()
    handler = FakeHandler()
    fake_stream = FakeStreamModel(
        [
            # turn 1: text + tool call
            [
                ModelChunk("text_delta", text="thinking..."),
                ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
            ],
            # turn 2: text + stop -> done
            [
                ModelChunk("text_delta", text="final answer"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )
    outcome = Outcome()

    events = _run_engine(engine, _config(), handler, outcome)

    types = [e["type"] for e in events]
    # tool_start and tool_done are present.
    assert "tool_start" in types
    assert "tool_done" in types
    start_i = types.index("tool_start")
    done_i = types.index("tool_done")
    assert start_i < done_i
    assert events[start_i] == {"type": "tool_start", "name": tc.name}
    assert events[done_i] == {"type": "tool_done", "name": tc.name}
    # dispatch_tool was called once with the assembled tool call.
    assert handler.dispatched == [tc]
    # Ends with done at turn 2.
    assert events[-1] == {"type": "done", "turns": 2}
    assert outcome.value.status == "completed"
    assert outcome.value.turns == 2


# --- 4. Default deps wiring -------------------------------------------------


def test_default_deps_wires_real_stream_model():
    """QueryEngine(settings) without deps uses production_deps (real stream_model)."""
    engine = QueryEngine(settings=RuntimeSettings())
    assert engine.deps.stream_model is real_stream_model


# --- 5. Internal-outcome path -----------------------------------------------


def test_no_outcome_arg_still_drains_cleanly():
    """Calling run() without passing outcome= still works — no shared mutable default."""
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="ok"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    # No outcome= kwarg — must not raise or share state across calls.
    events = _run_engine(engine, _config(), FakeHandler(), outcome=None)

    assert events[-1] == {"type": "done", "turns": 1}
    # Second call with a fresh script to confirm no mutable default sharing.
    fake_stream2 = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="also ok"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    engine2 = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream2),
    )
    events2 = _run_engine(engine2, _config(), FakeHandler(), outcome=None)
    assert events2[-1] == {"type": "done", "turns": 1}


# --- 6. run_to_outcome: shared non-streaming drain (R1-T4a extraction) --------


def test_run_to_outcome_drives_to_completed_loop_outcome():
    """run_to_outcome bridges the async engine and returns the terminal outcome.

    The shared non-streaming drain hoisted out of the three orchestrators'
    byte-identical ``_run_engine`` helpers: from a no-running-loop context it
    drives ``run`` to completion and returns the ``LoopOutcome`` — no event
    stream to parse. Audit events still flow into the passed list in place.
    """
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="the answer"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )
    audit_events: list = []

    outcome = engine.run_to_outcome(_config(), FakeHandler(), "run-qe-1", audit_events)

    assert outcome == LoopOutcome(
        status="completed",
        final_message="the answer",
        turns=1,
    )


def test_run_to_outcome_maps_exhaustion():
    """max_turns hit without a final answer surfaces as an ``exhausted`` outcome."""
    tc = _tool_call()
    fake_stream = FakeStreamModel(
        # Always request a tool → never a bare final → exhaust the loop.
        [
            [ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls")]
            for _ in range(3)
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    outcome = engine.run_to_outcome(
        _config(max_turns=2), FakeHandler(), "run-qe-1", []
    )

    assert outcome.status == "exhausted"


def test_run_to_outcome_refuses_inside_running_loop():
    """An async caller must drive ``run`` directly, not bridge via asyncio.run."""
    fake_stream = FakeStreamModel(
        [[ModelChunk("final", finish_reason="stop")]]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    async def _call_from_running_loop() -> None:
        engine.run_to_outcome(_config(), FakeHandler(), "run-qe-1", [])

    raised = False
    try:
        asyncio.run(_call_from_running_loop())
    except RuntimeError:
        raised = True
    assert raised


# --- 7. Run-less terminal vocabulary (R1-T1a extraction pin) ------------------


def test_swallowed_engine_terminals_pins_the_runless_terminal_set():
    """The shared constant matches the engine's run-less terminal vocabulary.

    Domain SSE surfaces swallow exactly these three and re-emit their own
    ``{"type": "done", "run": <run>}``; ``awaiting_approval`` must stay OUT of
    the set — it is the one terminal a domain surface may forward verbatim.
    """
    from services.runtime.app.engine.query_engine import SWALLOWED_ENGINE_TERMINALS

    assert SWALLOWED_ENGINE_TERMINALS == frozenset({"done", "exhausted", "error"})
    assert "awaiting_approval" not in SWALLOWED_ENGINE_TERMINALS
    assert isinstance(SWALLOWED_ENGINE_TERMINALS, frozenset)


# --- 8. run_single_call: single-shot primitive (R1-T5a) ----------------------


def _single_call_request() -> ModelRequest:
    return ModelRequest(
        messages=[{"role": "user", "content": "emit a draft"}],
        tools=[_TOOL],
    )


def test_run_single_call_returns_tool_calls_on_success():
    """A ``final`` chunk carrying an emit tool call surfaces on the result.

    Structured-output domains read ``result.tool_calls`` (as Create reads the
    single ``create.emit_*_draft`` call); ``error_code`` is None on success.
    """
    emit = ModelToolCall(id="call_emit", name="create.emit_skill_draft", arguments={"skill_id": "x"})
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="drafting"),
                ModelChunk("final", tool_calls=(emit,), finish_reason="tool_calls"),
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    result = engine.run_single_call(_single_call_request(), "run-sc-1", [])

    assert isinstance(result, SingleCallResult)
    assert result.error_code is None
    assert result.message is None
    assert result.tool_calls == [emit]
    assert result.assistant_text == "drafting"
    # Exactly one model call — no loop, no re-ask.
    assert len(fake_stream.calls) == 1


def test_run_single_call_text_only_success_has_no_tool_calls():
    """A bare ``final`` with streamed text but no tool calls succeeds cleanly."""
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="just "),
                ModelChunk("text_delta", text="text"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    result = engine.run_single_call(_single_call_request(), "run-sc-1", [])

    assert result.error_code is None
    assert result.tool_calls == []
    assert result.assistant_text == "just text"


def test_run_single_call_maps_error_chunk_and_empties_tool_calls():
    """An ``error`` terminal chunk populates error_code/message; tool_calls empty."""
    fake_stream = FakeStreamModel(
        [
            [
                ModelChunk(
                    "error",
                    error_code="model_not_configured",
                    message="model endpoint and API key are required before running Anna Create",
                )
            ]
        ]
    )
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    result = engine.run_single_call(_single_call_request(), "run-sc-1", [])

    assert result.error_code == "model_not_configured"
    assert result.message == "model endpoint and API key are required before running Anna Create"
    assert result.tool_calls == []
    assert result.assistant_text is None


def test_run_single_call_refuses_inside_running_loop_without_warning():
    """An async caller must drive stream_model directly, not bridge via asyncio.run.

    Mirrors ``run_to_outcome``'s negative test: ``run_async`` raises before
    awaiting, and the never-started coroutine is closed so no
    ``coroutine '_drain' was never awaited`` RuntimeWarning surfaces.
    """
    fake_stream = FakeStreamModel([[ModelChunk("final", finish_reason="stop")]])
    engine = QueryEngine(
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=fake_stream),
    )

    async def _call_from_running_loop() -> None:
        engine.run_single_call(_single_call_request(), "run-sc-1", [])

    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        raised = False
        try:
            asyncio.run(_call_from_running_loop())
        except RuntimeError:
            raised = True
    assert raised
