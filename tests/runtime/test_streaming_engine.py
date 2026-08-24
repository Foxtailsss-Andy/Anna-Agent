import asyncio

import httpx
import pytest

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.streaming import stream_chat_text
from services.runtime.app.model_provider import ModelProviderError


def _settings() -> RuntimeSettings:
    return RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key",
    )


def _sse(*chunks: str) -> bytes:
    lines = []
    for chunk in chunks:
        lines.append(
            'data: {"choices":[{"delta":{"content":' + f'"{chunk}"' + "}}]}"
        )
    lines.append("data: [DONE]")
    return ("\n\n".join(lines) + "\n\n").encode("utf-8")


async def _collect(settings, transport) -> list[str]:
    out = []
    async for delta in stream_chat_text(settings, [{"role": "user", "content": "hi"}], transport=transport):
        out.append(delta)
    return out


def test_stream_yields_text_deltas_in_order():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_sse("你好", "，", "世界"),
            headers={"content-type": "text/event-stream"},
        )

    deltas = asyncio.run(_collect(_settings(), httpx.MockTransport(handler)))

    assert deltas == ["你好", "，", "世界"]
    assert "".join(deltas) == "你好，世界"


def test_stream_requires_model_config():
    settings = RuntimeSettings()

    async def run():
        return await _collect(settings, None)

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(run())

    assert error.value.error_code == "model_not_configured"


def test_stream_classifies_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(_collect(_settings(), httpx.MockTransport(handler)))

    assert error.value.error_code == "model_auth_failed"
    assert error.value.retryable is False
