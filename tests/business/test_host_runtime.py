from __future__ import annotations

import json

import httpx

from services.business.harness_client import HarnessHostClient
from services.business.host_runtime import HostHarnessRuntime
from services.business.mode import BusinessModeConfig
from services.runtime.app.model_provider import ModelRequest


def _client(handler):
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="secret",
        wait_timeout_seconds=1,
        poll_interval_seconds=0,
    )
    return HarnessHostClient(config, transport=httpx.MockTransport(handler))


def test_planning_call_is_a_whole_host_task_and_returns_structured_tool_call():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "crew-plan", "status": "queued"})
        return httpx.Response(
            200,
            json={
                "run_id": "crew-plan",
                "status": "completed",
                "result": {
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "name": "crew__emit_project_plan",
                            "arguments": {"tasks": []},
                        }
                    ],
                    "finish_reason": "tool_calls",
                },
            },
        )

    events = []
    tool = {
        "name": "crew.emit_project_plan",
        "description": "emit",
        "input_schema": {"type": "object"},
    }
    result = HostHarnessRuntime(_client(handler)).call_model(
        "crew-plan",
        events,
        ModelRequest(
            messages=[
                {"role": "system", "content": "system"},
                {"role": "user", "content": "goal"},
            ],
            tools=[tool],
        ),
    )

    assert result.response is not None
    assert result.response.tool_calls[0].name == "crew.emit_project_plan"
    assert requests[0].headers["x-anna-service-token"] == "secret"
    submitted = json.loads(requests[0].content)
    assert submitted["surface"] == "crew"
    assert submitted["permission_mode"] == "readonly"
    assert submitted["context"]["planning"] is True
    assert submitted["context"]["tool_catalog"] == [tool]


def test_planning_projection_ignores_native_todo_but_keeps_emitted_proposal():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "crew-plan", "status": "queued"})
        return httpx.Response(
            200,
            json={
                "run_id": "crew-plan",
                "status": "completed",
                "result": {
                    "tool_calls": [
                        {"id": "todo-1", "name": "todo", "arguments": {"op": "init"}},
                        {
                            "id": "emit-1",
                            "name": "crew__emit_project_plan",
                            "arguments": {"tasks": []},
                        },
                    ],
                },
                "events": [
                    {
                        "type": "omp.transcript.message",
                        "payload": {"message": {"role": "assistant", "content": []}},
                    }
                ],
            },
        )

    tool = {
        "name": "crew.emit_project_plan",
        "description": "emit",
        "input_schema": {"type": "object"},
    }
    result = HostHarnessRuntime(_client(handler)).call_model(
        "crew-plan",
        [],
        ModelRequest(messages=[{"role": "user", "content": "goal"}], tools=[tool]),
    )

    assert result.response is not None
    assert [call.name for call in result.response.tool_calls] == ["crew.emit_project_plan"]


def test_planning_call_fails_honestly_when_host_fails():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"code": "host_unavailable"})

    result = HostHarnessRuntime(_client(handler)).call_model(
        "crew-plan",
        [],
        ModelRequest(messages=[{"role": "user", "content": "goal"}], tools=[]),
    )

    assert result.response is None
    assert result.error_code == "host_unavailable"


def test_planning_call_recovers_real_omp_tool_call_from_canonical_transcript():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "crew-plan", "status": "queued"})
        return httpx.Response(
            200,
            json={
                "run_id": "crew-plan",
                "status": "completed",
                "result": {"assistant_message": "计划已生成"},
                "events": [
                    {
                        "seq": 3,
                        "type": "omp.transcript.message",
                        "payload": {
                            "message": {
                                "role": "assistant",
                                "content": [
                                    {
                                        "type": "toolCall",
                                        "id": "omp-call-1",
                                        "name": "crew__emit_task_drafts",
                                        "arguments": {"drafts": [{"title": "核对"}]},
                                    }
                                ],
                            }
                        },
                    },
                    {
                        "seq": 4,
                        "type": "omp.tool.response",
                        "payload": {
                            "tool": "crew__emit_task_drafts",
                            "result": {
                                "status": "succeeded",
                                "output": {"drafts": [{"title": "核对"}]},
                            },
                        },
                    },
                ],
            },
        )

    tool = {"name": "crew.emit_task_drafts", "input_schema": {"type": "object"}}
    result = HostHarnessRuntime(_client(handler)).call_model(
        "crew-plan",
        [],
        ModelRequest(messages=[{"role": "user", "content": "goal"}], tools=[tool]),
    )

    assert result.response is not None
    assert result.response.tool_calls[0].name == "crew.emit_task_drafts"
    assert result.response.tool_calls[0].arguments == {
        "drafts": [{"title": "核对"}]
    }
