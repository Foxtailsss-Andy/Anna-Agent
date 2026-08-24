"""Shared hiker test fakes — one canonical home, no cross-test-module imports.

``FakeGateway`` (deterministic Hiker MCP reads) and ``FakeSkillLoader`` (fixed
``LoadedSkill`` for the hiker assistant skill) were previously defined in
``test_hiker_orchestrator`` and imported by ``test_hiker_routes`` /
``test_hiker_assistant_stream`` (which also carried its own duplicate
``FakeSkillLoader``) — the cross-test-module pattern
``tests.support.engine_fakes`` eliminated for the engine fakes. Same cure
here: every hiker test module imports the fakes from this plain module.
"""
from __future__ import annotations

from pathlib import Path

from services.runtime.app.hiker_tool_registry import HIKER_ALLOWED_TOOLS
from services.runtime.app.skill_loader import LoadedSkill


DASHBOARD_DATA = {
    "contract_count": 4,
    "contract_amount": "1000000.00",
    "planned_receipt_amount": "600000.00",
    "actual_receipt_amount": "450000.00",
    "unreceived_amount": "150000.00",
    "invoiced_amount": "0.00",
    "uninvoiced_amount": "0.00",
    "receivable_invoice_amount": "0.00",
}
COLLECTION_DATA = {
    "reminders": {"summary": {"due_soon_count": 2, "overdue_count": 0}, "rows": []},
    "aging": {
        "summary": {
            "not_due_count": 4, "not_due_amount": "150000.00",
            "overdue_1_30_count": 0, "overdue_1_30_amount": "0.00",
            "overdue_31_60_count": 0, "overdue_31_60_amount": "0.00",
            "overdue_61_90_count": 0, "overdue_61_90_amount": "0.00",
            "overdue_90_plus_count": 0, "overdue_90_plus_amount": "0.00",
        },
        "rows": [],
    },
    "risk": {"summary": {"due_soon_count": 2, "overdue_count": 0}, "rows": []},
    "customers": {
        "rows": [
            {"customer_name": "示例客户甲", "contract_count": 2, "contract_amount": "700000.00",
             "planned_receipt_amount": "420000.00", "actual_receipt_amount": "320000.00", "unreceived_amount": "100000.00"},
            {"customer_name": "示例客户乙", "contract_count": 2, "contract_amount": "300000.00",
             "planned_receipt_amount": "180000.00", "actual_receipt_amount": "130000.00", "unreceived_amount": "50000.00"},
        ]
    },
}
COUNTRY_DATA = {"query": "", "items": [{"type": "country", "code": "CN", "name": "中国"}, {"type": "country", "code": "US", "name": "美国"}]}


class FakeGateway:
    """Stand-in for HikerMcpGateway with deterministic read responses."""

    def status(self):
        return {"status": "connected", "tool_count": 11, "tool_names": []}

    def call_tool(self, tool_name, arguments):
        if tool_name == "hiker.report.get_dashboard_summary":
            return {"data": DASHBOARD_DATA}
        if tool_name == "hiker.report.get_collection_summary":
            return {"data": COLLECTION_DATA}
        if tool_name == "hiker.master_data.search":
            return {"data": COUNTRY_DATA}
        raise AssertionError(f"unexpected tool {tool_name}")


class FakeSkillLoader:
    """Stub SkillLoader whose .load() always returns a fixed LoadedSkill."""

    def load(self, skill_id: str) -> LoadedSkill:
        return LoadedSkill(
            id="hiker/global-customer",
            name="hiker-global-customer",
            version="0.1.0",
            path=Path("."),
            content="test skill",
            content_hash="x",
            allowed_tools=list(HIKER_ALLOWED_TOOLS),
            forbidden_tools=[],
            frontmatter={},
        )
