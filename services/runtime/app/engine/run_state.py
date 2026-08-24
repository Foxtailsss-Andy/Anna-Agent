"""Per-iteration loop state for the Anna engine.

Mirrors the immutable state design from the forge-harness reference. Both
dataclasses are frozen; continue sites rewrite the whole state via
``dataclasses.replace(state, ...)`` rather than mutating fields in place.
This discipline makes a future pure-reducer ``step(state, event, config)``
extraction straightforward and keeps every loop turn trivially testable.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Transition:
    """Identifies which path continued the loop at a given turn.

    ``reason`` is the documented extension point for loop-back and future
    recovery transitions (e.g. compaction retry, error recovery). Two reasons
    are produced this round: ``"next_turn"`` (a tool round folded observations
    forward) and ``"guidance_nudge"`` (``on_assistant_final`` returned a
    continuation nudge); additional reasons extend here without touching the
    loop body. This lets tests assert WHICH path continued without inspecting
    message contents.
    """

    reason: str


@dataclass(frozen=True)
class RunState:
    """Immutable snapshot of loop state at a single iteration boundary.

    Iron rule: continue sites MUST rewrite the whole object::

        state = dataclasses.replace(
            state,
            messages=[*state.messages, new_msg],
            turn_count=state.turn_count + 1,
            transition=Transition(reason="next_turn"),
        )

    Never assign to individual fields — ``frozen=True`` enforces this at
    runtime. The replace-based pattern keeps each turn's before/after state
    as distinct objects, which makes the agent loop trivially testable.

    Fields
    ------
    messages:
        OpenAI-style dict messages accumulated so far (Anna's wire format).
    turn_count:
        Number of model turns completed in this run. Compared against
        ``QueryConfig.max_turns`` to enforce the safety valve.
    transition:
        The ``Transition`` that produced this state, or ``None`` for the
        initial state at run start.
    """

    messages: list[dict]
    turn_count: int
    transition: Transition | None
