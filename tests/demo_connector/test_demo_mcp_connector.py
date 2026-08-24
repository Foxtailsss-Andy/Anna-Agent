"""The demo MCP connector must satisfy the real Anna MCP client contracts.

These tests drive the production ReimbursementMcpGateway and Associate ERP gateway
against the demo connector over a real JSON-RPC envelope (httpx transport),
and validate every tool result against the real Pydantic schemas. The demo
connector is an external server Anna talks to over the wire; Anna's product
code has no knowledge that it is a demo tenant.
"""
from __future__ import annotations

from services.mcp_gateway.app.erp_adapter import (
    REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS,
    REQUIRED_ASSOCIATE_READ_MCP_TOOLS,
    ErpMcpGateway,
)
from services.mcp_gateway.app.reimbursement_adapter import (
    REQUIRED_REIMBURSEMENT_MCP_TOOLS,
    ReimbursementMcpGateway,
)
from services.runtime.app.config import RuntimeSettings
from tools.demo_mcp_connector.connector import DemoMcpConnector


def _reimbursement_gateway(connector: DemoMcpConnector) -> ReimbursementMcpGateway:
    settings = RuntimeSettings(
        reimbursement_mcp_server="https://demo-connector.local/reimbursement/rpc",
    )
    return ReimbursementMcpGateway(settings, transport=connector.reimbursement_transport())


def _erp_gateway(connector: DemoMcpConnector) -> ErpMcpGateway:
    settings = RuntimeSettings(erp_mcp_server="https://demo-connector.local/erp/rpc")
    return ErpMcpGateway(settings, transport=connector.erp_transport())


def test_reimbursement_gateway_reports_connected_with_all_required_tools():
    gateway = _reimbursement_gateway(DemoMcpConnector())

    status = gateway.status()

    assert status["status"] == "connected"
    for tool_name in REQUIRED_REIMBURSEMENT_MCP_TOOLS:
        assert tool_name in status["tool_names"]


def test_erp_gateway_reports_connected_with_associate_tools():
    gateway = _erp_gateway(DemoMcpConnector())

    status = gateway.status()

    assert status["status"] == "connected"
    for tool_name in (*REQUIRED_ASSOCIATE_READ_MCP_TOOLS, *REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS):
        assert tool_name in status["tool_names"]


def test_reimbursement_submit_tool_exposes_snapshot_contract_schema():
    # A compliant reimbursement connector must declare that submit accepts the
    # approval snapshot fields so Anna's backend can pass its snapshot evidence.
    gateway = _reimbursement_gateway(DemoMcpConnector())

    status = gateway.status()

    submit_tool = next(
        tool for tool in status["tools"] if tool["name"] == "reimbursement.submit"
    )
    properties = submit_tool["input_schema"]["properties"]
    assert "expected_draft_snapshot" in properties
    assert "expected_draft_snapshot_hash" in properties


def test_reimbursement_full_write_and_readback_cycle():
    connector = DemoMcpConnector()
    gateway = _reimbursement_gateway(connector)

    capabilities = gateway.call_tool("reimbursement.get_capabilities", {})
    assert "category" in capabilities["required_fields"]

    draft = {
        "category": "travel",
        "amount": 1280.0,
        "currency": "CNY",
        "expense_date": "2026-06-09",
        "merchant": "演示供应商",
        "reason": "客户拜访差旅",
        "department_id": "DEPT-DEMO",
        "cost_center_id": "CC-DEMO",
    }
    validation = gateway.call_tool(
        "reimbursement.validate_draft",
        {"draft": draft},
    )
    assert validation["valid"] is True

    created = gateway.call_tool(
        "reimbursement.create_draft",
        {"source_run_id": "run_demo_1", "idempotency_key": "idem-1", "draft": draft},
    )
    external_id = created["external_reimbursement_id"]
    assert external_id
    assert created["external_status"] == "draft"

    submitted = gateway.call_tool(
        "reimbursement.submit",
        {"external_reimbursement_id": external_id, "idempotency_key": "idem-1"},
    )
    assert submitted["external_status"] == "submitted"

    status = gateway.call_tool(
        "reimbursement.get_status",
        {"external_reimbursement_id": external_id},
    )
    assert status["external_status"] == "submitted"


def test_associate_receivables_aging_returns_rows():
    gateway = _erp_gateway(DemoMcpConnector())

    result = gateway.call_tool(
        "erp.finance.get_receivables_aging",
        {"period": "2026-06", "overdue_days": 30},
    )

    assert isinstance(result.get("rows"), list)
    assert result["rows"]


def test_associate_collection_task_write_and_readback_match():
    connector = DemoMcpConnector()
    gateway = _erp_gateway(connector)

    created = gateway.call_tool(
        "erp.collection_task.create_draft",
        {
            "workspace_id": "demo",
            "node_id": "node-1",
            "idempotency_key": "assoc-1",
            "payload": {"customer": "演示客户A", "amount": 50000.0},
        },
    )
    external_task_id = created.get("external_task_id") or created.get("id")
    assert external_task_id

    readback = gateway.call_tool(
        "erp.collection_task.get_status",
        {"external_task_id": external_task_id},
    )
    readback_id = readback.get("external_task_id") or readback.get("id")
    assert readback_id == external_task_id
    assert (readback.get("external_status") or readback.get("status")) == (
        created.get("external_status") or created.get("status")
    )


def test_connector_rejects_unknown_tool():
    connector = DemoMcpConnector()
    gateway = _erp_gateway(connector)

    try:
        gateway.call_tool("erp.finance.unknown_tool", {})
    except Exception as exc:  # noqa: BLE001 - asserting the gateway raised
        assert "unknown_tool" in str(exc) or "tool_not_found" in str(exc)
    else:
        raise AssertionError("expected the connector to reject an unknown tool")
