from __future__ import annotations

import json

import httpx
import pytest

from services.api.app.routes.chat import _host_event_frame
from services.business.harness_client import (
    HarnessHostClient,
    HarnessHostError,
    HarnessRun,
    ProductTask,
    result_payload,
)
from services.business.mode import BusinessModeConfig, BusinessModeConfigurationError


def _config() -> BusinessModeConfig:
    return BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="service-secret",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )


def _task(**overrides):
    data = {
        "run_id": "chat_run_1",
        "workspace_id": "ws_1",
        "actor_user_id": "u_1",
        "surface": "chat",
        "prompt": "回答问题",
    }
    data.update(overrides)
    return ProductTask.model_validate(data)


def test_product_task_rejects_non_json_context():
    with pytest.raises(ValueError, match="JSON-safe"):
        _task(context={"bad": object()})


def test_client_submits_with_internal_token_and_waits_for_terminal():
    requests: list[httpx.Request] = []
    responses = [
        {"run_id": "host-run-1", "status": "queued"},
        {"run_id": "host-run-1", "status": "completed", "result": {"answer": "已完成"}},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = responses.pop(0)
        return httpx.Response(202 if request.method == "POST" else 200, json=body)

    client = HarnessHostClient(_config(), transport=httpx.MockTransport(handler))
    result = client.submit_and_wait(_task())

    assert result.run_id == "host-run-1"
    assert result.status == "completed"
    assert result.result == {"answer": "已完成"}
    assert requests[0].url.path == "/_harness/runs"
    assert requests[0].headers["x-anna-service-token"] == "service-secret"
    assert json.loads(requests[0].content)["surface"] == "chat"


def test_client_rejects_host_protocol_error_without_leaking_token():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"run_id": "host-run-1", "status": "completed", "result": "bad"},
        )

    client = HarnessHostClient(_config(), transport=httpx.MockTransport(handler))
    with pytest.raises(HarnessHostError, match="non-object result") as error:
        client.submit(_task())
    assert "service-secret" not in str(error.value)


def test_enabled_mode_requires_origin_and_token():
    with pytest.raises(BusinessModeConfigurationError, match="ORIGIN"):
        BusinessModeConfig(enabled=True, service_token="secret").validate()
    with pytest.raises(BusinessModeConfigurationError, match="SERVICE_TOKEN"):
        BusinessModeConfig(enabled=True, host_origin="http://host.test").validate()


def test_from_env_accepts_product_launcher_names(monkeypatch):
    monkeypatch.setenv("ANNA_HARNESS_BUSINESS_MODE", "1")
    monkeypatch.setenv("ANNA_HARNESS_HOST_ORIGIN", "http://127.0.0.1:4311")
    monkeypatch.setenv("ANNA_HARNESS_BUSINESS_SERVICE_TOKEN", "launcher-token")
    monkeypatch.setenv("ANNA_HARNESS_BUSINESS_PORT", "4312")

    config = BusinessModeConfig.from_env()

    assert config.enabled is True
    assert config.host_origin == "http://127.0.0.1:4311"
    assert config.service_token == "launcher-token"
    assert config.port == 4312


def test_result_payload_projects_only_native_todo_phases_to_plan():
    run = HarnessRun(
        run_id="host-chat-plan",
        status="completed",
        result={"assistant_message": "完成"},
        events=(
            {
                "type": "omp.tool.response",
                "payload": {"result": {"status": "succeeded", "output": {"plan": [{"title": "ignore"}]}}},
            },
            {
                "type": "omp.transcript.message",
                "payload": {
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "todo-1",
                        "toolName": "todo",
                        "status": "succeeded",
                        "details": {
                            "phases": [
                                {
                                    "name": "Plan",
                                    "tasks": [
                                        {"content": "Draft", "status": "pending"},
                                        {"content": "Ship", "status": "completed"},
                                        {"content": "Drop", "status": "abandoned"},
                                        {"content": "Wait", "status": "blocked"},
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        ),
    )

    payload = result_payload(run)

    assert payload["plan"] == [
        {"id": "todo-1-1", "title": "Draft", "status": "pending"},
        {"id": "todo-1-2", "title": "Ship", "status": "done"},
        {"id": "todo-1-3", "title": "Drop (abandoned)", "status": "pending"},
        {"id": "todo-1-4", "title": "Wait", "status": "pending"},
    ]


def test_host_event_frame_maps_omp_tool_lifecycle_and_preserves_failure():
    tool_names: dict[str, str] = {}
    dispatch = {
        "type": "omp.tool.dispatch",
        "payload": {"toolCallId": "call-1", "tool": "chat__emit_document"},
    }
    response = {
        "type": "omp.tool.response",
        "payload": {
            "toolCallId": "call-1",
            "result": {"status": "unknown", "output": {"reason": "lost"}},
        },
    }

    assert _host_event_frame(dispatch, tool_names) == [
        {"type": "tool_start", "name": "chat.emit_document"},
    ]
    frames = _host_event_frame(response, tool_names)

    assert frames[0]["type"] == "event"
    assert frames[0]["event"]["type"] == "mcp.tool.called"
    assert frames[0]["event"]["payload"] == {
        "tool_name": "chat.emit_document",
        "status": "error",
        "result_status": "unknown",
    }
    assert frames[1] == {
        "type": "tool_done",
        "name": "chat.emit_document",
        "ok": False,
    }


def test_host_event_frame_emits_success_audit_after_a_failed_retry():
    tool_names: dict[str, str] = {}
    dispatch = {
        "type": "omp.tool.dispatch",
        "payload": {"toolCallId": "call-retry", "tool": "chat__emit_document"},
    }
    failed = {
        "type": "omp.tool.response",
        "payload": {
            "toolCallId": "call-retry",
            "result": {"status": "failed", "output": {"reason": "temporary"}},
        },
    }
    succeeded = {
        "type": "omp.tool.response",
        "payload": {
            "toolCallId": "call-retry",
            "result": {"status": "succeeded", "output": {"accepted": True}},
        },
    }

    _host_event_frame(dispatch, tool_names)
    failed_frames = _host_event_frame(failed, tool_names)
    success_frames = _host_event_frame(succeeded, tool_names)

    assert failed_frames[0]["event"]["payload"]["status"] == "error"
    assert success_frames[0]["event"]["type"] == "mcp.tool.called"
    assert success_frames[0]["event"]["payload"] == {
        "tool_name": "chat.emit_document",
        "status": "success",
        "result_status": "succeeded",
    }
    assert success_frames[1] == {
        "type": "tool_done",
        "name": "chat.emit_document",
        "ok": True,
    }


def test_host_event_frame_emits_plan_update_only_for_native_todo_details():
    frame = _host_event_frame(
        {
            "type": "omp.transcript.message",
            "timestamp": "2026-09-01T00:00:00.000Z",
            "streamId": "chat-run",
            "payload": {
                "message": {
                    "role": "toolResult",
                    "toolName": "todo",
                    "details": {
                        "phases": [
                            {"name": "Delivery", "tasks": [{"content": "Publish", "status": "in_progress"}]},
                        ],
                    },
                },
            },
        },
    )

    assert frame == [
        {
            "type": "event",
            "event": {
                "type": "plan.updated",
                "run_id": "chat-run",
                "created_at": "2026-09-01T00:00:00.000Z",
                "payload": {
                    "count": 1,
                    "done_count": 0,
                    "items": [{"id": "todo-1-1", "title": "Publish", "status": "in_progress"}],
                },
            },
        },
    ]
