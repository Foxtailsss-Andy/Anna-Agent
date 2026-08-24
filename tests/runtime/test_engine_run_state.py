"""Tests for services.runtime.app.engine.run_state.

Covers: construction, frozen enforcement, and whole-rewrite semantics via
dataclasses.replace — the iron rule that RunState is never mutated in place.
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError, replace

import pytest

from services.runtime.app.engine.run_state import RunState, Transition


# ---------------------------------------------------------------------------
# Transition
# ---------------------------------------------------------------------------

def test_transition_holds_reason():
    t = Transition(reason="next_turn")
    assert t.reason == "next_turn"


def test_transition_is_frozen():
    t = Transition(reason="next_turn")
    with pytest.raises(FrozenInstanceError):
        t.reason = "other"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# RunState
# ---------------------------------------------------------------------------

def test_run_state_holds_fields():
    msgs = [{"role": "user", "content": "hello"}]
    state = RunState(messages=msgs, turn_count=0, transition=None)
    assert state.messages == msgs
    assert state.turn_count == 0
    assert state.transition is None


def test_run_state_is_frozen():
    state = RunState(messages=[], turn_count=0, transition=None)
    with pytest.raises(FrozenInstanceError):
        state.turn_count = 99  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Whole-rewrite semantics: dataclasses.replace must produce a new instance
# and leave the original untouched — this is the iron rule for continue sites.
# ---------------------------------------------------------------------------

def test_replace_returns_new_instance_with_updated_fields():
    initial_msgs = [{"role": "user", "content": "hi"}]
    state = RunState(messages=initial_msgs, turn_count=0, transition=None)

    extra = {"role": "assistant", "content": "hello"}
    next_transition = Transition(reason="next_turn")
    new_state = replace(
        state,
        messages=[*state.messages, extra],
        turn_count=state.turn_count + 1,
        transition=next_transition,
    )

    # New instance reflects updates.
    assert new_state.turn_count == 1
    assert new_state.transition is next_transition
    assert new_state.transition.reason == "next_turn"
    assert len(new_state.messages) == 2

    # Original is untouched — the iron rule.
    assert state.turn_count == 0
    assert state.transition is None
    assert len(state.messages) == 1


def test_replace_produces_a_different_object():
    state = RunState(messages=[], turn_count=0, transition=None)
    new_state = replace(state, turn_count=1)
    assert new_state is not state
