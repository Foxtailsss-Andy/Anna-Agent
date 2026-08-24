"""Tests for services.runtime.app.engine.capability.

Covers all four contracts: ModelChunk, LoopOutcome, CapabilityError, and the
CapabilityHandler protocol — including positive and negative isinstance checks.
"""
from __future__ import annotations

import dataclasses
from dataclasses import FrozenInstanceError

import pytest

from services.runtime.app.engine.capability import (
    CapabilityError,
    CapabilityHandler,
    CapabilitySuspend,
    LoopOutcome,
    ModelChunk,
)
from services.runtime.app.model_provider import ModelRequest, ModelToolCall


# ---------------------------------------------------------------------------
# ModelChunk
# ---------------------------------------------------------------------------


def test_model_chunk_text_delta_holds_text():
    chunk = ModelChunk(kind="text_delta", text="hello")
    assert chunk.kind == "text_delta"
    assert chunk.text == "hello"


def test_model_chunk_final_holds_tool_calls_and_finish_reason():
    tc = ModelToolCall(id="call_1", name="some_tool", arguments={"x": 1})
    chunk = ModelChunk(kind="final", tool_calls=(tc,), finish_reason="tool_calls")
    assert chunk.kind == "final"
    assert chunk.tool_calls == (tc,)
    assert chunk.finish_reason == "tool_calls"


def test_model_chunk_error_holds_error_code_and_message():
    chunk = ModelChunk(kind="error", error_code="rate_limited", message="too many requests")
    assert chunk.kind == "error"
    assert chunk.error_code == "rate_limited"
    assert chunk.message == "too many requests"


def test_model_chunk_defaults():
    chunk = ModelChunk(kind="text_delta")
    assert chunk.text == ""
    assert chunk.tool_calls == ()
    assert chunk.finish_reason is None
    assert chunk.error_code is None
    assert chunk.message is None


def test_model_chunk_tool_calls_is_tuple():
    tc = ModelToolCall(id="c1", name="t", arguments={})
    chunk = ModelChunk(kind="final", tool_calls=(tc,))
    assert isinstance(chunk.tool_calls, tuple)


def test_model_chunk_is_frozen():
    chunk = ModelChunk(kind="text_delta", text="hi")
    with pytest.raises(FrozenInstanceError):
        chunk.text = "bye"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# LoopOutcome
# ---------------------------------------------------------------------------


def test_loop_outcome_holds_all_fields():
    outcome = LoopOutcome(
        status="completed",
        final_message="done",
        turns=3,
        error_code=None,
        message=None,
    )
    assert outcome.status == "completed"
    assert outcome.final_message == "done"
    assert outcome.turns == 3
    assert outcome.error_code is None
    assert outcome.message is None


def test_loop_outcome_failed_holds_error_fields():
    outcome = LoopOutcome(
        status="failed",
        error_code="tool_error",
        message="tool dispatch failed",
    )
    assert outcome.status == "failed"
    assert outcome.error_code == "tool_error"
    assert outcome.message == "tool dispatch failed"


def test_loop_outcome_defaults():
    outcome = LoopOutcome(status="exhausted")
    assert outcome.final_message is None
    assert outcome.turns == 0
    assert outcome.error_code is None
    assert outcome.message is None


def test_loop_outcome_is_frozen():
    outcome = LoopOutcome(status="completed")
    with pytest.raises(FrozenInstanceError):
        outcome.status = "failed"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# CapabilityError
# ---------------------------------------------------------------------------


def test_capability_error_is_exception():
    err = CapabilityError("some_code", "something went wrong")
    assert isinstance(err, Exception)


def test_capability_error_carries_error_code_and_message():
    err = CapabilityError("governance_denied", "action not permitted")
    assert err.error_code == "governance_denied"
    assert err.message == "action not permitted"


def test_capability_error_str_is_message():
    err = CapabilityError("mcp_failure", "upstream mcp failed")
    assert str(err) == "upstream mcp failed"


def test_capability_error_can_be_raised_and_caught():
    with pytest.raises(CapabilityError) as exc_info:
        raise CapabilityError("test_code", "test message")
    caught = exc_info.value
    assert caught.error_code == "test_code"
    assert caught.message == "test message"


# ---------------------------------------------------------------------------
# CapabilitySuspend — a non-error pause signal, distinct from CapabilityError
# ---------------------------------------------------------------------------


def test_capability_suspend_is_exception():
    assert isinstance(CapabilitySuspend(), Exception)


def test_capability_suspend_default_reason_and_detail():
    suspend = CapabilitySuspend()
    assert suspend.reason == "awaiting_approval"
    assert suspend.detail is None


def test_capability_suspend_carries_reason_and_detail():
    suspend = CapabilitySuspend("need_signoff", detail={"approval_id": "a1"})
    assert suspend.reason == "need_signoff"
    assert suspend.detail == {"approval_id": "a1"}


def test_capability_suspend_str_is_reason():
    suspend = CapabilitySuspend("awaiting_approval")
    assert str(suspend) == "awaiting_approval"


def test_capability_suspend_is_not_capability_error():
    # A pause is NOT a failure — the loop must be able to distinguish them.
    assert not isinstance(CapabilitySuspend(), CapabilityError)


def test_capability_suspend_can_be_raised_and_caught():
    with pytest.raises(CapabilitySuspend) as exc_info:
        raise CapabilitySuspend("awaiting_approval", detail={"approval_id": "a1"})
    caught = exc_info.value
    assert caught.reason == "awaiting_approval"
    assert caught.detail == {"approval_id": "a1"}


# ---------------------------------------------------------------------------
# CapabilityHandler protocol — positive and negative isinstance checks
# ---------------------------------------------------------------------------


class _FakeHandler:
    """Minimal conforming handler implementation for protocol tests."""

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(
            messages=[{"role": "user", "content": "hi"}],
            tools=[],
        )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        return {"role": "tool", "tool_call_id": tool_call.id, "content": "ok"}

    def on_assistant_final(self, assistant_message: str | None) -> None:
        return None


class _MissingDispatch:
    """Handler missing dispatch_tool — must NOT satisfy the protocol."""

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(messages=[], tools=[])

    def on_assistant_final(self, assistant_message: str | None) -> None:
        return None


class _NudgingHandler:
    """Conforming handler whose on_assistant_final returns a str (a nudge)."""

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        return {"role": "tool", "tool_call_id": tool_call.id, "content": "ok"}

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        return "please continue"


def test_conforming_handler_isinstance():
    handler = _FakeHandler()
    assert isinstance(handler, CapabilityHandler)


def test_bare_object_not_isinstance():
    assert not isinstance(object(), CapabilityHandler)


def test_missing_method_not_isinstance():
    assert not isinstance(_MissingDispatch(), CapabilityHandler)


def test_nudging_handler_returning_str_still_isinstance():
    # on_assistant_final may now return str | None; a str-returning handler must
    # still satisfy the protocol (Protocol checks method presence, not return type).
    assert isinstance(_NudgingHandler(), CapabilityHandler)
