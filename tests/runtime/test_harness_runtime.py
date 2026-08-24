import hashlib
import json

from services.reimbursement.app.audit import AuditService
from services.runtime.app.context_compaction import (
    MODEL_CONTEXT_WINDOW_DEFAULT,
    context_usage,
)
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import (
    ModelProviderError,
    ModelRequest,
    ModelResponse,
    ModelToolCall,
    provider_tool_contract,
)


class HarnessModelProvider:
    def __init__(self, settings=None, error=None):
        self.settings = settings or RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="model-key",
            model_name="mimo-v2.5-pro",
        )
        self.error = error
        self.requests = []

    async def create_response(self, request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return ModelResponse(
            assistant_message="done",
            tool_calls=[
                ModelToolCall(
                    id="call_1",
                    name="hiker.report.get_sales_dashboard",
                    arguments={"metric": "revenue", "period": "current_month"},
                )
            ],
            finish_reason="tool_calls",
        )


def test_harness_runtime_rejects_missing_model_config_before_model_call():
    provider = HarnessModelProvider(settings=RuntimeSettings())
    runtime = AnnaHarnessRuntime(model_provider=provider, audit=AuditService())
    events = []

    result = runtime.call_model(
        run_id="run_001",
        audit_events=events,
        request=ModelRequest(messages=[], tools=[]),
        config_error_message="model is required",
    )

    assert result.response is None
    assert result.error_code == "model_not_configured"
    assert result.message == "model is required"
    assert provider.requests == []
    assert events == []


def test_harness_runtime_records_model_call_contract_and_response():
    provider = HarnessModelProvider()
    runtime = AnnaHarnessRuntime(model_provider=provider, audit=AuditService())
    events = []
    tools = [
        {
            "name": "hiker.report.get_sales_dashboard",
            "description": "Query Hiker dashboard data",
            "input_schema": {"type": "object"},
        }
    ]

    result = runtime.call_model(
        run_id="run_001",
        audit_events=events,
        request=ModelRequest(messages=[{"role": "user", "content": "问收入"}], tools=tools),
        started_payload={"skill_id": "hiker/global-customer"},
    )

    assert result.error_code is None
    assert result.response is not None
    assert len(provider.requests) == 1
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.completed",
    ]
    expected_hash = hashlib.sha256(
        json.dumps({"tools": provider_tool_contract(tools)}, sort_keys=True).encode()
    ).hexdigest()
    expected_usage = context_usage(
        [{"role": "user", "content": "问收入"}], model="mimo-v2.5-pro"
    )
    assert events[0].payload == {
        "model_name": "mimo-v2.5-pro",
        "tool_names": ["hiker.report.get_sales_dashboard"],
        "tool_contract_hash": expected_hash,
        "context_token_count": expected_usage["token_count"],
        "context_window": MODEL_CONTEXT_WINDOW_DEFAULT,
        "context_percent_left": expected_usage["percent_left"],
        "skill_id": "hiker/global-customer",
    }
    assert events[1].payload == {
        "finish_reason": "tool_calls",
        "tool_call_count": 1,
        "requested_tool_names": ["hiker.report.get_sales_dashboard"],
    }


def test_harness_runtime_applies_context_compaction_over_threshold():
    provider = HarnessModelProvider(
        settings=RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="model-key",
            model_name="mimo-v2.5-pro",
            model_context_window=34_000,  # effective 14k -> auto-compact threshold 1k
        )
    )
    runtime = AnnaHarnessRuntime(model_provider=provider, audit=AuditService())
    events = []
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

    result = runtime.call_model(
        run_id="run_001",
        audit_events=events,
        request=ModelRequest(messages=messages, tools=[]),
    )

    assert result.error_code is None
    # Compaction fires and is audited just before the model call.
    assert [event.type for event in events] == [
        "context.compaction.applied",
        "model.call.started",
        "model.call.completed",
    ]
    assert events[0].payload["tokens_freed"] > 0
    assert events[0].payload["post_compact_token_count"] < events[0].payload["pre_compact_token_count"]
    # The provider received the compacted request: the old tool result is truncated,
    # its tool_call_id linkage intact, and the recent tail preserved.
    sent = provider.requests[0]
    assert sent.messages[2]["content"] == "[earlier tool result omitted to fit the context window]"
    assert sent.messages[2]["tool_call_id"] == "c1"
    assert sent.messages[-1]["content"] == "继续 3"


def test_harness_runtime_records_model_provider_failures():
    provider = HarnessModelProvider(
        error=ModelProviderError(
            "model_call_failed",
            "provider unavailable",
            retryable=True,
        )
    )
    runtime = AnnaHarnessRuntime(model_provider=provider, audit=AuditService())
    events = []

    result = runtime.call_model(
        run_id="run_001",
        audit_events=events,
        request=ModelRequest(messages=[], tools=[]),
    )

    assert result.response is None
    assert result.error_code == "model_call_failed"
    assert result.message == "provider unavailable"
    assert result.retryable is True
    assert [event.type for event in events] == [
        "model.call.started",
        "model.call.failed",
    ]
    assert events[1].payload == {"error_code": "model_call_failed", "retryable": True}


# --- run_async (public bridge, R1-T1a extraction) -----------------------------


def test_run_async_is_public_and_drives_coroutine_to_completion():
    from services.runtime.app.harness_runtime import run_async

    async def _coro():
        return 42

    assert run_async(_coro()) == 42


def test_run_async_refuses_running_loop_with_neutral_message():
    import asyncio

    import pytest

    from services.runtime.app.harness_runtime import run_async

    async def _outer():
        async def _inner():
            return 1

        coro = _inner()
        try:
            with pytest.raises(RuntimeError) as exc_info:
                run_async(coro)
        finally:
            coro.close()  # never awaited — avoid the RuntimeWarning
        return str(exc_info.value)

    message = asyncio.run(_outer())
    # Neutral wording: the bridge is shared by every orchestrator now, not an
    # AnnaHarnessRuntime internal.
    assert "AnnaHarnessRuntime" not in message
    assert "event loop" in message
