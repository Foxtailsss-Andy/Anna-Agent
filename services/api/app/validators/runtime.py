from __future__ import annotations

import hashlib
import json
from typing import Any

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.mcp_gateway.app.erp_adapter import REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS
from services.mcp_gateway.app.reimbursement_adapter import ReimbursementMcpError
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.reimbursement.app.schemas import ReimbursementDraft
from services.runtime.app.model_provider import ModelProviderError, ModelRequest

from ..projections.runtime_status import _skill_status
from ..redaction import _redact_runtime_status
from ..runtime_config import _session_identity


def _api_main() -> Any:
    # Imported lazily so monkeypatched attributes on services.api.app.main
    # (e.g. _model_visible_reimbursement_tools, date) are honored at call time.
    from services.api.app import main as api_main

    return api_main


async def _runtime_validation_response(
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
) -> dict[str, Any]:
    mcp_status = _redact_runtime_status(reimbursement.adapter.status())
    erp_status = _redact_runtime_status(associate.adapter.status())
    skill_status = _skill_status(
        reimbursement.skill_loader,
        reimbursement.settings.reimbursement_skill_id,
    )
    visible_tools = _api_main()._model_visible_reimbursement_tools(reimbursement, mcp_status)
    visible_tool_names = [tool["name"] for tool in visible_tools]
    backend_submit_model_visible = "reimbursement.submit" in visible_tool_names
    model_probe_tools = (
        visible_tools if skill_status["loaded"] and not backend_submit_model_visible else []
    )
    model_status = await _validate_model_provider(reimbursement, model_probe_tools)
    mcp_read_probe = _validate_mcp_read_probe(reimbursement, mcp_status)
    associate_execution = _validate_erp_associate_execution_readiness(erp_status)
    backend_submit_snapshot_contract = _backend_submit_snapshot_contract(mcp_status)
    mcp_schema_compatibility = _mcp_schema_compatibility(mcp_status)
    ready = (
        model_status["status"] == "connected"
        and mcp_status.get("status") == "connected"
        and mcp_read_probe["status"] == "passed"
        and skill_status["loaded"]
        and not backend_submit_model_visible
        and backend_submit_snapshot_contract["status"] == "passed"
        and mcp_schema_compatibility["status"] != "failed"
    )
    return {
        "status": "ready" if ready else "blocked",
        "writes_external_data": False,
        "model": model_status,
        "reimbursement_mcp": mcp_status,
        "reimbursement_mcp_read_probe": mcp_read_probe,
        "erp_mcp_associate_execution_readiness": associate_execution,
        "skill": skill_status,
        "tool_contract": {
            "model_visible_count": len(visible_tools),
            "model_visible_tool_names": visible_tool_names,
            "backend_submit_model_visible": backend_submit_model_visible,
            "backend_submit_snapshot_contract": backend_submit_snapshot_contract,
            "mcp_schema_compatibility": mcp_schema_compatibility,
        },
    }


def _validate_erp_associate_execution_readiness(
    erp_status: dict[str, Any],
) -> dict[str, Any]:
    required_tools = list(REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS)
    if erp_status.get("status") != "connected":
        return {
            "status": "skipped",
            "writes_external_data": False,
            "required_tool_names": required_tools,
            "tool_names": _tool_names(erp_status),
        }
    missing_tools = _missing_tool_names(
        erp_status,
        REQUIRED_ASSOCIATE_EXECUTION_MCP_TOOLS,
    )
    if missing_tools:
        return {
            "status": "failed",
            "writes_external_data": False,
            "required_tool_names": required_tools,
            "tool_names": _tool_names(erp_status),
            "missing_tools": missing_tools,
            "error_code": "associate_execution_tools_missing",
            "retryable": False,
        }
    return {
        "status": "passed",
        "writes_external_data": False,
        "required_tool_names": required_tools,
        "tool_names": _tool_names(erp_status),
        "missing_tools": [],
    }


def _missing_tool_names(status: dict[str, Any], required: tuple[str, ...]) -> list[str]:
    available = set(_tool_names(status))
    return [tool_name for tool_name in required if tool_name not in available]


def _tool_names(status: dict[str, Any]) -> list[str]:
    tool_names = status.get("tool_names")
    if not isinstance(tool_names, list):
        tools = status.get("tools")
        if isinstance(tools, list):
            tool_names = [
                tool.get("name")
                for tool in tools
                if isinstance(tool, dict) and isinstance(tool.get("name"), str)
            ]
        else:
            tool_names = []
    return [str(tool_name) for tool_name in tool_names]


def _backend_submit_snapshot_contract(mcp_status: dict[str, Any]) -> dict[str, Any]:
    if mcp_status.get("status") != "connected":
        return {"status": "skipped"}
    submit_tool = next(
        (
            tool
            for tool in mcp_status.get("tools", [])
            if isinstance(tool, dict) and tool.get("name") == "reimbursement.submit"
        ),
        None,
    )
    if not isinstance(submit_tool, dict):
        return {"status": "unknown", "error_code": "submit_tool_metadata_missing"}
    input_schema = submit_tool.get("input_schema", submit_tool.get("inputSchema"))
    if not isinstance(input_schema, dict):
        return {"status": "unknown", "error_code": "submit_schema_missing"}
    properties = input_schema.get("properties")
    if not isinstance(properties, dict):
        return {"status": "unknown", "error_code": "submit_schema_properties_missing"}
    required_fields = [
        "expected_draft_snapshot",
        "expected_draft_snapshot_hash",
    ]
    missing_fields = [field for field in required_fields if field not in properties]
    if missing_fields:
        return {
            "status": "failed",
            "error_code": "submit_snapshot_contract_missing_fields",
            "missing_fields": missing_fields,
        }
    return {"status": "passed"}


def _mcp_schema_compatibility(mcp_status: dict[str, Any]) -> dict[str, Any]:
    if mcp_status.get("status") != "connected":
        return {"status": "skipped"}
    supported_draft_fields = set(ReimbursementDraft.model_fields) - {
        "external_reimbursement_id",
        "external_status",
    }
    unsupported_required_fields: list[str] = []
    for tool in mcp_status.get("tools", []):
        if not isinstance(tool, dict):
            continue
        if tool.get("name") not in {
            "reimbursement.validate_draft",
            "reimbursement.create_draft",
        }:
            continue
        input_schema = tool.get("input_schema", tool.get("inputSchema"))
        if not isinstance(input_schema, dict):
            continue
        draft_schema = _draft_input_schema(input_schema)
        required_fields = _schema_required_fields(draft_schema)
        unsupported_required_fields.extend(
            field
            for field in required_fields
            if field not in supported_draft_fields
            and field not in unsupported_required_fields
        )
    if unsupported_required_fields:
        return {
            "status": "failed",
            "error_code": "unsupported_mcp_required_fields",
            "unsupported_required_fields": unsupported_required_fields,
        }
    return {"status": "passed"}


def _draft_input_schema(input_schema: dict[str, Any]) -> dict[str, Any]:
    properties = input_schema.get("properties")
    if isinstance(properties, dict) and isinstance(properties.get("draft"), dict):
        return properties["draft"]
    return {}


def _schema_required_fields(schema: dict[str, Any]) -> list[str]:
    required = schema.get("required")
    if not isinstance(required, list):
        return []
    return [str(field) for field in required]


def _validate_mcp_read_probe(
    reimbursement: ReimbursementOrchestrator,
    mcp_status: dict[str, Any],
) -> dict[str, Any]:
    if mcp_status.get("status") != "connected":
        return {
            "status": "skipped",
            "writes_external_data": False,
            "tool_names": [],
        }
    session = _session_identity(reimbursement)
    workspace_id = session["workspace_id"]
    actor_user_id = session["user_id"]
    tool_names: list[str] = []
    try:
        tool_names.append("reimbursement.get_capabilities")
        reimbursement.adapter.call_tool(
            "reimbursement.get_capabilities",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
            },
        )
        tool_names.append("reimbursement.validate_draft")
        validation = reimbursement.adapter.call_tool(
            "reimbursement.validate_draft",
            {
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "draft": _api_main()._runtime_validation_draft(reimbursement.settings),
            },
        )
    except ReimbursementMcpError as exc:
        return {
            "status": "failed",
            "writes_external_data": False,
            "tool_names": tool_names,
            "error_code": exc.error_code,
            "retryable": exc.retryable,
        }
    if validation.get("valid") is not True or validation.get("blocked") is True:
        return {
            "status": "failed",
            "writes_external_data": False,
            "tool_names": tool_names,
            "error_code": "mcp_read_probe_validation_failed",
            "retryable": False,
        }
    if validation.get("missing_fields"):
        return {
            "status": "failed",
            "writes_external_data": False,
            "tool_names": tool_names,
            "error_code": "mcp_read_probe_missing_fields",
            "retryable": False,
        }
    return {
        "status": "passed",
        "writes_external_data": False,
        "tool_names": tool_names,
        "draft_source": _api_main()._runtime_validation_draft_source(reimbursement.settings),
    }


async def _validate_model_provider(
    reimbursement: ReimbursementOrchestrator,
    tool_contract: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    settings = reimbursement.model_provider.settings
    if not settings.model_api_key or not settings.model_endpoint:
        return {
            "provider": settings.model_provider,
            "model_name": settings.model_name,
            "configured": False,
            "status": "not_configured",
            "error_code": "model_not_configured",
        }
    try:
        response = await reimbursement.model_provider.create_response(
            ModelRequest(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are Anna runtime validation. Reply briefly with ok. "
                            "Do not request tools."
                        ),
                    },
                    {
                        "role": "user",
                        "content": "Validate that the configured model endpoint can respond.",
                    },
                ],
                tools=[],
            )
        )
    except ModelProviderError as exc:
        return {
            "provider": settings.model_provider,
            "model_name": settings.model_name,
            "configured": True,
            "status": "failed",
            "error_code": exc.error_code,
            "retryable": exc.retryable,
        }
    if response.tool_calls:
        return {
            "provider": settings.model_provider,
            "model_name": settings.model_name,
            "configured": True,
            "status": "failed",
            "error_code": "model_probe_requested_tools",
            "retryable": False,
            "finish_reason": response.finish_reason,
            "tool_call_count": len(response.tool_calls),
        }
    tool_contract_probe = await _validate_model_tool_contract(
        reimbursement,
        tool_contract or [],
    )
    if tool_contract_probe["status"] == "failed":
        return {
            "provider": settings.model_provider,
            "model_name": settings.model_name,
            "configured": True,
            "status": "failed",
            "error_code": tool_contract_probe["error_code"],
            "retryable": tool_contract_probe.get("retryable", False),
            "finish_reason": response.finish_reason,
            "tool_call_count": len(response.tool_calls),
            "tool_contract_probe": tool_contract_probe,
        }
    return {
        "provider": settings.model_provider,
        "model_name": settings.model_name,
        "configured": True,
        "status": "connected",
        "finish_reason": response.finish_reason,
        "tool_call_count": len(response.tool_calls),
        "tool_contract_probe": tool_contract_probe,
    }


async def _validate_model_tool_contract(
    reimbursement: ReimbursementOrchestrator,
    tool_contract: list[dict[str, Any]],
) -> dict[str, Any]:
    if not tool_contract:
        return {
            "status": "skipped",
            "tool_count": 0,
        }
    try:
        response = await reimbursement.model_provider.create_response(
            ModelRequest(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are Anna runtime validation. Reply briefly with ok. "
                            "Do not request tools."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "Validate that the configured model endpoint accepts Anna "
                            "reimbursement tool schemas. Do not call any tool."
                        ),
                    },
                ],
                tools=tool_contract,
            )
        )
    except ModelProviderError as exc:
        return {
            "status": "failed",
            "error_code": exc.error_code,
            "retryable": exc.retryable,
            "tool_count": len(tool_contract),
        }
    if response.tool_calls:
        return {
            "status": "failed",
            "error_code": "model_tool_contract_probe_requested_tools",
            "retryable": False,
            "finish_reason": response.finish_reason,
            "tool_call_count": len(response.tool_calls),
            "tool_count": len(tool_contract),
        }
    return {
        "status": "connected",
        "finish_reason": response.finish_reason,
        "tool_call_count": len(response.tool_calls),
        "tool_count": len(tool_contract),
    }


def _runtime_validation_fingerprint(
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
) -> str:
    model_settings = reimbursement.model_provider.settings
    reimbursement_settings = reimbursement.adapter.settings
    associate_settings = associate.adapter.settings
    payload = {
        "model_provider": model_settings.model_provider,
        "model_name": model_settings.model_name,
        "model_endpoint_hash": _fingerprint_value(model_settings.model_endpoint),
        "model_key_configured": bool(model_settings.model_api_key),
        "reimbursement_mcp_server_hash": _fingerprint_value(
            reimbursement_settings.reimbursement_mcp_server
        ),
        "reimbursement_mcp_key_configured": bool(
            reimbursement_settings.reimbursement_mcp_api_key
        ),
        "reimbursement_skill_id": reimbursement.settings.reimbursement_skill_id,
        "erp_mcp_server_hash": _fingerprint_value(associate_settings.erp_mcp_server),
        "erp_mcp_key_configured": bool(associate_settings.erp_mcp_api_key),
        "associate_receivables_skill_id": associate.settings.associate_receivables_skill_id,
    }
    serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _fingerprint_value(value: str | None) -> str | None:
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
