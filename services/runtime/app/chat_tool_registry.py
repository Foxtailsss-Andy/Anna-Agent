from __future__ import annotations

from copy import deepcopy

from services.runtime.app.engine.plan_tool import (
    PLAN_UPDATE_DESCRIPTION,
    PLAN_UPDATE_INPUT_SCHEMA,
    PLAN_UPDATE_TOOL_NAME,
)
from services.runtime.app.skill_loader import LoadedSkill


# P4 交付闭环:模型经 Harness 调用 emit 工具提交正式产物(落 run.artifacts+审计),
# 而不是把 HTML/文档当纯文本吐给前端截流。
# W1.T3:plan.update 原生工具(引擎层实现),模型维护任务计划清单落 run.plan。
CHAT_ALLOWED_TOOLS = frozenset(
    {
        "chat.emit_page",
        "chat.emit_document",
        PLAN_UPDATE_TOOL_NAME,
    }
)


class ChatToolRegistry:
    """Fail-closed registry exposing only Chat planning and deliverable tools."""

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

    def assert_allowed(self, tool_name: str) -> None:
        if tool_name not in CHAT_ALLOWED_TOOLS:
            raise PermissionError(f"tool is not available in chat runtime: {tool_name}")

    def _model_visible_tool_names(self, skill: LoadedSkill | None) -> list[str]:
        tool_names = set(CHAT_ALLOWED_TOOLS)
        if skill is not None:
            tool_names -= set(skill.forbidden_tools)
        return sorted(tool_names)


def _model_visible_tool(tool_name: str, discovered_by_name: dict[str, dict]) -> dict:
    base_schema = _tool_input_schema(tool_name)
    discovered = discovered_by_name.get(tool_name)
    if discovered is None:
        return {
            "name": tool_name,
            "description": _tool_description(tool_name),
            "input_schema": base_schema,
            "schema_source": "registry",
        }

    merged = deepcopy(base_schema)
    input_schema = discovered.get("input_schema")
    if isinstance(input_schema, dict):
        discovered_properties = input_schema.get("properties")
        base_properties = merged.get("properties")
        if isinstance(discovered_properties, dict) and isinstance(base_properties, dict):
            for field_name, field_schema in base_properties.items():
                discovered_field = discovered_properties.get(field_name)
                if isinstance(field_schema, dict) and isinstance(discovered_field, dict):
                    for key in ("enum", "minimum", "maximum", "minLength", "maxLength"):
                        if key in discovered_field:
                            field_schema[key] = discovered_field[key]
    return {
        "name": tool_name,
        "description": _tool_description(tool_name),
        "input_schema": merged,
        "schema_source": "mcp",
    }


def _tool_description(tool_name: str) -> str:
    descriptions = {
        "chat.emit_page": "Submit a finished single-file HTML page as a formal deliverable. Call this whenever the user asks for a webpage.",
        "chat.emit_document": "Submit a finished markdown document as a formal deliverable. Call this whenever the user asks for a document/report.",
        PLAN_UPDATE_TOOL_NAME: PLAN_UPDATE_DESCRIPTION,
    }
    return descriptions[tool_name]


def _tool_input_schema(tool_name: str) -> dict:
    schemas = {
        "chat.emit_page": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short page title."},
                "html": {
                    "type": "string",
                    "description": "Complete standalone HTML (inline styles, no external resources).",
                },
            },
            "required": ["title", "html"],
            "additionalProperties": False,
        },
        "chat.emit_document": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short document title."},
                "markdown": {"type": "string", "description": "Complete markdown document body."},
            },
            "required": ["title", "markdown"],
            "additionalProperties": False,
        },
        PLAN_UPDATE_TOOL_NAME: PLAN_UPDATE_INPUT_SCHEMA,
    }
    return schemas[tool_name]


def _discovered_tool_map(discovered_tools: list[dict]) -> dict[str, dict]:
    discovered_by_name: dict[str, dict] = {}
    for tool in discovered_tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        input_schema = tool.get("input_schema")
        if not isinstance(name, str) or not isinstance(input_schema, dict):
            continue
        discovered_by_name[name] = {"input_schema": input_schema}
    return discovered_by_name
