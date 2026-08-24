from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any


def _runtime_validation_ledger_item(
    validation: dict[str, Any],
    validation_id: str,
    runtime_fingerprint: str | None = None,
) -> dict[str, Any]:
    model = validation.get("model", {})
    reimbursement_mcp = validation.get("reimbursement_mcp", {})
    read_probe = validation.get("reimbursement_mcp_read_probe", {})
    associate_execution = validation.get("erp_mcp_associate_execution_readiness", {})
    skill = validation.get("skill", {})
    tool_contract = validation.get("tool_contract", {})
    return {
        "validation_id": validation_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "runtime_fingerprint": runtime_fingerprint,
        "status": validation.get("status", "blocked"),
        "writes_external_data": bool(validation.get("writes_external_data")),
        "model_status": model.get("status", "unknown"),
        "model_error_code": model.get("error_code"),
        "reimbursement_mcp_status": reimbursement_mcp.get("status", "unknown"),
        "reimbursement_mcp_error_code": reimbursement_mcp.get("error_code"),
        "reimbursement_mcp_read_probe_status": read_probe.get("status", "unknown"),
        "reimbursement_mcp_read_probe_error_code": read_probe.get("error_code"),
        "associate_execution_status": associate_execution.get("status", "unknown"),
        "associate_execution_error_code": associate_execution.get("error_code"),
        "skill_loaded": bool(skill.get("loaded")),
        "tool_contract_status": _runtime_validation_tool_contract_status(tool_contract),
    }


def _runtime_validation_tool_contract_status(tool_contract: dict[str, Any]) -> str:
    if tool_contract.get("backend_submit_model_visible"):
        return "failed"
    snapshot = tool_contract.get("backend_submit_snapshot_contract", {})
    schema = tool_contract.get("mcp_schema_compatibility", {})
    if snapshot.get("status") == "failed" or schema.get("status") == "failed":
        return "failed"
    if snapshot.get("status") == "passed" and schema.get("status") == "passed":
        return "passed"
    return str(snapshot.get("status") or schema.get("status") or "unknown")


def _runtime_validation_ledger_response(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "summary": {
            "validation_count": len(items),
            "ready_count": sum(1 for item in items if item["status"] == "ready"),
            "blocked_count": sum(1 for item in items if item["status"] == "blocked"),
            "external_write_count": sum(
                1 for item in items if item["writes_external_data"]
            ),
        },
        "items": items,
    }


def _runtime_validation_report_response(items: list[dict[str, Any]]) -> dict[str, Any]:
    today = date.today().isoformat()
    return {
        "filename": f"anna-runtime-validation-report-{today}.md",
        "content_type": "text/markdown; charset=utf-8",
        "content": _runtime_validation_report_markdown(items),
    }


def _runtime_validation_report_markdown(items: list[dict[str, Any]]) -> str:
    summary = _runtime_validation_ledger_response(items)["summary"]
    lines = [
        "# Anna Runtime Validation Report",
        "",
        f"generated_at: {datetime.now(timezone.utc).isoformat()}",
        f"validation_count: {summary['validation_count']}",
        f"ready_count: {summary['ready_count']}",
        f"blocked_count: {summary['blocked_count']}",
        f"external_write_count: {summary['external_write_count']}",
    ]
    if not items:
        lines.extend(["", "No runtime validation records."])
        return "\n".join(lines) + "\n"

    for item in items:
        lines.extend(
            [
                "",
                f"## {item['validation_id']}",
                "",
                f"created_at: {item['created_at']}",
                f"status: {item['status']}",
                f"writes_external_data: {str(item['writes_external_data']).lower()}",
                f"model: {item['model_status']}",
                f"mcp: {item['reimbursement_mcp_status']}",
                f"mcp_read_probe: {item['reimbursement_mcp_read_probe_status']}",
                f"associate_execution: {item.get('associate_execution_status', 'unknown')}",
                f"skill_loaded: {str(item['skill_loaded']).lower()}",
                f"tool_contract: {item['tool_contract_status']}",
            ]
        )
        error_codes = [
            item.get("model_error_code"),
            item.get("reimbursement_mcp_error_code"),
            item.get("reimbursement_mcp_read_probe_error_code"),
            item.get("associate_execution_error_code"),
        ]
        visible_error_codes = [code for code in error_codes if code]
        if visible_error_codes:
            lines.append(f"error_codes: {', '.join(visible_error_codes)}")
    return "\n".join(lines) + "\n"
