from __future__ import annotations

from services.runtime.app.associate_tool_registry import ASSOCIATE_ALLOWED_TOOLS
from services.runtime.app.hiker_tool_registry import HIKER_ALLOWED_TOOLS
from services.runtime.app.toolset import REIMBURSEMENT_ALLOWED_TOOLS


CREATE_INTERNAL_TOOLS = frozenset(
    {
        "create.emit_skill_draft",
        "create.emit_prompt_draft",
        "create.emit_python_tool_draft",
    }
)
WRITE_OR_DANGEROUS_TOOLS = frozenset(
    {
        "reimbursement.submit",
        "erp.collection_task.create",
        "erp.action.execute",
    }
)
REGISTERED_MODEL_VISIBLE_TOOLS = (
    set(REIMBURSEMENT_ALLOWED_TOOLS)
    | set(ASSOCIATE_ALLOWED_TOOLS)
    | set(HIKER_ALLOWED_TOOLS)
)


class CreateToolRegistry:
    def model_visible_tools(self) -> list[dict]:
        return [
            {
                "name": "create.emit_skill_draft",
                "description": "Emit a generated Anna Skill draft for validation and review.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "skill_id": {"type": "string"},
                        "name": {"type": "string"},
                        "version": {"type": "string"},
                        "description": {"type": "string"},
                        "allowed_tools": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "forbidden_tools": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "body": {"type": "string"},
                    },
                    "required": [
                        "skill_id",
                        "name",
                        "version",
                        "description",
                        "allowed_tools",
                        "forbidden_tools",
                        "body",
                    ],
                    "additionalProperties": False,
                },
                "schema_source": "registry",
            },
            {
                "name": "create.emit_prompt_draft",
                "description": "Emit a generated Anna Prompt draft for review.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "prompt_id": {"type": "string"},
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "body": {"type": "string"},
                        "variables": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": [
                        "prompt_id",
                        "title",
                        "description",
                        "body",
                        "variables",
                    ],
                    "additionalProperties": False,
                },
                "schema_source": "registry",
            },
            {
                "name": "create.emit_python_tool_draft",
                "description": "Emit a generated Python tool draft with fixture input for no-secret evaluation.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "tool_id": {"type": "string"},
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "code": {"type": "string"},
                        "fixture_input": {"type": "string"},
                    },
                    "required": [
                        "tool_id",
                        "name",
                        "description",
                        "code",
                        "fixture_input",
                    ],
                    "additionalProperties": False,
                },
                "schema_source": "registry",
            },
        ]

    def unknown_allowed_tools(self, tool_names: list[str]) -> list[str]:
        return sorted(
            {
                tool_name
                for tool_name in tool_names
                if tool_name not in REGISTERED_MODEL_VISIBLE_TOOLS
            }
        )

    def dangerous_allowed_tools(self, tool_names: list[str]) -> list[str]:
        return sorted(
            {
                tool_name
                for tool_name in tool_names
                if tool_name in WRITE_OR_DANGEROUS_TOOLS
            }
        )
