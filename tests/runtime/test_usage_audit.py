"""W1.T5 — per-run token usage audit at the model-call chokepoint(s).

Provider-reported usage (prompt/completion tokens) surfaces on the
``model.call.completed`` audit event as ``input_tokens`` / ``output_tokens`` —
but ONLY when the provider actually reports it. When usage is absent the keys
are absent too (honesty rule: an estimate must never impersonate a real
provider number). Covered at BOTH chokepoints: the non-streaming
``call_model`` and the streaming ``stream_model``.
"""
from __future__ import annotations

import asyncio
import json

import httpx

from services.reimbursement.app.audit import AuditService
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.streaming_model import stream_model
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import (
    ModelRequest,
    OpenAICompatibleModelProvider,
)


_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    model_name="mimo-v2.5-pro",
)


def _completed(events):
    return next(e for e in events if e.type == "model.call.completed")


def _request() -> ModelRequest:
    return ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])


# --- non-streaming chokepoint (call_model) ----------------------------------


def _call_model_with_response_body(body: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    provider = OpenAICompatibleModelProvider(
        _SETTINGS, transport=httpx.MockTransport(handler)
    )
    runtime = AnnaHarnessRuntime(model_provider=provider, audit=AuditService())
    events: list = []
    runtime.call_model(run_id="run_usage", audit_events=events, request=_request())
    return events


def test_call_model_records_usage_on_completed_when_provider_reports_it():
    events = _call_model_with_response_body(
        {
            "choices": [
                {"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 128, "completion_tokens": 42, "total_tokens": 170},
        }
    )
    completed = _completed(events)
    # Exact provider numbers, not estimates.
    assert completed.payload["input_tokens"] == 128
    assert completed.payload["output_tokens"] == 42


def test_call_model_omits_usage_when_provider_reports_none():
    events = _call_model_with_response_body(
        {
            "choices": [
                {"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
            ]
            # no usage field at all
        }
    )
    completed = _completed(events)
    # The event is still emitted (audit-trail integrity) but carries NO usage keys.
    assert "input_tokens" not in completed.payload
    assert "output_tokens" not in completed.payload


def test_call_model_omits_usage_on_malformed_partial_usage():
    # Honesty: a partial/garbled usage object is NOT half-reported — all-or-nothing.
    events = _call_model_with_response_body(
        {
            "choices": [
                {"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 10},  # completion_tokens missing
        }
    )
    completed = _completed(events)
    assert "input_tokens" not in completed.payload
    assert "output_tokens" not in completed.payload


def test_provider_parses_usage_into_model_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3},
            },
        )

    provider = OpenAICompatibleModelProvider(
        _SETTINGS, transport=httpx.MockTransport(handler)
    )
    response = asyncio.run(provider.create_response(_request()))
    assert response.input_tokens == 10
    assert response.output_tokens == 3


def test_provider_leaves_usage_none_when_absent():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]},
        )

    provider = OpenAICompatibleModelProvider(
        _SETTINGS, transport=httpx.MockTransport(handler)
    )
    response = asyncio.run(provider.create_response(_request()))
    assert response.input_tokens is None
    assert response.output_tokens is None


# --- streaming chokepoint (stream_model) ------------------------------------


def _data(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False)


def _sse(*events: str) -> bytes:
    return ("\n\n".join([*events, "data: [DONE]"]) + "\n\n").encode("utf-8")


def _stream_events(sse_bytes: bytes, captured: dict | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if captured is not None:
            captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, content=sse_bytes, headers={"content-type": "text/event-stream"}
        )

    events: list = []

    async def _drain():
        async for _chunk in stream_model(
            "run_usage",
            events,
            _request(),
            settings=_SETTINGS,
            transport=httpx.MockTransport(handler),
        ):
            pass

    asyncio.run(_drain())
    return events


def test_stream_model_records_usage_from_include_usage_frame():
    sse = _sse(
        _data({"choices": [{"delta": {"content": "ok"}, "finish_reason": None}]}),
        _data({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
        # include_usage final frame: choices empty, top-level usage populated.
        _data(
            {
                "choices": [],
                "usage": {"prompt_tokens": 200, "completion_tokens": 55, "total_tokens": 255},
            }
        ),
    )
    completed = _completed(_stream_events(sse))
    assert completed.payload["input_tokens"] == 200
    assert completed.payload["output_tokens"] == 55
    # Existing completed keys stay intact alongside the new usage keys.
    assert completed.payload["finish_reason"] == "stop"


def test_stream_model_omits_usage_when_no_usage_frame():
    sse = _sse(
        _data({"choices": [{"delta": {"content": "ok"}, "finish_reason": None}]}),
        _data({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
    )
    completed = _completed(_stream_events(sse))
    assert "input_tokens" not in completed.payload
    assert "output_tokens" not in completed.payload


def test_stream_model_requests_include_usage_stream_option():
    captured: dict = {}
    sse = _sse(_data({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]}))
    _stream_events(sse, captured=captured)
    # We must ASK the provider for usage on the stream, or it never sends it.
    assert captured["body"]["stream_options"] == {"include_usage": True}
    assert captured["body"]["stream"] is True
