from __future__ import annotations

from typing import Any

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.chat.app.orchestrator import ChatOrchestrator
from services.create.app.orchestrator import CreateOrchestrator
from services.hiker.app.orchestrator import HikerOrchestrator
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.harness_catalog import build_harness_catalog

from ..projections.runtime_status import _skill_status
from ..redaction import _redact_runtime_status
from ..validators.runtime import _runtime_validation_fingerprint


def _domain_readiness_matrix(
    *,
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    create: CreateOrchestrator,
    chat: ChatOrchestrator,
    latest_validation: dict[str, Any] | None,
) -> dict[str, Any]:
    current_runtime_fingerprint = _runtime_validation_fingerprint(reimbursement, associate)
    catalog = build_harness_catalog(reimbursement.settings)
    current_connectors = {
        "reimbursement_mcp": _redact_runtime_status(
            reimbursement.adapter.status()
        ).get("status", "unknown"),
        "erp_mcp": _redact_runtime_status(associate.adapter.status()).get(
            "status",
            "unknown",
        ),
        "hiker_mcp": _redact_runtime_status(hiker.adapter.status()).get(
            "status",
            "unknown",
        ),
    }
    domains = [
        _domain_readiness_row(
            domain,
            reimbursement=reimbursement,
            associate=associate,
            hiker=hiker,
            create=create,
            chat=chat,
            latest_validation=latest_validation,
            current_runtime_fingerprint=current_runtime_fingerprint,
            current_connectors=current_connectors,
        )
        for domain in catalog["domains"]
    ]
    return {
        "writes_external_data": False,
        "summary": {
            "domain_count": len(domains),
            "ready_count": sum(
                1 for domain in domains if domain["readiness_status"] == "ready"
            ),
            "blocked_count": sum(
                1 for domain in domains if domain["readiness_status"] == "blocked"
            ),
            "needs_validation_count": sum(
                1
                for domain in domains
                if domain["readiness_status"] == "needs_validation"
            ),
            "unknown_count": sum(
                1 for domain in domains if domain["readiness_status"] == "unknown"
            ),
            "external_write_domain_count": sum(
                1 for domain in domains if domain["writes_external_data"]
            ),
            "approval_required_domain_count": sum(
                1 for domain in domains if domain["approval_required_for_writes"]
            ),
        },
        "domains": domains,
    }


def _domain_readiness_row(
    domain: dict[str, Any],
    *,
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    create: CreateOrchestrator,
    chat: ChatOrchestrator,
    latest_validation: dict[str, Any] | None,
    current_runtime_fingerprint: str,
    current_connectors: dict[str, str],
) -> dict[str, Any]:
    validation_config_changed = _validation_config_changed(
        latest_validation,
        current_runtime_fingerprint,
    )
    model_status = _domain_model_status(reimbursement, latest_validation)
    skill_status = _domain_skill_readiness(
        domain,
        reimbursement=reimbursement,
        associate=associate,
        hiker=hiker,
        create=create,
        chat=chat,
    )
    connector_statuses = {
        dependency: _domain_connector_status(
            domain["id"],
            dependency,
            latest_validation,
            current_connectors,
        )
        for dependency in domain["mcp_dependencies"]
    }
    tool_contract_status = _domain_tool_contract_status(domain, latest_validation)
    blocking_reasons = _domain_blocking_reasons(
        domain=domain,
        model_status=model_status,
        skill_status=skill_status,
        connector_statuses=connector_statuses,
        tool_contract_status=tool_contract_status,
        latest_validation=latest_validation,
        validation_config_changed=validation_config_changed,
    )
    readiness_status = _domain_readiness_status(
        blocking_reasons,
        latest_validation,
    )
    return {
        "domain_id": domain["id"],
        "surface": domain["surface"],
        "skill_id": domain.get("skill_id"),
        "audit_domain": domain["audit_domain"],
        "readiness_status": readiness_status,
        "evidence_source": (
            "latest_runtime_validation" if latest_validation else "current_config"
        ),
        "latest_validation_id": (
            latest_validation.get("validation_id") if latest_validation else None
        ),
        "last_validated_at": (
            latest_validation.get("created_at") if latest_validation else None
        ),
        "model_required": domain["model_required"],
        "model_status": model_status,
        "mcp_dependencies": domain["mcp_dependencies"],
        "connector_statuses": connector_statuses,
        "skill_status": skill_status,
        "tool_contract_status": tool_contract_status,
        "writes_external_data": domain["writes_external_data"],
        "approval_required_for_writes": domain["approval_required_for_writes"],
        "blocking_reasons": blocking_reasons,
    }


def _domain_model_status(
    reimbursement: ReimbursementOrchestrator,
    latest_validation: dict[str, Any] | None,
) -> str:
    settings = reimbursement.model_provider.settings
    if not (settings.model_endpoint and settings.model_api_key):
        return "not_configured"
    if latest_validation:
        return str(latest_validation.get("model_status") or "unknown")
    return "configured"


def _domain_skill_readiness(
    domain: dict[str, Any],
    *,
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    create: CreateOrchestrator,
    chat: ChatOrchestrator,
) -> str:
    skill_id = domain.get("skill_id")
    if not skill_id:
        return "not_required"
    loader = _domain_skill_loader(domain["id"], reimbursement, associate, hiker, create, chat)
    status = _skill_status(loader, skill_id)
    if status["loaded"]:
        return "loaded"
    return str(status.get("error_code") or "missing")


def _domain_skill_loader(
    domain_id: str,
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    create: CreateOrchestrator,
    chat: ChatOrchestrator,
) -> Any:
    if domain_id == "chat.general_assistant":
        return chat.skill_loader
    if domain_id == "cowork.associate_receivables":
        return associate.skill_loader
    if domain_id == "cowork.hiker":
        return hiker.skill_loader
    if domain_id == "cowork.reimbursement":
        return reimbursement.skill_loader
    return create.skill_loader


def _domain_connector_status(
    domain_id: str,
    dependency: str,
    latest_validation: dict[str, Any] | None,
    current_connectors: dict[str, str],
) -> str:
    current_status = current_connectors.get(dependency, "unknown")
    if current_status != "connected":
        return current_status
    if not latest_validation:
        return current_status
    if dependency == "reimbursement_mcp":
        return str(latest_validation.get("reimbursement_mcp_status") or "unknown")
    if dependency == "hiker_mcp":
        return current_status
    if dependency == "erp_mcp" and domain_id == "cowork.associate_receivables":
        return str(
            latest_validation.get("associate_execution_status")
            or latest_validation.get("erp_mcp_associate_execution_readiness_status")
            or "unknown"
        )
    return "unknown"


def _domain_tool_contract_status(
    domain: dict[str, Any],
    latest_validation: dict[str, Any] | None,
) -> str:
    if domain["id"] == "cowork.reimbursement":
        if not latest_validation:
            return "needs_validation"
        return str(latest_validation.get("tool_contract_status") or "unknown")
    return "not_required"


def _domain_blocking_reasons(
    *,
    domain: dict[str, Any],
    model_status: str,
    skill_status: str,
    connector_statuses: dict[str, str],
    tool_contract_status: str,
    latest_validation: dict[str, Any] | None,
    validation_config_changed: bool,
) -> list[str]:
    reasons: list[str] = []
    if validation_config_changed:
        reasons.append("runtime_validation_config_changed")
    if domain["model_required"] and model_status == "not_configured":
        reasons.append("model_not_configured")
    elif domain["model_required"] and latest_validation and model_status != "connected":
        reasons.append(f"model_{model_status}")

    if skill_status not in {"loaded", "not_required"}:
        reasons.append(f"skill_{skill_status}")

    for dependency, status in connector_statuses.items():
        if status in {"connected", "passed"}:
            continue
        if status == "not_configured":
            reasons.append(f"{dependency}_not_configured")
        else:
            reasons.append(f"{dependency}_{status}")

    if tool_contract_status not in {"passed", "not_required", "needs_validation"}:
        reasons.append(f"tool_contract_{tool_contract_status}")

    if not latest_validation and not reasons:
        reasons.append("runtime_validation_required")
    return reasons


def _domain_readiness_status(
    blocking_reasons: list[str],
    latest_validation: dict[str, Any] | None,
) -> str:
    if blocking_reasons == ["runtime_validation_config_changed"]:
        return "needs_validation"
    if not blocking_reasons and latest_validation:
        return "ready"
    if blocking_reasons == ["runtime_validation_required"]:
        return "needs_validation"
    if blocking_reasons:
        return "blocked"
    return "unknown"


def _validation_config_changed(
    latest_validation: dict[str, Any] | None,
    current_runtime_fingerprint: str,
) -> bool:
    if not latest_validation:
        return False
    validation_fingerprint = latest_validation.get("runtime_fingerprint")
    if not validation_fingerprint:
        return True
    return str(validation_fingerprint) != current_runtime_fingerprint
