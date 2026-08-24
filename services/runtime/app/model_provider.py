from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from services.runtime.app.config import RuntimeSettings


OPENAI_FUNCTION_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ModelProviderError(Exception):
    def __init__(
        self,
        error_code: str,
        message: str,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class ModelRequest:
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]


@dataclass(frozen=True)
class ModelToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ModelResponse:
    assistant_message: str | None = None
    tool_calls: list[ModelToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    # Provider-reported token usage (W1.T5). Both None unless the provider
    # actually reported it — never estimated (honesty rule: an estimate must
    # not impersonate a real provider number).
    input_tokens: int | None = None
    output_tokens: int | None = None


class OpenAICompatibleModelProvider:
    """OpenAI-compatible chat completions transport.

    Retry/backoff and error classification follow the hermes-agent transport
    patterns (vendor/hermes-agent, MIT): transient failures (timeouts, 429,
    5xx) retry with exponential backoff, while auth and request errors fail
    fast with a stable error contract.
    """

    def __init__(
        self,
        settings: RuntimeSettings | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        max_attempts: int = 3,
        backoff_base_seconds: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self._transport = transport
        self._max_attempts = max(1, max_attempts)
        self._backoff_base_seconds = backoff_base_seconds
        self._sleep = sleep or asyncio.sleep

    async def create_response(self, request: ModelRequest) -> ModelResponse:
        if not self.settings.model_api_key or not self.settings.model_endpoint:
            raise ModelProviderError(
                "model_not_configured",
                "model endpoint and API key are required before running Anna agent",
                retryable=False,
            )

        tool_name_map = {
            _model_tool_name(tool["name"]): tool["name"]
            for tool in request.tools
            if isinstance(tool.get("name"), str)
        }
        payload = {
            "model": self.settings.model_name,
            "messages": [_openai_message(message) for message in request.messages],
        }
        if request.tools:
            payload["tools"] = provider_tool_contract(request.tools)
        if self.settings.model_reasoning_effort:
            # Deep-thinking (OpenAI-compatible, e.g. DeepSeek): both fields are
            # required to enable reasoning at the requested effort.
            payload["reasoning_effort"] = self.settings.model_reasoning_effort
            payload["thinking"] = {"type": "enabled"}
        # Optional output cap, injected ONLY when set (None -> key absent -> wire
        # payload byte-identical to the pre-L4a format). The autocompact summary
        # call sets it to bound the aux completion; the streaming path already
        # injects the same key.
        if self.settings.model_max_tokens is not None:
            payload["max_tokens"] = self.settings.model_max_tokens
        headers = {"Authorization": f"Bearer {self.settings.model_api_key}"}

        last_error: ModelProviderError | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                async with httpx.AsyncClient(timeout=60, transport=self._transport) as client:
                    response = await client.post(
                        self.settings.model_endpoint,
                        json=payload,
                        headers=headers,
                    )
                    response.raise_for_status()
                # Parse inside the retry loop: a 200 response with a malformed /
                # non-object body (some providers do this transiently) raises a
                # retryable ModelProviderError that must be retried, not escape.
                return _normalize_openai_response(
                    _response_json_object(response), tool_name_map
                )
            except httpx.HTTPStatusError as exc:
                last_error = _classify_status_error(exc)
            except httpx.TimeoutException as exc:
                last_error = ModelProviderError(
                    "model_call_timeout",
                    "model provider call timed out",
                    retryable=True,
                )
                last_error.__cause__ = exc
            except httpx.HTTPError as exc:
                last_error = ModelProviderError(
                    "model_call_failed",
                    "model provider call failed",
                    retryable=True,
                )
                last_error.__cause__ = exc
            except ModelProviderError as exc:
                last_error = exc

            if not last_error.retryable or attempt >= self._max_attempts:
                raise last_error
            await self._sleep(self._backoff_base_seconds * (2 ** (attempt - 1)))

        raise last_error  # pragma: no cover - loop always raises or returns


def _classify_status_error(exc: httpx.HTTPStatusError) -> ModelProviderError:
    status = exc.response.status_code
    if status == 429:
        error = ModelProviderError(
            "model_rate_limited",
            "model provider rate limited the request",
            retryable=True,
        )
    elif status in (401, 403):
        error = ModelProviderError(
            "model_auth_failed",
            "model provider rejected the configured API key",
            retryable=False,
        )
    elif status >= 500:
        error = ModelProviderError(
            "model_provider_unavailable",
            "model provider is unavailable",
            retryable=True,
        )
    else:
        error = ModelProviderError(
            "model_request_rejected",
            f"model provider rejected the request with status {status}",
            retryable=False,
        )
    error.__cause__ = exc
    return error


def provider_tool_contract(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [_openai_tool(tool) for tool in tools]


def _openai_tool(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": _model_tool_name(str(tool["name"])),
            "description": str(tool.get("description") or ""),
            "parameters": tool.get("input_schema") or {"type": "object"},
        },
    }


def _openai_message(message: dict[str, Any]) -> dict[str, Any]:
    outbound = dict(message)
    if isinstance(outbound.get("tool_calls"), list):
        outbound["tool_calls"] = [
            _openai_tool_call(tool_call)
            for tool_call in outbound["tool_calls"]
            if isinstance(tool_call, dict)
        ]
    if outbound.get("role") == "tool":
        outbound.pop("name", None)
    return outbound


def _openai_tool_call(tool_call: dict[str, Any]) -> dict[str, Any]:
    outbound = dict(tool_call)
    function = outbound.get("function")
    if isinstance(function, dict) and isinstance(function.get("name"), str):
        outbound["function"] = {
            **function,
            "name": _model_tool_name(function["name"]),
        }
    return outbound


def _model_tool_name(internal_name: str) -> str:
    return internal_name.replace(".", "__")


def _normalize_openai_response(
    body: dict[str, Any],
    tool_name_map: dict[str, str] | None = None,
) -> ModelResponse:
    tool_name_map = tool_name_map or {}
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ModelProviderError(
            "model_response_invalid",
            "model response did not include choices",
            retryable=False,
        )
    first = choices[0]
    if not isinstance(first, dict):
        raise ModelProviderError(
            "model_response_invalid",
            "model response choice must be an object",
            retryable=False,
        )
    message = first.get("message", {})
    if not isinstance(message, dict):
        raise ModelProviderError(
            "model_response_invalid",
            "model response message must be an object",
            retryable=False,
        )
    raw_tool_calls = message.get("tool_calls")
    if raw_tool_calls is None:
        raw_tool_calls = []
    if not isinstance(raw_tool_calls, list):
        raise ModelProviderError(
            "model_response_invalid",
            "model response tool_calls must be a list",
            retryable=False,
        )
    tool_calls: list[ModelToolCall] = []
    for index, raw_call in enumerate(raw_tool_calls):
        if not isinstance(raw_call, dict):
            raise ModelProviderError(
                "model_response_invalid",
                "model response tool call must be an object",
                retryable=False,
            )
        function = raw_call.get("function", {})
        if not isinstance(function, dict):
            raise ModelProviderError(
                "model_response_invalid",
                "model response tool call function must be an object",
                retryable=False,
            )
        function_name = function.get("name")
        if not isinstance(function_name, str) or not OPENAI_FUNCTION_NAME_PATTERN.fullmatch(function_name):
            raise ModelProviderError(
                "model_response_invalid",
                "model response tool call function name was invalid",
                retryable=False,
            )
        if function_name not in tool_name_map:
            raise ModelProviderError(
                "model_tool_not_offered",
                "model requested a tool that was not offered in this request",
                retryable=False,
            )
        tool_calls.append(
            ModelToolCall(
                id=str(raw_call.get("id") or f"call_{index + 1}"),
                name=tool_name_map[function_name],
                arguments=_normalize_arguments(function.get("arguments")),
            )
        )
    usage = _normalize_usage(body.get("usage"))
    return ModelResponse(
        assistant_message=message.get("content"),
        tool_calls=tool_calls,
        finish_reason=first.get("finish_reason"),
        input_tokens=usage["input_tokens"] if usage else None,
        output_tokens=usage["output_tokens"] if usage else None,
    )


def _normalize_usage(raw: Any) -> dict[str, int] | None:
    """Extract ``{input_tokens, output_tokens}`` from an OpenAI-style usage object.

    Returns the pair ONLY when both ``prompt_tokens`` and ``completion_tokens``
    are present as non-negative ints (the shape every OpenAI-compatible provider
    emits, DeepSeek included). Anything partial, malformed, or absent returns
    ``None`` — the caller then omits usage entirely rather than half-reporting or
    fabricating a number (W1.T5 honesty rule). ``bool`` is rejected explicitly
    (it is an ``int`` subclass) so a stray ``True`` never reads as a token count.
    """
    if not isinstance(raw, dict):
        return None
    prompt = raw.get("prompt_tokens")
    completion = raw.get("completion_tokens")
    if isinstance(prompt, bool) or isinstance(completion, bool):
        return None
    if not isinstance(prompt, int) or not isinstance(completion, int):
        return None
    if prompt < 0 or completion < 0:
        return None
    return {"input_tokens": prompt, "output_tokens": completion}


def _normalize_arguments(arguments: Any) -> dict[str, Any]:
    if arguments is None:
        return {}
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError as exc:
            raise ModelProviderError(
                "model_tool_arguments_invalid",
                "model tool arguments were not valid JSON",
                retryable=False,
            ) from exc
        if isinstance(decoded, dict):
            return decoded
    raise ModelProviderError(
        "model_tool_arguments_invalid",
        "model tool arguments must be an object",
        retryable=False,
    )


def _response_json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError as exc:
        raise ModelProviderError(
            "model_response_invalid",
            "model response was not valid JSON",
            retryable=True,
        ) from exc
    if not isinstance(body, dict):
        raise ModelProviderError(
            "model_response_invalid",
            "model response must be a JSON object",
            retryable=True,
        )
    return body
