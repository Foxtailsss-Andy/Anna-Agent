import asyncio
import json

import httpx
import pytest

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import (
    ModelProviderError,
    ModelRequest,
    OpenAICompatibleModelProvider,
)


def test_model_provider_defaults_to_mimo_target_model(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_NAME", raising=False)

    settings = RuntimeSettings.from_env()

    assert settings.model_name == "mimo-v2.5-pro"


def test_missing_model_api_key_returns_model_not_configured(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    provider = OpenAICompatibleModelProvider(RuntimeSettings.from_env())

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(provider.create_response(
            ModelRequest(
                messages=[{"role": "user", "content": "报销 100 元"}],
                tools=[],
            )
        ))

    assert error.value.error_code == "model_not_configured"


def _provider_settings() -> RuntimeSettings:
    return RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key",
    )


def _ok_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }
            ]
        },
    )


def test_reasoning_effort_adds_thinking_payload_when_configured():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _ok_response()

    settings = RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key",
        model_reasoning_effort="high",
    )
    provider = OpenAICompatibleModelProvider(settings, transport=httpx.MockTransport(handler))
    asyncio.run(provider.create_response(
        ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
    ))

    assert captured["body"]["reasoning_effort"] == "high"
    assert captured["body"]["thinking"] == {"type": "enabled"}


def test_reasoning_payload_absent_when_not_configured():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _ok_response()

    provider = OpenAICompatibleModelProvider(
        _provider_settings(), transport=httpx.MockTransport(handler)
    )
    asyncio.run(provider.create_response(
        ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
    ))

    assert "reasoning_effort" not in captured["body"]
    assert "thinking" not in captured["body"]


def test_model_provider_retries_rate_limit_then_succeeds():
    attempts = []
    sleeps = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        if len(attempts) < 3:
            return httpx.Response(429, json={"error": "rate limited"})
        return _ok_response()

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    provider = OpenAICompatibleModelProvider(
        _provider_settings(),
        transport=httpx.MockTransport(handler),
        sleep=fake_sleep,
    )

    response = asyncio.run(provider.create_response(
        ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
    ))

    assert response.assistant_message == "ok"
    assert len(attempts) == 3
    assert len(sleeps) == 2
    assert sleeps[1] > sleeps[0] > 0


def test_model_provider_classifies_server_error_after_exhausting_retries():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        return httpx.Response(503, json={"error": "unavailable"})

    async def fake_sleep(seconds: float) -> None:
        return None

    provider = OpenAICompatibleModelProvider(
        _provider_settings(),
        transport=httpx.MockTransport(handler),
        sleep=fake_sleep,
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(provider.create_response(
            ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
        ))

    assert error.value.error_code == "model_provider_unavailable"
    assert error.value.retryable is True
    assert len(attempts) == 3


def test_model_provider_does_not_retry_auth_failure():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        return httpx.Response(401, json={"error": "bad key"})

    provider = OpenAICompatibleModelProvider(
        _provider_settings(),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(provider.create_response(
            ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
        ))

    assert error.value.error_code == "model_auth_failed"
    assert error.value.retryable is False
    assert len(attempts) == 1


def test_model_provider_retries_timeout_and_classifies_it():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        raise httpx.ConnectTimeout("connect timed out")

    async def fake_sleep(seconds: float) -> None:
        return None

    provider = OpenAICompatibleModelProvider(
        _provider_settings(),
        transport=httpx.MockTransport(handler),
        sleep=fake_sleep,
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(provider.create_response(
            ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
        ))

    assert error.value.error_code == "model_call_timeout"
    assert error.value.retryable is True
    assert len(attempts) == 3


def test_model_provider_serializes_tools_as_openai_functions_and_maps_calls_back():
    captured_payloads = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payloads.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "reimbursement__get_policy",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    response = asyncio.run(
        provider.create_response(
            ModelRequest(
                messages=[{"role": "user", "content": "probe"}],
                tools=[
                    {
                        "name": "reimbursement.get_policy",
                        "description": "Read reimbursement policy.",
                        "input_schema": {
                            "type": "object",
                            "properties": {"amount": {"type": "number"}},
                        },
                    }
                ],
            )
        )
    )

    assert captured_payloads[0]["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "reimbursement__get_policy",
                "description": "Read reimbursement policy.",
                "parameters": {
                    "type": "object",
                    "properties": {"amount": {"type": "number"}},
                },
            },
        }
    ]
    assert response.tool_calls[0].name == "reimbursement.get_policy"


def test_model_provider_rejects_tool_call_that_was_not_offered():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "reimbursement__submit",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[
                        {
                            "name": "reimbursement.get_policy",
                            "description": "Read reimbursement policy.",
                            "input_schema": {"type": "object"},
                        }
                    ],
                )
            )
        )

    assert error.value.error_code == "model_tool_not_offered"
    assert error.value.retryable is False


def test_model_provider_omits_tools_field_for_no_tool_probe():
    captured_payloads = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payloads.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": "ok"},
                        "finish_reason": "stop",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    asyncio.run(
        provider.create_response(
            ModelRequest(
                messages=[{"role": "user", "content": "probe"}],
                tools=[],
            )
        )
    )

    assert "tools" not in captured_payloads[0]


def test_model_provider_serializes_tool_call_history_names_for_openai():
    captured_payloads = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payloads.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": "ok"},
                        "finish_reason": "stop",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    asyncio.run(
        provider.create_response(
            ModelRequest(
                messages=[
                    {"role": "user", "content": "报销"},
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "reimbursement.validate_draft",
                                    "arguments": "{}",
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "name": "reimbursement.validate_draft",
                        "content": "{}",
                    },
                ],
                tools=[
                    {
                        "name": "reimbursement.validate_draft",
                        "description": "Validate draft.",
                        "input_schema": {"type": "object"},
                    }
                ],
            )
        )
    )

    assert (
        captured_payloads[0]["messages"][1]["tool_calls"][0]["function"]["name"]
        == "reimbursement__validate_draft"
    )
    assert "name" not in captured_payloads[0]["messages"][2]


def test_model_provider_rejects_non_json_response_as_model_response_invalid():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>bad gateway</html>")

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[],
                )
            )
        )

    assert error.value.error_code == "model_response_invalid"
    assert error.value.retryable is True


def test_model_provider_rejects_non_object_json_response():
    attempts = []
    sleeps = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        return httpx.Response(200, json=["not", "an", "object"])

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    provider = OpenAICompatibleModelProvider(
        _provider_settings(),
        transport=httpx.MockTransport(handler),
        sleep=fake_sleep,
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[],
                )
            )
        )

    assert error.value.error_code == "model_response_invalid"
    assert error.value.retryable is True
    # A retryable parse error is retried up to max_attempts before raising,
    # not escaped on the first attempt.
    assert len(attempts) == 3
    assert len(sleeps) == 2


def test_model_provider_retries_non_object_response_then_succeeds():
    # Regression: a transient 200 response with a non-object JSON body (some
    # providers do this occasionally) must be retried, not hard-fail the run.
    attempts = []
    sleeps = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        if len(attempts) < 3:
            return httpx.Response(200, json=["not", "an", "object"])
        return _ok_response()

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    provider = OpenAICompatibleModelProvider(
        _provider_settings(),
        transport=httpx.MockTransport(handler),
        sleep=fake_sleep,
    )

    response = asyncio.run(
        provider.create_response(
            ModelRequest(messages=[{"role": "user", "content": "hi"}], tools=[])
        )
    )

    assert response.assistant_message == "ok"
    assert len(attempts) == 3
    assert len(sleeps) == 2


def test_model_provider_rejects_non_object_message_response():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": "not-an-object", "finish_reason": "stop"}]},
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[],
                )
            )
        )

    assert error.value.error_code == "model_response_invalid"


def test_model_provider_rejects_non_list_tool_calls_response():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": "not-a-list",
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[],
                )
            )
        )

    assert error.value.error_code == "model_response_invalid"


@pytest.mark.parametrize("tool_calls", ["", {}, False, 0])
def test_model_provider_rejects_falsy_non_list_tool_calls_response(tool_calls):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": tool_calls,
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[],
                )
            )
        )

    assert error.value.error_code == "model_response_invalid"


@pytest.mark.parametrize(
    "function",
    [
        {},
        {"name": None, "arguments": "{}"},
        {"name": 42, "arguments": "{}"},
        {"name": "", "arguments": "{}"},
        {"name": " ", "arguments": "{}"},
        {"name": "bad name", "arguments": "{}"},
        {"name": "reimbursement.validate_draft", "arguments": "{}"},
    ],
)
def test_model_provider_rejects_tool_call_without_valid_function_name(function):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": function,
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )

    provider = OpenAICompatibleModelProvider(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as error:
        asyncio.run(
            provider.create_response(
                ModelRequest(
                    messages=[{"role": "user", "content": "probe"}],
                    tools=[],
                )
            )
        )

    assert error.value.error_code == "model_response_invalid"
