from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from services.reimbursement.app.audit import AuditEvent


RunStatus = Literal[
    "collecting",
    "validating",
    "draft_created",
    "waiting_confirmation",
    "submitting",
    "verifying",
    "completed",
    "failed",
    "verify_pending",
]


class AttachmentRef(BaseModel):
    name: str
    uri: str


class ReimbursementDraft(BaseModel):
    category: str | None = None
    amount: float | None = None
    currency: str | None = None
    expense_date: str | None = None
    merchant: str | None = None
    reason: str | None = None
    department_id: str | None = None
    cost_center_id: str | None = None
    project_id: str | None = None
    attachments: list[AttachmentRef] = Field(default_factory=list)
    external_reimbursement_id: str | None = None
    external_status: str | None = None

    def as_mcp_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class ApprovalRequest(BaseModel):
    id: str
    run_id: str
    action_type: str
    risk_level: str
    status: Literal["pending", "approved", "rejected", "expired"] = "pending"
    payload: dict[str, Any]
    payload_hash: str | None = None
    draft_snapshot: dict[str, Any] | None = None
    draft_snapshot_hash: str | None = None


class ReimbursementWriteAction(BaseModel):
    id: str
    run_id: str
    approval_id: str
    external_reimbursement_id: str
    idempotency_key: str
    status: Literal["success", "failed"]
    verify_status: Literal["verified", "verify_pending", "failed"]
    approval_payload_hash: str | None = None
    draft_snapshot_hash: str | None = None


class ReimbursementRun(BaseModel):
    id: str
    workspace_id: str
    actor_user_id: str
    input_text: str
    status: RunStatus
    draft: ReimbursementDraft
    missing_fields: list[str] = Field(default_factory=list)
    agent_message: str | None = None
    approval: ApprovalRequest | None = None
    write_action: ReimbursementWriteAction | None = None
    audit_events: list[AuditEvent] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
