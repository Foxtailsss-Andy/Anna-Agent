"""Streaming agent loop — the heart of the Anna engine (T5).

One ``while True`` async generator implementing the ReAct cycle: stream the
model's text token-by-token DURING the loop, run any requested tools between
rounds, splice the assistant tool-call message + tool observations back into the
history, and ask the model again — until the model stops calling tools.

The loop is model-agnostic and business-agnostic: all domain knowledge lives in
the injected ``CapabilityHandler`` (system prompt + tools via
``build_initial_request``, tool routing via ``dispatch_tool``, wrap-up via
``on_assistant_final``). The streaming model call (compaction + audit + SSE) is
injected via ``QueryDeps.stream_model`` so tests drive the loop with a fake.

Structure follows the forge-harness reference (``02-agent-loop.md``):

* An async generator can't ``return`` a value, so the structured terminal
  ``LoopOutcome`` is delivered through a small mutable ``Outcome`` holder the
  caller passes in and reads after the stream drains.
* Loop state lives in the frozen ``RunState`` (T1); each loop-back site rewrites
  it wholesale via ``dataclasses.replace`` rather than mutating fields, tagging
  the ``Transition`` with the reason it continued for. Two reasons are produced
  this round: ``"next_turn"`` (a tool round folded observations forward) and
  ``"guidance_nudge"`` (``on_assistant_final`` returned a continuation nudge).
  Andy's recovery ladder / token budget remain out of scope.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import replace

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import (
    CapabilityError,
    CapabilityHandler,
    CapabilitySuspend,
    LoopOutcome,
    SUSPEND_REASON_AWAITING_INPUT,
    StepEvent,
)
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.run_state import RunState, Transition
from services.runtime.app.model_provider import ModelRequest, ModelToolCall


class Outcome:
    """Mutable holder for the loop's structured terminal ``LoopOutcome``.

    An async generator cannot ``return`` a value, so the caller passes an
    ``Outcome`` into ``AgentLoop.run`` and reads ``outcome.value`` after draining
    the event stream. ``run`` populates ``value`` before every terminal
    ``return``, so a fully-drained stream always leaves a non-``None`` outcome.
    """

    def __init__(self) -> None:
        self.value: LoopOutcome | None = None


def assistant_tool_call_message(
    assistant_text: str | None,
    tool_calls: list[ModelToolCall],
) -> dict:
    """Build the OpenAI-dict assistant message carrying the model's tool calls.

    Mirrors ``mcp_dispatcher.assistant_tool_call_message``'s wire format exactly
    (byte-identical ``json.dumps`` of arguments with ``ensure_ascii=False,
    sort_keys=True``), but takes the accumulated streamed ``assistant_text`` and
    the assembled ``ModelToolCall``s directly instead of a ``ModelResponse`` —
    the streaming loop never materializes a ``ModelResponse``. Empty text folds
    to ``None`` content (no empty-string assistant turns on the wire).
    """
    return {
        "role": "assistant",
        "content": assistant_text or None,
        "tool_calls": [
            {
                "id": tool_call.id,
                "type": "function",
                "function": {
                    "name": tool_call.name,
                    "arguments": json.dumps(
                        tool_call.arguments,
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                },
            }
            for tool_call in tool_calls
        ],
    }


def _exhausted_outcome(
    config: QueryConfig,
    turn_count: int,
    suspended_messages: list[dict],
) -> LoopOutcome:
    """The terminal outcome when the loop hits ``max_turns`` (L4a).

    Default (``suspend_on_exhaust`` False): a terminal ``exhausted`` failure —
    byte-identical to the pre-L4a behavior, so the four surfaces that don't opt
    in are unaffected. Opt-in: a RESUMABLE ``exhausted_suspended`` carrying the
    CURRENT messages (the loop owns them) so the caller can persist + resume with
    a fresh budget. Both cases still yield the same ``{"type": "exhausted"}`` live
    event (swallowed by every surface's terminal mapping); the resumability is
    read off the outcome, not the event — so the frame contract is unchanged.
    """
    if config.suspend_on_exhaust:
        return LoopOutcome(
            status="exhausted_suspended",
            turns=turn_count,
            message="max_turns",
            messages=suspended_messages,
        )
    return LoopOutcome(status="exhausted", turns=turn_count)


class AgentLoop:
    """The streaming ReAct loop. See module docstring for the design."""

    async def run(
        self,
        config: QueryConfig,
        handler: CapabilityHandler,
        deps: QueryDeps,
        run_id: str,
        audit_events: list,
        settings: RuntimeSettings,
        outcome: Outcome,
    ) -> AsyncIterator[dict]:
        """Drive the ReAct loop, yielding live process-event dicts.

        Yields, in order: ``{"type": "text_delta", "text": ...}`` per streamed
        token; ``{"type": "tool_start"/"tool_done", "name": ...}`` around each
        tool dispatch; ``{"type": "step", ...}`` authoritative process markers
        (``analyze`` before each model call, ``tool`` before each dispatch,
        ``deliver`` before the final answer) — but ONLY when the handler opts in
        by defining ``humanize_step`` (else zero step frames, keeping every other
        surface unaffected); and exactly one terminal event — ``done`` (normal stop),
        ``exhausted`` (hit ``max_turns``), ``error`` (stream failure or
        ``CapabilityError``), or ``awaiting_approval`` (a handler raised
        ``CapabilitySuspend`` to pause the run). Before each terminal ``return``
        it writes the matching ``LoopOutcome`` into ``outcome.value``.

        ``settings`` is threaded explicitly (not on ``QueryConfig``) and passed
        straight through to ``deps.stream_model``.
        """
        request = handler.build_initial_request()
        state = RunState(
            messages=list(request.messages),
            turn_count=1,
            transition=None,
        )
        # Tools come from the handler's initial request, per spec — the loop is
        # business-agnostic and does not read tools off the config.
        tools = request.tools

        # Optional step-observability hook (W1.T2). A handler that defines
        # ``humanize_step`` OPTS IN to authoritative ``{"type": "step"}`` frames;
        # a handler without it produces none (the ``getattr`` opt-in mirrors
        # ``on_tool_batch``). Resolved ONCE per run. ``_step_frame`` is only
        # called when ``handler_humanize`` is not None, so the intent is always a
        # real, code-generated label (ADR-002 — never model prose).
        handler_humanize = getattr(handler, "humanize_step", None)

        # Optional mid-run steering hook (J3). A handler that defines
        # ``drain_interjections`` OPTS IN to letting the user speak to a run that
        # is already running; a handler without it is untouched (the ``getattr``
        # opt-in mirrors ``on_tool_batch`` / ``humanize_step``). Resolved ONCE per
        # run. Drained at the TOP of every turn — before the model call — so what
        # the user said reaches the model at the earliest possible moment.
        handler_drain = getattr(handler, "drain_interjections", None)

        def _step_frame(phase: str, tool_call: ModelToolCall | None, turn: int) -> dict:
            return StepEvent(
                phase=phase,
                intent=handler_humanize(phase, tool_call),
                tool=tool_call.name if tool_call is not None else None,
                turn=turn,
            ).as_frame()

        while True:
            # STEER: anything the user said since the last turn enters here, each
            # as its own ``user`` message — NOT folded into a tool observation.
            # Compaction and journal replay must be able to treat an interjection
            # as the genuine user turn it is. Whole-rewrite discipline (never
            # mutate ``state``); an empty drain leaves ``state`` untouched, so a
            # run nobody steers is byte-identical to the pre-J3 loop.
            if handler_drain is not None:
                interjections = handler_drain()
                if interjections:
                    state = replace(
                        state,
                        messages=[
                            *state.messages,
                            *(
                                {"role": "user", "content": text}
                                for text in interjections
                            ),
                        ],
                    )
            # ANALYZE: before every model call (a fresh turn OR a nudge re-ask).
            if handler_humanize is not None:
                yield _step_frame("analyze", None, state.turn_count)
            assistant_text = ""
            tool_calls: list[ModelToolCall] = []
            async for chunk in deps.stream_model(
                run_id,
                audit_events,
                ModelRequest(messages=state.messages, tools=tools),
                settings=settings,
                config_error_message=config.config_error_message,
            ):
                if chunk.kind == "text_delta":
                    # Skip empty deltas: accumulating "" is a no-op, and an empty
                    # text_delta event is pure noise. T3 never emits empties today,
                    # but the loop stays self-consistent regardless of producer.
                    if chunk.text:
                        assistant_text += chunk.text
                        # Live per-token streaming DURING the loop.
                        yield {"type": "text_delta", "text": chunk.text}
                elif chunk.kind == "error":
                    outcome.value = LoopOutcome(
                        status="failed",
                        error_code=chunk.error_code,
                        message=chunk.message,
                    )
                    yield {
                        "type": "error",
                        "error_code": chunk.error_code,
                        "message": chunk.message,
                    }
                    return
                elif chunk.kind == "final":
                    tool_calls = list(chunk.tool_calls)

            if not tool_calls:
                # Model stopped requesting tools. The handler may either end the
                # run (return None) or hand back a continuation nudge (a str).
                nudge = handler.on_assistant_final(assistant_text or None)
                if nudge is None:
                    # DELIVER: the model produced its final answer (no more tools,
                    # no nudge) — emit before the terminal that closes the run.
                    if handler_humanize is not None:
                        yield _step_frame("deliver", None, state.turn_count)
                    # J2 opt-in: a completed outcome may carry the final messages
                    # (the same snapshot the suspend path builds) so the caller can
                    # RESUME the finished conversation for an Evaluator补办 round.
                    # Default off -> messages None -> byte-identical for every
                    # non-opted-in surface.
                    completed_messages = (
                        [
                            *state.messages,
                            {"role": "assistant", "content": assistant_text or None},
                        ]
                        if config.carry_messages_on_complete
                        else None
                    )
                    outcome.value = LoopOutcome(
                        status="completed",
                        final_message=assistant_text or None,
                        turns=state.turn_count,
                        messages=completed_messages,
                    )
                    yield {"type": "done", "turns": state.turn_count}
                    return
                # A nudge wants another turn — but the safety valve still applies.
                next_turn = state.turn_count + 1
                if config.max_turns and next_turn > config.max_turns:
                    # The turn budget is spent, so the nudge cannot be honored
                    # NOW — but it must not be destroyed either. ``handler.
                    # on_assistant_final`` has already CONSUMED whatever produced
                    # it (a J3 interjection queue drains exactly-once; a J1
                    # PlanGate fire is already counted and audited), so dropping
                    # the nudge here is a silent loss: the user watched their
                    # message be accepted and nobody will ever deliver it. Splice
                    # it into the suspended snapshot as the trailing user turn —
                    # the SAME shape the continue site builds — so the resume
                    # picks up exactly where the nudge asked to go.
                    outcome.value = _exhausted_outcome(
                        config,
                        state.turn_count,
                        [
                            *state.messages,
                            {"role": "assistant", "content": assistant_text or None},
                            {"role": "user", "content": nudge},
                        ],
                    )
                    yield {"type": "exhausted", "turns": state.turn_count}
                    return
                # Whole-rewrite continue site — splice the assistant message plus
                # the nudge as a user turn, then re-ask the model.
                state = replace(
                    state,
                    messages=[
                        *state.messages,
                        {"role": "assistant", "content": assistant_text or None},
                        {"role": "user", "content": nudge},
                    ],
                    turn_count=next_turn,
                    transition=Transition(reason="guidance_nudge"),
                )
                continue

            try:
                # Optional pre-dispatch hook: a handler that defines
                # ``on_tool_batch(tool_calls)`` sees the WHOLE per-round batch
                # once, BEFORE any per-call dispatch (the loop otherwise
                # dispatches one call at a time, so a handler could never
                # enforce batch-level rules such as "this tool must not be
                # combined with others"). A raise here is handled exactly like
                # a raise from ``dispatch_tool``: ``CapabilitySuspend`` pauses
                # the run, ``CapabilityError`` fails it — with no ``tool_start``
                # emitted and no tool dispatched. Handlers without the hook are
                # untouched (the default path is unchanged).
                on_tool_batch = getattr(handler, "on_tool_batch", None)
                observations: list[dict] = []
                if on_tool_batch is not None:
                    on_tool_batch(list(tool_calls))
                for tool_call in tool_calls:
                    # TOOL: before dispatching THIS call (after any batch hook).
                    if handler_humanize is not None:
                        yield _step_frame("tool", tool_call, state.turn_count)
                    yield {"type": "tool_start", "name": tool_call.name}
                    observations.append(handler.dispatch_tool(tool_call))
                    yield {"type": "tool_done", "name": tool_call.name}
            except CapabilitySuspend as suspend:
                # A pause, not a failure: the run is healthy but awaits external
                # input. (tool_start for the suspending call was already
                # yielded, unless the suspend came from the batch hook, which
                # precedes any tool_start.)
                suspended_messages = (
                    [
                        *state.messages,
                        assistant_tool_call_message(assistant_text, tool_calls),
                        *observations,
                    ]
                    if config.carry_messages_on_suspend
                    else None
                )
                outcome.value = LoopOutcome(
                    status="suspended",
                    turns=state.turn_count,
                    message=suspend.reason,
                    messages=suspended_messages,
                )
                yield {
                    "type": (
                        "awaiting_input"
                        if suspend.reason == SUSPEND_REASON_AWAITING_INPUT
                        else "awaiting_approval"
                    ),
                    "reason": suspend.reason,
                    "detail": suspend.detail,
                }
                return
            except CapabilityError as exc:
                outcome.value = LoopOutcome(
                    status="failed",
                    error_code=exc.error_code,
                    message=exc.message,
                )
                yield {
                    "type": "error",
                    "error_code": exc.error_code,
                    "message": exc.message,
                }
                return

            next_turn = state.turn_count + 1
            if config.max_turns and next_turn > config.max_turns:
                # Suspend (opt-in) resumes from the messages WITH this completed
                # tool round folded in, so no dispatched work is lost on resume.
                outcome.value = _exhausted_outcome(
                    config,
                    state.turn_count,
                    [
                        *state.messages,
                        assistant_tool_call_message(assistant_text, tool_calls),
                        *observations,
                    ],
                )
                yield {"type": "exhausted", "turns": state.turn_count}
                return

            # Whole-rewrite continue site — never mutate fields. Splice the
            # assistant tool-call message + this turn's observations forward.
            state = replace(
                state,
                messages=[
                    *state.messages,
                    assistant_tool_call_message(assistant_text, tool_calls),
                    *observations,
                ],
                turn_count=next_turn,
                transition=Transition(reason="next_turn"),
            )
