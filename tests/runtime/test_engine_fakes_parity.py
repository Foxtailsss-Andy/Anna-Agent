"""Anti-drift pin: governed ``FakeStreamModel`` vs the REAL ``stream_model``.

``tests/support/engine_fakes.py::FakeStreamModel`` hand-mirrors the governance
side effects of ``services/runtime/app/engine/streaming_model.py::stream_model``
(the "governance mirror" contract in its class docstring), but nothing
structural keeps the two in lockstep — THIS module does. Each test drives BOTH
producers with an equivalent request/settings — the real one through the
MockTransport SSE harness (same pattern as ``test_engine_streaming_model``),
the fake through an equivalent script — and asserts audit-payload KEY parity
per event type.

When the real producer's payloads change (e.g. R1-T3 adding ``temperature`` /
``max_tokens`` to ``model.call.started``), these tests MUST go red until the
fake follows. Do not weaken them; update the fake instead.
"""
from __future__ import annotations

import asyncio
import json

import httpx

from services.reimbursement.app.audit import AuditEvent
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.streaming_model import stream_model
from services.runtime.app.model_provider import ModelRequest
from tests.support.engine_fakes import FakeStreamModel


_TOOL = {
    "name": "erp.finance.query",
    "description": "Query finance data",
    "input_schema": {"type": "object"},
}

_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    model_name="mimo-v2.5-pro",
)


def _request() -> ModelRequest:
    return ModelRequest(
        messages=[{"role": "user", "content": "问收入"}], tools=[_TOOL]
    )


def _sse_event(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False)


def _sse_bytes(*events: str) -> bytes:
    return ("\n\n".join([*events, "data: [DONE]"]) + "\n\n").encode("utf-8")


def _real_audit_events(
    handler, settings: RuntimeSettings = _SETTINGS
) -> list[AuditEvent]:
    """Drive the REAL producer against a MockTransport handler; return audits."""
    events: list[AuditEvent] = []

    async def _drain() -> None:
        async for _chunk in stream_model(
            "run_parity",
            events,
            _request(),
            settings=settings,
            transport=httpx.MockTransport(handler),
        ):
            pass

    asyncio.run(_drain())
    return events


def _fake_audit_events(
    script: list[ModelChunk], settings: RuntimeSettings = _SETTINGS
) -> list[AuditEvent]:
    """Drive the governed fake with one equivalent scripted turn; return audits."""
    events: list[AuditEvent] = []
    fake = FakeStreamModel([script])

    async def _drain() -> None:
        async for _chunk in fake(
            "run_parity",
            events,
            _request(),
            settings=settings,
            config_error_message="model endpoint and API key are required",
        ):
            pass

    asyncio.run(_drain())
    return events


# --- success path: started + completed payload-key parity --------------------


def test_fake_mirrors_real_started_and_completed_payload_keys():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _sse_event(
                    {"choices": [{"delta": {"content": "你好"}, "finish_reason": None}]}
                ),
                _sse_event({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
            ),
            headers={"content-type": "text/event-stream"},
        )

    real = _real_audit_events(handler)
    fake = _fake_audit_events(
        [ModelChunk("text_delta", text="你好"), ModelChunk("final", finish_reason="stop")]
    )

    assert [e.type for e in real] == ["model.call.started", "model.call.completed"]
    assert [e.type for e in fake] == [e.type for e in real]

    real_started, real_completed = real
    fake_started, fake_completed = fake
    # Full payload-KEY parity: when the real producer's payload grows a key
    # (e.g. temperature / max_tokens), the fake must grow it too.
    assert set(fake_started.payload.keys()) == set(real_started.payload.keys())
    assert set(fake_completed.payload.keys()) == set(real_completed.payload.keys())


# --- success path with sampling set: R1-T3 conditional keys must mirror ------


def test_fake_mirrors_real_started_payload_keys_with_sampling_set():
    # R1-T3: with model_temperature / model_max_tokens set, the real producer's
    # model.call.started payload grows conditional `temperature` / `max_tokens`
    # keys. The governed fake must grow the same keys under the same settings —
    # and must NOT grow them by default (the case above pins the default).
    sampling_settings = RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key",
        model_name="mimo-v2.5-pro",
        model_temperature=0.2,
        model_max_tokens=1024,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _sse_event(
                    {"choices": [{"delta": {"content": "你好"}, "finish_reason": None}]}
                ),
                _sse_event({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
            ),
            headers={"content-type": "text/event-stream"},
        )

    real = _real_audit_events(handler, settings=sampling_settings)
    fake = _fake_audit_events(
        [ModelChunk("text_delta", text="你好"), ModelChunk("final", finish_reason="stop")],
        settings=sampling_settings,
    )

    assert [e.type for e in real] == ["model.call.started", "model.call.completed"]
    assert [e.type for e in fake] == [e.type for e in real]

    real_started, real_completed = real
    fake_started, fake_completed = fake
    # This case must actually exercise the conditional keys (guard against a
    # trivially-passing parity where both sides omit them).
    assert {"temperature", "max_tokens"} <= set(real_started.payload.keys())
    assert set(fake_started.payload.keys()) == set(real_started.payload.keys())
    assert set(fake_completed.payload.keys()) == set(real_completed.payload.keys())
    # Values mirror too, not just key presence.
    assert fake_started.payload["temperature"] == real_started.payload["temperature"]
    assert fake_started.payload["max_tokens"] == real_started.payload["max_tokens"]


# --- success path with usage: W1.T5 conditional usage keys must mirror -------


def test_fake_mirrors_real_completed_payload_keys_with_usage():
    # W1.T5: when the provider reports token usage, the real producer's
    # model.call.completed payload grows `input_tokens` / `output_tokens`. The
    # governed fake must grow the same keys (and values) when its scripted final
    # chunk carries usage — and the default (no-usage) case above pins their
    # absence, so this guards against a trivially-passing parity.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse_bytes(
                _sse_event(
                    {"choices": [{"delta": {"content": "你好"}, "finish_reason": None}]}
                ),
                _sse_event({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
                _sse_event(
                    {
                        "choices": [],
                        "usage": {"prompt_tokens": 128, "completion_tokens": 42},
                    }
                ),
            ),
            headers={"content-type": "text/event-stream"},
        )

    real = _real_audit_events(handler)
    fake = _fake_audit_events(
        [
            ModelChunk("text_delta", text="你好"),
            ModelChunk(
                "final", finish_reason="stop", input_tokens=128, output_tokens=42
            ),
        ]
    )

    assert [e.type for e in real] == ["model.call.started", "model.call.completed"]
    assert [e.type for e in fake] == [e.type for e in real]

    real_completed = real[-1]
    fake_completed = fake[-1]
    # This case must actually exercise the usage keys, not trivially pass.
    assert {"input_tokens", "output_tokens"} <= set(real_completed.payload.keys())
    assert set(fake_completed.payload.keys()) == set(real_completed.payload.keys())
    # Values mirror too — the real provider numbers, byte-for-byte.
    assert fake_completed.payload["input_tokens"] == real_completed.payload["input_tokens"] == 128
    assert fake_completed.payload["output_tokens"] == real_completed.payload["output_tokens"] == 42


# --- error path: the fake must mirror model.call.failed, never completed -----


def test_fake_mirrors_real_failed_audit_on_error_terminal():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    real = _real_audit_events(handler)
    fake = _fake_audit_events(
        [ModelChunk("error", error_code="model_auth_failed", message="bad key")]
    )

    assert [e.type for e in real] == ["model.call.started", "model.call.failed"]
    # A script whose terminal chunk is ``error`` mirrors the real producer's
    # ``_fail``: model.call.failed — NOT model.call.completed.
    assert [e.type for e in fake] == [e.type for e in real]
    assert set(fake[-1].payload.keys()) == set(real[-1].payload.keys())
    # Same retryable classification for the same error code.
    assert fake[-1].payload == real[-1].payload


def test_fake_mirrors_real_retryable_classification_on_timeout(monkeypatch):
    # The always-timeout handler drives the real producer through its full
    # pre-first-chunk retry schedule (R1-T2). Record the backoff instead of
    # burning ~1.5s of wall clock — and pin the schedule while we're here.
    sleeps: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", _record_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("simulated read timeout")

    real = _real_audit_events(handler)
    # Provider-parity backoff ran silently before the single terminal audit.
    assert sleeps == [0.5, 1.0]
    fake = _fake_audit_events(
        [ModelChunk("error", error_code="model_call_timeout", message="timed out")]
    )

    assert [e.type for e in real] == ["model.call.started", "model.call.failed"]
    assert [e.type for e in fake] == [e.type for e in real]
    # retryable=True must be mirrored for a retryable code, not hardcoded False.
    assert fake[-1].payload == real[-1].payload
