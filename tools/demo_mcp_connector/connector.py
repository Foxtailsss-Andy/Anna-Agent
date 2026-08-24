"""Demo MCP connector core: real MCP JSON-RPC handlers for two endpoints.

The same pure handlers back both the in-process httpx transports used by
tests and the FastAPI app used for real serving (see app.py). The connector
is stateful within a process so a created reimbursement draft / collection
task can be read back, exactly like a real connector.
"""
from __future__ import annotations

import itertools
from typing import Any

import httpx

from services.mcp_gateway.app.erp_adapter import (
    REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS,
    REQUIRED_ASSOCIATE_READ_MCP_TOOLS,
)
from services.mcp_gateway.app.reimbursement_adapter import (
    REQUIRED_REIMBURSEMENT_MCP_TOOLS,
)

from . import data

ERP_TOOLS = (
    *REQUIRED_ASSOCIATE_READ_MCP_TOOLS,
    *REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS,
)


class DemoMcpConnector:
    def __init__(self) -> None:
        self._drafts: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, dict[str, Any]] = {}
        self._draft_ids = itertools.count(1)
        self._task_ids = itertools.count(1)

    # -- transports for tests -------------------------------------------------
    def reimbursement_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(
            lambda request: _to_response(request, self.handle_reimbursement)
        )

    def erp_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(lambda request: _to_response(request, self.handle_erp))

    # -- reimbursement contract ----------------------------------------------
    def handle_reimbursement(self, body: dict[str, Any]) -> dict[str, Any]:
        method = body.get("method")
        if method == "tools/list":
            return _ok(body, {"tools": [_reimbursement_tool_metadata(name) for name in REQUIRED_REIMBURSEMENT_MCP_TOOLS]})
        if method != "tools/call":
            return _err(body, "method_not_found", f"unsupported method: {method}")
        name, arguments = _call_params(body)
        if arguments is None:
            return _err(body, "invalid_arguments", "arguments must be an object")

        if name == "reimbursement.get_capabilities":
            return _ok(body, _structured({
                "categories": ["travel", "meal", "office", "transport", "other"],
                "currencies": ["CNY"],
                "supports_attachments": True,
                "supports_create_draft": True,
                "supports_submit": True,
                "required_fields": [
                    "category", "amount", "currency", "expense_date",
                    "merchant", "reason", "department_id", "cost_center_id",
                ],
                "attachment_required_above_amount": 0,
            }))
        if name == "reimbursement.get_policy":
            return _ok(body, _structured({
                "risk_level": "low",
                "requires_confirmation": True,
                "requires_manager_approval": True,
                "policy_checks": [],
                "blocked": False,
                "policy_summary": f"{data.DEMO_MARK}：金额在演示租户报销限额内。",
            }))
        if name == "reimbursement.validate_draft":
            return _ok(body, _structured({
                "valid": True,
                "missing_fields": [],
                "normalized_draft": arguments.get("draft", {}),
                "policy_summary": f"{data.DEMO_MARK}：草稿校验通过。",
                "risk_level": "low",
            }))
        if name == "reimbursement.create_draft":
            external_id = f"demo-reimb-{next(self._draft_ids):04d}"
            draft = dict(arguments.get("draft", {}))
            self._drafts[external_id] = {
                **draft,
                "external_reimbursement_id": external_id,
                "external_status": "draft",
            }
            return _ok(body, _structured({
                "external_reimbursement_id": external_id,
                "external_status": "draft",
                "created": True,
                "idempotent_replay": False,
            }))
        if name == "reimbursement.submit":
            external_id = str(arguments.get("external_reimbursement_id", ""))
            draft = self._drafts.get(external_id)
            if draft is None:
                return _err(body, "draft_not_found", "external reimbursement draft was not found")
            draft["external_status"] = "submitted"
            return _ok(body, _structured({
                "external_reimbursement_id": external_id,
                "external_status": "submitted",
                "submitted": True,
            }))
        if name == "reimbursement.get_status":
            external_id = str(arguments.get("external_reimbursement_id", ""))
            draft = self._drafts.get(external_id)
            if draft is None:
                return _err(body, "draft_not_found", "external reimbursement draft was not found")
            return _ok(body, _structured(dict(draft)))
        return _err(body, "tool_not_found", f"unsupported tool: {name}")

    # -- ERP contract ---------------------------------------------------------
    def handle_erp(self, body: dict[str, Any]) -> dict[str, Any]:
        method = body.get("method")
        if method == "tools/list":
            return _ok(body, {"tools": [{"name": name} for name in ERP_TOOLS]})
        if method != "tools/call":
            return _err(body, "method_not_found", f"unsupported method: {method}")
        name, arguments = _call_params(body)
        if arguments is None:
            return _err(body, "invalid_arguments", "arguments must be an object")

        if name == "erp.finance.get_receivables_aging":
            period = str(arguments.get("period") or "2026-06")
            overdue_days = float(arguments.get("overdue_days") or 30)
            return _ok(body, _structured(data.receivables_aging(period, overdue_days)))
        if name == "erp.collection_task.create_draft":
            external_task_id = f"demo-task-{next(self._task_ids):04d}"
            payload = arguments.get("payload", {})
            self._tasks[external_task_id] = {
                "external_task_id": external_task_id,
                "external_status": "created",
                "payload": payload,
                "note": data.DEMO_MARK,
            }
            return _ok(body, _structured(dict(self._tasks[external_task_id])))
        if name == "erp.collection_task.get_status":
            external_task_id = str(arguments.get("external_task_id", ""))
            task = self._tasks.get(external_task_id)
            if task is None:
                return _err(body, "task_not_found", "external collection task was not found")
            return _ok(body, _structured(dict(task)))
        return _err(body, "tool_not_found", f"unsupported tool: {name}")


def _reimbursement_tool_metadata(tool_name: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {"name": tool_name}
    if tool_name == "reimbursement.submit":
        # Declare the approval-snapshot contract Anna's backend submit relies on.
        metadata["inputSchema"] = {
            "type": "object",
            "properties": {
                "external_reimbursement_id": {"type": "string"},
                "idempotency_key": {"type": "string"},
                "expected_draft_snapshot": {"type": "object"},
                "expected_draft_snapshot_hash": {"type": "string"},
            },
            "required": ["external_reimbursement_id"],
        }
    return metadata


def _call_params(body: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    params = body.get("params", {})
    if not isinstance(params, dict):
        return "", None
    arguments = params.get("arguments", {})
    if not isinstance(arguments, dict):
        return str(params.get("name", "")), None
    return str(params.get("name", "")), arguments


def _structured(payload: dict[str, Any]) -> dict[str, Any]:
    return {"structuredContent": payload}


def _ok(body: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": body.get("id"), "result": result}


def _err(body: dict[str, Any], code: str, message: str, retryable: bool = False) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": body.get("id"),
        "error": {"code": code, "message": message, "retryable": retryable},
    }


def _to_response(request: httpx.Request, handler) -> httpx.Response:
    import json

    body = json.loads(request.content)
    return httpx.Response(200, json=handler(body))
