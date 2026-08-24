from __future__ import annotations

from typing import Any

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.skill_loader import SkillLoaderError


def _model_status(settings: Any) -> dict[str, Any]:
    configured = bool(settings.model_api_key and settings.model_endpoint)
    status = {
        "provider": settings.model_provider,
        "model_name": settings.model_name,
        "configured": configured,
        "status": "configured" if configured else "not_configured",
    }
    if not configured:
        status["error_code"] = "model_not_configured"
    return status


def _runtime_config_status(
    model_settings: Any,
    mcp_settings: Any,
    associate_settings: Any,
    hiker_adapter_settings: Any = None,
) -> dict[str, Any]:
    return {
        "runtime_config_path": (
            model_settings.runtime_config_path or mcp_settings.runtime_config_path
        ),
        "state_db_path": model_settings.state_db_path or mcp_settings.state_db_path,
        "model_endpoint_configured": bool(model_settings.model_endpoint),
        "model_api_key_configured": bool(model_settings.model_api_key),
        "reimbursement_mcp_server_configured": bool(
            mcp_settings.reimbursement_mcp_server
        ),
        "reimbursement_mcp_api_key_configured": bool(
            getattr(mcp_settings, "reimbursement_mcp_api_key", None)
        ),
        "erp_mcp_server_configured": bool(
            getattr(associate_settings, "erp_mcp_server", None)
        ),
        "erp_mcp_api_key_configured": bool(
            getattr(associate_settings, "erp_mcp_api_key", None)
        ),
        "hiker_mcp_server_configured": bool(
            getattr(hiker_adapter_settings, "hiker_mcp_server", None)
        ),
        "hiker_mcp_api_key_configured": bool(
            getattr(hiker_adapter_settings, "hiker_mcp_api_key", None)
        ),
        "associate_receivables_skill_id": getattr(
            associate_settings,
            "associate_receivables_skill_id",
            RuntimeSettings().associate_receivables_skill_id,
        ),
        "chat_skill_id": getattr(
            model_settings,
            "chat_skill_id",
            RuntimeSettings().chat_skill_id,
        ),
        "requires_restart_after_edit": True,
    }


def _skill_status(skill_loader: Any, skill_id: str) -> dict[str, Any]:
    try:
        skill = skill_loader.load(skill_id)
    except SkillLoaderError as exc:
        return {
            "id": skill_id,
            "name": None,
            "version": None,
            "loaded": False,
            "content_hash": None,
            "allowed_tools": [],
            "forbidden_tools": [],
            "error_code": exc.error_code,
        }
    return {
        "id": skill.id,
        "name": skill.name,
        "version": skill.version,
        "loaded": True,
        "content_hash": skill.content_hash,
        "allowed_tools": skill.allowed_tools,
        "forbidden_tools": skill.forbidden_tools,
    }


def _skill_registry_item(skill: Any, active_skill_id: str) -> dict[str, Any]:
    return {
        "id": skill.id,
        "name": skill.name,
        "version": skill.version,
        "content_hash": skill.content_hash,
        "allowed_tools": skill.allowed_tools,
        "forbidden_tools": skill.forbidden_tools,
        "active": skill.id == active_skill_id,
    }
