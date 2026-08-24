from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from services.identity.app.schemas import SessionIdentity
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings

from .redaction import (
    _blank_to_none,
    _is_redacted_placeholder,
    _redact_config_display_value,
)

PROBE_DRAFT_CONFIG_FIELDS = frozenset(
    {
        "category",
        "amount",
        "currency",
        "expense_date",
        "merchant",
        "reason",
        "department_id",
        "cost_center_id",
        "project_id",
    }
)


def _sanitize_reimbursement_probe_draft(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    sanitized = {
        key: value[key]
        for key in sorted(PROBE_DRAFT_CONFIG_FIELDS)
        if key in value and value[key] is not None
    }
    return sanitized or None


def _active_runtime_config_path(reimbursement: ReimbursementOrchestrator) -> Path:
    runtime_config_path = (
        reimbursement.model_provider.settings.runtime_config_path
        or reimbursement.adapter.settings.runtime_config_path
    )
    if not runtime_config_path:
        raise HTTPException(
            status_code=400,
            detail="ANNA_RUNTIME_CONFIG_PATH is not configured",
        )
    return Path(runtime_config_path)


def _runtime_config_file_response(
    config_path: Path,
    requires_restart_after_save: bool,
) -> dict[str, Any]:
    config = _read_runtime_config_file(config_path)
    return {
        "runtime_config_path": str(config_path),
        "exists": config_path.exists(),
        "values": {
            "model_provider": config.get("model_provider", "openai-compatible"),
            "model_endpoint": _redact_config_display_value(config.get("model_endpoint")),
            "model_name": config.get("model_name", "mimo-v2.5-pro"),
            "reimbursement_skill_id": config.get(
                "reimbursement_skill_id",
                RuntimeSettings().reimbursement_skill_id,
            ),
            "associate_receivables_skill_id": config.get(
                "associate_receivables_skill_id",
                RuntimeSettings().associate_receivables_skill_id,
            ),
            "chat_skill_id": config.get(
                "chat_skill_id",
                RuntimeSettings().chat_skill_id,
            ),
            "reimbursement_probe_draft": _sanitize_reimbursement_probe_draft(
                config.get("reimbursement_probe_draft")
            ),
            # P3 refinement - Agent center reads/writes these round-trip.
            "agent_directives": (
                config.get("agent_directives")
                if isinstance(config.get("agent_directives"), dict)
                else {}
            ),
            "model_profiles": (
                [
                    {
                        "id": str(item.get("id") or ""),
                        "label": str(item.get("label") or item.get("model_name") or ""),
                        "provider": str(item.get("provider") or ""),
                        "model_name": str(item.get("model_name") or ""),
                        "endpoint": _redact_config_display_value(item.get("endpoint")),
                        "api_key_configured": bool(item.get("api_key")),
                    }
                    for item in config.get("model_profiles", [])
                    if isinstance(item, dict)
                ]
                if isinstance(config.get("model_profiles"), list)
                else []
            ),
        },
        "secrets": {
            "model_api_key_configured": bool(_blank_to_none(config.get("model_api_key"))),
            "reimbursement_mcp_server_configured": bool(
                _blank_to_none(config.get("reimbursement_mcp_server"))
            ),
            "reimbursement_mcp_api_key_configured": bool(
                _blank_to_none(config.get("reimbursement_mcp_api_key"))
            ),
            "erp_mcp_server_configured": bool(
                _blank_to_none(config.get("erp_mcp_server"))
            ),
            "erp_mcp_api_key_configured": bool(
                _blank_to_none(config.get("erp_mcp_api_key"))
            ),
            "hiker_mcp_server_configured": bool(
                _blank_to_none(config.get("hiker_mcp_server"))
            ),
            "hiker_mcp_api_key_configured": bool(
                _blank_to_none(config.get("hiker_mcp_api_key"))
            ),
        },
        "requires_restart_after_save": requires_restart_after_save,
    }


def _read_runtime_config_file(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        return {}
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail="runtime config file is not valid JSON",
        ) from exc
    if not isinstance(config, dict):
        raise HTTPException(
            status_code=400,
            detail="runtime config file must contain a JSON object",
        )
    return config


def _write_runtime_config_file(
    config_path: Path,
    updates: dict[str, Any],
) -> None:
    allowed_keys = {
        "model_provider",
        "model_endpoint",
        "model_name",
        "model_api_key",
        "reimbursement_mcp_server",
        "reimbursement_mcp_api_key",
        "reimbursement_skill_id",
        "reimbursement_probe_draft",
        "erp_mcp_server",
        "erp_mcp_api_key",
        "hiker_mcp_server",
        "hiker_mcp_api_key",
        "associate_receivables_skill_id",
        "chat_skill_id",
        # P3 refinement — Agent 中心与模型档案的持久化键。
        "agent_directives",
        "model_profiles",
    }
    config = _read_runtime_config_file(config_path)
    for key, value in updates.items():
        if key not in allowed_keys:
            continue
        if key == "reimbursement_probe_draft":
            config[key] = _sanitize_reimbursement_probe_draft(value)
            continue
        # P3 refinement — structured values persist as-is (no blank-to-none 字符串语义)。
        if key == "model_profiles":
            config[key] = [p for p in value if isinstance(p, dict)] if isinstance(value, list) else []
            continue
        if key == "agent_directives":
            config[key] = (
                {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}
            )
            continue
        if key in {"model_endpoint", "reimbursement_mcp_server", "erp_mcp_server", "hiker_mcp_server"} and _is_redacted_placeholder(value):
            continue
        config[key] = _blank_to_none(value)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _runtime_value(
    config: dict[str, Any],
    config_key: str,
    env_key: str,
    default: str,
) -> str:
    return (
        _blank_to_none(os.environ.get(env_key))
        or _blank_to_none(config.get(config_key))
        or default
    )


def _session_identity(reimbursement: ReimbursementOrchestrator) -> dict[str, str]:
    config: dict[str, Any] = {}
    runtime_config_path = (
        reimbursement.model_provider.settings.runtime_config_path
        or reimbursement.adapter.settings.runtime_config_path
    )
    if runtime_config_path:
        config = _read_runtime_config_file(Path(runtime_config_path))

    username = _blank_to_none(os.environ.get("USER")) or getpass.getuser()
    user_id = _runtime_value(
        config,
        "user_id",
        "ANNA_USER_ID",
        f"local-{username}",
    )
    return {
        "workspace_id": _runtime_value(
            config,
            "workspace_id",
            "ANNA_WORKSPACE_ID",
            "local-workspace",
        ),
        "workspace_name": _runtime_value(
            config,
            "workspace_name",
            "ANNA_WORKSPACE_NAME",
            "Anna Local Workspace",
        ),
        "user_id": user_id,
        "user_display_name": _runtime_value(
            config,
            "user_display_name",
            "ANNA_USER_DISPLAY_NAME",
            username,
        ),
        "role": _runtime_value(
            config,
            "role",
            "ANNA_ROLE",
            "boss",
        ),
        "source": "local-runtime",
    }


def local_session_identity(reimbursement: ReimbursementOrchestrator) -> SessionIdentity:
    """The no-login desktop user as a real ``SessionIdentity``.

    Crew/team routes require a session; the rest of the app already runs
    token-less against this local-runtime identity. This lets those routes
    accept the same fallback (surface-consistency), while token-based
    cross-workspace isolation is unchanged — a local identity only ever
    resolves to its OWN configured workspace.
    """
    data = _session_identity(reimbursement)
    return SessionIdentity(
        workspace_id=data["workspace_id"],
        workspace_name=data["workspace_name"],
        user_id=data["user_id"],
        user_display_name=data["user_display_name"],
        role=data["role"],
    )
