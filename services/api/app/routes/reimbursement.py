from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.business.harness_client import HarnessHostClient, HarnessHostError, HarnessRun, ProductTask, result_payload
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


def build_router(
    reimbursement: ReimbursementOrchestrator,
    *,
    harness_client: HarnessHostClient | None = None,
    product_mode: bool = False,
) -> APIRouter:
    router = APIRouter()

    def require_host() -> HarnessHostClient:
        if not product_mode or harness_client is None:
            raise HTTPException(status_code=503, detail="Harness Host is not configured")
        return harness_client

    def host_tool_catalog() -> list[dict[str, Any]]:
        try:
            skill = reimbursement.skill_loader.load(
                reimbursement.settings.reimbursement_skill_id
            )
        except Exception:  # noqa: BLE001 - an unavailable skill admits no business tools
            return []
        return reimbursement.tool_registry.model_visible_tools(skill)

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
        if product_mode:
            run = reimbursement.begin_run(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                input_text=request.input_text,
                attachments=request.attachments,
            )
            reimbursement._record_created(run, request.input_text)
            try:
                host_run = require_host().submit_and_wait(
                    _task_for_reimbursement_run(
                        run, stage="create", tool_catalog=host_tool_catalog()
                    )
                )
            except HarnessHostError as exc:
                run = reimbursement._save_and_return(
                    reimbursement._fail_run(run, exc.code or "harness_request_failed", "Harness Host reimbursement task failed")
                )
            else:
                run = reimbursement.apply_host_result(run, result_payload(host_run), host_status=host_run.status)
        else:
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
            if product_mode:
                reimbursement._record_answers(run, request.answers)
                host_run = require_host().submit_and_wait(
                    _task_for_reimbursement_run(
                        run,
                        stage="answers",
                        answers=request.answers,
                        host_run_id=_linked_host_run_id(run, "answers", request.answers),
                        linked_run_id=run.id,
                        tool_catalog=host_tool_catalog(),
                    )
                )
                updated = reimbursement.apply_host_result(
                    run, result_payload(host_run), host_status=host_run.status
                )
            else:
                updated = reimbursement.answer_missing_fields(run_id, request.answers)
        except HarnessHostError as exc:
            raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
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
            if product_mode and updated.write_action is not None:
                host_run = require_host().submit_and_wait(
                    _task_for_reimbursement_run(
                        updated,
                        stage="approval",
                        linked_run_id=updated.id,
                        host_run_id=_linked_host_run_id(
                            updated,
                            "approval",
                            {"approval_id": approval_id, "approved_by": request.approved_by},
                        ),
                        continuation_facts={
                            "approval_id": approval_id,
                            "approved_by": request.approved_by,
                            "write_action": updated.write_action.model_dump(mode="json"),
                        },
                        tool_catalog=host_tool_catalog(),
                    )
                )
                updated = reimbursement.apply_host_result(
                    updated, result_payload(host_run), host_status=host_run.status
                )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except HarnessHostError as exc:
            raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
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
            if product_mode:
                reimbursement._record_created(run, request.input_text)
                async for frame in _stream_host_reimbursement(
                    reimbursement,
                    run,
                    stage="create",
                    client=require_host(),
                    tool_catalog=host_tool_catalog(),
                ):
                    yield sse_frame(frame)
                return
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
            if product_mode:
                reimbursement._record_answers(run, request.answers)
                async for frame in _stream_host_reimbursement(
                    reimbursement,
                    run,
                    stage="answers",
                    answers=request.answers,
                    client=require_host(),
                    tool_catalog=host_tool_catalog(),
                ):
                    yield sse_frame(frame)
                return
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
        # The external submit/readback remains a deterministic business effect,
        # but product mode also records an explicit linked Host continuation so
        # the approval turn has canonical Host evidence and an assistant tail.
        run = reimbursement.get_run_by_approval_id(approval_id)
        if run is None:
            raise HTTPException(status_code=404, detail="approval request not found")
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if request.approved_by != anna_user_id:
            raise HTTPException(status_code=403, detail="approved_by must match current user")

        async def event_stream():
            if product_mode:
                try:
                    updated = await asyncio.to_thread(
                        reimbursement.approve_submit,
                        approval_id=approval_id,
                        approved_by=request.approved_by,
                    )
                    if updated.write_action is None:
                        yield sse_frame({"type": "done", "run": updated})
                        return
                    async for frame in _stream_host_reimbursement(
                        reimbursement,
                        updated,
                        stage="approval",
                        continuation_facts={
                            "approval_id": approval_id,
                            "approved_by": request.approved_by,
                            "write_action": updated.write_action.model_dump(mode="json"),
                        },
                        tool_catalog=host_tool_catalog(),
                        client=require_host(),
                    ):
                        yield sse_frame(frame)
                except (HarnessHostError, ValueError) as exc:
                    yield sse_frame({"type": "error", "message": str(exc)})
                return
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


def _task_for_reimbursement_run(
    run,
    *,
    stage: str,
    answers: dict[str, Any] | None = None,
    host_run_id: str | None = None,
    linked_run_id: str | None = None,
    continuation_facts: dict[str, Any] | None = None,
    tool_catalog: list[dict[str, Any]] | None = None,
) -> ProductTask:
    if stage != "create":
        linked_run_id = linked_run_id or run.id
        host_run_id = host_run_id or _linked_host_run_id(run, stage, answers)
    context: dict[str, Any] = {
        "source": "cowork.reimbursement",
        "stage": stage,
        "draft": run.draft.model_dump(mode="json"),
        "missing_fields": list(run.missing_fields),
    }
    if answers is not None:
        context["answers"] = answers
    if continuation_facts is not None:
        context["continuation_facts"] = continuation_facts
    if tool_catalog is not None:
        context["tool_catalog"] = tool_catalog
    if linked_run_id is not None:
        context["linked_run_id"] = linked_run_id
        context["continuation_kind"] = stage
        context["original_business_state"] = {
            "run_id": run.id,
            "status": run.status,
            "draft": run.draft.model_dump(mode="json"),
            "missing_fields": list(run.missing_fields),
            "approval": (
                run.approval.model_dump(mode="json")
                if run.approval is not None
                else None
            ),
            "write_action": (
                run.write_action.model_dump(mode="json")
                if run.write_action is not None
                else None
            ),
        }
    run_id = host_run_id or run.id
    return ProductTask(
        run_id=run_id,
        workspace_id=run.workspace_id,
        actor_user_id=run.actor_user_id,
        surface="reimbursement",
        prompt=run.input_text if stage == "create" else "根据补充信息继续处理报销",
        conversation_id=f"reimbursement:{run.id}",
        context=context,
        permission_mode="ask",
        source_event_id=f"reimbursement:{run.id}:{stage}",
    )


def _linked_host_run_id(
    run,
    stage: str,
    facts: dict[str, Any] | None = None,
) -> str:
    # Include the business snapshot in the identity so a repeated answer after
    # a connector mutation cannot collide with the prior Host task.
    fingerprint = {
        "stage": stage,
        "facts": facts or {},
        "status": run.status,
        "draft": run.draft.model_dump(mode="json"),
        "missing_fields": list(run.missing_fields),
        "approval_id": run.approval.id if run.approval is not None else None,
        "write_action_id": run.write_action.id if run.write_action is not None else None,
    }
    digest = hashlib.sha256(
        json.dumps(fingerprint, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]
    return f"{run.id}:{stage}:{digest}"


async def _stream_host_reimbursement(
    reimbursement: ReimbursementOrchestrator,
    run,
    *,
    stage: str,
    client: HarnessHostClient,
    answers: dict[str, Any] | None = None,
    continuation_facts: dict[str, Any] | None = None,
    tool_catalog: list[dict[str, Any]] | None = None,
):
    try:
        linked_run_id = run.id if stage != "create" else None
        host_run_id = (
            run.id
            if linked_run_id is None
            else _linked_host_run_id(
                run,
                stage,
                {"answers": answers, "facts": continuation_facts},
            )
        )
        submitted = await asyncio.to_thread(
            client.submit,
            _task_for_reimbursement_run(
                run,
                stage=stage,
                answers=answers,
                host_run_id=host_run_id,
                linked_run_id=linked_run_id,
                continuation_facts=continuation_facts,
                tool_catalog=tool_catalog,
            ),
        )
        for event in run.audit_events:
            yield {"type": "event", "event": event}
        after_seq = -1
        while True:
            events = await asyncio.to_thread(client.events, submitted.run_id, after_seq=after_seq)
            for event in events:
                after_seq = max(after_seq, _event_seq(event))
                yield _host_event_frame(event)
            current = await asyncio.to_thread(client.get, submitted.run_id)
            if current.terminal:
                updated = reimbursement.apply_host_result(
                    run, result_payload(current), host_status=current.status
                )
                yield {"type": "done", "run": updated}
                return
            await asyncio.sleep(0.05)
    except HarnessHostError as exc:
        failed = reimbursement._save_and_return(
            reimbursement._fail_run(
                run,
                exc.code or "harness_request_failed",
                "Harness Host reimbursement task failed",
            )
        )
        yield {"type": "done", "run": failed}


def _host_event_frame(event: dict) -> dict:
    event_type = event.get("type")
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    if event_type in {"run.text.delta", "assistant.text.delta", "text_delta"}:
        text = payload.get("text") or event.get("text")
        if isinstance(text, str):
            return {"type": "text_delta", "text": text}
    if event_type in {"run.tool.started", "tool_start"}:
        name = payload.get("tool") or payload.get("name") or event.get("name")
        if isinstance(name, str):
            return {"type": "tool_start", "name": name}
    if event_type in {"run.tool.completed", "tool_done"}:
        name = payload.get("tool") or payload.get("name") or event.get("name")
        if isinstance(name, str):
            return {"type": "tool_done", "name": name}
    return {"type": "event", "event": event}


def _event_seq(event: dict) -> int:
    return event.get("seq") if isinstance(event.get("seq"), int) else -1
