from __future__ import annotations

import itertools
import json
from typing import Any

import httpx

from services.runtime.app.config import RuntimeSettings


REQUIRED_ASSOCIATE_READ_MCP_TOOLS = ("erp.finance.get_receivables_aging",)
REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS = (
    "erp.collection_task.create_draft",
    "erp.collection_task.get_status",
)


class ErpMcpError(Exception):
    def __init__(self, error_code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.retryable = retryable

    def as_contract(self) -> dict:
        return {
            "error_code": self.error_code,
            "message": self.message,
            "retryable": self.retryable,
        }


class ErpMcpGateway:
    def __init__(
        self,
        settings: RuntimeSettings | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self._transport = transport
        self._ids = itertools.count(1)

    def status(self) -> dict[str, Any]:
        if not self.settings.erp_mcp_server:
            return {
                "status": "not_configured",
                "error_code": "connector_not_configured",
            }
        try:
            result = self._json_rpc("tools/list", {})
        except ErpMcpError as exc:
            return {"status": "unhealthy", **exc.as_contract()}
        tools = result.get("tools", []) if isinstance(result, dict) else []
        tool_names = _extract_tool_names(tools)
        tool_metadata = _extract_tool_metadata(tools)
        missing_tools = [
            tool_name
            for tool_name in REQUIRED_ASSOCIATE_READ_MCP_TOOLS
            if tool_name not in tool_names
        ]
        if missing_tools:
            return {
                "status": "unhealthy",
                "tool_count": len(tool_names),
                "tool_names": tool_names,
                "tools": tool_metadata,
                "missing_tools": missing_tools,
                "error_code": "mcp_required_tools_missing",
                "message": "ERP MCP server is missing required Associate tools",
                "retryable": False,
            }
        return {
            "status": "connected",
            "tool_count": len(tool_names),
            "tool_names": tool_names,
            "tools": tool_metadata,
        }

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self._json_rpc(
            "tools/call",
            {"name": tool_name, "arguments": arguments},
        )
        return _extract_tool_payload(result)

    def _json_rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.erp_mcp_server:
            raise ErpMcpError(
                "connector_not_configured",
                "ERP MCP connector is not configured",
                retryable=False,
            )
        payload = {
            "jsonrpc": "2.0",
            "id": f"anna-erp-{next(self._ids)}",
            "method": method,
            "params": params,
        }
        try:
            with httpx.Client(timeout=30, transport=self._transport) as client:
                response = client.post(
                    self.settings.erp_mcp_server,
                    json=payload,
                    headers=self._request_headers(),
                )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ErpMcpError("mcp_call_failed", str(exc), retryable=True) from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise ErpMcpError(
                "mcp_response_invalid",
                "MCP response was not valid JSON",
                retryable=True,
            ) from exc
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0" or body.get("id") != payload["id"]:
            raise ErpMcpError(
                "mcp_response_invalid",
                "MCP response JSON-RPC envelope was invalid",
                retryable=True,
            )
        if "error" in body:
            error = body["error"] if isinstance(body["error"], dict) else {}
            raise ErpMcpError(
                str(error.get("code", "mcp_error")),
                str(error.get("message", "MCP tool call failed")),
                retryable=bool(error.get("retryable", True)),
            )
        result = body.get("result")
        if not isinstance(result, dict):
            raise ErpMcpError(
                "mcp_response_invalid",
                "MCP response did not include a structured result",
                retryable=True,
            )
        return result

    def _request_headers(self) -> dict[str, str] | None:
        if not self.settings.erp_mcp_api_key:
            return None
        return {"Authorization": f"Bearer {self.settings.erp_mcp_api_key}"}


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


def _extract_tool_metadata(tools: Any) -> list[dict[str, Any]]:
    if not isinstance(tools, list):
        return []
    metadata: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if not isinstance(name, str):
            continue
        item: dict[str, Any] = {"name": name}
        input_schema = tool.get("inputSchema", tool.get("input_schema"))
        if isinstance(input_schema, dict):
            item["input_schema"] = input_schema
        metadata.append(item)
    return metadata
