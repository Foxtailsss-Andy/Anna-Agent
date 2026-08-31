from __future__ import annotations

import asyncio

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse

from services.business.harness_client import HarnessHostClient, HarnessHostError, HarnessRun, ProductTask, result_payload
from services.hiker.app.orchestrator import HikerOrchestrator

from ..schemas import CreateHikerAssistantRunRequest, CreateHikerDashboardRunRequest
from ..security import _assert_identity
from ._sse import SSE_HEADERS, sse_frame


def build_router(
    hiker: HikerOrchestrator,
    *,
    harness_client: HarnessHostClient | None = None,
    product_mode: bool = False,
) -> APIRouter:
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
            if product_mode:
                try:
                    hiker._record_assistant_created(run, request.question)
                    host = harness_client
                    if host is None:
                        raise HarnessHostError("Harness Host is not configured", code="harness_not_configured")
                    task = ProductTask(
                        run_id=run.id,
                        workspace_id=run.workspace_id,
                        actor_user_id=run.actor_user_id,
                        surface="hiker",
                        prompt=request.question,
                        conversation_id=f"hiker:{run.id}",
                        context={
                            "source": "cowork.hiker.assistant",
                            "tool_catalog": hiker.tool_registry.model_visible_tools(),
                            "remote_actor": "server_configured",
                        },
                        permission_mode="ask",
                    )
                    submitted = await asyncio.to_thread(host.submit, task)
                    after_seq = -1
                    while True:
                        events = await asyncio.to_thread(host.events, submitted.run_id, after_seq=after_seq)
                        for event in events:
                            after_seq = max(after_seq, _event_seq(event))
                            yield sse_frame(_host_event_frame(event))
                        current = await asyncio.to_thread(host.get, submitted.run_id)
                        if current.terminal:
                            _apply_host_run(hiker, run, current)
                            yield sse_frame({"type": "done", "run": run.model_dump(mode="json")})
                            return
                        await asyncio.sleep(0.05)
                except HarnessHostError as exc:
                    hiker._fail_assistant_run(
                        run,
                        exc.code or "harness_request_failed",
                        "Harness Host Hiker task failed",
                    )
                    yield sse_frame({"type": "done", "run": run.model_dump(mode="json")})
                return
            async for frame in hiker.stream_assistant_advance(run, request.question):
                yield sse_frame(frame)

        return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)

    return router


def _apply_host_run(hiker: HikerOrchestrator, run, host_run: HarnessRun) -> None:
    result = result_payload(host_run)
    tools = result.get("tools_used")
    if isinstance(tools, list):
        run.tools_used = [str(tool) for tool in tools if isinstance(tool, str)]
    if host_run.status in {"completed", "succeeded"}:
        answer = result.get("answer")
        if answer is None:
            answer = result.get("assistant_message")
        run.answer = answer if isinstance(answer, str) else None
        run.agent_message = run.answer
        run.status = "ready"
        hiker.audit.append(
            run.audit_events,
            "hiker.assistant.answered",
            run.id,
            {"tools_used": run.tools_used, "source": "harness"},
        )
        return
    hiker._fail_assistant_run(
        run,
        _host_error_code(host_run) or "harness_task_failed",
        _host_error_message(host_run) or "Harness Host Hiker task failed",
    )


def _host_error_code(run: HarnessRun) -> str | None:
    result = run.result or {}
    for key in ("error_code", "code", "error"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _host_error_message(run: HarnessRun) -> str | None:
    result = run.result or {}
    for key in ("error_message", "message", "error"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


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
