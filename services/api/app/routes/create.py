from __future__ import annotations

import json

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

from services.create.app.orchestrator import CreateOrchestrator, CreateRunNotFoundError

from ..schemas import (
    CreateDraftRequest,
    CreateSkillDraftRequest,
    SaveCreateSkillDraftRequest,
)
from ..security import _assert_identity


def build_router(create: CreateOrchestrator) -> APIRouter:
    router = APIRouter()

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
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

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
