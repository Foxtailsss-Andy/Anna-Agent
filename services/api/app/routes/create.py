from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

from services.create.app.orchestrator import CreateOrchestrator, CreateRunNotFoundError
from services.business.harness_client import HarnessHostClient, HarnessHostError, HarnessRun, ProductTask, result_payload

from ..schemas import (
    CreateDraftRequest,
    CreateSkillDraftRequest,
    SaveCreateSkillDraftRequest,
)
from ..security import _assert_identity


def build_router(
    create: CreateOrchestrator,
    *,
    harness_client: HarnessHostClient | None = None,
    product_mode: bool = False,
) -> APIRouter:
    router = APIRouter()

    def require_host() -> HarnessHostClient:
        if not product_mode or harness_client is None:
            raise HTTPException(status_code=503, detail="Harness Host is not configured")
        return harness_client

    @router.post("/api/create/skills")
    def create_skill_draft(
        request: CreateSkillDraftRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        if product_mode:
            run, failed = create.begin_draft(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                prompt=request.prompt,
                kind="skill",
            )
            if failed is not None:
                return failed.model_dump(mode="json")
            try:
                host_run = require_host().submit_and_wait(_task_for_create_run(run))
            except HarnessHostError as exc:
                return create._fail_run(run, exc.code or "harness_request_failed", "Harness Host Create task failed").model_dump(mode="json")
            run = create.apply_host_result(run, result_payload(host_run), host_status=host_run.status)
        else:
            run = create.create_skill_draft(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                prompt=request.prompt,
            )
        return run.model_dump(mode="json")

    @router.post("/api/create/drafts")
    def create_draft(
        request: CreateDraftRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        if product_mode:
            run, failed = create.begin_draft(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                prompt=request.prompt,
                kind=request.kind,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                permission_mode=request.permission_mode,
            )
            if failed is not None:
                return failed.model_dump(mode="json")
            try:
                host_run = require_host().submit_and_wait(_task_for_create_run(run))
            except HarnessHostError as exc:
                return create._fail_run(run, exc.code or "harness_request_failed", "Harness Host Create task failed").model_dump(mode="json")
            run = create.apply_host_result(run, result_payload(host_run), host_status=host_run.status)
        else:
            run = create.create_draft(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                prompt=request.prompt,
                kind=request.kind,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                permission_mode=request.permission_mode,
            )
        return run.model_dump(mode="json")

    @router.post("/api/create/runs/stream")
    async def stream_create_run(
        request: CreateDraftRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        """B1 — Create 流式管线(chat 同形帧词表:step/event/done/error)。"""
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )

        async def event_stream():
            if product_mode:
                run, failed = create.begin_draft(
                    workspace_id=request.workspace_id,
                    actor_user_id=request.actor_user_id,
                    prompt=request.prompt,
                    kind=request.kind,
                    agent_id=request.agent_id,
                    workdir_id=request.workdir_id,
                    permission_mode=request.permission_mode,
                )
                for audit in run.audit_events:
                    yield _json_sse({"type": "event", "event": audit.model_dump(mode="json")})
                if failed is not None:
                    yield _json_sse({"type": "error", "run": failed.model_dump(mode="json")})
                    return
                try:
                    host = require_host()
                    submitted = await asyncio.to_thread(host.submit, _task_for_create_run(run))
                    after_seq = -1
                    while True:
                        events = await asyncio.to_thread(host.events, submitted.run_id, after_seq=after_seq)
                        for event in events:
                            after_seq = max(after_seq, _event_seq(event))
                            yield _json_sse(_host_event_frame(event))
                        current = await asyncio.to_thread(host.get, submitted.run_id)
                        if current.terminal:
                            run = create.apply_host_result(run, result_payload(current), host_status=current.status)
                            yield _json_sse({"type": "done" if run.status == "ready_for_review" else "error", "run": run.model_dump(mode="json")})
                            return
                        await asyncio.sleep(0.05)
                except HarnessHostError as exc:
                    failed_run = create._fail_run(run, exc.code or "harness_request_failed", "Harness Host Create task failed")
                    yield _json_sse({"type": "error", "run": failed_run.model_dump(mode="json")})
                return
            async for event in create.stream_draft(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                prompt=request.prompt,
                kind=request.kind,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                permission_mode=request.permission_mode,
            ):
                payload = dict(event)
                run = payload.get("run")
                if run is not None and hasattr(run, "model_dump"):
                    payload["run"] = run.model_dump(mode="json")
                inner = payload.get("event")
                if inner is not None and hasattr(inner, "model_dump"):
                    payload["event"] = inner.model_dump(mode="json")
                yield _json_sse(payload)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.get("/api/create/drafts")
    def list_create_drafts(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> list[dict]:
        runs = create.list_runs(anna_workspace_id, anna_user_id)
        return [run.model_dump(mode="json") for run in runs]

    @router.post("/api/create/drafts/{run_id}/activate")
    def activate_create_draft(
        run_id: str,
        request: SaveCreateSkillDraftRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        if request.confirmed_by != anna_user_id:
            raise HTTPException(
                status_code=403,
                detail="confirmed_by must match X-Anna-User-ID",
            )
        try:
            run = create.get_run(run_id)
        except CreateRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="create run not found") from exc
        _assert_identity(
            run.workspace_id,
            run.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        run = create.activate_artifact(run_id, confirmed_by=request.confirmed_by)
        return run.model_dump(mode="json")

    @router.post("/api/create/skills/{run_id}/save")
    def save_create_skill_draft(
        run_id: str,
        request: SaveCreateSkillDraftRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        if request.confirmed_by != anna_user_id:
            raise HTTPException(
                status_code=403,
                detail="confirmed_by must match X-Anna-User-ID",
            )
        try:
            run = create.get_run(run_id)
        except CreateRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="create run not found") from exc
        _assert_identity(
            run.workspace_id,
            run.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        run = create.save_skill(run_id, confirmed_by=request.confirmed_by)
        return run.model_dump(mode="json")

    return router


def _task_for_create_run(run) -> ProductTask:
    return ProductTask(
        run_id=run.id,
        workspace_id=run.workspace_id,
        actor_user_id=run.actor_user_id,
        surface="create",
        prompt=run.prompt,
        conversation_id=f"create:{run.id}",
        context={
            "kind": run.kind,
            "agent_id": run.agent_id,
            "workdir_id": run.workdir_id,
            "permission_mode": run.permission_mode,
            "source": "home.create",
        },
        permission_mode="ask",
    )


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


def _json_sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
