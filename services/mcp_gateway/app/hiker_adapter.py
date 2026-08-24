from __future__ import annotations

import itertools
import json
from typing import Any

import httpx

from services.runtime.app.config import RuntimeSettings


REQUIRED_HIKER_MCP_TOOLS = (
    "hiker.system.list_capabilities",
    "hiker.system.get_current_user_context",
    "hiker.master_data.search",
    "hiker.master_data.get_detail",
    "hiker.contract.list_contracts",
    "hiker.contract.get_contract_detail",
    "hiker.contract.get_business_chain",
    "hiker.report.get_dashboard_summary",
    "hiker.report.get_collection_summary",
    "hiker.report.get_invoice_summary",
    "hiker.report.get_po_receivable_summary",
)
FORBIDDEN_HIKER_MCP_TOOLS = (
    "hiker.execute_sql",
    "hiker.call_api",
    "hiker.update_record",
    "hiker.delete_record",
    "hiker.admin.reset_password",
    "hiker.file.read_any_path",
)


class HikerMcpError(Exception):
    def __init__(self, error_code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.retryable = retryable

    def as_contract(self) -> dict:
        return {"error_code": self.error_code, "message": self.message, "retryable": self.retryable}


class HikerMcpGateway:
    def __init__(
        self,
        settings: RuntimeSettings | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self._transport = transport
        self._ids = itertools.count(1)

    def status(self) -> dict[str, Any]:
        if not self.settings.hiker_mcp_server:
            return {"status": "not_configured", "error_code": "connector_not_configured"}
        try:
            result = self._json_rpc("tools/list", {})
        except HikerMcpError as exc:
            return {"status": "unhealthy", **exc.as_contract()}
        tools = result.get("tools", []) if isinstance(result, dict) else []
        tool_names = _extract_tool_names(tools)
        missing = [name for name in REQUIRED_HIKER_MCP_TOOLS if name not in tool_names]
        if missing:
            return {
                "status": "unhealthy",
                "tool_count": len(tool_names),
                "tool_names": tool_names,
                "missing_tools": missing,
                "error_code": "mcp_required_tools_missing",
                "message": "Hiker MCP server is missing required tools",
                "retryable": False,
            }
        return {"status": "connected", "tool_count": len(tool_names), "tool_names": tool_names}

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self._json_rpc("tools/call", {"name": tool_name, "arguments": arguments})
        return _extract_tool_payload(result)

    def _json_rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.hiker_mcp_server:
            raise HikerMcpError("connector_not_configured", "Hiker MCP connector is not configured", retryable=False)
        payload = {
            "jsonrpc": "2.0",
            "id": f"anna-hiker-{next(self._ids)}",
            "method": method,
            "params": params,
        }
        try:
            with httpx.Client(timeout=30, transport=self._transport) as client:
                response = client.post(
                    self.settings.hiker_mcp_server,
                    json=payload,
                    headers=self._request_headers(),
                )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            code = "unauthorized" if exc.response.status_code == 401 else "mcp_call_failed"
            raise HikerMcpError(code, str(exc), retryable=exc.response.status_code >= 500) from exc
        except httpx.HTTPError as exc:
            raise HikerMcpError("mcp_call_failed", str(exc), retryable=True) from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise HikerMcpError("mcp_response_invalid", "MCP response was not valid JSON", retryable=True) from exc
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0" or body.get("id") != payload["id"]:
            raise HikerMcpError("mcp_response_invalid", "MCP response JSON-RPC envelope was invalid", retryable=True)
        # Hiker always returns an explicit `retryable` in its error envelope;
        # default to non-retryable so unknown errors are not blindly retried
        # (per Hiker 对接说明 §5: 401/permission_denied/validation_failed 不盲目重试).
        if "error" in body:
            error = body["error"] if isinstance(body["error"], dict) else {}
            raise HikerMcpError(
                str(error.get("code", "mcp_error")),
                str(error.get("message", "MCP tool call failed")),
                retryable=bool(error.get("retryable", False)),
            )
        result = body.get("result")
        if not isinstance(result, dict):
            raise HikerMcpError("mcp_response_invalid", "MCP response did not include a structured result", retryable=True)
        return result

    def _request_headers(self) -> dict[str, str] | None:
        if not self.settings.hiker_mcp_api_key:
            return None
        return {"Authorization": f"Bearer {self.settings.hiker_mcp_api_key}"}


def _extract_tool_payload(result: dict[str, Any]) -> dict[str, Any]:
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                try:
                    decoded = json.loads(item["text"])
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    return decoded
    if "result" in result and isinstance(result["result"], dict):
        return result["result"]
    return result


def _extract_tool_names(tools: Any) -> list[str]:
    if not isinstance(tools, list):
        return []
    return [tool["name"] for tool in tools if isinstance(tool, dict) and isinstance(tool.get("name"), str)]
