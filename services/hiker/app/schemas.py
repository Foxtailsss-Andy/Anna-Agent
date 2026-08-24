from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from services.reimbursement.app.audit import AuditEvent


HikerStatus = Literal["validating", "ready", "failed"]


class HikerKpi(BaseModel):
    id: str
    label: str
    value: float
    unit: str | None = None


class HikerCollectionProgress(BaseModel):
    planned_amount: float = 0.0
    actual_amount: float = 0.0
    unreceived_amount: float = 0.0


class HikerAgingBucket(BaseModel):
    id: str
    label: str
    count: int = 0
    amount: float = 0.0


class HikerCustomerRow(BaseModel):
    customer_name: str
    contract_count: int = 0
    contract_amount: float = 0.0
    planned_receipt_amount: float = 0.0
    actual_receipt_amount: float = 0.0
    unreceived_amount: float = 0.0


class HikerAnomaly(BaseModel):
    id: str
    title: str
    severity: Literal["low", "medium", "high"] = "medium"
    explanation: str


class HikerDashboardSnapshot(BaseModel):
    source: str = "Hiker MCP"
    kpis: list[HikerKpi] = Field(default_factory=list)
    collection: HikerCollectionProgress = Field(default_factory=HikerCollectionProgress)
    aging_buckets: list[HikerAgingBucket] = Field(default_factory=list)
    risk_due_soon_count: int = 0
    risk_overdue_count: int = 0
    top_customers: list[HikerCustomerRow] = Field(default_factory=list)
    anomalies: list[HikerAnomaly] = Field(default_factory=list)


class HikerDashboardRun(BaseModel):
    id: str
    workspace_id: str
    actor_user_id: str
    status: HikerStatus
    snapshot: HikerDashboardSnapshot | None = None
    audit_events: list[AuditEvent] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None


class HikerAssistantRun(BaseModel):
    id: str
    workspace_id: str
    actor_user_id: str
    question: str
    status: Literal["validating", "ready", "failed"]
    answer: str | None = None
    agent_message: str | None = None
    tools_used: list[str] = Field(default_factory=list)
    audit_events: list[AuditEvent] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
