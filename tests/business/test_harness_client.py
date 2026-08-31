from __future__ import annotations

import json

import httpx
import pytest

from services.business.harness_client import HarnessHostClient, HarnessHostError, ProductTask
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
