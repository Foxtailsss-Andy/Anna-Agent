from __future__ import annotations

from services.reimbursement.app.schemas import ReimbursementDraft


class ReimbursementPolicy:
    def required_missing_fields(
        self,
        draft: ReimbursementDraft,
        required_fields: list[str],
    ) -> list[str]:
        payload = draft.as_mcp_payload()
        return [field for field in required_fields if not payload.get(field)]

    def submit_idempotency_key(self, run_id: str) -> str:
        return f"idem_{run_id}_submit"

    def create_idempotency_key(self, run_id: str) -> str:
        return f"idem_{run_id}_create"
