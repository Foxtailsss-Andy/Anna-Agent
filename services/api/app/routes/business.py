from __future__ import annotations

import secrets
import json
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from services.chat.app.orchestrator import ChatOrchestrator, ChatRunNotFoundError
from services.crew.app.service import CrewService
from services.hiker.app.orchestrator import HikerOrchestrator
from services.identity.app.service import IdentityService
from services.memory.app.store import BusinessMemoryStore
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.reimbursement.app.capability import ReimbursementCapabilityHandler
from services.runtime.app.engine.capability import CapabilityError, CapabilitySuspend
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.skill_loader import SkillLoaderError


class HikerToolCallRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    run_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class CrewToolCallRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    run_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ReimbursementToolCallRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    run_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ChatToolCallRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    run_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


def build_router(
    *,
    hiker: HikerOrchestrator,
    crew: CrewService,
    chat: ChatOrchestrator | None = None,
    identity: IdentityService,
    memory: BusinessMemoryStore,
    reimbursement: ReimbursementOrchestrator | None = None,
    service_token: str | None,
) -> APIRouter:
    """Internal business adapters used by the Node Harness Host.

    These routes are deliberately separate from the public product routes. A
    browser request cannot substitute the Host token, and every request still
    carries the product scope that is checked against the persisted business
    object before a connector/store operation is performed.
    """

    router = APIRouter()

    def require_token(token: str | None) -> None:
        if not service_token or token is None or not secrets.compare_digest(token, service_token):
            raise HTTPException(status_code=401, detail="internal service authentication required")

    def require_scope(workspace_id: str, actor_user_id: str, run_id: str) -> None:
        if not workspace_id.strip() or not actor_user_id.strip() or not run_id.strip():
            raise HTTPException(status_code=400, detail="business scope is required")

    @router.get("/_business/status")
    def status(x_anna_service_token: str | None = Header(default=None)) -> dict[str, Any]:
        require_token(x_anna_service_token)
        hiker_status = hiker.adapter.status()
        return {
            "mode": "harness-backed-business",
            "agent_execution": "host",
            "model_credentials": "absent",
            "hiker": hiker_status,
        }

    @router.get("/_business/hiker/tools")
    def hiker_tools(x_anna_service_token: str | None = Header(default=None)) -> dict[str, Any]:
        require_token(x_anna_service_token)
        status_payload = hiker.adapter.status()
        tools = hiker.tool_registry.model_visible_tools(skill=None, discovered_tools=[])
        # Current Hiker upstream advertises read tools only. Do not infer write
        # support from a remote description; the Host must see this explicit
        # blocked state until the connector publishes an approved capability.
        return {
            "connector": status_payload,
            "tools": [
                {**tool, "effect": "read", "admitted": True}
                for tool in tools
            ],
            "write_capability": {
                "status": "blocked",
                "reason": "upstream_write_capability_not_advertised",
            },
        }

    @router.get("/_business/chat/tools")
    def chat_tools(x_anna_service_token: str | None = Header(default=None)) -> dict[str, Any]:
        require_token(x_anna_service_token)
        if chat is None:
            raise HTTPException(status_code=503, detail="chat adapter is unavailable")
        tools = chat.tool_registry.model_visible_tools(skill=None, discovered_tools=[])
        return {
            "tools": [
                {**tool, "effect": "contained_write", "admitted": True}
                for tool in tools
                if tool.get("name") in {"chat.emit_page", "chat.emit_document"}
            ],
            "native_tools": [{"name": "todo", "effect": "session_state", "admitted": True}],
        }

    @router.post("/_business/chat/tools/call")
    def call_chat_tool(
        request: ChatToolCallRequest,
        x_anna_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        require_token(x_anna_service_token)
        require_scope(request.workspace_id, request.actor_user_id, request.run_id)
        if chat is None:
            raise HTTPException(status_code=503, detail="chat adapter is unavailable")
        canonical_name = request.name.replace("__", ".")
        if canonical_name not in {"chat.emit_page", "chat.emit_document", "workdir.read_file"}:
            raise HTTPException(status_code=403, detail="chat tool is not admitted")
        try:
            run = chat.get_run(request.run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        if run.workspace_id != request.workspace_id or run.actor_user_id != request.actor_user_id:
            raise HTTPException(status_code=403, detail="chat scope is not authorized")
        try:
            handler = chat.build_host_capability(run)
            observation = handler.dispatch_tool(
                ModelToolCall(
                    id=f"host-{request.run_id}-{canonical_name}",
                    name=canonical_name,
                    arguments=dict(request.arguments),
                )
            )
            payload = json.loads(observation["content"])
        except CapabilityError as exc:
            chat._persist_run(run)
            raise HTTPException(status_code=422, detail={"code": exc.error_code}) from exc
        except (TypeError, ValueError, KeyError) as exc:
            chat._persist_run(run)
            raise HTTPException(status_code=502, detail="chat tool result invalid") from exc
        chat._persist_run(run)
        if canonical_name in {"chat.emit_page", "chat.emit_document"} and run.artifacts:
            artifact = run.artifacts[-1]
            payload = {**payload, "artifact": artifact}
        return {
            "name": canonical_name,
            "effect": "artifact" if canonical_name.startswith("chat.emit_") else "read",
            "result": payload,
            "audit_events": [event.model_dump(mode="json") for event in run.audit_events],
        }

    @router.post("/_business/hiker/tools/call")
    def call_hiker_tool(
        request: HikerToolCallRequest,
        x_anna_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        require_token(x_anna_service_token)
        require_scope(request.workspace_id, request.actor_user_id, request.run_id)
        try:
            hiker.tool_registry.assert_allowed(request.name)
            hiker.tool_registry.validate_arguments(request.name, request.arguments)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="hiker tool is not admitted") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        # The remote Hiker actor is selected from protected server settings. The
        # request's actor_user_id is Anna-side ownership/audit only and cannot
        # override the upstream actor field.
        arguments = {
            **request.arguments,
            **hiker._base_args(request.run_id, request.actor_user_id),
        }
        audit_events: list[Any] = []
        try:
            payload = hiker.mcp_dispatcher.call_tool_audited(
                audit_events,
                request.run_id,
                request.name,
                request.arguments,
                arguments,
            )
        except Exception as exc:  # connector-specific errors remain truthful
            error_code = getattr(exc, "error_code", None) or "hiker_tool_failed"
            raise HTTPException(status_code=502, detail={"code": error_code}) from exc
        return {
            "name": request.name,
            "effect": "read",
            "result": payload,
            "audit_events": [
                event.model_dump(mode="json") if hasattr(event, "model_dump") else event
                for event in audit_events
            ],
        }

    @router.get("/_business/crew/context")
    def crew_context(
        workspace_id: str = Query(...),
        actor_user_id: str = Query(...),
        run_id: str = Query(...),
        project_id: str = Query(...),
        channel_id: str | None = Query(default=None),
        x_anna_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        require_token(x_anna_service_token)
        require_scope(workspace_id, actor_user_id, run_id)
        project = crew.get_project(project_id)
        if project is None or project.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="project not found")
        if channel_id not in (None, "", f"crew_channel:{project_id}"):
            raise HTTPException(status_code=404, detail="channel not found")
        # Project memory is explicitly scoped; workspace memory is not silently
        # broadcast into a Crew channel.
        memory_items = memory.list_items(
            workspace_id,
            scope="project",
            project_id=project_id,
            limit=100,
        )
        messages = crew.list_channel(project_id)
        return {
            "workspace_id": workspace_id,
            "project_id": project_id,
            "channel_id": f"crew_channel:{project_id}",
            "run_id": run_id,
            "project": project.model_dump(mode="json"),
            "channel_messages": [message.model_dump(mode="json") for message in messages],
            "project_memory": [item.model_dump(mode="json") for item in reversed(memory_items)],
        }

    @router.post("/_business/crew/tools/call")
    def call_crew_tool(
        request: CrewToolCallRequest,
        x_anna_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        """Return structured Crew proposals to the Host without mutating facts.

        ``emit_project_plan``, ``emit_assignments`` and ``emit_task_drafts`` are
        model output tools. The existing Python Crew services validate and
        persist their proposals only after the caller's normal confirm/lifecycle
        operation; this adapter therefore returns the typed arguments as an
        observation and never creates a project/task itself.
        """
        require_token(x_anna_service_token)
        require_scope(request.workspace_id, request.actor_user_id, request.run_id)
        allowed = {
            "crew.emit_project_plan",
            "crew.emit_assignments",
            "crew.emit_task_drafts",
        }
        if request.name not in allowed:
            raise HTTPException(status_code=403, detail="crew tool is not admitted")
        return {
            "name": request.name,
            "effect": "proposal",
            "result": {
                "status": "succeeded",
                "output": request.arguments,
            },
        }

    @router.post("/_business/reimbursement/tools/call")
    def call_reimbursement_tool(
        request: ReimbursementToolCallRequest,
        x_anna_service_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        """Dispatch one admitted Host reimbursement tool through domain rules."""
        require_token(x_anna_service_token)
        require_scope(request.workspace_id, request.actor_user_id, request.run_id)
        if reimbursement is None:
            raise HTTPException(status_code=503, detail="reimbursement adapter is unavailable")
        local_run_id = request.run_id.split(":", 1)[0]
        run = reimbursement.get_run(request.run_id) or reimbursement.get_run(local_run_id)
        if run is None or run.workspace_id != request.workspace_id or run.actor_user_id != request.actor_user_id:
            raise HTTPException(status_code=404, detail="reimbursement run not found")
        allowed = {
            "reimbursement.get_capabilities",
            "reimbursement.get_policy",
            "reimbursement.validate_draft",
            "reimbursement.create_draft",
            "reimbursement.submit_intent",
            "reimbursement.get_status",
            "reimbursement.list_approvals",
            "reimbursement.get_approval",
            "reimbursement.approve_intent",
            "reimbursement.reject_intent",
        }
        if request.name not in allowed:
            raise HTTPException(status_code=403, detail="reimbursement tool is not admitted")
        try:
            skill = reimbursement.skill_loader.load(reimbursement.settings.reimbursement_skill_id)
        except SkillLoaderError as exc:
            raise HTTPException(status_code=503, detail="reimbursement skill unavailable") from exc
        handler = ReimbursementCapabilityHandler(
            orchestrator=reimbursement,
            boss_directive=reimbursement.settings.agent_directive("reimbursement"),
            skill=skill,
            mcp_status=None,
            run=run,
        )
        tool_call = ModelToolCall(
            id=f"host-{request.run_id}-{request.name}",
            name=request.name,
            arguments=dict(request.arguments),
        )
        try:
            observation = handler.dispatch_tool(tool_call)
            payload = json.loads(observation["content"])
        except CapabilitySuspend as exc:
            payload = {
                "status": "suspended",
                "reason": exc.reason,
                "detail": exc.detail or {},
                "business_status": run.status,
                "approval": (
                    run.approval.model_dump(mode="json")
                    if run.approval is not None
                    else None
                ),
                "missing_fields": list(run.missing_fields),
            }
        except CapabilityError as exc:
            reimbursement._save_and_return(run)
            raise HTTPException(status_code=422, detail={"code": exc.error_code}) from exc
        except (TypeError, ValueError) as exc:
            reimbursement._save_and_return(run)
            raise HTTPException(status_code=502, detail="reimbursement tool result invalid") from exc
        reimbursement._save_and_return(run)
        return {
            "name": request.name,
            "effect": "business",
            "result": payload,
        }

    return router
