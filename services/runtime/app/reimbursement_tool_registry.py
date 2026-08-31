from __future__ import annotations

from copy import deepcopy

from services.runtime.app.skill_loader import LoadedSkill
from services.runtime.app.toolset import (
    REIMBURSEMENT_ALLOWED_TOOLS,
    assert_model_visible_tool_allowed,
)


APPROVAL_INTENT_TOOLS = frozenset({"reimbursement.submit_intent"})
APPROVAL_ACTION_INTENT_TOOLS = frozenset(
    {"reimbursement.approve_intent", "reimbursement.reject_intent"}
)
READ_ONLY_TOOLS = frozenset(
    {
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.get_status",
        "reimbursement.list_approvals",
        "reimbursement.get_approval",
    }
)
MERGEABLE_SCHEMA_KEYS = frozenset(
    {
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "multipleOf",
    }
)


class ReimbursementToolRegistry:
    def model_visible_tools(
        self,
        skill: LoadedSkill | None = None,
        discovered_tools: list[dict] | None = None,
    ) -> list[dict]:
        discovered_by_name = _discovered_tool_map(discovered_tools or [])
        return [
            _model_visible_tool(tool_name, discovered_by_name)
            for tool_name in self._model_visible_tool_names(skill)
        ]

    def dispatch_kind(self, tool_name: str) -> str:
        assert_model_visible_tool_allowed(tool_name)
        if tool_name in APPROVAL_INTENT_TOOLS:
            return "approval_intent"
        if tool_name in APPROVAL_ACTION_INTENT_TOOLS:
            return "approval_action_intent"
        return "mcp_tool"

    def _model_visible_tool_names(self, skill: LoadedSkill | None) -> list[str]:
        tool_names = set(REIMBURSEMENT_ALLOWED_TOOLS)
        if skill is not None:
            tool_names &= set(skill.allowed_tools)
            tool_names -= set(skill.forbidden_tools)
        return sorted(tool_names)


def _tool_description(tool_name: str) -> str:
    descriptions = {
        "reimbursement.get_capabilities": "Read reimbursement adapter capabilities.",
        "reimbursement.get_policy": "Read reimbursement policy checks.",
        "reimbursement.validate_draft": "Validate a reimbursement draft.",
        "reimbursement.create_draft": "Create an external reimbursement draft.",
        "reimbursement.submit_intent": "Request approval for reimbursement submit.",
        "reimbursement.get_status": "Read external reimbursement status.",
        "reimbursement.list_approvals": "List pending external reimbursement approvals for the actor.",
        "reimbursement.get_approval": "Read an external approval's detail and approval chain.",
        "reimbursement.approve_intent": "Request the leader to approve an external reimbursement.",
        "reimbursement.reject_intent": "Request the leader to reject an external reimbursement.",
    }
    return descriptions[tool_name]


def _model_visible_tool(tool_name: str, discovered_by_name: dict[str, dict]) -> dict:
    base_schema = _tool_input_schema(tool_name)
    discovered = discovered_by_name.get(tool_name)
    if discovered is not None:
        input_schema, schema_changed = _merge_discovered_schema(
            base_schema,
            discovered["input_schema"],
        )
        if schema_changed:
            return {
                "name": tool_name,
                "description": _tool_description(tool_name),
                "input_schema": input_schema,
                "schema_source": "mcp",
                **_tool_metadata(tool_name),
            }
    return {
        "name": tool_name,
        "description": _tool_description(tool_name),
        "input_schema": base_schema,
        "schema_source": "registry",
        **_tool_metadata(tool_name),
    }


def _tool_metadata(tool_name: str) -> dict[str, str]:
    if tool_name in READ_ONLY_TOOLS:
        return {"effect": "read", "replay_policy": "safe"}
    if tool_name == "reimbursement.create_draft":
        return {"effect": "business_write", "replay_policy": "never"}
    if tool_name in APPROVAL_INTENT_TOOLS | APPROVAL_ACTION_INTENT_TOOLS:
        return {"effect": "approval", "replay_policy": "never"}
    raise ValueError(f"unknown reimbursement tool metadata: {tool_name}")


def _merge_discovered_schema(
    base_schema: dict,
    discovered_schema: dict,
) -> tuple[dict, bool]:
    merged = deepcopy(base_schema)
    changed = _merge_schema_into(merged, discovered_schema)
    return merged, changed


def _merge_schema_into(base_schema: dict, discovered_schema: dict) -> bool:
    changed = False
    for key in MERGEABLE_SCHEMA_KEYS:
        if key in discovered_schema and base_schema.get(key) != discovered_schema[key]:
            base_schema[key] = discovered_schema[key]
            changed = True
    base_properties = base_schema.get("properties")
    discovered_properties = discovered_schema.get("properties")
    if isinstance(base_properties, dict) and isinstance(discovered_properties, dict):
        for property_name, base_property_schema in base_properties.items():
            discovered_property_schema = discovered_properties.get(property_name)
            if not isinstance(base_property_schema, dict) or not isinstance(
                discovered_property_schema,
                dict,
            ):
                continue
            if _merge_schema_into(base_property_schema, discovered_property_schema):
                changed = True
    base_items = base_schema.get("items")
    discovered_items = discovered_schema.get("items")
    if isinstance(base_items, dict) and isinstance(discovered_items, dict):
        if _merge_schema_into(base_items, discovered_items):
            changed = True
    return changed


def _discovered_tool_map(discovered_tools: list[dict]) -> dict[str, dict]:
    discovered_by_name: dict[str, dict] = {}
    for tool in discovered_tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        input_schema = tool.get("input_schema")
        if not isinstance(name, str) or not isinstance(input_schema, dict):
            continue
        discovered_by_name[name] = {
            "description": tool.get("description") if isinstance(tool.get("description"), str) else None,
            "input_schema": input_schema,
        }
    return discovered_by_name


def _tool_input_schema(tool_name: str) -> dict:
    schemas = {
        "reimbursement.get_capabilities": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "reimbursement.get_policy": {
            "type": "object",
            "properties": {
                "category": {"type": "string"},
                "amount": {"type": "number"},
                "currency": {"type": "string"},
                "department_id": {"type": "string"},
                "cost_center_id": {"type": "string"},
            },
            "required": [
                "category",
                "amount",
                "currency",
                "department_id",
                "cost_center_id",
            ],
            "additionalProperties": False,
        },
        "reimbursement.validate_draft": {
            "type": "object",
            "properties": {"draft": _draft_schema()},
            "required": ["draft"],
            "additionalProperties": False,
        },
        "reimbursement.create_draft": {
            "type": "object",
            "properties": {"draft": _draft_schema()},
            "required": ["draft"],
            "additionalProperties": False,
        },
        "reimbursement.submit_intent": {
            "type": "object",
            "properties": {
                "external_reimbursement_id": {"type": "string"},
                "amount": {"type": "number"},
                "currency": {"type": "string"},
                "reason": {"type": "string"},
                "policy_summary": {"type": "string"},
                "risk_level": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                },
            },
            "required": [
                "external_reimbursement_id",
                "amount",
                "currency",
                "reason",
                "policy_summary",
                "risk_level",
            ],
            "additionalProperties": False,
        },
        "reimbursement.get_status": {
            "type": "object",
            "properties": {
                "external_reimbursement_id": {"type": "string"},
            },
            "required": ["external_reimbursement_id"],
            "additionalProperties": False,
        },
        "reimbursement.list_approvals": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["pending"]},
                "risk_level": {"type": "string", "enum": ["low", "medium", "high"]},
                "applicant": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "reimbursement.get_approval": {
            "type": "object",
            "properties": {"approval_id": {"type": "string"}},
            "required": ["approval_id"],
            "additionalProperties": False,
        },
        "reimbursement.approve_intent": {
            "type": "object",
            "properties": {
                "approval_id": {"type": "string"},
                "comment": {"type": "string"},
            },
            "required": ["approval_id"],
            "additionalProperties": False,
        },
        "reimbursement.reject_intent": {
            "type": "object",
            "properties": {
                "approval_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["approval_id", "reason"],
            "additionalProperties": False,
        },
    }
    return schemas[tool_name]


def _draft_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "category": {"type": "string"},
            "amount": {"type": "number"},
            "currency": {"type": "string"},
            "expense_date": {"type": "string"},
            "merchant": {"type": "string"},
            "reason": {"type": "string"},
            "department_id": {"type": "string"},
            "cost_center_id": {"type": "string"},
            "project_id": {"type": "string"},
            "attachments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "uri": {"type": "string"},
                    },
                    "required": ["name", "uri"],
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    }
