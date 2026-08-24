from __future__ import annotations

from fastapi import APIRouter, Header

from services.identity.app.service import IdentityService
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator

from ..runtime_config import _session_identity


def build_router(
    reimbursement: ReimbursementOrchestrator,
    identity: IdentityService | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/api/session/current")
    def get_current_session(
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        if identity is not None and authorization and authorization.startswith("Bearer "):
            token = authorization.removeprefix("Bearer ").strip()
            resolved = identity.resolve(token) if token else None
            if resolved is not None:
                payload = resolved.model_dump(mode="json")
                payload["source"] = "token"
                return payload
        return _session_identity(reimbursement)

    return router
