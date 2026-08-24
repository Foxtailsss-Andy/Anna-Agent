from __future__ import annotations

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse

from services.hiker.app.orchestrator import HikerOrchestrator

from ..schemas import CreateHikerAssistantRunRequest, CreateHikerDashboardRunRequest
from ..security import _assert_identity
from ._sse import SSE_HEADERS, sse_frame


def build_router(hiker: HikerOrchestrator) -> APIRouter:
    router = APIRouter()

    @router.post("/api/cowork/hiker/dashboard/runs")
    def create_hiker_dashboard_run(
        request: CreateHikerDashboardRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(request.workspace_id, request.actor_user_id, anna_workspace_id, anna_user_id)
        run = hiker.start_dashboard_run(workspace_id=request.workspace_id, actor_user_id=request.actor_user_id)
        return run.model_dump(mode="json")

    @router.post("/api/cowork/hiker/assistant/runs/stream")
    async def stream_hiker_assistant_run(
        request: CreateHikerAssistantRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        # Streams the hiker-assistant ReAct loop live off the platform engine
        # (Hiker MCP is read-only): audit-event frames plus real token
        # streaming (text_delta) and tool_start/tool_done, terminated by a
        # done frame carrying the final run.
        _assert_identity(request.workspace_id, request.actor_user_id, anna_workspace_id, anna_user_id)
        run = hiker.begin_assistant_run(
            workspace_id=request.workspace_id,
            actor_user_id=request.actor_user_id,
            question=request.question,
        )

        async def event_stream():
            async for frame in hiker.stream_assistant_advance(run, request.question):
                yield sse_frame(frame)

        return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)

    return router
