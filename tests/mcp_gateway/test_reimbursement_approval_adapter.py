# tests/mcp_gateway/test_reimbursement_approval_adapter.py
from __future__ import annotations

import json

import httpx
import pytest

from services.mcp_gateway.app.reimbursement_adapter import (
    ReimbursementMcpError,
    ReimbursementMcpGateway,
)
from services.runtime.app.config import RuntimeSettings


def _gateway(handler):
    settings = RuntimeSettings(reimbursement_mcp_server="http://mcp.test/rpc")
    return ReimbursementMcpGateway(settings, transport=httpx.MockTransport(handler))


def _rpc_result(request: httpx.Request, structured: dict) -> httpx.Response:
    body = json.loads(request.content)
    return httpx.Response(
        200,
        json={"jsonrpc": "2.0", "id": body["id"], "result": {"structuredContent": structured}},
    )


def test_list_approvals_passes_actor_and_status():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured.update(body["params"]["arguments"])
        captured["name"] = body["params"]["name"]
        return _rpc_result(request, {"approvals": [{"approval_id": "ap_1"}]})

    result = _gateway(handler).list_approvals(
        workspace_id="ws", actor_user_id="li-na", status="pending"
    )
    assert captured["name"] == "reimbursement.list_approvals"
    assert captured["workspace_id"] == "ws"
    assert captured["actor_user_id"] == "li-na"
    assert captured["status"] == "pending"
    assert result == {"approvals": [{"approval_id": "ap_1"}]}


def test_get_approval_passes_approval_id():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["params"]["arguments"]["approval_id"] == "ap_1"
        return _rpc_result(request, {"approval_id": "ap_1", "snapshot_hash": "h1"})

    out = _gateway(handler).get_approval(workspace_id="ws", actor_user_id="li-na", approval_id="ap_1")
    assert out["snapshot_hash"] == "h1"


def test_approve_sends_idempotency_and_snapshot_hash():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        args = body["params"]["arguments"]
        assert body["params"]["name"] == "reimbursement.approve"
        assert args["idempotency_key"] == "idem-1"
        assert args["expected_snapshot_hash"] == "h1"
        assert args["comment"] == "ok"
        return _rpc_result(request, {"approval_id": "ap_1", "status": "approved"})

    out = _gateway(handler).approve(
        workspace_id="ws", actor_user_id="li-na", approval_id="ap_1",
        idempotency_key="idem-1", expected_snapshot_hash="h1", comment="ok",
    )
    assert out["status"] == "approved"


def test_reject_requires_reason():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["params"]["arguments"]["reason"] == "金额超标"
        return _rpc_result(request, {"approval_id": "ap_1", "status": "rejected"})

    out = _gateway(handler).reject(
        workspace_id="ws", actor_user_id="li-na", approval_id="ap_1",
        reason="金额超标", idempotency_key="idem-2", expected_snapshot_hash="h1",
    )
    assert out["status"] == "rejected"


def test_approve_propagates_mcp_error_code():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"],
                  "error": {"code": "stale_snapshot", "message": "changed", "retryable": False}},
        )

    with pytest.raises(ReimbursementMcpError) as exc:
        _gateway(handler).approve(
            workspace_id="ws", actor_user_id="li-na", approval_id="ap_1",
            idempotency_key="idem-1", expected_snapshot_hash="stale",
        )
    assert exc.value.error_code == "stale_snapshot"


def test_status_flags_approval_supported_when_tools_present():
    tool_names = [
        "reimbursement.get_capabilities", "reimbursement.get_policy",
        "reimbursement.validate_draft", "reimbursement.create_draft",
        "reimbursement.submit", "reimbursement.get_status",
        "reimbursement.list_approvals", "reimbursement.get_approval",
        "reimbursement.approve", "reimbursement.reject",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                              "result": {"tools": [{"name": n} for n in tool_names]}})

    status = _gateway(handler).status()
    assert status["status"] == "connected"
    assert status["approval_supported"] is True


def test_status_approval_unsupported_when_tools_absent():
    tool_names = [
        "reimbursement.get_capabilities", "reimbursement.get_policy",
        "reimbursement.validate_draft", "reimbursement.create_draft",
        "reimbursement.submit", "reimbursement.get_status",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                              "result": {"tools": [{"name": n} for n in tool_names]}})

    status = _gateway(handler).status()
    assert status["status"] == "connected"
    assert status["approval_supported"] is False
