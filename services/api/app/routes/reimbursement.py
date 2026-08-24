from __future__ import annotations

from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.event_stream import stream_run_action

from ..schemas import (
    AnswerMissingFieldsRequest,
    ApproveSubmitRequest,
    CreateReimbursementRunRequest,
    RejectSubmitRequest,
)
from ..security import _assert_identity, _assert_run_access
from ..validators.attachments import (
    _assert_imported_attachment_answers,
    _assert_imported_attachment_list,
    _import_attachment,
)
from ._sse import SSE_HEADERS, sse_frame


def build_router(reimbursement: ReimbursementOrchestrator) -> APIRouter:
    router = APIRouter()

    @router.post("/api/cowork/reimbursements/runs")
    def create_reimbursement_run(
        request: CreateReimbursementRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        _assert_imported_attachment_list(
            request.attachments, reimbursement, anna_workspace_id, anna_user_id
        )
        run = reimbursement.start_run(
            workspace_id=request.workspace_id,
            actor_user_id=request.actor_user_id,
            input_text=request.input_text,
            attachments=request.attachments,
        )
        return run.model_dump(mode="json")

    @router.get("/api/cowork/reimbursements/runs")
    def list_reimbursement_runs(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        runs = reimbursement.list_runs(anna_workspace_id, anna_user_id)
        return {"runs": [run.model_dump(mode="json") for run in runs]}

    @router.get("/api/cowork/reimbursements/runs/{run_id}")
    def get_reimbursement_run(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = reimbursement.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        return run.model_dump(mode="json")

    @router.post("/api/cowork/reimbursements/runs/{run_id}/answers")
    def answer_reimbursement_missing_fields(
        run_id: str,
        request: AnswerMissingFieldsRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = reimbursement.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        _assert_imported_attachment_answers(
            request.answers,
            reimbursement,
            anna_workspace_id,
            anna_user_id,
        )
        try:
            updated = reimbursement.answer_missing_fields(run_id, request.answers)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @router.post("/api/cowork/reimbursements/attachments")
    async def import_reimbursement_attachment(
        request: Request,
        anna_attachment_name: str = Header(alias="X-Anna-Attachment-Name"),
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict[str, Any]:
        content = await request.body()
        if not content:
            raise HTTPException(status_code=400, detail="attachment file is empty")
        return _import_attachment(
            reimbursement,
            anna_workspace_id,
            anna_user_id,
            unquote(anna_attachment_name),
            content,
        )

    @router.post("/api/cowork/reimbursements/approvals/{approval_id}/approve")
    def approve_reimbursement_submit(
        approval_id: str,
        request: ApproveSubmitRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = reimbursement.get_run_by_approval_id(approval_id)
        if run is None:
            raise HTTPException(status_code=404, detail="approval request not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if request.approved_by != anna_user_id:
            raise HTTPException(status_code=403, detail="approved_by must match current user")
        try:
            updated = reimbursement.approve_submit(
                approval_id=approval_id,
                approved_by=request.approved_by,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @router.post("/api/cowork/reimbursements/approvals/{approval_id}/reject")
    def reject_reimbursement_submit(
        approval_id: str,
        request: RejectSubmitRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = reimbursement.get_run_by_approval_id(approval_id)
        if run is None:
            raise HTTPException(status_code=404, detail="approval request not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if request.rejected_by != anna_user_id:
            raise HTTPException(status_code=403, detail="rejected_by must match current user")
        try:
            updated = reimbursement.reject_submit(
                approval_id=approval_id,
                rejected_by=request.rejected_by,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @router.post("/api/cowork/reimbursements/runs/{run_id}/verify")
    def retry_reimbursement_verify(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = reimbursement.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        try:
            updated = reimbursement.retry_verify(run_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @router.get("/api/admin/audit/reimbursement/runs/{run_id}")
    def get_reimbursement_audit(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        run = reimbursement.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        return {
            "run_id": run.id,
            "status": run.status,
            "audit_events": [
                event.model_dump(mode="json") for event in run.audit_events
            ],
        }

    @router.get("/api/admin/audit/reimbursement/actions/{write_action_id}")
    def get_reimbursement_write_action(
        write_action_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        action = reimbursement.get_write_action(write_action_id)
        if action is None:
            raise HTTPException(status_code=404, detail="write action not found")
        run = reimbursement.get_run(action.run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        return action.model_dump(mode="json")

    # ---- Streaming (SSE) variants: stream the ReAct loop live as it runs. ----
    # The create + answers streams drive the platform engine via the
    # orchestrator's async generators (audit-event frames, real token
    # streaming via text_delta, tool_start/tool_done, an awaiting_approval
    # frame on the approval suspend, and a terminal done frame carrying the
    # run). The MCP / governance / approval / audit logic is unchanged.

    @router.post("/api/cowork/reimbursements/runs/stream")
    async def stream_create_reimbursement_run(
        request: CreateReimbursementRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        _assert_imported_attachment_list(
            request.attachments, reimbursement, anna_workspace_id, anna_user_id
        )
        run = reimbursement.begin_run(
            workspace_id=request.workspace_id,
            actor_user_id=request.actor_user_id,
            input_text=request.input_text,
            attachments=request.attachments,
        )

        async def event_stream():
            async for frame in reimbursement.stream_created_advance(
                run, request.input_text
            ):
                yield sse_frame(frame)

        return StreamingResponse(
            event_stream(), media_type="text/event-stream", headers=SSE_HEADERS
        )

    @router.post("/api/cowork/reimbursements/runs/{run_id}/answers/stream")
    async def stream_answer_reimbursement_missing_fields(
        run_id: str,
        request: AnswerMissingFieldsRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        run = reimbursement.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        _assert_imported_attachment_answers(
            request.answers,
            reimbursement,
            anna_workspace_id,
            anna_user_id,
        )
        try:
            run = reimbursement.begin_answer(run_id, request.answers)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        async def event_stream():
            async for frame in reimbursement.stream_answers_advance(
                run, request.answers
            ):
                yield sse_frame(frame)

        return StreamingResponse(
            event_stream(), media_type="text/event-stream", headers=SSE_HEADERS
        )

    @router.post("/api/cowork/reimbursements/approvals/{approval_id}/approve/stream")
    async def stream_approve_reimbursement_submit(
        approval_id: str,
        request: ApproveSubmitRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        # Deliberately NOT migrated to the engine: approve_submit is the
        # RESUME path — a direct adapter.submit() + verify readback with no
        # model in the loop (spec §2/§4.2), so there are no engine frames to
        # stream. stream_run_action (retained for not-yet-migrated paths per
        # spec §5) still streams its audit events live.
        run = reimbursement.get_run_by_approval_id(approval_id)
        if run is None:
            raise HTTPException(status_code=404, detail="approval request not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if request.approved_by != anna_user_id:
            raise HTTPException(status_code=403, detail="approved_by must match current user")

        async def event_stream():
            async for event in stream_run_action(
                run,
                lambda: reimbursement.approve_submit(
                    approval_id=approval_id, approved_by=request.approved_by
                ),
            ):
                yield sse_frame(event)

        return StreamingResponse(
            event_stream(), media_type="text/event-stream", headers=SSE_HEADERS
        )

    return router
