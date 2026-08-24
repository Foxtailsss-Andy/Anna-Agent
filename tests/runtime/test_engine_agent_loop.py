"""Tests for the streaming agent loop (engine layer, T5).

The loop is an async generator that streams model text token-by-token DURING
the ReAct loop, runs tools between rounds, emits process-event dicts, and writes
the structured terminal ``LoopOutcome`` into a mutable ``Outcome`` holder.

These tests drive ``AgentLoop().run(...)`` with small fakes (no HTTP — that is
T3's concern) and assert all six terminal paths plus the streaming property and
the ``assistant_tool_call_message`` wire format. ``asyncio.run`` drives an async
helper that ``async for``s the generator, collecting every yielded event dict.
"""
from __future__ import annotations

import asyncio
import json

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import (
    AgentLoop,
    Outcome,
    assistant_tool_call_message,
)
from services.runtime.app.engine.capability import (
    CapabilityError,
    CapabilitySuspend,
    LoopOutcome,
    ModelChunk,
)
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelRequest, ModelToolCall
from tests.support.engine_fakes import BareFakeStreamModel as FakeStreamModel


# --- fakes ------------------------------------------------------------------


class FakeHandler:
    """A scripted ``CapabilityHandler`` that records the loop's calls.

    ``build_initial_request`` returns a real ``ModelRequest`` with one user
    message and one tool. ``dispatch_tool`` returns a ``{"role": "tool", ...}``
    observation dict and records the tool calls it received.
    ``on_assistant_final`` records the message and the number of times it fired.
    """

    def __init__(
        self,
        *,
        tools=None,
        dispatch_error: CapabilityError | None = None,
        dispatch_suspend: CapabilitySuspend | None = None,
        nudges: list[str | None] | None = None,
    ):
        self.tools = tools if tools is not None else [_TOOL]
        self._dispatch_error = dispatch_error
        self._dispatch_suspend = dispatch_suspend
        # Scripted return values for on_assistant_final, popped per call. When
        # None (the default), on_assistant_final always returns None — the
        # existing no-nudge behavior the pre-W1 tests rely on.
        self._nudges = list(nudges) if nudges is not None else None
        self.dispatched: list[ModelToolCall] = []
        self.final_messages: list[str | None] = []

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(
            messages=[{"role": "user", "content": "hi"}],
            tools=list(self.tools),
        )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        self.dispatched.append(tool_call)
        if self._dispatch_suspend is not None:
            raise self._dispatch_suspend
        if self._dispatch_error is not None:
            raise self._dispatch_error
        return {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": tool_call.name,
            "content": "obs",
        }

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        self.final_messages.append(assistant_message)
        if self._nudges is not None:
            return self._nudges.pop(0)
        return None


# FakeStreamModel is the shared BareFakeStreamModel (tests/support/engine_fakes):
# scripts only, zero governance side effects — these tests assert pure loop
# mechanics against unconfigured RuntimeSettings.

_TOOL = {"name": "erp.finance.query", "description": "", "input_schema": {"type": "object"}}


# --- drivers ----------------------------------------------------------------


def _run(config, handler, deps, outcome) -> list[dict]:
    """Drive ``AgentLoop().run`` to completion, collecting every event dict."""
    events: list[dict] = []

    async def _drive() -> None:
        async for event in AgentLoop().run(
            config,
            handler,
            deps,
            run_id="run-1",
            audit_events=[],
            settings=RuntimeSettings(),
            outcome=outcome,
        ):
            events.append(event)

    asyncio.run(_drive())
    return events


def _config(**overrides) -> QueryConfig:
    base = {"run_id": "run-1", "skill_id": "skill-1", "tools": [_TOOL]}
    base.update(overrides)
    return QueryConfig(**base)


def _tool_call(**overrides) -> ModelToolCall:
    base = {"id": "c1", "name": "erp.finance.query", "arguments": {"q": 1}}
    base.update(overrides)
    return ModelToolCall(**base)


# --- 1. streaming (CORE) ----------------------------------------------------


def test_streaming_emits_ordered_text_deltas_before_done():
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="hel"),
                    ModelChunk("text_delta", text="lo "),
                    ModelChunk("text_delta", text="world"),
                    ModelChunk("final", finish_reason="stop"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(), FakeHandler(), deps, outcome)

    deltas = [e for e in events if e["type"] == "text_delta"]
    assert [e["text"] for e in deltas] == ["hel", "lo ", "world"]
    # Every delta must appear BEFORE the terminal `done` event (live streaming).
    done_index = next(i for i, e in enumerate(events) if e["type"] == "done")
    delta_indexes = [i for i, e in enumerate(events) if e["type"] == "text_delta"]
    assert delta_indexes == [0, 1, 2]
    assert all(i < done_index for i in delta_indexes)
    # Concatenated deltas reconstruct the full model text.
    assert "".join(e["text"] for e in deltas) == "hello world"


def test_empty_text_delta_is_not_forwarded_as_event():
    # An empty-string delta interleaved with real ones must be dropped: no
    # noise {"type":"text_delta","text":""} event, and it must not pollute the
    # accumulated text. Completion still works normally.
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="real"),
                    ModelChunk("text_delta", text=""),  # noise — must be skipped
                    ModelChunk("text_delta", text="text"),
                    ModelChunk("final", finish_reason="stop"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    deltas = [e for e in events if e["type"] == "text_delta"]
    # Only the two non-empty deltas appear; the "" one is gone.
    assert [e["text"] for e in deltas] == ["real", "text"]
    assert "" not in [e["text"] for e in deltas]
    # The empty delta did not pollute the accumulated final text.
    assert handler.final_messages == ["realtext"]
    assert events[-1] == {"type": "done", "turns": 1}
    assert outcome.value == LoopOutcome(
        status="completed", final_message="realtext", turns=1
    )


# --- 2. completion ----------------------------------------------------------


def test_completion_calls_on_assistant_final_once_and_populates_outcome():
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="all "),
                    ModelChunk("text_delta", text="done"),
                    ModelChunk("final", finish_reason="stop"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    assert handler.final_messages == ["all done"]
    assert events[-1] == {"type": "done", "turns": 1}
    assert outcome.value == LoopOutcome(
        status="completed", final_message="all done", turns=1
    )


def test_completion_with_empty_text_passes_none_to_final():
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel([[ModelChunk("final", finish_reason="stop")]])
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    assert handler.final_messages == [None]
    assert events == [{"type": "done", "turns": 1}]
    assert outcome.value == LoopOutcome(
        status="completed", final_message=None, turns=1
    )


# --- 2b. carry_messages_on_complete (J2 opt-in, default off byte-identical) --


def test_completed_outcome_carries_no_messages_by_default():
    # Default off: a completed outcome leaves ``messages`` None — byte-identical
    # to every pre-J2 surface (the four non-chat surfaces never opt in).
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [[ModelChunk("text_delta", text="done"), ModelChunk("final", finish_reason="stop")]]
        )
    )
    outcome = Outcome()

    _run(_config(), handler, deps, outcome)

    assert outcome.value == LoopOutcome(
        status="completed", final_message="done", turns=1, messages=None
    )
    assert outcome.value.messages is None


def test_completed_outcome_carries_messages_when_opted_in():
    # Opt-in: a completed outcome carries the full conversation snapshot (the
    # SAME shape the suspend path builds) — the initial messages plus the final
    # assistant turn — so an Evaluator continuation can resume the finished run.
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [[ModelChunk("text_delta", text="done"), ModelChunk("final", finish_reason="stop")]]
        )
    )
    outcome = Outcome()

    _run(_config(carry_messages_on_complete=True), handler, deps, outcome)

    assert outcome.value.status == "completed"
    # build_initial_request seeds [{"role":"user","content":"hi"}]; the completed
    # snapshot appends the final assistant turn.
    assert outcome.value.messages == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "done"},
    ]


# --- 3. tool round + multi-turn + state whole-rewrite -----------------------


def test_tool_round_folds_observations_and_advances_turn():
    tc = _tool_call()
    handler = FakeHandler()
    stream = FakeStreamModel(
        [
            # turn 1: text + a tool call
            [
                ModelChunk("text_delta", text="think"),
                ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
            ],
            # turn 2: text + no tool calls -> done
            [
                ModelChunk("text_delta", text="final answer"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    # tool_start / tool_done bracket the dispatch, with the tool name.
    types = [e["type"] for e in events]
    assert "tool_start" in types and "tool_done" in types
    start_i = types.index("tool_start")
    done_i = types.index("tool_done")
    assert start_i < done_i
    assert events[start_i] == {"type": "tool_start", "name": tc.name}
    assert events[done_i] == {"type": "tool_done", "name": tc.name}

    # dispatch_tool called exactly once, with the assembled tool call.
    assert handler.dispatched == [tc]

    # The SECOND stream_model call must have received the spliced history:
    # [initial user msg, assistant tool-call msg, observation dict]. This proves
    # the whole-rewrite via dataclasses.replace folded observations forward.
    assert len(stream.calls) == 2
    second_messages = stream.calls[1].messages
    assert second_messages == [
        {"role": "user", "content": "hi"},
        assistant_tool_call_message("think", [tc]),
        {
            "role": "tool",
            "tool_call_id": tc.id,
            "name": tc.name,
            "content": "obs",
        },
    ]
    # The first call saw only the initial user message (no accumulation yet).
    assert stream.calls[0].messages == [{"role": "user", "content": "hi"}]

    # Ends with done at turn 2; outcome reflects two turns completed.
    assert events[-1] == {"type": "done", "turns": 2}
    assert outcome.value.status == "completed"
    assert outcome.value.turns == 2
    assert outcome.value.final_message == "final answer"


def test_multi_delta_text_accumulates_into_assistant_tool_call_message():
    # A tool turn that streams TWO text deltas before the final-with-tool-call:
    # the spliced assistant message's content must be the concatenation of BOTH
    # deltas — proving multi-delta accumulation feeds assistant_tool_call_message
    # content on the tool path, not only the completion path.
    tc = _tool_call()
    handler = FakeHandler()
    stream = FakeStreamModel(
        [
            # turn 1: two text deltas, then a tool call
            [
                ModelChunk("text_delta", text="part one "),
                ModelChunk("text_delta", text="part two"),
                ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
            ],
            # turn 2: stop
            [ModelChunk("final", finish_reason="stop")],
        ]
    )
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    _run(_config(), handler, deps, outcome)

    assert len(stream.calls) == 2
    spliced_assistant = stream.calls[1].messages[1]
    assert spliced_assistant == assistant_tool_call_message("part one part two", [tc])
    assert spliced_assistant["content"] == "part one part two"


def test_tools_come_from_handler_initial_request_not_config():
    # The handler offers a different tool than the config; the loop must thread
    # the handler's initial-request tools into stream_model (per spec).
    handler_tool = {
        "name": "erp.other.tool",
        "description": "",
        "input_schema": {"type": "object"},
    }
    handler = FakeHandler(tools=[handler_tool])
    stream = FakeStreamModel([[ModelChunk("final", finish_reason="stop")]])
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    _run(_config(tools=[_TOOL]), handler, deps, outcome)

    assert stream.calls[0].tools == [handler_tool]


# --- 4. CapabilityError -----------------------------------------------------


def test_capability_error_terminates_run_as_failed():
    tc = _tool_call()
    handler = FakeHandler(
        dispatch_error=CapabilityError("tool_not_allowed", "nope")
    )
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="x"),
                    ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    # A tool_start fires before the error; no done.
    types = [e["type"] for e in events]
    assert "tool_start" in types
    assert "done" not in types
    assert events[-1] == {
        "type": "error",
        "error_code": "tool_not_allowed",
        "message": "nope",
    }
    assert outcome.value == LoopOutcome(
        status="failed", error_code="tool_not_allowed", message="nope"
    )


# --- 4b. CapabilitySuspend (pause, not failure) -----------------------------


def test_capability_suspend_pauses_run_as_suspended():
    tc = _tool_call()
    handler = FakeHandler(
        dispatch_suspend=CapabilitySuspend(
            "awaiting_approval", detail={"approval_id": "a1"}
        )
    )
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="submitting"),
                    ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    # A tool_start fires before the suspend; the run neither completes nor errors.
    types = [e["type"] for e in events]
    assert "tool_start" in types
    assert "done" not in types
    assert "error" not in types
    # Suspend terminal carries the reason + detail verbatim.
    assert events[-1] == {
        "type": "awaiting_approval",
        "reason": "awaiting_approval",
        "detail": {"approval_id": "a1"},
    }
    assert outcome.value == LoopOutcome(
        status="suspended", turns=1, message="awaiting_approval"
    )


def test_capability_suspend_can_carry_resume_messages_checkpoint():
    tc = _tool_call(
        id="ask_1",
        name="crew.ask_human",
        arguments={"question": "缺少哪一类用户?"},
    )
    handler = FakeHandler(
        tools=[
            {
                "name": "crew.ask_human",
                "description": "",
                "input_schema": {"type": "object"},
            }
        ],
        dispatch_suspend=CapabilitySuspend(
            "awaiting_input",
            detail={
                "tool": "crew.ask_human",
                "tool_call_id": "ask_1",
                "question": "缺少哪一类用户?",
            },
        ),
    )
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="need info"),
                    ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(carry_messages_on_suspend=True), handler, deps, outcome)

    assert events[-1] == {
        "type": "awaiting_input",
        "reason": "awaiting_input",
        "detail": {
            "tool": "crew.ask_human",
            "tool_call_id": "ask_1",
            "question": "缺少哪一类用户?",
        },
    }
    assert outcome.value.status == "suspended"
    assert outcome.value.message == "awaiting_input"
    assert outcome.value.messages == [
        {"role": "user", "content": "hi"},
        assistant_tool_call_message("need info", [tc]),
    ]


# --- 4c. optional on_tool_batch pre-dispatch hook ----------------------------


class BatchAwareHandler(FakeHandler):
    """A ``FakeHandler`` that also implements the optional ``on_tool_batch``
    pre-dispatch hook, recording every batch it sees (and optionally raising)."""

    def __init__(self, *, batch_raise: Exception | None = None, **kwargs):
        super().__init__(**kwargs)
        self._batch_raise = batch_raise
        self.batches: list[list[ModelToolCall]] = []

    def on_tool_batch(self, tool_calls: list[ModelToolCall]) -> None:
        self.batches.append(list(tool_calls))
        if self._batch_raise is not None:
            raise self._batch_raise


def test_on_tool_batch_sees_whole_batch_once_per_round_before_dispatch():
    tc1 = _tool_call(id="c1")
    tc2 = _tool_call(id="c2")
    handler = BatchAwareHandler()
    stream = FakeStreamModel(
        [
            # turn 1: TWO tool calls in one batch
            [ModelChunk("final", tool_calls=(tc1, tc2), finish_reason="tool_calls")],
            # turn 2: stop
            [ModelChunk("final", finish_reason="stop")],
        ]
    )
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    # The hook fired exactly once per tool round, with the FULL batch.
    assert handler.batches == [[tc1, tc2]]
    # Dispatch still ran for both calls, after the hook.
    assert handler.dispatched == [tc1, tc2]
    assert events[-1] == {"type": "done", "turns": 2}
    assert outcome.value.status == "completed"


def test_on_tool_batch_capability_error_fails_run_before_any_dispatch():
    tc1 = _tool_call(id="c1")
    tc2 = _tool_call(id="c2")
    handler = BatchAwareHandler(
        batch_raise=CapabilityError("submit_intent_requires_prior_observation", "mixed")
    )
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [[ModelChunk("final", tool_calls=(tc1, tc2), finish_reason="tool_calls")]]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    # The batch was rejected BEFORE any dispatch: no tool_start, no dispatch calls.
    assert handler.dispatched == []
    assert [e["type"] for e in events] == ["error"]
    assert events[-1] == {
        "type": "error",
        "error_code": "submit_intent_requires_prior_observation",
        "message": "mixed",
    }
    assert outcome.value == LoopOutcome(
        status="failed",
        error_code="submit_intent_requires_prior_observation",
        message="mixed",
    )


def test_on_tool_batch_capability_suspend_pauses_run_before_any_dispatch():
    tc = _tool_call()
    handler = BatchAwareHandler(
        batch_raise=CapabilitySuspend("awaiting_approval", detail={"approval_id": "a9"})
    )
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [[ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls")]]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    assert handler.dispatched == []
    assert [e["type"] for e in events] == ["awaiting_approval"]
    assert events[-1] == {
        "type": "awaiting_approval",
        "reason": "awaiting_approval",
        "detail": {"approval_id": "a9"},
    }
    assert outcome.value == LoopOutcome(
        status="suspended", turns=1, message="awaiting_approval"
    )


# --- 5. max_turns exhausted -------------------------------------------------


def test_max_turns_exhausted_after_tool_round():
    tc = _tool_call()
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk("text_delta", text="want more"),
                    ModelChunk("final", tool_calls=(tc,), finish_reason="tool_calls"),
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(max_turns=1), handler, deps, outcome)

    # Tool round ran, but next_turn(2) > max_turns(1) -> exhausted, no done.
    types = [e["type"] for e in events]
    assert "tool_done" in types
    assert "done" not in types
    assert events[-1] == {"type": "exhausted", "turns": 1}
    assert outcome.value.status == "exhausted"
    assert outcome.value.turns == 1
    # on_assistant_final must NOT fire on exhaustion.
    assert handler.final_messages == []


# --- 5b. on_assistant_final nudge continuation ------------------------------


def test_nudge_continuation_runs_another_turn_then_completes():
    # BOTH turns' finals have NO tool calls. Turn 1's on_assistant_final returns
    # a nudge -> the loop splices a user message and runs turn 2; turn 2 returns
    # None -> the run completes.
    handler = FakeHandler(nudges=["please continue", None])
    stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="first"),
                ModelChunk("final", finish_reason="stop"),
            ],
            [
                ModelChunk("text_delta", text="second"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    # A 2nd turn ran, and its request history carries the spliced nudge as a
    # user message (after the turn-1 assistant message).
    assert len(stream.calls) == 2
    assert stream.calls[1].messages == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "first"},
        {"role": "user", "content": "please continue"},
    ]
    # on_assistant_final fired once per turn, seeing each turn's text.
    assert handler.final_messages == ["first", "second"]
    # Ends normally at turn 2.
    assert events[-1] == {"type": "done", "turns": 2}
    assert outcome.value.status == "completed"
    assert outcome.value.turns == 2
    assert outcome.value.final_message == "second"


def test_nudge_blocked_by_max_turns_yields_exhausted():
    # A no-tool-calls turn-1 final whose handler wants to nudge, but max_turns=1
    # blocks the 2nd turn -> exhausted (no done), and no 2nd stream_model call.
    handler = FakeHandler(nudges=["please continue"])
    stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="answer"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    events = _run(_config(max_turns=1), handler, deps, outcome)

    types = [e["type"] for e in events]
    assert "done" not in types
    assert events[-1] == {"type": "exhausted", "turns": 1}
    assert outcome.value.status == "exhausted"
    assert outcome.value.turns == 1
    # The nudge was consumed (on_assistant_final fired) but no 2nd turn ran.
    assert handler.final_messages == ["answer"]
    assert len(stream.calls) == 1


def test_nudge_blocked_by_max_turns_rides_the_suspended_snapshot():
    # The same boundary, but with the chat surface's ``suspend_on_exhaust``: the
    # nudge ``on_assistant_final`` just produced must NOT be destroyed here. The
    # handler already CONSUMED whatever produced it (an interjection queue is
    # drained exactly-once; a PlanGate fire is already audited), so a nudge
    # dropped at the boundary is a message the user watched be accepted and then
    # never delivered. It rides the resumable snapshot as the trailing user turn,
    # so the resume picks up exactly where the nudge asked to go.
    handler = FakeHandler(nudges=["please continue"])
    stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="answer"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )
    deps = QueryDeps(stream_model=stream)
    outcome = Outcome()

    events = _run(
        _config(max_turns=1, suspend_on_exhaust=True), handler, deps, outcome
    )

    assert events[-1] == {"type": "exhausted", "turns": 1}
    assert outcome.value.status == "exhausted_suspended"
    assert outcome.value.messages == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "answer"},
        {"role": "user", "content": "please continue"},
    ]


# --- 6. stream_model error --------------------------------------------------


def test_stream_model_error_terminates_immediately():
    handler = FakeHandler()
    deps = QueryDeps(
        stream_model=FakeStreamModel(
            [
                [
                    ModelChunk(
                        "error",
                        error_code="model_not_configured",
                        message="model endpoint and API key are required",
                    )
                ]
            ]
        )
    )
    outcome = Outcome()

    events = _run(_config(), handler, deps, outcome)

    assert events == [
        {
            "type": "error",
            "error_code": "model_not_configured",
            "message": "model endpoint and API key are required",
        }
    ]
    # No text_delta, no done; handler.on_assistant_final never fired.
    assert handler.final_messages == []
    assert outcome.value.status == "failed"
    assert outcome.value.error_code == "model_not_configured"
    assert outcome.value.message == "model endpoint and API key are required"


# --- assistant_tool_call_message (wire format) ------------------------------


def test_assistant_tool_call_message_shape():
    tc = ModelToolCall(id="c1", name="erp.finance.query", arguments={"q": 1})

    message = assistant_tool_call_message("some text", [tc])

    assert message == {
        "role": "assistant",
        "content": "some text",
        "tool_calls": [
            {
                "id": "c1",
                "type": "function",
                "function": {
                    "name": "erp.finance.query",
                    "arguments": json.dumps(
                        {"q": 1}, ensure_ascii=False, sort_keys=True
                    ),
                },
            }
        ],
    }


def test_assistant_tool_call_message_empty_text_is_none_content():
    tc = ModelToolCall(id="c1", name="erp.finance.query", arguments={"q": 1})

    message = assistant_tool_call_message("", [tc])

    assert message["content"] is None


def test_assistant_tool_call_message_sorts_keys_and_keeps_unicode():
    # sort_keys=True orders b before z; ensure_ascii=False keeps the unicode char.
    tc = ModelToolCall(
        id="c1", name="t", arguments={"z": 1, "b": "中"}
    )

    message = assistant_tool_call_message("hi", [tc])

    arguments = message["tool_calls"][0]["function"]["arguments"]
    assert arguments == '{"b": "中", "z": 1}'
