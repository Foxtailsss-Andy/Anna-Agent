from __future__ import annotations

import os
from typing import Any

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.hiker.app.orchestrator import HikerOrchestrator
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings

from ..redaction import _blank_to_none


def _live_validation_checklist(
    *,
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    domain_readiness: dict[str, Any],
    latest_validation: dict[str, Any] | None,
) -> dict[str, Any]:
    model_settings = reimbursement.model_provider.settings
    reimbursement_settings = reimbursement.adapter.settings
    associate_settings = associate.adapter.settings
    hiker_settings = hiker.adapter.settings
    domain_step = _live_domain_readiness_step(domain_readiness, latest_validation)
    steps = [
        _live_checklist_step(
            "runtime_configuration",
            "Runtime configuration",
            (
                "ready"
                if _has_model_credentials(model_settings)
                and _has_reimbursement_credentials(reimbursement_settings)
                and _has_hiker_credentials(hiker_settings)
                and _has_erp_credentials(associate_settings)
                else "manual_required"
            ),
            (
                "runtime_configured"
                if _has_model_credentials(model_settings)
                and _has_reimbursement_credentials(reimbursement_settings)
                and _has_hiker_credentials(hiker_settings)
                and _has_erp_credentials(associate_settings)
                else "runtime_configuration_required"
            ),
            configured=(
                _has_model_credentials(model_settings)
                and _has_reimbursement_credentials(reimbursement_settings)
                and _has_hiker_credentials(hiker_settings)
                and _has_erp_credentials(associate_settings)
            ),
        ),
        _live_checklist_step(
            "model_credentials",
            "Model credentials",
            "ready" if _has_model_credentials(model_settings) else "blocked",
            "model_configured" if _has_model_credentials(model_settings) else "model_not_configured",
            configured=_has_model_credentials(model_settings),
        ),
        _live_checklist_step(
            "reimbursement_mcp_credentials",
            "Reimbursement MCP credentials",
            "ready" if _has_reimbursement_credentials(reimbursement_settings) else "blocked",
            (
                "reimbursement_mcp_configured"
                if _has_reimbursement_credentials(reimbursement_settings)
                else "reimbursement_mcp_not_configured"
            ),
            configured=_has_reimbursement_credentials(reimbursement_settings),
        ),
        _live_checklist_step(
            "hiker_mcp_credentials",
            "Hiker MCP credentials",
            "ready" if _has_hiker_credentials(hiker_settings) else "blocked",
            (
                "hiker_mcp_configured"
                if _has_hiker_credentials(hiker_settings)
                else "hiker_mcp_not_configured"
            ),
            configured=_has_hiker_credentials(hiker_settings),
        ),
        _live_checklist_step(
            "erp_mcp_credentials",
            "ERP MCP credentials",
            "ready" if _has_erp_credentials(associate_settings) else "blocked",
            (
                "erp_mcp_configured"
                if _has_erp_credentials(associate_settings)
                else "erp_mcp_not_configured"
            ),
            configured=_has_erp_credentials(associate_settings),
        ),
        domain_step,
        _live_validation_report_step(latest_validation, domain_step),
        _live_env_step(
            "live_input",
            "Operator live request gate",
            "ANNA_LIVE_REIMBURSEMENT_INPUT",
            "live_input_configured",
            "live_input_required",
        ),
        _live_external_write_authorization_step(),
    ]
    return {
        "writes_external_data": False,
        "command": "npm run live:e2e",
        "summary": _live_checklist_summary(steps),
        "steps": steps,
    }


def _has_model_credentials(settings: RuntimeSettings) -> bool:
    return bool(settings.model_endpoint and settings.model_api_key)


def _has_reimbursement_credentials(settings: RuntimeSettings) -> bool:
    return bool(settings.reimbursement_mcp_server and settings.reimbursement_mcp_api_key)


def _has_erp_credentials(settings: RuntimeSettings) -> bool:
    return bool(settings.erp_mcp_server and settings.erp_mcp_api_key)


def _has_hiker_credentials(settings: RuntimeSettings) -> bool:
    return bool(settings.hiker_mcp_server and settings.hiker_mcp_api_key)


def _live_domain_readiness_step(
    domain_readiness: dict[str, Any],
    latest_validation: dict[str, Any] | None,
) -> dict[str, Any]:
    domain_statuses = [
        str(domain.get("readiness_status") or "unknown")
        for domain in domain_readiness.get("domains", [])
    ]
    if domain_statuses and all(status == "ready" for status in domain_statuses):
        status = "ready"
        reason = "domains_ready"
    elif "blocked" in domain_statuses:
        status = "blocked"
        reason = "domain_blocked"
    elif "needs_validation" in domain_statuses:
        status = "needs_validation"
        reason = "runtime_validation_required"
    else:
        status = "blocked"
        reason = "domain_readiness_unavailable"
    return _live_checklist_step(
        "domain_readiness",
        "Domain Readiness Matrix",
        status,
        reason,
        evidence_id=latest_validation.get("validation_id") if latest_validation else None,
    )


def _live_validation_report_step(
    latest_validation: dict[str, Any] | None,
    domain_step: dict[str, Any],
) -> dict[str, Any]:
    if not latest_validation:
        return _live_checklist_step(
            "validation_report",
            "Runtime validation report",
            "blocked",
            "runtime_validation_required",
        )
    if domain_step["status"] == "ready" and latest_validation.get("status") == "ready":
        status = "ready"
        reason = "current_validation_ready"
    elif domain_step["status"] == "needs_validation":
        status = "needs_validation"
        reason = "runtime_revalidation_required"
    else:
        status = "blocked"
        reason = "runtime_validation_blocked"
    return _live_checklist_step(
        "validation_report",
        "Runtime validation report",
        status,
        reason,
        evidence_id=latest_validation.get("validation_id"),
    )


def _live_env_step(
    step_id: str,
    label: str,
    env_var: str,
    ready_reason: str,
    missing_reason: str,
) -> dict[str, Any]:
    configured = bool(_blank_to_none(os.environ.get(env_var)))
    return _live_checklist_step(
        step_id,
        label,
        "ready" if configured else "manual_required",
        ready_reason if configured else missing_reason,
        env_var=env_var,
        configured=configured,
    )


def _live_external_write_authorization_step() -> dict[str, Any]:
    configured = os.environ.get("ANNA_LIVE_ALLOW_EXTERNAL_WRITES") == "1"
    return _live_checklist_step(
        "external_write_authorization",
        "External write authorization",
        "ready" if configured else "manual_required",
        "external_writes_enabled" if configured else "external_writes_not_enabled",
        env_var="ANNA_LIVE_ALLOW_EXTERNAL_WRITES",
        configured=configured,
    )


def _live_checklist_step(
    step_id: str,
    label: str,
    status: str,
    reason: str,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "id": step_id,
        "label": label,
        "status": status,
        "reason": reason,
        **{key: value for key, value in extra.items() if value is not None},
    }


def _live_checklist_summary(steps: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "step_count": len(steps),
        "ready_count": sum(1 for step in steps if step["status"] == "ready"),
        "blocked_count": sum(1 for step in steps if step["status"] == "blocked"),
        "manual_required_count": sum(
            1 for step in steps if step["status"] == "manual_required"
        ),
        "needs_validation_count": sum(
            1 for step in steps if step["status"] == "needs_validation"
        ),
    }
