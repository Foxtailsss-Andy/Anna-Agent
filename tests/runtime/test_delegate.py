"""B2 · run_subagent — one-shot, isolated, read-only sub-agent runner (RED).

The engine-layer delegate primitive (``services/runtime/app/engine/delegate.py``)
drives a FRESH ``QueryEngine`` + handler to a terminal outcome, completely
isolated from any parent conversation (WorkBuddy 模式1: only the ``prompt``
crosses in), and maps the engine's terminal ``LoopOutcome`` onto a small
``SubagentResult``. Written BEFORE the implementation it must turn green.

Covers the four contract properties:

* three terminal states — completed / exhausted / (model error or handler
  exception) → failed;
* isolation — the factory receives ONLY the prompt, and the child model request
  carries no parent history;
* readonly — v1 forces ``permission_mode="readonly"`` (a non-readonly mode
  raises BEFORE any handler is built or model call spent);
* summary truncation — a > 2000-char final answer is truncated + marked.
"""
from __future__ import annotations

import pytest

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.delegate import (
    SUBAGENT_SUMMARY_MAX_CHARS,
    SubagentResult,
    run_subagent,
)
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelResponse,
    ModelToolCall,
)
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)
_UNCONFIGURED = RuntimeSettings()


class _RecordingHandler:
    """Minimal read-only handler that bakes in ONLY the prompt (isolation probe).

    Implements the three-method ``CapabilityHandler`` protocol (plus nothing
    else): a system line + the prompt as the sole user turn, an empty toolset,
    and ``on_assistant_final`` returning ``None`` (the engine's final text is the
    deliverable).
    """

    def __init__(self, prompt: str, *, tools: list[dict] | None = None) -> None:
        self.prompt = prompt
        self._tools = list(tools or [])

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(
            messages=[
                {"role": "system", "content": "you are a read-only assistant"},
                {"role": "user", "content": self.prompt},
            ],
            tools=self._tools,
        )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        return {"role": "tool", "tool_call_id": tool_call.id, "content": "observed"}

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        return None


class _ToolHandler(_RecordingHandler):
    """A read-only handler offering a single no-op tool (exhaustion probe)."""

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(
            messages=[{"role": "user", "content": self.prompt}],
            tools=[
                {
                    "name": "noop",
                    "description": "no-op read tool",
                    "input_schema": {"type": "object", "properties": {}},
                }
            ],
        )


class _AlwaysToolModel(FakeStreamModel):
    """Governed fake that ALWAYS calls ``noop`` — the loop can never finish."""

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=None,
            tool_calls=[ModelToolCall(id="c", name="noop", arguments={})],
            finish_reason="tool_calls",
        )


class _TextModel(FakeStreamModel):
    """Governed fake returning a fixed final answer with no tool calls."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text, tool_calls=[], finish_reason="stop"
        )


def _recording_factory(sink: list[_RecordingHandler]):
    def factory(prompt: str) -> _RecordingHandler:
        handler = _RecordingHandler(prompt)
        sink.append(handler)
        return handler

    return factory


def test_completed_maps_engine_final_to_summary():
    fake = _TextModel("交付物内容")
    result = run_subagent(
        handler_factory=lambda prompt: _RecordingHandler(prompt),
        prompt="起草 PRD",
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=fake),
    )
    assert isinstance(result, SubagentResult)
    assert result.status == "completed"
    assert result.summary == "交付物内容"
    assert result.turns_used == 1
    # The engine's live process frames are captured for the parent's trace.
    assert any(frame.get("type") == "done" for frame in result.audit_events)


def test_isolation_only_prompt_crosses_into_the_child():
    sink: list[_RecordingHandler] = []
    fake = _TextModel("ok")
    run_subagent(
        handler_factory=_recording_factory(sink),
        prompt="唯一提示词",
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=fake),
    )
    # The factory was handed EXACTLY the prompt and nothing else (no parent turns).
    assert len(sink) == 1
    assert sink[0].prompt == "唯一提示词"
    # The child model request carries only the prompt-derived turns — no assistant
    # history, no parent user messages beyond the prompt.
    request = fake.requests[0]
    user_messages = [m for m in request.messages if m["role"] == "user"]
    assert user_messages == [{"role": "user", "content": "唯一提示词"}]
    assert all(m["role"] in ("system", "user") for m in request.messages)


def test_readonly_is_forced_in_v1():
    sink: list[_RecordingHandler] = []
    fake = _TextModel("never reached")
    with pytest.raises(ValueError):
        run_subagent(
            handler_factory=_recording_factory(sink),
            prompt="x",
            settings=_CONFIGURED,
            deps=QueryDeps(stream_model=fake),
            permission_mode="write",
        )
    # A non-readonly request is refused BEFORE building a handler or spending a call.
    assert sink == []
    assert fake.requests == []


def test_default_permission_mode_is_readonly():
    # Omitting permission_mode runs cleanly (the default IS readonly).
    result = run_subagent(
        handler_factory=lambda prompt: _RecordingHandler(prompt),
        prompt="x",
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=_TextModel("done")),
    )
    assert result.status == "completed"


def test_exhausted_when_model_never_stops_calling_tools():
    result = run_subagent(
        handler_factory=lambda prompt: _ToolHandler(prompt),
        prompt="loop forever",
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=_AlwaysToolModel()),
        max_turns=2,
    )
    assert result.status == "exhausted"
    assert result.turns_used == 2


def test_failed_on_model_error():
    result = run_subagent(
        handler_factory=lambda prompt: _RecordingHandler(prompt),
        prompt="x",
        settings=_UNCONFIGURED,  # no endpoint/key -> model_not_configured error chunk
        deps=QueryDeps(stream_model=_TextModel("unused")),
    )
    assert result.status == "failed"
    assert result.summary  # carries the model error message
    assert result.error_code is not None


def test_failed_on_handler_exception():
    class _BoomHandler(_RecordingHandler):
        def build_initial_request(self) -> ModelRequest:
            raise RuntimeError("boom in build_initial_request")

    result = run_subagent(
        handler_factory=lambda prompt: _BoomHandler(prompt),
        prompt="x",
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=_TextModel("unused")),
    )
    assert result.status == "failed"
    assert "boom" in result.summary


def test_summary_is_truncated_and_marked_when_over_limit():
    long_text = "字" * (SUBAGENT_SUMMARY_MAX_CHARS + 500)
    result = run_subagent(
        handler_factory=lambda prompt: _RecordingHandler(prompt),
        prompt="x",
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=_TextModel(long_text)),
    )
    assert result.status == "completed"
    assert result.summary.startswith("字")
    assert result.summary.endswith("……[截断]")
    # The kept body is exactly the cap; the marker is the only overflow.
    assert len(result.summary) == SUBAGENT_SUMMARY_MAX_CHARS + len("……[截断]")
