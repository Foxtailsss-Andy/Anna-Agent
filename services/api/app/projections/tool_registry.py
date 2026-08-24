from __future__ import annotations

from typing import Any

from services.associate.app.orchestrator import ASSOCIATE_BACKEND_WRITE_ACTIONS
from services.runtime.app.associate_tool_registry import AssociateToolRegistry
from services.runtime.app.create_tool_registry import CreateToolRegistry
from services.runtime.app.reimbursement_tool_registry import ReimbursementToolRegistry


def _tool_registry_status() -> list[dict[str, Any]]:
    return [
        _registry_item(
            "associate",
            AssociateToolRegistry().model_visible_tools(),
            read_write="mixed",
            write_tools=sorted(ASSOCIATE_BACKEND_WRITE_ACTIONS),
        ),
        _registry_item(
            "create",
            CreateToolRegistry().model_visible_tools(),
            read_write="internal",
            write_tools=[],
        ),
        _registry_item(
            "reimbursement",
            ReimbursementToolRegistry().model_visible_tools(),
            read_write="mixed",
            write_tools=["reimbursement.submit"],
        ),
    ]


def _registry_item(
    registry_id: str,
    tools: list[dict[str, Any]],
    read_write: str,
    write_tools: list[str],
) -> dict[str, Any]:
    return {
        "id": registry_id,
        "tool_count": len(tools),
        "tool_names": [tool["name"] for tool in tools],
        "tools": [
            {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "input_schema": tool.get("input_schema", {}),
                "schema_source": tool.get("schema_source", "registry"),
                "read_write": _tool_read_write(tool["name"], read_write),
                "risk_level": _tool_risk_level(tool["name"]),
                "requires_confirmation": tool["name"].endswith("submit_intent"),
            }
            for tool in tools
        ],
        "read_write": read_write,
        "write_tools": write_tools,
    }


def _tool_read_write(tool_name: str, registry_read_write: str) -> str:
    if tool_name.endswith("submit_intent") or ".create_" in tool_name:
        return "write_intent"
    if tool_name.startswith("create."):
        return "internal"
    if tool_name.startswith("associate.emit"):
        return "internal"
    return "read" if registry_read_write in {"read", "mixed"} else registry_read_write


def _tool_risk_level(tool_name: str) -> str:
    if tool_name.endswith("submit_intent"):
        return "medium"
    if ".create_" in tool_name:
        return "medium"
    return "low"


def _tool_registry_catalog() -> dict[str, Any]:
    registries = _tool_registry_status()
    model_visible_tools = [
        {
            "name": tool["name"],
            "registry_id": registry["id"],
            "description": tool["description"],
            "read_write": tool["read_write"],
            "risk_level": tool["risk_level"],
            "requires_confirmation": tool["requires_confirmation"],
            "visibility": "model_visible",
            "schema_source": tool["schema_source"],
        }
        for registry in registries
        for tool in registry["tools"]
    ]
    backend_only_tools = [
        _backend_only_tool_item(registry["id"], tool_name)
        for registry in registries
        for tool_name in registry["write_tools"]
    ]
    confirmation_required_count = sum(
        1
        for tool in [*model_visible_tools, *backend_only_tools]
        if tool["requires_confirmation"]
    )
    return {
        "summary": {
            "registry_count": len(registries),
            "model_visible_tool_count": len(model_visible_tools),
            "backend_only_tool_count": len(backend_only_tools),
            "confirmation_required_count": confirmation_required_count,
            "external_write_tool_count": len(backend_only_tools),
        },
        "registries": registries,
        "model_visible_tools": model_visible_tools,
        "backend_only_tools": backend_only_tools,
    }


def _backend_only_tool_item(registry_id: str, tool_name: str) -> dict[str, Any]:
    descriptions = {
        "erp.collection_task.create_draft": "Create an approved ERP collection task draft.",
        "reimbursement.submit": "Submit an approved external reimbursement draft.",
    }
    return {
        "name": tool_name,
        "registry_id": registry_id,
        "description": descriptions.get(tool_name, "Backend-only external write tool."),
        "read_write": "write",
        "risk_level": "high",
        "requires_confirmation": True,
        "visibility": "backend_only",
    }
