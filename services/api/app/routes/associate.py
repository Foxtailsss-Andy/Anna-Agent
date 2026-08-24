from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator

from ..schemas import (
    ApproveAssociateNodeRequest,
    CreateAssociateNodeApprovalRequest,
    CreateAssociateReceivablesRunRequest,
    RejectAssociateNodeRequest,
)
from ..security import _assert_identity, _assert_run_access


def build_router(associate: AssociateReceivablesOrchestrator) -> APIRouter:
    router = APIRouter()

    @router.post("/api/cowork/associate/receivables-recovery/runs")
    def create_associate_receivables_run(
        request: CreateAssociateReceivablesRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        run = associate.start_run(
            workspace_id=request.workspace_id,
            actor_user_id=request.actor_user_id,
            period=request.period,
            goal_text=request.goal_text,
        )
        return run.model_dump(mode="json")

    @router.get("/api/cowork/associate/receivables-recovery/runs/{run_id}")
    def get_associate_receivables_run(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = associate.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="associate run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        return run.model_dump(mode="json")

    @router.post("/api/cowork/associate/receivables-recovery/runs/{run_id}/nodes/{node_id}/approval")
    def create_associate_node_approval(
        run_id: str,
        node_id: str,
        request: CreateAssociateNodeApprovalRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        if request.requested_by != anna_user_id:
            raise HTTPException(status_code=403, detail="requested_by must match current user")
        run = associate.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="associate run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        try:
            updated = associate.request_node_execution(
                run_id,
                node_id,
                requested_by=request.requested_by,
            )
        except ValueError as exc:
            status_code = 404 if str(exc) == "Associate node not found" else 400
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @router.post("/api/cowork/associate/receivables-recovery/approvals/{approval_id}/approve")
    def approve_associate_node_execution(
        approval_id: str,
        request: ApproveAssociateNodeRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        if request.approved_by != anna_user_id:
            raise HTTPException(status_code=403, detail="approved_by must match current user")
        run = associate.get_run_by_approval_id(approval_id)
        if run is None:
            raise HTTPException(status_code=404, detail="approval request not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        try:
            updated = associate.approve_node_execution(
                approval_id,
                approved_by=request.approved_by,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @router.post("/api/cowork/associate/receivables-recovery/approvals/{approval_id}/reject")
    def reject_associate_node_execution(
        approval_id: str,
        request: RejectAssociateNodeRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        if request.rejected_by != anna_user_id:
            raise HTTPException(status_code=403, detail="rejected_by must match current user")
        run = associate.get_run_by_approval_id(approval_id)
        if run is None:
            raise HTTPException(status_code=404, detail="approval request not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        try:
            updated = associate.reject_node_execution(
                approval_id,
                rejected_by=request.rejected_by,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    return router
