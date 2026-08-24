from __future__ import annotations

import itertools
import json
import re
from typing import Any

import httpx

from services.runtime.app.config import RuntimeSettings

REQUIRED_REIMBURSEMENT_MCP_TOOLS = (
    "reimbursement.get_capabilities",
    "reimbursement.get_policy",
    "reimbursement.validate_draft",
    "reimbursement.create_draft",
    "reimbursement.submit",
    "reimbursement.get_status",
)

OPTIONAL_REIMBURSEMENT_APPROVAL_TOOLS = (
    "reimbursement.list_approvals",
    "reimbursement.get_approval",
    "reimbursement.approve",
    "reimbursement.reject",
)


class ReimbursementMcpError(Exception):
    def __init__(
        self,
        error_code: str,
        message: str,
        retryable: bool,
        field: str | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.retryable = retryable
        self.field = field

    def as_contract(self) -> dict:
        error = {
            "error_code": self.error_code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.field:
            error["field"] = self.field
        return error


class ReimbursementMcpGateway:
    def __init__(
        self,
        settings: RuntimeSettings | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self._transport = transport
        self._ids = itertools.count(1)

    def status(self) -> dict[str, Any]:
        if not self.settings.reimbursement_mcp_server:
            return {
                "status": "not_configured",
                "error_code": "connector_not_configured",
            }
        try:
            result = self._json_rpc("tools/list", {})
        except ReimbursementMcpError as exc:
            return {"status": "unhealthy", **exc.as_contract()}
        tools = result.get("tools", []) if isinstance(result, dict) else []
        tool_names = _extract_tool_names(tools)
        tool_metadata = _extract_tool_metadata(tools)
        missing_tools = [
            tool_name
            for tool_name in REQUIRED_REIMBURSEMENT_MCP_TOOLS
            if tool_name not in tool_names
        ]
        if missing_tools:
            return {
                "status": "unhealthy",
                "server": self.settings.reimbursement_mcp_server,
                "tool_count": len(tool_names),
                "tool_names": tool_names,
                "tools": tool_metadata,
                "missing_tools": missing_tools,
                "error_code": "mcp_required_tools_missing",
                "message": "reimbursement MCP server is missing required tools",
                "retryable": False,
            }
        return {
            "status": "connected",
            "server": self.settings.reimbursement_mcp_server,
            "tool_count": len(tool_names),
            "tool_names": tool_names,
            "tools": tool_metadata,
            "approval_supported": all(
                tool in tool_names for tool in OPTIONAL_REIMBURSEMENT_APPROVAL_TOOLS
            ),
        }

    def get_capabilities(self, workspace_id: str, actor_user_id: str) -> dict:
        return self.call_tool(
            "reimbursement.get_capabilities",
            {"workspace_id": workspace_id, "actor_user_id": actor_user_id},
        )

    def get_policy(
        self,
        workspace_id: str,
        actor_user_id: str,
        category: str,
        amount: float,
        currency: str,
        department_id: str,
        cost_center_id: str,
    ) -> dict:
        return self.call_tool(
            "reimbursement.get_policy",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "category": category,
                "amount": amount,
                "currency": currency,
                "department_id": department_id,
                "cost_center_id": cost_center_id,
            },
        )

    def validate_draft(
        self,
        workspace_id: str,
        actor_user_id: str,
        draft: dict,
    ) -> dict:
        return self.call_tool(
            "reimbursement.validate_draft",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "draft": draft,
            },
        )

    def create_draft(
        self,
        workspace_id: str,
        actor_user_id: str,
        source_run_id: str,
        idempotency_key: str,
        draft: dict,
    ) -> dict:
        return self.call_tool(
            "reimbursement.create_draft",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "source": "Anna",
                "source_run_id": source_run_id,
                "idempotency_key": idempotency_key,
                "draft": draft,
            },
        )

    def submit(
        self,
        workspace_id: str,
        actor_user_id: str,
        source_run_id: str,
        confirmation_id: str,
        idempotency_key: str,
        external_reimbursement_id: str,
        expected_draft_snapshot: dict[str, Any] | None = None,
        expected_draft_snapshot_hash: str | None = None,
    ) -> dict:
        arguments = {
            "workspace_id": workspace_id,
            "actor_user_id": actor_user_id,
            "source": "Anna",
            "source_run_id": source_run_id,
            "confirmation_id": confirmation_id,
            "idempotency_key": idempotency_key,
            "external_reimbursement_id": external_reimbursement_id,
        }
        if expected_draft_snapshot is not None:
            arguments["expected_draft_snapshot"] = expected_draft_snapshot
        if expected_draft_snapshot_hash is not None:
            arguments["expected_draft_snapshot_hash"] = expected_draft_snapshot_hash
        return self.call_tool("reimbursement.submit", arguments)

    def get_status(
        self,
        workspace_id: str,
        actor_user_id: str,
        external_reimbursement_id: str,
    ) -> dict:
        return self.call_tool(
            "reimbursement.get_status",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "external_reimbursement_id": external_reimbursement_id,
            },
        )

    def list_approvals(
        self,
        workspace_id: str,
        actor_user_id: str,
        status: str = "pending",
        filters: dict[str, Any] | None = None,
    ) -> dict:
        arguments: dict[str, Any] = {
            "workspace_id": workspace_id,
            "actor_user_id": actor_user_id,
            "status": status,
        }
        if filters:
            arguments["filters"] = filters
        return self.call_tool("reimbursement.list_approvals", arguments)

    def get_approval(self, workspace_id: str, actor_user_id: str, approval_id: str) -> dict:
        return self.call_tool(
            "reimbursement.get_approval",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "approval_id": approval_id,
            },
        )

    def approve(
        self,
        workspace_id: str,
        actor_user_id: str,
        approval_id: str,
        idempotency_key: str,
        expected_snapshot_hash: str,
        comment: str | None = None,
    ) -> dict:
        arguments: dict[str, Any] = {
            "workspace_id": workspace_id,
            "actor_user_id": actor_user_id,
            "approval_id": approval_id,
            "idempotency_key": idempotency_key,
            "expected_snapshot_hash": expected_snapshot_hash,
        }
        if comment:
            arguments["comment"] = comment
        return self.call_tool("reimbursement.approve", arguments)

    def reject(
        self,
        workspace_id: str,
        actor_user_id: str,
        approval_id: str,
        reason: str,
        idempotency_key: str,
        expected_snapshot_hash: str,
    ) -> dict:
        return self.call_tool(
            "reimbursement.reject",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "approval_id": approval_id,
                "reason": reason,
                "idempotency_key": idempotency_key,
                "expected_snapshot_hash": expected_snapshot_hash,
            },
        )

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._call_tool(tool_name, arguments)

    def _call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self._json_rpc(
            "tools/call",
            {"name": tool_name, "arguments": arguments},
        )
        return _extract_tool_payload(result)

    def _json_rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.reimbursement_mcp_server:
            raise ReimbursementMcpError(
                "connector_not_configured",
                "reimbursement MCP connector is not configured",
                retryable=False,
            )
        payload = {
            "jsonrpc": "2.0",
            "id": f"anna-{next(self._ids)}",
            "method": method,
            "params": params,
        }
        try:
            with httpx.Client(timeout=30, transport=self._transport) as client:
                response = client.post(
                    self.settings.reimbursement_mcp_server,
                    json=payload,
                    headers=self._request_headers(),
                )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ReimbursementMcpError(
                "mcp_call_failed",
                _redact_secrets(str(exc)),
                retryable=True,
            ) from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise ReimbursementMcpError(
                "mcp_response_invalid",
                "MCP response was not valid JSON",
                retryable=True,
            ) from exc
        if not isinstance(body, dict):
            raise ReimbursementMcpError(
                "mcp_response_invalid",
                "MCP response did not include a JSON-RPC object",
                retryable=True,
            )
        if body.get("jsonrpc") != "2.0" or body.get("id") != payload["id"]:
            raise ReimbursementMcpError(
                "mcp_response_invalid",
                "MCP response JSON-RPC envelope was invalid",
                retryable=True,
            )
        if "error" in body:
            error = body["error"]
            if not isinstance(error, dict):
                raise ReimbursementMcpError(
                    "mcp_response_invalid",
                    "MCP response error was not structured",
                    retryable=True,
                )
            raise ReimbursementMcpError(
                str(error.get("code", "mcp_error")),
                _redact_secrets(str(error.get("message", "MCP tool call failed"))),
                retryable=bool(error.get("retryable", True)),
            )
        result = body.get("result")
        if not isinstance(result, dict):
            raise ReimbursementMcpError(
                "mcp_response_invalid",
                "MCP response did not include a structured result",
                retryable=True,
            )
        return result

    def _request_headers(self) -> dict[str, str] | None:
        if not self.settings.reimbursement_mcp_api_key:
            return None
        return {"Authorization": f"Bearer {self.settings.reimbursement_mcp_api_key}"}


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
    tool_names: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if isinstance(name, str):
            tool_names.append(name)
    return tool_names


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
        description = tool.get("description")
        if isinstance(description, str):
            item["description"] = description
        input_schema = tool.get("inputSchema", tool.get("input_schema"))
        if isinstance(input_schema, dict):
            item["input_schema"] = input_schema
        metadata.append(item)
    return metadata


def _redact_secrets(message: str) -> str:
    sensitive_key = (
        r"(?:api[_-]?key|access[_-]?token|client[_-]?secret|"
        r"token|secret|password|content[_-]?base64)"
    )
    redacted = re.sub(
        r"(Bearer\s+)[A-Za-z0-9._~+/=-]+",
        r"\1[REDACTED]",
        message,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        rf"(({sensitive_key})=)[^&\s,}}]+",
        lambda match: match.group(1) + "[REDACTED]",
        redacted,
        flags=re.IGNORECASE,
    )
    return re.sub(
        rf'((?:"{sensitive_key}"|{sensitive_key})\s*:\s*)(["\']).*?(\2)',
        lambda match: match.group(1) + match.group(2) + "[REDACTED]" + match.group(3),
        redacted,
        flags=re.IGNORECASE,
    )
