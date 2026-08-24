from __future__ import annotations

from typing import Any

from services.runtime.app.associate_tool_registry import AssociateToolRegistry
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.create_tool_registry import CreateToolRegistry
from services.runtime.app.hiker_tool_registry import HikerToolRegistry
from services.runtime.app.reimbursement_tool_registry import ReimbursementToolRegistry


REIMBURSEMENT_TOOL_FLOW = [
    "reimbursement.get_capabilities",
    "reimbursement.get_policy",
    "reimbursement.validate_draft",
    "reimbursement.create_draft",
    "reimbursement.submit_intent",
    "reimbursement.get_status",
]

V2_SURFACE_IDS = ("create", "cowork", "hub")


def build_v2_capabilities() -> dict[str, Any]:
    """Expose the v2 boundary without implying that a bridge is deployed."""
    surfaces = [
        {
            "id": surface_id,
            "status": "unsupported",
            "legacy_status": "available",
            "reason": "v2_bridge_not_implemented",
            "required_before_enable": [
                "production_runtime_consumer",
                "real_provider_evidence",
            ],
        }
        for surface_id in V2_SURFACE_IDS
    ]
    return {
        "api_version": "harness-v2",
        "status": "partial",
        "review_gate": {
            "status": "blocked",
            "reason": "real_review_approval_bridge_not_implemented",
            "owner": "unverified",
            "provider": "unverified",
            "live_evidence": "unverified",
        },
        "completed_prerequisites": ["desktop_decision_to_resume"],
        "unsupported_capabilities": {
            "web_search": {
                "status": "unsupported",
                "reason": "provider_connector_not_implemented",
            },
        },
        "surfaces": surfaces,
    }


def build_harness_catalog(settings: RuntimeSettings | None = None) -> dict[str, Any]:
    active_settings = settings or RuntimeSettings.from_env()
    domains = _domains(active_settings)
    backend_write_tool_count = sum(len(domain["backend_write_tools"]) for domain in domains)
    return {
        "summary": {
            "domain_count": len(domains),
            "model_backed_domain_count": sum(1 for domain in domains if domain["model_required"]),
            "mcp_dependent_domain_count": sum(1 for domain in domains if domain["mcp_dependencies"]),
            "backend_write_tool_count": backend_write_tool_count,
            "approval_required_write_count": sum(
                len(domain["backend_write_tools"])
                for domain in domains
                if domain["approval_required_for_writes"]
            ),
        },
        "connectors": _connectors(active_settings),
        "domains": domains,
    }


def _domains(settings: RuntimeSettings) -> list[dict[str, Any]]:
    return [
        {
            "id": "chat.general_assistant",
            "surface": "Chat",
            "skill_id": settings.chat_skill_id,
            "model_required": True,
            "mcp_dependencies": [],
            "model_visible_tools": [],
            "backend_write_tools": [],
            "writes_external_data": False,
            "approval_required_for_writes": False,
            "audit_domain": "chat",
        },
        {
            "id": "cowork.reimbursement",
            "surface": "Cowork · Hiker",
            "skill_id": settings.reimbursement_skill_id,
            "model_required": True,
            "mcp_dependencies": ["reimbursement_mcp"],
            "model_visible_tools": _ordered_tool_names(
                ReimbursementToolRegistry().model_visible_tools(),
                REIMBURSEMENT_TOOL_FLOW,
            ),
            "backend_write_tools": ["reimbursement.submit"],
            "writes_external_data": True,
            "approval_required_for_writes": True,
            "audit_domain": "reimbursement",
        },
        {
            "id": "cowork.hiker",
            "surface": "Cowork · Hiker",
            "skill_id": settings.hiker_assistant_skill_id,
            "model_required": True,
            "mcp_dependencies": ["hiker_mcp"],
            "model_visible_tools": _tool_names(HikerToolRegistry().model_visible_tools()),
            "backend_write_tools": [],
            "writes_external_data": False,
            "approval_required_for_writes": False,
            "audit_domain": "hiker",
        },
        {
            "id": "cowork.associate_receivables",
            "surface": "Cowork",
            "skill_id": settings.associate_receivables_skill_id,
            "model_required": True,
            "mcp_dependencies": ["erp_mcp"],
            "model_visible_tools": _tool_names(
                AssociateToolRegistry().model_visible_tools()
            ),
            "backend_write_tools": ["erp.collection_task.create_draft"],
            "writes_external_data": True,
            "approval_required_for_writes": True,
            "audit_domain": "associate",
        },
        {
            "id": "create.capability_draft",
            "surface": "Create",
            "skill_id": None,
            "model_required": True,
            "mcp_dependencies": [],
            "model_visible_tools": _tool_names(CreateToolRegistry().model_visible_tools()),
            "backend_write_tools": [],
            "writes_external_data": False,
            "approval_required_for_writes": False,
            "audit_domain": "create",
        },
    ]


def _connectors(settings: RuntimeSettings) -> list[dict[str, Any]]:
    return [
        {
            "id": "model",
            "type": "model_provider",
            "configured": bool(settings.model_endpoint),
            "secret_configured": bool(settings.model_api_key),
        },
        {
            "id": "reimbursement_mcp",
            "type": "mcp_connector",
            "configured": bool(settings.reimbursement_mcp_server),
            "secret_configured": bool(settings.reimbursement_mcp_api_key),
        },
        {
            "id": "erp_mcp",
            "type": "mcp_connector",
            "configured": bool(settings.erp_mcp_server),
            "secret_configured": bool(settings.erp_mcp_api_key),
        },
        {
            "id": "hiker_mcp",
            "type": "mcp_connector",
            "configured": bool(settings.hiker_mcp_server),
            "secret_configured": bool(settings.hiker_mcp_api_key),
        },
    ]


def _tool_names(tools: list[dict[str, Any]]) -> list[str]:
    return [tool["name"] for tool in tools]


def _ordered_tool_names(tools: list[dict[str, Any]], preferred_order: list[str]) -> list[str]:
    names = set(_tool_names(tools))
    return [tool_name for tool_name in preferred_order if tool_name in names]
