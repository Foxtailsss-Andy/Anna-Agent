from __future__ import annotations

from services.runtime.app.skill_loader import LoadedSkill


ASSOCIATE_ALLOWED_TOOLS = frozenset(
    {
        "erp.finance.get_receivables_aging",
        "associate.emit_goal_plan",
    }
)
ASSOCIATE_INTERNAL_TOOLS = frozenset({"associate.emit_goal_plan"})


class AssociateToolRegistry:
    def model_visible_tools(
        self,
        skill: LoadedSkill | None = None,
        discovered_tools: list[dict] | None = None,
    ) -> list[dict]:
        return [
            _model_visible_tool(tool_name)
            for tool_name in self._model_visible_tool_names(skill)
        ]

    def assert_allowed(self, tool_name: str) -> None:
        if tool_name not in ASSOCIATE_ALLOWED_TOOLS:
            raise PermissionError(f"tool is not available in Associate runtime: {tool_name}")

    def dispatch_kind(self, tool_name: str) -> str:
        self.assert_allowed(tool_name)
        return "internal" if tool_name in ASSOCIATE_INTERNAL_TOOLS else "mcp_tool"

    def _model_visible_tool_names(self, skill: LoadedSkill | None) -> list[str]:
        tool_names = set(ASSOCIATE_ALLOWED_TOOLS)
        if skill is not None:
            tool_names &= set(skill.allowed_tools)
            tool_names -= set(skill.forbidden_tools)
        return sorted(tool_names)


def _model_visible_tool(tool_name: str) -> dict:
    return {
        "name": tool_name,
        "description": _tool_description(tool_name),
        "input_schema": _tool_input_schema(tool_name),
        "schema_source": "registry",
    }


def _tool_description(tool_name: str) -> str:
    descriptions = {
        "erp.finance.get_receivables_aging": "Read ERP receivables aging items for Associate goal planning.",
        "associate.emit_goal_plan": "Emit a structured Associate goal plan with DAG nodes.",
    }
    return descriptions[tool_name]


def _tool_input_schema(tool_name: str) -> dict:
    schemas = {
        "erp.finance.get_receivables_aging": {
            "type": "object",
            "properties": {
                "period": {"type": "string"},
                "overdue_days": {"type": "number"},
            },
            "required": ["period", "overdue_days"],
            "additionalProperties": False,
        },
        "associate.emit_goal_plan": {
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "summary": {"type": "string"},
                "nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "title": {"type": "string"},
                            "status": {
                                "type": "string",
                                "enum": ["ready", "blocked", "running", "completed"],
                            },
                            "owner": {"type": "string"},
                            "depends_on": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "evidence": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "blocker": {"type": "string"},
                            "write_intent": {
                                "type": "object",
                                "properties": {
                                    "action_type": {"type": "string"},
                                    "risk_level": {
                                        "type": "string",
                                        "enum": ["low", "medium", "high"],
                                    },
                                    "summary": {"type": "string"},
                                },
                                "required": ["action_type", "risk_level", "summary"],
                                "additionalProperties": False,
                            },
                        },
                        "required": ["id", "title", "status"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["goal", "summary", "nodes"],
            "additionalProperties": False,
        },
    }
    return schemas[tool_name]
