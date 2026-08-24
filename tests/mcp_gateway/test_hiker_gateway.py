import json

import httpx
import pytest

from services.mcp_gateway.app.hiker_adapter import (
    REQUIRED_HIKER_MCP_TOOLS,
    HikerMcpError,
    HikerMcpGateway,
)
from services.runtime.app.config import RuntimeSettings


ALL_TOOLS = [{"name": name} for name in REQUIRED_HIKER_MCP_TOOLS]


def test_status_not_configured_without_server(monkeypatch):
    monkeypatch.delenv("ANNA_HIKER_MCP_SERVER", raising=False)
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)

    status = HikerMcpGateway(RuntimeSettings.from_env()).status()

    assert status["status"] == "not_configured"
    assert status["error_code"] == "connector_not_configured"


def test_status_connected_lists_required_tools():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        assert request.headers["Authorization"] == "Bearer tok-123"
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": {"tools": ALL_TOOLS}},
        )

    gateway = HikerMcpGateway(
        RuntimeSettings(hiker_mcp_server="http://hiker.test/rpc", hiker_mcp_api_key="tok-123"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "connected"
    assert status["tool_count"] == len(REQUIRED_HIKER_MCP_TOOLS)
    assert requests[0]["method"] == "tools/list"


def test_status_unhealthy_when_required_tool_missing():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": {"tools": [{"name": "hiker.system.list_capabilities"}]}},
        )

    gateway = HikerMcpGateway(
        RuntimeSettings(hiker_mcp_server="http://hiker.test/rpc", hiker_mcp_api_key="tok-123"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "unhealthy"
    assert status["error_code"] == "mcp_required_tools_missing"
    assert "hiker.report.get_dashboard_summary" in status["missing_tools"]


def test_call_tool_returns_structured_content_data():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {"structuredContent": {"tool_name": body["params"]["name"], "data": {"contract_count": 8}}},
            },
        )

    gateway = HikerMcpGateway(
        RuntimeSettings(hiker_mcp_server="http://hiker.test/rpc", hiker_mcp_api_key="tok-123"),
        transport=httpx.MockTransport(handler),
    )

    payload = gateway.call_tool("hiker.report.get_dashboard_summary", {"actor_user_id": "admin"})

    assert payload["data"]["contract_count"] == 8


def test_call_tool_raises_on_error_envelope():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "error": {"code": "permission_denied", "message": "no", "retryable": False}},
        )

    gateway = HikerMcpGateway(
        RuntimeSettings(hiker_mcp_server="http://hiker.test/rpc", hiker_mcp_api_key="tok-123"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(HikerMcpError) as error:
        gateway.call_tool("hiker.contract.list_contracts", {})

    assert error.value.error_code == "permission_denied"
    assert error.value.retryable is False


def test_no_auth_header_when_api_key_absent():
    seen_headers = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen_headers["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"tools": ALL_TOOLS}})

    gateway = HikerMcpGateway(
        RuntimeSettings(hiker_mcp_server="http://hiker.test/rpc"),
        transport=httpx.MockTransport(handler),
    )

    gateway.status()

    assert seen_headers["auth"] is None
