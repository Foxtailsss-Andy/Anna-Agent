import hashlib
import json

import httpx
import pytest

from services.mcp_gateway.app.reimbursement_adapter import (
    REQUIRED_REIMBURSEMENT_MCP_TOOLS,
    ReimbursementMcpError,
    ReimbursementMcpGateway,
)
from services.runtime.app.config import RuntimeSettings
from tests.mcp_gateway.local_reimbursement_mcp_server import (
    LocalReimbursementMcpContractServer,
)


def test_gateway_status_is_not_configured_without_mcp_server(monkeypatch):
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)

    status = ReimbursementMcpGateway(RuntimeSettings.from_env()).status()

    assert status["status"] == "not_configured"
    assert status["error_code"] == "connector_not_configured"


def test_gateway_refuses_to_create_fake_external_draft_without_connector(monkeypatch):
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    gateway = ReimbursementMcpGateway(RuntimeSettings.from_env())

    with pytest.raises(ReimbursementMcpError) as error:
        gateway.create_draft(
            workspace_id="demo",
            actor_user_id="u_demo",
            source_run_id="run_001",
            idempotency_key="idem_run_001_create",
            draft={"amount": 100, "currency": "CNY"},
        )

    assert error.value.error_code == "connector_not_configured"


def test_gateway_status_calls_external_mcp_tools_list():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": requests[-1]["id"],
                "result": {
                    "tools": [
                        {"name": "reimbursement.create_draft"},
                        {"name": "reimbursement.submit"},
                    ]
                },
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "unhealthy"
    assert status["error_code"] == "mcp_required_tools_missing"
    assert status["server"] == "https://mcp.example/rpc"
    assert status["tool_count"] == 2
    assert "reimbursement.get_capabilities" in status["missing_tools"]
    assert requests == [
        {
            "jsonrpc": "2.0",
            "id": "anna-1",
            "method": "tools/list",
            "params": {},
        }
    ]


def test_gateway_status_reports_connected_only_when_required_tools_exist():
    required_tools = [
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit",
        "reimbursement.get_status",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {
                    "tools": [{"name": tool_name} for tool_name in required_tools]
                },
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status == {
        "status": "connected",
        "server": "https://mcp.example/rpc",
        "tool_count": 6,
        "tool_names": required_tools,
        "tools": [{"name": tool_name} for tool_name in required_tools],
        "approval_supported": False,
    }


def test_gateway_status_preserves_discovered_tool_input_schemas():
    required_tools = [
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit",
        "reimbursement.get_status",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {
                    "tools": [
                        {
                            "name": tool_name,
                            "description": f"{tool_name} from MCP",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "mcp_field": {"type": "string"},
                                },
                                "required": ["mcp_field"],
                            },
                        }
                        for tool_name in required_tools
                    ]
                },
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "connected"
    assert status["tools"][0] == {
        "name": "reimbursement.get_capabilities",
        "description": "reimbursement.get_capabilities from MCP",
        "input_schema": {
            "type": "object",
            "properties": {
                "mcp_field": {"type": "string"},
            },
            "required": ["mcp_field"],
        },
    }


def test_gateway_status_reports_unhealthy_for_invalid_jsonrpc_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json")

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "unhealthy"
    assert status["error_code"] == "mcp_response_invalid"
    assert status["retryable"] is True


def test_gateway_status_reports_unhealthy_for_malformed_jsonrpc_error():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": "bad",
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "unhealthy"
    assert status["error_code"] == "mcp_response_invalid"
    assert status["retryable"] is True


def test_gateway_status_requires_valid_jsonrpc_envelope():
    required_tools = [
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit",
        "reimbursement.get_status",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "jsonrpc": "1.0",
                "id": "wrong-id",
                "result": {
                    "tools": [{"name": tool_name} for tool_name in required_tools]
                },
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    status = gateway.status()

    assert status["status"] == "unhealthy"
    assert status["error_code"] == "mcp_response_invalid"
    assert status["retryable"] is True


def test_required_mcp_tools_are_the_p0_backend_contract():
    assert REQUIRED_REIMBURSEMENT_MCP_TOOLS == (
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit",
        "reimbursement.get_status",
    )


def test_gateway_create_draft_calls_external_mcp_tool_and_returns_external_id():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": requests[-1]["id"],
                "result": {
                    "structuredContent": {
                        "external_reimbursement_id": "rbm_external_789",
                        "status": "draft_created",
                    }
                },
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    result = gateway.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        source_run_id="run_001",
        idempotency_key="idem_run_001_create",
        draft={"amount": 100, "currency": "CNY"},
    )

    assert result == {
        "external_reimbursement_id": "rbm_external_789",
        "status": "draft_created",
    }
    assert requests == [
        {
            "jsonrpc": "2.0",
            "id": "anna-1",
            "method": "tools/call",
            "params": {
                "name": "reimbursement.create_draft",
                "arguments": {
                    "workspace_id": "demo",
                    "actor_user_id": "u_demo",
                    "source": "Anna",
                    "source_run_id": "run_001",
                    "idempotency_key": "idem_run_001_create",
                    "draft": {"amount": 100, "currency": "CNY"},
                },
            },
        }
    ]


def test_gateway_sends_mcp_api_key_as_bearer_authorization_header():
    seen_headers = []
    seen_payloads = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers)
        seen_payloads.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": seen_payloads[-1]["id"],
                "result": {"tools": [{"name": name} for name in REQUIRED_REIMBURSEMENT_MCP_TOOLS]},
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(
            reimbursement_mcp_server="https://mcp.example/rpc",
            reimbursement_mcp_api_key="mcp-secret-key",
        ),
        transport=httpx.MockTransport(handler),
    )

    assert gateway.status()["status"] == "connected"
    assert seen_headers[0]["authorization"] == "Bearer mcp-secret-key"


def test_gateway_redacts_attachment_content_echoed_by_mcp_error():
    content_base64 = "cmVjZWlwdC1ieXRlcy1zZWNyZXQ="

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {
                    "code": "invalid_attachment",
                    "message": (
                        "bad attachment payload: "
                        f'{{"content_base64":"{content_base64}",'
                        '"api_key":"gateway-secret"}'
                    ),
                    "retryable": False,
                },
            },
        )

    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ReimbursementMcpError) as error:
        gateway.create_draft(
            workspace_id="demo",
            actor_user_id="u_demo",
            source_run_id="run_001",
            idempotency_key="idem_run_001_create",
            draft={
                "amount": 100,
                "currency": "CNY",
                "attachments": [
                    {
                        "name": "receipt.pdf",
                        "uri": "anna://attachment/hash/receipt.pdf",
                        "content_base64": content_base64,
                    }
                ],
            },
        )

    assert error.value.error_code == "invalid_attachment"
    assert error.value.message == (
        'bad attachment payload: {"content_base64":"[REDACTED]",'
        '"api_key":"[REDACTED]"}'
    )
    assert content_base64 not in error.value.message
    assert "gateway-secret" not in error.value.message


def test_gateway_runs_create_submit_status_against_local_contract_server():
    server = LocalReimbursementMcpContractServer()
    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server=server.url),
        transport=server.transport(),
    )

    assert gateway.status()["status"] == "connected"

    created = gateway.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        source_run_id="run_001",
        idempotency_key="idem_run_001_create",
        draft={
            "category": "meal",
            "amount": 860,
            "currency": "CNY",
            "expense_date": "2026-05-28",
            "merchant": "上海客户餐厅",
            "reason": "ACME 续约客户晚餐",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
        },
    )
    assert created["external_reimbursement_id"].startswith("contract-draft-")
    assert created["external_status"] == "draft"

    submitted = gateway.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        source_run_id="run_001",
        confirmation_id="approval_001",
        idempotency_key="idem_run_001_submit",
        external_reimbursement_id=created["external_reimbursement_id"],
        expected_draft_snapshot={
            "category": "meal",
            "amount": 860,
            "currency": "CNY",
            "expense_date": "2026-05-28",
            "merchant": "上海客户餐厅",
            "reason": "ACME 续约客户晚餐",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
            "external_reimbursement_id": created["external_reimbursement_id"],
            "external_status": "draft",
        },
        expected_draft_snapshot_hash=_draft_hash(
            {
                "category": "meal",
                "amount": 860,
                "currency": "CNY",
                "expense_date": "2026-05-28",
                "merchant": "上海客户餐厅",
                "reason": "ACME 续约客户晚餐",
                "department_id": "sales",
                "cost_center_id": "cc_acme",
                "external_reimbursement_id": created["external_reimbursement_id"],
                "external_status": "draft",
            }
        ),
    )
    assert submitted["external_reimbursement_id"] == created["external_reimbursement_id"]
    assert submitted["external_status"] == "submitted"

    status = gateway.get_status(
        workspace_id="demo",
        actor_user_id="u_demo",
        external_reimbursement_id=created["external_reimbursement_id"],
    )
    assert status["external_status"] == "submitted"
    assert [call["method"] for call in server.requests] == [
        "tools/list",
        "tools/call",
        "tools/call",
        "tools/call",
    ]


def test_contract_server_stores_uploaded_attachments_as_reference_snapshot():
    server = LocalReimbursementMcpContractServer()
    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server=server.url),
        transport=server.transport(),
    )
    attachment_ref = {
        "name": "invoice.pdf",
        "uri": "anna://attachment/" + "a" * 64 + "/invoice.pdf",
    }
    draft = {
        "category": "meal",
        "amount": 860,
        "currency": "CNY",
        "expense_date": "2026-05-28",
        "merchant": "上海客户餐厅",
        "reason": "ACME 续约客户晚餐",
        "department_id": "sales",
        "cost_center_id": "cc_acme",
        "attachments": [
            {
                **attachment_ref,
                "size_bytes": 13,
                "sha256": hashlib.sha256(b"receipt-bytes").hexdigest(),
                "content_base64": "cmVjZWlwdC1ieXRlcw==",
            }
        ],
    }

    gateway.status()
    created = gateway.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        source_run_id="run_001",
        idempotency_key="idem_run_001_create",
        draft=draft,
    )
    approved_snapshot = {
        **{key: value for key, value in draft.items() if key != "attachments"},
        "attachments": [attachment_ref],
        "external_reimbursement_id": created["external_reimbursement_id"],
        "external_status": "draft",
    }

    submitted = gateway.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        source_run_id="run_001",
        confirmation_id="approval_001",
        idempotency_key="idem_run_001_submit",
        external_reimbursement_id=created["external_reimbursement_id"],
        expected_draft_snapshot=approved_snapshot,
        expected_draft_snapshot_hash=_draft_hash(approved_snapshot),
    )
    status = gateway.get_status(
        workspace_id="demo",
        actor_user_id="u_demo",
        external_reimbursement_id=created["external_reimbursement_id"],
    )

    assert submitted["external_status"] == "submitted"
    assert status["attachments"] == [attachment_ref]
    assert "content_base64" not in json.dumps(status)


def test_contract_server_rejects_attachment_reference_without_upload_content():
    server = LocalReimbursementMcpContractServer()
    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server=server.url),
        transport=server.transport(),
    )

    with pytest.raises(ReimbursementMcpError) as error:
        gateway.create_draft(
            workspace_id="demo",
            actor_user_id="u_demo",
            source_run_id="run_001",
            idempotency_key="idem_run_001_create",
            draft={
                "category": "meal",
                "amount": 860,
                "currency": "CNY",
                "expense_date": "2026-05-28",
                "merchant": "上海客户餐厅",
                "reason": "ACME 续约客户晚餐",
                "department_id": "sales",
                "cost_center_id": "cc_acme",
                "attachments": [
                    {
                        "name": "invoice.pdf",
                        "uri": "anna://attachment/" + "a" * 64 + "/invoice.pdf",
                    }
                ],
            },
        )

    assert error.value.error_code == "attachment_content_required"
    assert error.value.retryable is False


def test_contract_server_rejects_submit_when_external_draft_changed_after_approval():
    server = LocalReimbursementMcpContractServer()
    gateway = ReimbursementMcpGateway(
        RuntimeSettings(reimbursement_mcp_server=server.url),
        transport=server.transport(),
    )
    draft = {
        "category": "meal",
        "amount": 860,
        "currency": "CNY",
        "expense_date": "2026-05-28",
        "merchant": "上海客户餐厅",
        "reason": "ACME 续约客户晚餐",
        "department_id": "sales",
        "cost_center_id": "cc_acme",
    }

    gateway.status()
    created = gateway.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        source_run_id="run_001",
        idempotency_key="idem_run_001_create",
        draft=draft,
    )
    approved_snapshot = {
        **draft,
        "external_reimbursement_id": created["external_reimbursement_id"],
        "external_status": "draft",
    }
    server.mutate_draft(
        created["external_reimbursement_id"],
        {"merchant": "审批后外部改动的商户"},
    )

    with pytest.raises(ReimbursementMcpError) as error:
        gateway.submit(
            workspace_id="demo",
            actor_user_id="u_demo",
            source_run_id="run_001",
            confirmation_id="approval_001",
            idempotency_key="idem_run_001_submit",
            external_reimbursement_id=created["external_reimbursement_id"],
            expected_draft_snapshot=approved_snapshot,
            expected_draft_snapshot_hash=_draft_hash(approved_snapshot),
        )

    assert error.value.error_code == "external_draft_snapshot_mismatch"


def _draft_hash(draft: dict) -> str:
    encoded = json.dumps(
        {"draft": draft},
        sort_keys=True,
        ensure_ascii=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
