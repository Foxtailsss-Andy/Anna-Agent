from __future__ import annotations

import asyncio
import inspect
import json

import httpx
import pytest

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.context_compaction import (
    MODEL_CONTEXT_WINDOW_DEFAULT,
    context_usage,
)
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.streaming_model import (
    _STREAM_MAX_ATTEMPTS,
    _STREAM_RETRY_BACKOFF_SECONDS,
    _STREAM_TIMEOUT,
    stream_model,
)
from services.runtime.app.harness_runtime import _hash_payload
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelToolCall,
    OpenAICompatibleModelProvider,
    provider_tool_contract,
)


# --- fixtures / helpers -----------------------------------------------------


def _settings(**overrides) -> RuntimeSettings:
    base = {
        "model_endpoint": "https://model.example/v1/chat/completions",
        "model_api_key": "model-key",
        "model_name": "mimo-v2.5-pro",
    }
    base.update(overrides)
    return RuntimeSettings(**base)


def _sse_event(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False)


def _content_event(text: str) -> str:
    return _sse_event({"choices": [{"delta": {"content": text}, "finish_reason": None}]})


def _tool_call_event(
    *,
    index: int = 0,
    call_id: str | None = None,
    name: str | None = None,
    arguments: str | None = None,
    finish_reason: str | None = None,
) -> str:
    tool_call: dict = {"index": index}
    if call_id is not None:
        tool_call["id"] = call_id
    function: dict = {}
    if name is not None:
        function["name"] = name
    if arguments is not None:
        function["arguments"] = arguments
    if function:
        tool_call["function"] = function
    return _sse_event(
        {"choices": [{"delta": {"tool_calls": [tool_call]}, "finish_reason": finish_reason}]}
    )


def _finish_event(finish_reason: str) -> str:
    return _sse_event({"choices": [{"delta": {}, "finish_reason": finish_reason}]})


def _sse_bytes(*events: str) -> bytes:
    return ("\n\n".join([*events, "data: [DONE]"]) + "\n\n").encode("utf-8")


def _collect(
    *,
    settings: RuntimeSettings,
    audit_events: list,
    request: ModelRequest,
    transport: httpx.AsyncBaseTransport | None,
    config_error_message: str = "model endpoint and API key are required before running Anna agent",
) -> list[ModelChunk]:
    async def run() -> list[ModelChunk]:
        chunks: list[ModelChunk] = []
        async for chunk in stream_model(
            "run_001",
            audit_events,
            request,
            settings=settings,
            config_error_message=config_error_message,
            transport=transport,
        ):
            chunks.append(chunk)
        return chunks

    return asyncio.run(run())


_FINANCE_TOOL = {
    "name": "erp.finance.query",
    "description": "Query finance data",
    "input_schema": {"type": "object"},
}


# --- 1. Text streaming (core) ----------------------------------------------


def test_stream_model_yields_text_deltas_in_order():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _content_event("你好"),
                _content_event("，"),
                _content_event("世界"),
            ),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    text_chunks = [c for c in chunks if c.kind == "text_delta"]
    final_chunks = [c for c in chunks if c.kind == "final"]
    # Streaming property: three content deltas arrive as three separate chunks.
    assert [c.text for c in text_chunks] == ["你好", "，", "世界"]
    assert "".join(c.text for c in text_chunks) == "你好，世界"
    assert len(final_chunks) == 1
    assert final_chunks[0].tool_calls == ()
    # text deltas precede the single terminal final chunk.
    assert chunks[-1].kind == "final"


# --- 2. Tool-call assembly (split across chunks) ----------------------------


def test_stream_model_assembles_tool_call_across_chunks():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _tool_call_event(index=0, call_id="call_abc", name="erp__finance__query"),
                _tool_call_event(index=0, arguments='{"question":'),
                _tool_call_event(index=0, arguments='"本月收入"}'),
                _finish_event("tool_calls"),
            ),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(
            messages=[{"role": "user", "content": "问收入"}], tools=[_FINANCE_TOOL]
        ),
        transport=httpx.MockTransport(handler),
    )

    final = [c for c in chunks if c.kind == "final"]
    assert len(final) == 1
    assert final[0].finish_reason == "tool_calls"
    assert len(final[0].tool_calls) == 1
    tool_call = final[0].tool_calls[0]
    assert isinstance(tool_call, ModelToolCall)
    assert tool_call.id == "call_abc"
    assert tool_call.name == "erp.finance.query"  # mapped back from erp__finance__query
    assert tool_call.arguments == {"question": "本月收入"}


# --- 3. Audit (no tools) ----------------------------------------------------


def test_stream_model_audits_started_and_completed_without_tools():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(_content_event("done"), _finish_event("stop")),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    messages = [{"role": "user", "content": "问收入"}]
    _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=messages, tools=[]),
        transport=httpx.MockTransport(handler),
    )

    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.completed",
    ]
    expected_hash = _hash_payload({"tools": provider_tool_contract([])})
    expected_usage = context_usage(messages, model="mimo-v2.5-pro")
    assert events[0].payload == {
        "model_name": "mimo-v2.5-pro",
        "tool_names": [],
        "tool_contract_hash": expected_hash,
        "context_token_count": expected_usage["token_count"],
        "context_window": MODEL_CONTEXT_WINDOW_DEFAULT,
        "context_percent_left": expected_usage["percent_left"],
    }
    assert events[1].payload == {
        "finish_reason": "stop",
        "tool_call_count": 0,
        "requested_tool_names": [],
    }


# --- 4. Audit (with tools) --------------------------------------------------


def test_stream_model_audits_completed_with_tools():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _tool_call_event(
                    index=0,
                    call_id="call_abc",
                    name="erp__finance__query",
                    arguments='{"question":"本月收入"}',
                ),
                _finish_event("tool_calls"),
            ),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    messages = [{"role": "user", "content": "问收入"}]
    _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=messages, tools=[_FINANCE_TOOL]),
        transport=httpx.MockTransport(handler),
    )

    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.completed",
    ]
    expected_hash = _hash_payload({"tools": provider_tool_contract([_FINANCE_TOOL])})
    assert events[0].payload["tool_names"] == ["erp.finance.query"]
    assert events[0].payload["tool_contract_hash"] == expected_hash
    assert events[1].payload == {
        "finish_reason": "tool_calls",
        "tool_call_count": 1,
        "requested_tool_names": ["erp.finance.query"],
    }


# --- 5. Compaction still fires inside stream_model --------------------------


def test_stream_model_applies_context_compaction_over_threshold():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            content=_sse_bytes(_content_event("ok"), _finish_event("stop")),
            headers={"content-type": "text/event-stream"},
        )

    settings = _settings(model_context_window=34_000)  # effective 14k -> threshold ~1k
    big_tool_result = "x" * 40_000
    messages = [
        {"role": "user", "content": "请分析逾期应收"},
        {"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "q"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": big_tool_result},
        {"role": "assistant", "content": "已拿到数据"},
        {"role": "user", "content": "继续 1"},
        {"role": "assistant", "content": "ok 1"},
        {"role": "user", "content": "继续 2"},
        {"role": "assistant", "content": "ok 2"},
        {"role": "user", "content": "继续 3"},
    ]

    events: list = []
    _collect(
        settings=settings,
        audit_events=events,
        request=ModelRequest(messages=messages, tools=[]),
        transport=httpx.MockTransport(handler),
    )

    assert [event.type for event in events] == [
        "context.compaction.applied",
        "model.call.started",
        "model.call.completed",
    ]
    assert events[0].payload["tokens_freed"] > 0
    assert (
        events[0].payload["post_compact_token_count"]
        < events[0].payload["pre_compact_token_count"]
    )
    # The provider received the compacted request body.
    sent_messages = captured["body"]["messages"]
    assert captured["body"]["stream"] is True
    assert sent_messages[2]["content"] == "[earlier tool result omitted to fit the context window]"
    assert sent_messages[2]["tool_call_id"] == "c1"
    assert sent_messages[-1]["content"] == "继续 3"


# --- 6. model_not_configured -----------------------------------------------


def test_stream_model_rejects_missing_model_config_before_audit():
    events: list = []
    chunks = _collect(
        settings=RuntimeSettings(),
        audit_events=events,
        request=ModelRequest(messages=[], tools=[]),
        transport=None,
        config_error_message="model is required",
    )

    assert len(chunks) == 1
    assert chunks[0].kind == "error"
    assert chunks[0].error_code == "model_not_configured"
    assert chunks[0].message == "model is required"
    assert events == []


# --- 7. Auth error classification ------------------------------------------


def test_stream_model_classifies_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    error_chunks = [c for c in chunks if c.kind == "error"]
    assert len(error_chunks) == 1
    assert error_chunks[0].error_code == "model_auth_failed"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {"error_code": "model_auth_failed", "retryable": False}


# --- 8. Tool not offered ----------------------------------------------------


def test_stream_model_errors_when_tool_not_offered():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _tool_call_event(
                    index=0,
                    call_id="call_abc",
                    name="not__offered__tool",
                    arguments="{}",
                ),
                _finish_event("tool_calls"),
            ),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(
            messages=[{"role": "user", "content": "hi"}], tools=[_FINANCE_TOOL]
        ),
        transport=httpx.MockTransport(handler),
    )

    error_chunks = [c for c in chunks if c.kind == "error"]
    assert len(error_chunks) == 1
    assert error_chunks[0].error_code == "model_tool_not_offered"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {
        "error_code": "model_tool_not_offered",
        "retryable": False,
    }


# --- 9. reasoning_effort / deep-thinking payload path -----------------------


def test_stream_model_sends_reasoning_effort_and_thinking_payload():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            content=_sse_bytes(_content_event("ok"), _finish_event("stop")),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    _collect(
        settings=_settings(model_reasoning_effort="high"),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    body = captured["body"]
    assert body["stream"] is True
    assert body["reasoning_effort"] == "high"
    assert body["thinking"] == {"type": "enabled"}


# --- 10. SSE robustness (junk lines are ignored, not fatal) -----------------


def test_stream_model_ignores_malformed_and_keepalive_sse_lines():
    def handler(request: httpx.Request) -> httpx.Response:
        # Interleave a keepalive comment, a malformed data line, and a blank line
        # among valid content deltas. None of the junk should be fatal.
        raw = (
            _content_event("你好")
            + "\n\n"
            + ": ping"  # SSE comment / keepalive
            + "\n\n"
            + "data: {bad json"  # malformed JSON payload
            + "\n\n"
            + ""  # blank line
            + "\n\n"
            + _content_event("世界")
            + "\n\n"
            + _finish_event("stop")
            + "\n\n"
            + "data: [DONE]"
            + "\n\n"
        ).encode("utf-8")
        return httpx.Response(
            200, content=raw, headers={"content-type": "text/event-stream"}
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    text_chunks = [c for c in chunks if c.kind == "text_delta"]
    final_chunks = [c for c in chunks if c.kind == "final"]
    error_chunks = [c for c in chunks if c.kind == "error"]
    # Valid deltas still come through; junk lines produced no chunks and no error.
    assert [c.text for c in text_chunks] == ["你好", "世界"]
    assert error_chunks == []
    assert len(final_chunks) == 1
    assert final_chunks[0].tool_calls == ()
    assert final_chunks[0].finish_reason == "stop"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.completed",
    ]


# --- 11. SSE-appropriate timeout split (Nit 1) ------------------------------


def test_stream_timeout_bounds_connect_tightly_but_read_generously():
    # `read` is the max gap BETWEEN streamed chunks, not a total cap, so a
    # healthy long-lived SSE stream must never be cut off mid-flight by a
    # single hard total timeout. connect/write/pool stay tight; read is
    # generous.
    assert isinstance(_STREAM_TIMEOUT, httpx.Timeout)
    assert _STREAM_TIMEOUT.connect == 10.0
    assert _STREAM_TIMEOUT.read == 120.0


# --- 12. Pre-first-chunk retry (R1-T2, provider-parity backoff) --------------
#
# stream_model retries transient failures with the SAME attempts/backoff as
# OpenAICompatibleModelProvider.create_response — but ONLY while no SSE data
# has left the producer. Once a text_delta has been yielded (or a tool-call
# fragment received), a retry would duplicate output, so failures past that
# point behave exactly like the pre-retry single-shot path.


def _record_sleeps(monkeypatch) -> list[float]:
    """Monkeypatch asyncio.sleep to record backoff waits instead of sleeping."""
    sleeps: list[float] = []

    async def _fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", _fake_sleep)
    return sleeps


def test_stream_retry_constants_mirror_model_provider_defaults():
    # Provider parity via introspection: if OpenAICompatibleModelProvider's
    # retry defaults are ever tuned, this goes red and forces a conscious
    # mirror-or-fork decision for the streaming producer.
    params = inspect.signature(OpenAICompatibleModelProvider.__init__).parameters
    assert params["max_attempts"].default == _STREAM_MAX_ATTEMPTS
    assert params["backoff_base_seconds"].default == _STREAM_RETRY_BACKOFF_SECONDS


def test_stream_model_retries_retryable_status_before_first_chunk(monkeypatch):
    sleeps = _record_sleeps(monkeypatch)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] < 3:
            return httpx.Response(503, json={"error": "unavailable"})
        return httpx.Response(
            200,
            content=_sse_bytes(_content_event("你好"), _finish_event("stop")),
            headers={"content-type": "text/event-stream"},
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    # Two 503s then success: three transport attempts, provider-parity backoff.
    assert calls["count"] == 3
    assert sleeps == [0.5, 1.0]
    # The stream completes normally — no error chunk ever reaches the consumer.
    assert [c.kind for c in chunks] == ["text_delta", "final"]
    assert chunks[0].text == "你好"
    assert chunks[1].finish_reason == "stop"
    # Audit contract: ONE started, ONE completed, ZERO failed (silent retries).
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.completed",
    ]


def test_stream_model_exhausts_retries_then_fails_once(monkeypatch):
    sleeps = _record_sleeps(monkeypatch)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(503, json={"error": "unavailable"})

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    assert calls["count"] == _STREAM_MAX_ATTEMPTS
    assert sleeps == [0.5, 1.0]
    # Terminal behaviour is byte-identical to the single-shot failure.
    assert len(chunks) == 1
    assert chunks[0].kind == "error"
    assert chunks[0].error_code == "model_provider_unavailable"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {
        "error_code": "model_provider_unavailable",
        "retryable": True,
    }


def test_stream_model_does_not_retry_non_retryable_auth_error(monkeypatch):
    sleeps = _record_sleeps(monkeypatch)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(401, json={"error": "bad key"})

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    # Non-retryable: exactly ONE attempt, no backoff, immediate failure.
    assert calls["count"] == 1
    assert sleeps == []
    assert len(chunks) == 1
    assert chunks[0].kind == "error"
    assert chunks[0].error_code == "model_auth_failed"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {"error_code": "model_auth_failed", "retryable": False}


def test_stream_model_does_not_retry_after_first_text_chunk(monkeypatch):
    sleeps = _record_sleeps(monkeypatch)
    calls = {"count": 0}

    async def _body():
        yield (_content_event("部分") + "\n\n").encode("utf-8")
        raise httpx.ReadTimeout("mid-stream timeout")

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            200, content=_body(), headers={"content-type": "text/event-stream"}
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    # A text_delta already reached the consumer: retrying would duplicate it,
    # so a mid-stream failure fails exactly like today — one attempt, no sleep.
    assert calls["count"] == 1
    assert sleeps == []
    assert [c.kind for c in chunks] == ["text_delta", "error"]
    assert chunks[0].text == "部分"
    assert chunks[1].error_code == "model_call_timeout"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {"error_code": "model_call_timeout", "retryable": True}


def test_stream_model_does_not_retry_after_tool_call_fragment(monkeypatch):
    sleeps = _record_sleeps(monkeypatch)
    calls = {"count": 0}

    async def _body():
        yield (
            _tool_call_event(index=0, call_id="call_abc", name="erp__finance__query")
            + "\n\n"
        ).encode("utf-8")
        raise httpx.ReadTimeout("mid-stream timeout")

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            200, content=_body(), headers={"content-type": "text/event-stream"}
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(
            messages=[{"role": "user", "content": "hi"}], tools=[_FINANCE_TOOL]
        ),
        transport=httpx.MockTransport(handler),
    )

    # Tool-call fragments are SSE data too: even though nothing was yielded to
    # the consumer yet, the model has begun emitting a response — a retry could
    # produce a different tool call and duplicate side effects downstream.
    assert calls["count"] == 1
    assert sleeps == []
    assert [c.kind for c in chunks] == ["error"]
    assert chunks[0].error_code == "model_call_timeout"
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {"error_code": "model_call_timeout", "retryable": True}


def test_stream_model_retry_then_mid_stream_failure_does_not_retry_again(monkeypatch):
    # Composed scenario: attempt 1 fails pre-chunk (retryable 503) and retries;
    # attempt 2 streams a text_delta then dies mid-stream. The per-attempt
    # streamed_output reset is what this observes: attempt 2 must start with a
    # clean latch (else the attempt-1 failure would have poisoned it), and once
    # attempt 2 has yielded output, its retryable timeout must NOT retry again.
    sleeps = _record_sleeps(monkeypatch)
    calls = {"count": 0}

    async def _dying_body():
        yield (_content_event("部分") + "\n\n").encode("utf-8")
        raise httpx.ReadTimeout("mid-stream timeout")

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(503, json={"error": "unavailable"})
        return httpx.Response(
            200, content=_dying_body(), headers={"content-type": "text/event-stream"}
        )

    events: list = []
    chunks = _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(handler),
    )

    # Exactly two transport attempts: one silent retry, then the fatal one.
    assert calls["count"] == 2
    assert sleeps == [0.5]
    assert [c.kind for c in chunks] == ["text_delta", "error"]
    assert chunks[0].text == "部分"
    assert chunks[1].error_code == "model_call_timeout"
    # Exactly ONE terminal failed audit for the logical call; zero completed.
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[-1].payload == {"error_code": "model_call_timeout", "retryable": True}


# --- 13. Sampling parameters (R1-T3): settings-driven temperature/max_tokens -
#
# Optional sampling params flow from RuntimeSettings into the streaming request
# payload and the model.call.started audit — ONLY when set. With both unset
# (the default), the HTTP body and the audit payload stay byte-identical to the
# pre-T3 wire format (section 3 pins the exact default audit payload).


def _ok_sse_handler(captured: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            content=_sse_bytes(_content_event("ok"), _finish_event("stop")),
            headers={"content-type": "text/event-stream"},
        )

    return handler


def test_stream_model_sends_temperature_and_max_tokens_when_set():
    captured: dict = {}
    events: list = []
    _collect(
        settings=_settings(model_temperature=0.2, model_max_tokens=1024),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(_ok_sse_handler(captured)),
    )

    body = captured["body"]
    assert body["temperature"] == 0.2
    assert body["max_tokens"] == 1024
    assert body["stream"] is True
    # Audit visibility: the started payload carries the sampling params.
    started = events[0]
    assert started.type == "model.call.started"
    assert started.payload["temperature"] == 0.2
    assert started.payload["max_tokens"] == 1024


def test_stream_model_omits_sampling_keys_when_unset():
    captured: dict = {}
    events: list = []
    _collect(
        settings=_settings(),
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
        transport=httpx.MockTransport(_ok_sse_handler(captured)),
    )

    # Defaults byte-identical: None → key absent, on the wire AND in the audit.
    body = captured["body"]
    assert "temperature" not in body
    assert "max_tokens" not in body
    started = events[0]
    assert started.type == "model.call.started"
    assert "temperature" not in started.payload
    assert "max_tokens" not in started.payload


def test_stream_model_rejects_out_of_range_temperature_loudly():
    # ADR-002 code gate: from_env coerces bad env/file values to None, so an
    # out-of-range value here means a directly-constructed settings bug —
    # fail loudly, before any audit or transport work.
    events: list = []
    with pytest.raises(ValueError, match="model_temperature"):
        _collect(
            settings=_settings(model_temperature=2.5),
            audit_events=events,
            request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
            transport=None,
        )
    assert events == []


def test_stream_model_rejects_non_positive_max_tokens_loudly():
    events: list = []
    with pytest.raises(ValueError, match="model_max_tokens"):
        _collect(
            settings=_settings(model_max_tokens=0),
            audit_events=events,
            request=ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[]),
            transport=None,
        )
    assert events == []
