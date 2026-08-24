from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from services.reimbursement.app.audit import AuditEvent


AssociateRunStatus = Literal["validating", "collecting", "ready", "failed"]
AssociateNodeStatus = Literal["ready", "blocked", "running", "verify_pending", "completed"]
AssociateApprovalStatus = Literal["pending", "approved", "rejected", "expired"]


class AssociateWriteIntent(BaseModel):
    action_type: str
    risk_level: Literal["low", "medium", "high"] = "medium"
    summary: str
    payload: dict[str, Any] = Field(default_factory=dict)


class AssociateApprovalRequest(BaseModel):
    id: str
    run_id: str
    node_id: str
    action_type: str
    risk_level: Literal["low", "medium", "high"] = "medium"
    status: AssociateApprovalStatus = "pending"
    payload: dict[str, Any]
    payload_hash: str
    node_snapshot: dict[str, Any]
    node_snapshot_hash: str


class AssociateWriteAction(BaseModel):
    id: str
    run_id: str
    node_id: str
    approval_id: str
    action_type: str
    status: Literal["success", "failed"]
    verify_status: Literal["verify_pending", "verified", "failed"] = "verify_pending"
    external_task_id: str | None = None
    external_status: str | None = None
    idempotency_key: str
    approval_payload_hash: str
    node_snapshot_hash: str


class AssociateGoalNode(BaseModel):
    id: str
    title: str
    status: AssociateNodeStatus
    owner: str | None = None
    depends_on: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    blocker: str | None = None
    write_intent: AssociateWriteIntent | None = None
    approval: AssociateApprovalRequest | None = None
    write_action: AssociateWriteAction | None = None


class AssociateGoalPlan(BaseModel):
    goal: str
    summary: str
    nodes: list[AssociateGoalNode] = Field(default_factory=list)


class AssociateReceivablesRun(BaseModel):
    id: str
    workspace_id: str
    actor_user_id: str
    period: str
    goal_text: str
    status: AssociateRunStatus
    plan: AssociateGoalPlan | None = None
    audit_events: list[AuditEvent] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
