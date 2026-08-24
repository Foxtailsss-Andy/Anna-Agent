from __future__ import annotations

import json

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.harness_v2_bridge import HarnessV2Bridge
from services.api.app.routes.harness_v2 import build_router


def test_harness_v2_bridge_forwards_runtime_contract_and_status_codes():
    seen: list[tuple[str, str, dict | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body))
        if request.method == "GET" and request.url.path == "/capabilities":
            return httpx.Response(200, json={"api_version": "harness-v2", "surfaces": []})
        if request.method == "POST" and request.url.path == "/v2/surfaces/create/runs":
            return httpx.Response(202, json={"run_id": "run-bridge", "status": "queued"})
        if request.method == "POST" and request.url.path == "/v2/surfaces/create/runs/run-bridge/resume":
            assert body == {
                "workspace_id": "workspace-bridge",
                "channel_id": "channel-bridge",
            }
            return httpx.Response(202, json={"run_id": "run-bridge", "status": "running"})
        if request.method == "GET" and request.url.path == "/v2/runs/run-bridge/events":
            assert request.url.params["workspace_id"] == "workspace-bridge"
            assert request.url.params["channel_id"] == "channel-bridge"
            assert request.url.params["from_seq"] == "3"
            return httpx.Response(200, json={"run_id": "run-bridge", "events": []})
        if request.method == "GET" and request.url.path == "/v2/create/runs":
            assert request.url.params["workspace_id"] == "workspace-bridge"
            assert request.url.params["channel_id"] == "channel-bridge"
            return httpx.Response(200, json={"runs": []})
        return httpx.Response(404, json={"code": "unexpected_bridge_request"})

    app = FastAPI()
    app.include_router(build_router(HarnessV2Bridge(
        "http://harness-v2.test",
        transport=httpx.MockTransport(handler),
    )))
    client = TestClient(app)

    assert client.get("/api/harness/v2/capabilities").json() == {
        "api_version": "harness-v2",
        "surfaces": [],
    }
    started = client.post(
        "/api/harness/v2/surfaces/create/runs",
        json={"goal": "bridge this request"},
    )
    assert started.status_code == 202
    assert started.json() == {"run_id": "run-bridge", "status": "queued"}
    resumed = client.post(
        "/api/harness/v2/surfaces/create/runs/run-bridge/resume",
        json={"workspace_id": "workspace-bridge", "channel_id": "channel-bridge"},
    )
    assert resumed.status_code == 202
    assert resumed.json() == {"run_id": "run-bridge", "status": "running"}
    events = client.get(
        "/api/harness/v2/runs/run-bridge/events",
        params={
            "workspace_id": "workspace-bridge",
            "channel_id": "channel-bridge",
            "from_seq": 3,
        },
    )
    assert events.status_code == 200
    assert events.json() == {"run_id": "run-bridge", "events": []}
    runs = client.get(
        "/api/harness/v2/create/runs",
        params={"workspace_id": "workspace-bridge", "channel_id": "channel-bridge"},
    )
    assert runs.status_code == 200
    assert runs.json() == {"runs": []}
    assert seen == [
        ("GET", "/capabilities", None),
        ("POST", "/v2/surfaces/create/runs", {"goal": "bridge this request"}),
        (
            "POST",
            "/v2/surfaces/create/runs/run-bridge/resume",
            {"workspace_id": "workspace-bridge", "channel_id": "channel-bridge"},
        ),
        ("GET", "/v2/runs/run-bridge/events", None),
        ("GET", "/v2/create/runs", None),
    ]
