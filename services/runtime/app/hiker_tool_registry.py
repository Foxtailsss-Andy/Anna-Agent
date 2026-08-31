from __future__ import annotations

from services.runtime.app.skill_loader import LoadedSkill


HIKER_ALLOWED_TOOLS = frozenset(
    {
        "hiker.system.list_capabilities",
        "hiker.system.get_current_user_context",
        "hiker.master_data.search",
        "hiker.master_data.get_detail",
        "hiker.contract.list_contracts",
        "hiker.contract.get_contract_detail",
        "hiker.contract.get_business_chain",
        "hiker.report.get_dashboard_summary",
        "hiker.report.get_collection_summary",
        "hiker.report.get_invoice_summary",
        "hiker.report.get_po_receivable_summary",
    }
)

# Hiker's tools/list returns empty inputSchema for every tool, so argument
# schemas are pinned locally (from the integration doc) rather than discovered.
_TOOL_DESCRIPTIONS = {
    "hiker.system.list_capabilities": "返回 Hiker MCP 可用工具与开关状态。",
    "hiker.system.get_current_user_context": "返回当前 Hiker 用户、角色与可用模块。",
    "hiker.master_data.search": "搜索 Hiker 主数据（客户、国家、币种、公司、员工）。",
    "hiker.master_data.get_detail": "查询指定 Hiker 主数据详情。",
    "hiker.contract.list_contracts": "查询 Hiker 合同列表（可按客户名、状态、合同号过滤）。",
    "hiker.contract.get_contract_detail": "查询指定合同详情与金额汇总。",
    "hiker.contract.get_business_chain": "查询合同下游业务链（收款计划、发货、应收、开票、核销）。",
    "hiker.report.get_dashboard_summary": "查询 Hiker 工作台 KPI 与经营摘要。",
    "hiker.report.get_collection_summary": "查询回款提醒、账龄、风险与客户回款摘要。",
    "hiker.report.get_invoice_summary": "查询开票统计与核销摘要。",
    "hiker.report.get_po_receivable_summary": "查询 PO、销售订单、出库、应收、核销进度。",
}

def _input_schema(tool_name: str) -> dict:
    if tool_name == "hiker.master_data.search":
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键字。"},
                "types": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["customer", "country", "currency", "company", "employee"]},
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "additionalProperties": False,
        }
    if tool_name == "hiker.master_data.get_detail":
        return {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["customer", "country", "currency", "company", "employee"]},
                "code": {"type": "string"},
            },
            "required": ["type", "code"],
            "additionalProperties": False,
        }
    if tool_name == "hiker.contract.list_contracts":
        return {
            "type": "object",
            "properties": {
                "filters": {
                    "type": "object",
                    "properties": {
                        "customer_name": {"type": "string"},
                        "status": {"type": "string"},
                        "contract_number": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "additionalProperties": False,
        }
    if tool_name in ("hiker.contract.get_contract_detail", "hiker.contract.get_business_chain"):
        return {
            "type": "object",
            "properties": {"contract_number": {"type": "string"}},
            "required": ["contract_number"],
            "additionalProperties": False,
        }
    if tool_name == "hiker.report.get_collection_summary":
        return {
            "type": "object",
            "properties": {
                "filters": {
                    "type": "object",
                    "properties": {
                        "today": {"type": "string", "description": "YYYY-MM-DD。"},
                        "window_days": {"type": "integer", "minimum": 1, "maximum": 90},
                    },
                    "additionalProperties": False,
                }
            },
            "additionalProperties": False,
        }
    return {"type": "object", "properties": {}, "additionalProperties": False}


class HikerToolRegistry:
    def model_visible_tools(
        self,
        skill: LoadedSkill | None = None,
        discovered_tools: list[dict] | None = None,
    ) -> list[dict]:
        return [
            {
                "name": name,
                "description": _TOOL_DESCRIPTIONS[name],
                "input_schema": _input_schema(name),
                "schema_source": "registry",
            }
            for name in self._model_visible_tool_names(skill)
        ]

    def assert_allowed(self, tool_name: str) -> None:
        if tool_name not in HIKER_ALLOWED_TOOLS:
            raise PermissionError(f"tool is not available in hiker runtime: {tool_name}")

    def validate_arguments(self, tool_name: str, arguments: dict) -> None:
        """Apply the local typed schema before crossing the Hiker connector.

        Hiker's ``tools/list`` currently omits useful input schemas, so the
        pinned registry remains the authority for admitted argument names and
        required fields. This also keeps a model/Host payload from smuggling an
        arbitrary SQL/API operation through a known tool route.
        """
        self.assert_allowed(tool_name)
        if not isinstance(arguments, dict):
            raise ValueError("hiker tool arguments must be an object")
        schema = _input_schema(tool_name)
        properties = schema.get("properties", {})
        unknown = sorted(set(arguments) - set(properties))
        if unknown:
            raise ValueError(
                f"unknown arguments for {tool_name}: {', '.join(unknown)}"
            )
        missing = [key for key in schema.get("required", []) if key not in arguments]
        if missing:
            raise ValueError(
                f"missing arguments for {tool_name}: {', '.join(missing)}"
            )

    def _model_visible_tool_names(self, skill: LoadedSkill | None) -> list[str]:
        tool_names = set(HIKER_ALLOWED_TOOLS)
        if skill is not None:
            tool_names &= set(skill.allowed_tools)
            tool_names -= set(skill.forbidden_tools)
        return sorted(tool_names)
