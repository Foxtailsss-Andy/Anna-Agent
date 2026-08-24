from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx

from services.mcp_gateway.app.reimbursement_adapter import REQUIRED_REIMBURSEMENT_MCP_TOOLS


class LocalReimbursementMcpContractServer:
    def __init__(self) -> None:
        self.url = "https://local-reimbursement-contract.test/rpc"
        self.requests: list[dict[str, Any]] = []
        self._drafts: dict[str, dict[str, Any]] = {}

    def mutate_draft(self, external_reimbursement_id: str, changes: dict[str, Any]) -> None:
        self._drafts[external_reimbursement_id].update(changes)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle_request)

    def _handle_request(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        method = body.get("method")
        if method == "tools/list":
            return self._result(
                body,
                {
                    "tools": [
                        _tool_metadata(tool_name)
                        for tool_name in REQUIRED_REIMBURSEMENT_MCP_TOOLS
                    ]
                },
            )
        if method == "tools/call":
            params = body.get("params", {})
            if not isinstance(params, dict):
                return self._error(body, "invalid_params", "params must be an object")
            return self._call_tool(
                body,
                str(params.get("name", "")),
                params.get("arguments", {}),
            )
        return self._error(body, "method_not_found", f"unsupported method: {method}")

    def _call_tool(
        self,
        request_body: dict[str, Any],
        tool_name: str,
        arguments: Any,
    ) -> httpx.Response:
        if not isinstance(arguments, dict):
            return self._error(request_body, "invalid_arguments", "arguments must be an object")
        if tool_name == "reimbursement.get_capabilities":
            return self._result(
                request_body,
                {
                    "structuredContent": {
                        "categories": ["travel", "meal", "office", "transport", "other"],
                        "currencies": ["CNY"],
                        "supports_attachments": True,
                        "supports_create_draft": True,
                        "supports_submit": True,
                        "required_fields": [
                            "category",
                            "amount",
                            "currency",
                            "expense_date",
                            "merchant",
                            "reason",
                            "department_id",
                            "cost_center_id",
                        ],
                        "attachment_required_above_amount": 0,
                    }
                },
            )
        if tool_name == "reimbursement.get_policy":
            return self._result(
                request_body,
                {
                    "structuredContent": {
                        "risk_level": "low",
                        "requires_confirmation": True,
                        "requires_manager_approval": True,
                        "policy_checks": [],
                        "blocked": False,
                    }
                },
            )
        if tool_name == "reimbursement.validate_draft":
            return self._result(
                request_body,
                {
                    "structuredContent": {
                        "valid": True,
                        "missing_fields": [],
                        "normalized_draft": arguments.get("draft", {}),
                        "policy_summary": "contract server validation passed",
                        "risk_level": "low",
                    }
                },
            )
        if tool_name == "reimbursement.create_draft":
            source_run_id = str(arguments.get("source_run_id", "run"))
            external_id = f"contract-draft-{source_run_id}"
            incoming_draft = dict(arguments.get("draft", {}))
            if _has_attachment_without_upload_content(incoming_draft):
                return self._error(
                    request_body,
                    "attachment_content_required",
                    "attachment content is required to create an external draft",
                    retryable=False,
                )
            draft = _external_draft_snapshot(incoming_draft)
            self._drafts[external_id] = {
                **draft,
                "external_reimbursement_id": external_id,
                "external_status": "draft",
            }
            return self._result(
                request_body,
                {
                    "structuredContent": {
                        "external_reimbursement_id": external_id,
                        "external_status": "draft",
                        "created": True,
                        "idempotent_replay": False,
                    }
                },
            )
        if tool_name == "reimbursement.submit":
            external_id = str(arguments.get("external_reimbursement_id", ""))
            if external_id not in self._drafts:
                return self._error(
                    request_body,
                    "draft_not_found",
                    "external reimbursement draft was not found",
                    retryable=False,
                )
            expected_hash = arguments.get("expected_draft_snapshot_hash")
            if expected_hash and expected_hash != _draft_hash(self._drafts[external_id]):
                return self._error(
                    request_body,
                    "external_draft_snapshot_mismatch",
                    "external reimbursement draft no longer matches the approved snapshot",
                    retryable=False,
                )
            expected_snapshot = arguments.get("expected_draft_snapshot")
            if (
                isinstance(expected_snapshot, dict)
                and expected_snapshot != self._drafts[external_id]
            ):
                return self._error(
                    request_body,
                    "external_draft_snapshot_mismatch",
                    "external reimbursement draft no longer matches the approved snapshot",
                    retryable=False,
                )
            self._drafts[external_id]["external_status"] = "submitted"
            return self._result(
                request_body,
                {
                    "structuredContent": {
                        "external_reimbursement_id": external_id,
                        "external_status": "submitted",
                        "submitted": True,
                    }
                },
            )
        if tool_name == "reimbursement.get_status":
            external_id = str(arguments.get("external_reimbursement_id", ""))
            draft = self._drafts.get(external_id)
            if draft is None:
                return self._error(
                    request_body,
                    "draft_not_found",
                    "external reimbursement draft was not found",
                    retryable=False,
                )
            return self._result(request_body, {"structuredContent": dict(draft)})
        return self._error(request_body, "tool_not_found", f"unsupported tool: {tool_name}")

    def _result(
        self,
        request_body: dict[str, Any],
        result: dict[str, Any],
    ) -> httpx.Response:
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": request_body.get("id"), "result": result},
        )

    def _error(
        self,
        request_body: dict[str, Any],
        code: str,
        message: str,
        retryable: bool = False,
    ) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": request_body.get("id"),
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": retryable,
                },
            },
        )


def _draft_hash(draft: dict[str, Any]) -> str:
    encoded = json.dumps({"draft": draft}, sort_keys=True, ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def _tool_metadata(tool_name: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {"name": tool_name}
    if tool_name == "reimbursement.submit":
        metadata["inputSchema"] = {
            "type": "object",
            "properties": {
                "external_reimbursement_id": {"type": "string"},
                "expected_draft_snapshot": {"type": "object"},
                "expected_draft_snapshot_hash": {"type": "string"},
            },
        }
    return metadata


def _external_draft_snapshot(draft: dict[str, Any]) -> dict[str, Any]:
    attachments = draft.get("attachments")
    if isinstance(attachments, list):
        draft["attachments"] = [
            {"name": item["name"], "uri": item["uri"]}
            for item in attachments
            if isinstance(item, dict)
            and isinstance(item.get("name"), str)
            and isinstance(item.get("uri"), str)
        ]
    return draft


def _has_attachment_without_upload_content(draft: dict[str, Any]) -> bool:
    attachments = draft.get("attachments")
    if not isinstance(attachments, list):
        return False
    for item in attachments:
        if not isinstance(item, dict):
            return True
        if not isinstance(item.get("content_base64"), str) or not item["content_base64"]:
            return True
        if not isinstance(item.get("sha256"), str) or not item["sha256"]:
            return True
        if not isinstance(item.get("size_bytes"), int) or item["size_bytes"] <= 0:
            return True
    return False
