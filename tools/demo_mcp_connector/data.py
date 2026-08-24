"""Demo-tenant data for the Anna demo MCP connector.

All values here are sample data for a fictional demo company. They are
deliberately labeled so that on-screen output cannot be mistaken for a real
business tenant. Numbers are illustrative and limited to the optional
Associate receivables seam and reimbursement connector.
"""
from __future__ import annotations

from typing import Any

DEMO_MARK = "演示数据"


def receivables_aging(period: str, overdue_days: float) -> dict[str, Any]:
    return {
        "period": period,
        "overdue_days": overdue_days,
        "currency": "CNY",
        "note": DEMO_MARK,
        "rows": _receivables_rows(),
    }


def _receivables_rows() -> list[dict[str, Any]]:
    return [
        {
            "customer": "演示客户A",
            "customer_id": "CUST-DEMO-A",
            "overdue_amount": 480_000.0,
            "aging_days": 72,
            "currency": "CNY",
        },
        {
            "customer": "演示客户C",
            "customer_id": "CUST-DEMO-C",
            "overdue_amount": 380_000.0,
            "aging_days": 64,
            "currency": "CNY",
        },
        {
            "customer": "演示客户F",
            "customer_id": "CUST-DEMO-F",
            "overdue_amount": 120_000.0,
            "aging_days": 41,
            "currency": "CNY",
        },
    ]


DEMO_TENANT_SOURCE = "演示租户账套 associate-erp-2026"
