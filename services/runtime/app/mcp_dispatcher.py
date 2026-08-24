from __future__ import annotations

import json
from typing import Any, Callable, Iterable

from services.reimbursement.app.audit import AuditEvent, AuditService
from services.runtime.app.model_provider import ModelResponse


def model_and_connector_preflight(
    model_settings: Any,
    adapter: Any,
    *,
    not_configured_message: str,
    not_connected_message: str,
) -> tuple[tuple[str, str] | None, dict[str, Any] | None]:
    """Fail-fast MCP preflight used by the finance and associate orchestrators.

    Checks model credentials first, then ``adapter.status()``. Returns
    ``(error, mcp_status)`` where ``error`` is ``(error_code, message)`` or
    ``None`` when the connector is ready.
    """
    if not model_settings.model_api_key or not model_settings.model_endpoint:
        return ("model_not_configured", not_configured_message), None
    mcp_status = adapter.status()
    if mcp_status.get("status") != "connected":
        return (
            (
                str(mcp_status.get("error_code") or "mcp_connector_not_ready"),
                str(mcp_status.get("message") or not_connected_message),
            ),
            mcp_status,
        )
    return None, mcp_status


def connector_preflight_when_model_configured(
    model_settings: Any,
    adapter: Any,
    *,
    not_connected_message: str,
) -> tuple[tuple[str, str] | None, dict[str, Any] | None]:
    """Reimbursement-style MCP preflight.

    When the model is not configured the connector status is not checked at
    all (``(None, None)``); the missing model configuration surfaces later
    through the harness model call.
    """
    if not (model_settings.model_api_key and model_settings.model_endpoint):
        return None, None
    mcp_status = adapter.status()
    if mcp_status.get("status") == "connected":
        return None, mcp_status
    return (
        (
            str(mcp_status.get("error_code") or "mcp_connector_not_ready"),
            str(mcp_status.get("message") or not_connected_message),
        ),
        mcp_status,
    )


def missing_required_tools(
    mcp_status: dict[str, Any],
    required_tools: Iterable[str],
) -> list[str]:
    tool_names = mcp_status.get("tool_names")
    if not isinstance(tool_names, list):
        return sorted(required_tools)
    return sorted(set(required_tools) - {str(name) for name in tool_names})


def assistant_tool_call_message(model_response: ModelResponse) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": model_response.assistant_message,
        "tool_calls": [
            {
                "id": tool_call.id,
                "type": "function",
                "function": {
                    "name": tool_call.name,
                    "arguments": json.dumps(
                        tool_call.arguments,
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                },
            }
            for tool_call in model_response.tool_calls
        ],
    }


def tool_observation_message(tool_call: Any, tool_result: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": tool_call.id,
        "name": tool_call.name,
        "content": json.dumps(tool_result, ensure_ascii=False, sort_keys=True),
    }


class McpToolDispatcher:
    """Audited MCP tool dispatch shared by the ERP-backed orchestrators.

    ``error_type`` and ``error_contract`` parameterize the per-domain MCP
    error class (``ErpMcpError`` / ``ReimbursementMcpError``) and the audit
    ``error`` payload builder so that event payloads stay byte-identical.
    """

    def __init__(
        self,
        adapter: Any,
        audit: AuditService,
        hash_payload: Callable[[dict[str, Any]], str],
        error_type: type[Exception],
        error_contract: Callable[[Any], dict[str, Any]],
    ) -> None:
        self.adapter = adapter
        self.audit = audit
        self._hash_payload = hash_payload
        self._error_type = error_type
        self._error_contract = error_contract

    def record_tool_called(
        self,
        audit_events: list[AuditEvent],
        run_id: str,
        tool_name: str,
        input_payload: dict[str, Any],
        status: str,
        error: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "tool_name": tool_name,
            "input_hash": self._hash_payload(input_payload),
            "status": status,
        }
        if error is not None:
            payload["error"] = error
        self.audit.append(audit_events, "mcp.tool.called", run_id, payload)

    def call_tool_audited(
        self,
        audit_events: list[AuditEvent],
        run_id: str,
        tool_name: str,
        input_payload: dict[str, Any],
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        """Call an MCP tool and record the ``mcp.tool.called`` audit event.

        ``input_payload`` is what gets hashed into the audit event (the
        domains historically hash the raw model arguments, not the enriched
        MCP arguments). On failure the audit event carries the per-domain
        error contract and the original exception is re-raised.
        """
        try:
            tool_result = self.adapter.call_tool(tool_name, arguments)
        except self._error_type as exc:
            self.record_tool_called(
                audit_events,
                run_id,
                tool_name,
                input_payload,
                "failed",
                error=self._error_contract(exc),
            )
            raise
        self.record_tool_called(audit_events, run_id, tool_name, input_payload, "success")
        return tool_result
