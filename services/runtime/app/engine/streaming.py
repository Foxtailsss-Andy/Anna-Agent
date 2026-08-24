"""Streaming chat-completions transport (engine layer).

Adapted from the hermes-agent chat_completions transport pattern
(vendor/hermes-agent, MIT): a server-sent-events reader that yields assistant
text deltas as they arrive. This is used for tool-free conversational turns
(Chat P0); tool-calling turns still go through the non-streaming
OpenAICompatibleModelProvider.create_response path.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import ModelProviderError, _classify_status_error


async def stream_chat_text(
    settings: RuntimeSettings,
    messages: list[dict[str, Any]],
    transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncIterator[str]:
    """Yield assistant text deltas from a streaming chat-completions response."""
    if not settings.model_api_key or not settings.model_endpoint:
        raise ModelProviderError(
            "model_not_configured",
            "model endpoint and API key are required before running Anna agent",
            retryable=False,
        )
    payload = {
        "model": settings.model_name,
        "messages": messages,
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {settings.model_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=120, transport=transport) as client:
            async with client.stream(
                "POST", settings.model_endpoint, json=payload, headers=headers
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    response.raise_for_status()
                async for line in response.aiter_lines():
                    delta = _delta_from_sse_line(line)
                    if delta == _DONE:
                        return
                    if delta:
                        yield delta
    except httpx.HTTPStatusError as exc:
        raise _classify_status_error(exc) from exc
    except httpx.TimeoutException as exc:
        raise ModelProviderError(
            "model_call_timeout", "model provider call timed out", retryable=True
        ) from exc
    except httpx.HTTPError as exc:
        raise ModelProviderError(
            "model_call_failed", "model provider call failed", retryable=True
        ) from exc


_DONE = object()


def _delta_from_sse_line(line: str) -> Any:
    line = line.strip()
    if not line or not line.startswith("data:"):
        return None
    data = line[len("data:"):].strip()
    if data == "[DONE]":
        return _DONE
    try:
        obj = json.loads(data)
    except json.JSONDecodeError:
        return None
    choices = obj.get("choices") if isinstance(obj, dict) else None
    if not isinstance(choices, list) or not choices:
        return None
    delta = choices[0].get("delta") if isinstance(choices[0], dict) else None
    if not isinstance(delta, dict):
        return None
    content = delta.get("content")
    return content if isinstance(content, str) and content else None
