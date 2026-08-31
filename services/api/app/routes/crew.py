from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from services.crew.app import approvals_projection, inbox as inbox_agg
from services.crew.app.actors import SYSTEM_ACTOR_IDS
from services.crew.app.agent_worker import HarnessWorkerExecutor
from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.decomposition import CrewDecompositionService
from services.crew.app.lifecycle import CrewLifecycleError
from services.crew.app.matching import CrewMatchingService, deterministic_proposals
from services.crew.app.schemas import TaskDraft
from services.crew.app.service import CrewPermissionError, CrewService
from services.crew.app.showcase import SHOWCASE_SCENARIO_ID
from services.crew.app.sop_templates import list_templates
from services.identity.app.schemas import SessionIdentity
from services.identity.app.service import IdentityService
from services.memory.app.schemas import BusinessMemoryItem
from services.memory.app.store import BusinessMemoryStore
from services.runtime.app.execution import (
    ActiveExecutionConflictError,
    AgentExecutionKernel,
    ExecutionNotFoundError,
    SignalExecution,
    StartExecution,
    TerminalStateError,
)
from services.runtime.app.execution.runtime import AgentExecutionRuntime
from services.runtime.app.execution.store import SQLiteExecutionStore
from services.runtime.app.config import RuntimeSettings
from services.business.harness_client import HarnessHostClient, HarnessHostError, ProductTask

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# C2 友好守卫:human-readable Chinese status labels for the 409 detail sentence
# (the machine-readable ``task_status`` field carries the raw status; the FE's
# friendlyError.ts maps the ``code`` for the final copy — this is the fallback).
_TASK_STATUS_ZH = {
    "todo": "待办", "assigned": "待开始", "running": "执行中",
    "submitted": "待审", "in_review": "评审中", "rework": "返工中",
    "done": "已完成", "blocked": "受阻",
}


def _status_zh(status: str) -> str:
    return _TASK_STATUS_ZH.get(status, status)


# 接管/改派 友好守卫:the context clause for a「任务已在进行,不能直接改派」409.
# Keyed on the raw status past ``assigned`` (未开工才可被接管);falls back to the
# short ``_status_zh`` label for any status outside this set.
_ASSIGN_CONFLICT_ZH = {
    "running": "已在执行中",
    "submitted": "已交付待审",
    "in_review": "已交付待审",
    "rework": "返工处理中",
    "done": "已完成",
}


def _assign_conflict_zh(status: str) -> str:
    return _ASSIGN_CONFLICT_ZH.get(status, _status_zh(status))


def _events_to_frames(events) -> list[dict]:
    frames: list[dict] = []
    for event in events:
        payload = event.payload
        frame: dict | None = None
        if event.type == "execution.started":
            frame = {
                "type": "event",
                "event": {
                    "type": "crew.run.created",
                    "run_ref": event.execution_id,
                    "task_id": _task_id_from_payload(payload),
                },
            }
        elif event.type == "execution.claimed":
            frame = {
                "type": "event",
                "event": {
                    "type": "crew.run.claimed",
                    "run_ref": event.execution_id,
                    "attempt": payload.get("attempt"),
                },
            }
        elif event.type == "execution.requeued":
            frame = {
                "type": "event",
                "event": {
                    "type": "run.queued",
                    "run_ref": event.execution_id,
                    "reason": payload.get("reason"),
                },
            }
        elif event.type == "execution.retry_scheduled":
            frame = {
                "type": "event",
                "event": {
                    "type": "run.queued",
                    "run_ref": event.execution_id,
                    "reason": "retry_scheduled",
                    "retry_reason": payload.get("reason"),
                    "attempt": payload.get("attempt"),
                    "max_attempts": payload.get("max_attempts"),
                    "not_before": payload.get("not_before"),
                },
            }
        elif event.type == "execution.result_deferred":
            frame = {
                "type": "event",
                "event": {
                    "type": "run.queued",
                    "run_ref": event.execution_id,
                    "reason": payload.get("reason"),
                    "deferred_status": payload.get("deferred_status"),
                },
            }
        elif event.type == "execution.frame":
            embedded = payload.get("frame")
            frame = dict(embedded) if isinstance(embedded, dict) else dict(payload)
        elif event.type in {"crew.task.artifact_produced", "artifact_produced"}:
            frame = {
                "type": "done",
                "run": {
                    "run_ref": event.execution_id,
                    "status": "done",
                    "task_id": _task_id_from_payload(payload),
                    "memory_hits": payload.get("memory_hits", []),
                },
            }
        elif event.type == "crew.task.agent_blocked":
            frame = {
                "type": "error",
                "run": {
                    "run_ref": event.execution_id,
                    "status": "blocked",
                    "task_id": _task_id_from_payload(payload),
                    "error": payload.get("reason") or payload.get("message"),
                    "memory_hits": payload.get("memory_hits", []),
                },
            }
        elif event.type == "execution.failed":
            frame = {
                "type": "error",
                "run": {
                    "run_ref": event.execution_id,
                    "status": "failed",
                    "error": payload.get("message") or payload.get("error_code"),
                },
            }
        elif event.type == "execution.dead_lettered":
            frame = {
                "type": "error",
                "run": {
                    "run_ref": event.execution_id,
                    "status": "dead_lettered",
                    "error": payload.get("message") or payload.get("error_code"),
                    "reason": payload.get("reason"),
                    "attempt": payload.get("attempt"),
                    "max_attempts": payload.get("max_attempts"),
                },
            }
        elif event.type == "execution.recovery_blocked":
            frame = {
                "type": "error",
                "run": {
                    "run_ref": event.execution_id,
                    "status": "recovery_blocked",
                    "error": payload.get("reason") or "manual recovery required",
                    "manual_recovery_required": payload.get("manual_recovery_required"),
                },
            }
        elif event.type == "execution.cancelled":
            frame = {
                "type": "error",
                "run": {
                    "run_ref": event.execution_id,
                    "status": "cancelled",
                    "error": payload.get("reason") or "cancelled",
                },
            }
        if frame is None:
            continue
        frame.setdefault("seq", event.seq)
        frames.append(frame)
    return frames


def _task_id_from_payload(payload: dict) -> str | None:
    value = payload.get("task_id") or payload.get("crew_task_id")
    return value if isinstance(value, str) else None


def _is_awaiting_crew_worker_answer(snapshot) -> bool:
    checkpoint = snapshot.checkpoint if snapshot is not None else None
    return (
        snapshot is not None
        and snapshot.status == "awaiting_signal"
        and isinstance(checkpoint, dict)
        and checkpoint.get("kind") == "crew.worker.awaiting_input.v1"
    )


class CreateProjectRequest(BaseModel):
    goal_text: str
    sop_template_id: str


class AssignRequest(BaseModel):
    member_id: str


class SubmitRequest(BaseModel):
    artifact: str


class ReviewRequest(BaseModel):
    approved: bool
    comment: str | None = None


class SayRequest(BaseModel):
    body: str
    mentions: list[str] = []


class ChannelCommandRequest(BaseModel):
    """POST .../channel/command body: draft tasks from a channel message."""
    text: str
    # The say row that triggered「+任务」, if invoked on an existing message.
    source_message_id: str | None = None


class ChannelCommandConfirmRequest(BaseModel):
    """POST .../channel/command/confirm body: push a subset of a command's drafts.

    ``draft_indexes`` selects into the command row's drafted list (server-side
    source of truth — the client cannot fabricate arbitrary tasks); omit to
    confirm all drafts."""
    message_id: str
    draft_indexes: list[int] | None = None


class ConsensusUpsertRequest(BaseModel):
    """PUT .../memory body: create (no id) or edit (id) one 共识 entry."""
    id: str | None = None
    kind: Literal["约束", "口径", "决策"]
    text: str


class ShowcaseEnsureRequest(BaseModel):
    scenario_id: str = SHOWCASE_SCENARIO_ID
    locale: str = "zh-CN"


# The stored title is a listing convenience derived from the text (the entry's
# full text lives in ``content``); kept short so the admin memory view stays
# scannable.
_CONSENSUS_TITLE_CHARS = 40


def _consensus_entry(item: BusinessMemoryItem) -> dict:
    """API shape of one 共识 entry. ``kind`` IS the item's ``memory_type``
    (约束/口径/决策 stored verbatim); ``text`` is its ``content``."""
    return {
        "id": item.id,
        "kind": item.memory_type,
        "text": item.content,
        "scope": item.scope,
        "project_id": item.project_id,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def build_router(
    crew: CrewService,
    identity: IdentityService,
    decomposition: CrewDecompositionService | None = None,
    matching: CrewMatchingService | None = None,
    execution_kernel: AgentExecutionKernel | None = None,
    execution_store: SQLiteExecutionStore | None = None,
    execution_runtime: AgentExecutionRuntime | None = None,
    settings: RuntimeSettings | None = None,
    memory_store: BusinessMemoryStore | None = None,
    reimbursement: object | None = None,
    command_drafting: CommandDraftingService | None = None,
    local_session: Callable[[], SessionIdentity] | None = None,
    auto_pilot: bool = False,
    max_queue_depth: int = 500,
    harness_client: HarnessHostClient | None = None,
    product_mode: bool = False,
) -> APIRouter:
    router = APIRouter()
    if execution_kernel is None and execution_store is not None:
        execution_kernel = AgentExecutionKernel(execution_store, max_queue_depth=max_queue_depth)
    # B3: wire the「+任务」drafting collaborator onto the service (model draft +
    # deterministic fallback), unless one was injected already.
    if getattr(crew, "_drafter", None) is None:
        crew._drafter = command_drafting or CommandDraftingService(settings=settings)
    # Wire accepted mention ids: identity members plus system actors such as
    # ``anna``. System actors are not accounts; CrewService keeps them out of
    # notifications and assignee validation.
    if getattr(crew, "_roster", None) is None:
        crew._roster = lambda ws: {m.id for m in identity.list_members(ws)} | set(SYSTEM_ACTOR_IDS)
    if getattr(crew, "_member_kind", None) is None:
        def _member_kind(member_id: str) -> str | None:
            account = identity.store.get_account(member_id)
            return account.kind if account else None
        crew._member_kind = _member_kind

    host_workers = ThreadPoolExecutor(max_workers=4, thread_name_prefix="anna-host-worker") if product_mode and harness_client else None
    host_runs: dict[tuple[str, str], str] = {}

    def _host_worker_task(
        project_id: str,
        task_id: str,
        actor_user_id: str,
        source_message_id: str | None = None,
        source_instruction: str | None = None,
        *,
        run_ref: str,
    ) -> ProductTask:
        project = crew.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        task = next((item for item in project.tasks if item.id == task_id), None)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        executor = HarnessWorkerExecutor(harness_client, memory_store=memory_store)
        product_task = executor.build_task(project, task, run_ref)
        if source_message_id or source_instruction:
            context = dict(product_task.context)
            context["source_message_id"] = source_message_id
            context["source_instruction"] = source_instruction
            product_task = product_task.model_copy(
                update={"actor_user_id": actor_user_id, "context": context}
            )
        return product_task

    def _dispatch_host_worker(
        pid: str,
        tid: str,
        ws: str,
        actor: str,
        source_message_id: str | None = None,
        source_instruction: str | None = None,
    ) -> None:
        if harness_client is None or host_workers is None:
            return
        key = (pid, tid)
        existing_id = host_runs.get(key)
        if existing_id:
            try:
                if not harness_client.get(existing_id).terminal:
                    return
            except HarnessHostError:
                pass
        project = crew.get_project(pid)
        if project is None:
            return
        run_ref = f"crew:{pid}:{tid}:v{project.project_version}:host"
        try:
            submitted = harness_client.submit(
                _host_worker_task(
                    pid,
                    tid,
                    actor,
                    source_message_id,
                    source_instruction,
                    run_ref=run_ref,
                )
            )
        except Exception:  # dispatch must not break the originating transition
            logger.warning("crew host worker dispatch failed for %s/%s", pid, tid, exc_info=True)
            return
        host_runs[key] = submitted.run_id
        executor = HarnessWorkerExecutor(
            harness_client,
            memory_store=memory_store,
            submitted_run_id=submitted.run_id,
        )

        def _finish() -> None:
            try:
                crew.run_agent(pid, tid, executor, run_ref=submitted.run_id)
            except Exception:  # noqa: BLE001 - CrewService records truthful block state
                logger.warning("crew host worker failed for %s/%s", pid, tid, exc_info=True)
            finally:
                host_runs.pop(key, None)

        host_workers.submit(_finish)

    # R-B auto-pilot: wire durable auto-trigger/auto-advance collaborators onto
    # the service. Dispatch is synchronously persisted before the lifecycle route
    # returns; runtime wake-up is only a notification to workers.
    if auto_pilot:
        if getattr(crew, "_agent_dispatcher", None) is None and product_mode and harness_client is not None:
            crew._agent_dispatcher = _dispatch_host_worker
        elif getattr(crew, "_agent_dispatcher", None) is None and execution_store is not None:
            def _dispatch(
                pid: str,
                tid: str,
                ws: str,
                actor: str,
                source_message_id: str | None = None,
                source_instruction: str | None = None,
            ) -> None:
                snapshot = _dispatch_start_execution_sync(
                    project_id=pid,
                    task_id=tid,
                    workspace_id=ws,
                    actor_user_id=actor,
                    source_message_id=source_message_id,
                    source_instruction=source_instruction,
                )
                if execution_runtime is not None and snapshot.status in (
                    "queued",
                    "running",
                    "awaiting_signal",
                ):
                    execution_runtime.wake()
            crew._agent_dispatcher = _dispatch
        if getattr(crew, "_propose_assignments", None) is None:
            def _propose(project):
                if product_mode and matching is not None:
                    return matching.propose(
                        project, identity.list_members(project.workspace_id)
                    )
                # Deterministic role-match (fast, no model call in the transition
                # path); the model-backed matcher stays for /suggest-assignments.
                return deterministic_proposals(
                    project, identity.list_members(project.workspace_id)
                )
            crew._propose_assignments = _propose

    def _session(authorization: str | None):
        token = None
        if authorization and authorization.startswith("Bearer "):
            token = authorization.removeprefix("Bearer ").strip() or None
        session = identity.resolve(token) if token else None
        # No token → fall back to the local-runtime identity (same as chat/
        # finance/create), when one is wired. Cross-workspace isolation is
        # unaffected: a local identity only ever sees its OWN workspace.
        if session is None and local_session is not None:
            session = local_session()
        if session is None:
            raise HTTPException(status_code=401, detail="authentication required")
        return session

    def _guard_project(project_id: str, session):
        project = crew.get_project(project_id)
        if project is None or project.workspace_id != session.workspace_id:
            raise HTTPException(status_code=404, detail="project not found")
        return project

    def _guard_run_ref(run_ref: str, session) -> None:
        """Resolve a Crew run to a project/task before consulting the Host."""
        parts = run_ref.split(":")
        if len(parts) >= 3 and parts[0] == "crew":
            project = _guard_project(parts[1], session)
            task = next((item for item in project.tasks if item.id == parts[2]), None)
            if task is None:
                raise HTTPException(status_code=404, detail="run not found")
            expected_prefix = f"crew:{project.id}:{task.id}:"
            if task.run_ref is not None and task.run_ref != run_ref:
                raise HTTPException(status_code=404, detail="run not found")
            if task.run_ref is None and not run_ref.startswith(expected_prefix):
                raise HTTPException(status_code=404, detail="run not found")
            return
        for project in crew.list_workspace_projects(session.workspace_id):
            if any(task.run_ref == run_ref for task in project.tasks):
                return
        raise HTTPException(status_code=404, detail="run not found")

    def _is_agent_member(member_id: str | None) -> bool:
        """Whether ``member_id`` is an Agent worker (kind=="agent"). Conservative:
        an unknown/unwired member is NOT an agent (never auto-run a stranger)."""
        if not member_id:
            return False
        account = identity.store.get_account(member_id)
        return bool(account and account.kind == "agent")

    def _active_execution_for_task(workspace_id: str, project_id: str, task_id: str):
        if execution_store is None:
            return None
        subject_ref = f"crew_task:{project_id}:{task_id}"
        active = execution_store.list_active(
            workspace_id=workspace_id,
            subject_ref_prefix=subject_ref,
        )
        for snapshot in active:
            if snapshot.subject_ref == subject_ref:
                return snapshot
        return None

    def _dispatch_start_execution_sync(
        *,
        project_id: str,
        task_id: str,
        workspace_id: str,
        actor_user_id: str,
        source_message_id: str | None = None,
        source_instruction: str | None = None,
    ):
        if execution_store is None:
            raise HTTPException(status_code=503, detail="execution runtime not configured")
        project = crew.get_project(project_id)
        if project is None or project.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="project not found")
        task = next((t for t in project.tasks if t.id == task_id), None)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        if not task.assignee_member_id:
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”还没有执行者。",
                "code": "task_not_runnable",
                "task_status": task.status,
            })
        if not _is_agent_member(task.assignee_member_id):
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”当前执行者不是 Agent。",
                "code": "task_not_runnable",
                "task_status": task.status,
            })
        if source_message_id:
            trigger_ref = f"crew_message:{project_id}:{source_message_id}"
            request_id = f"crew:message:{project_id}:{task_id}:{source_message_id}"
            command_input = {
                "project_id": project_id,
                "task_id": task_id,
                "actor": actor_user_id,
                "source_message_id": source_message_id,
                "source_instruction": source_instruction,
            }
        else:
            trigger_ref = f"crew_manual:{project_id}:{task_id}:v{project.project_version}"
            request_id = (
                f"crew:run-agent:{project_id}:{task_id}:"
                f"v{project.project_version}:manual"
            )
            command_input = {
                "project_id": project_id,
                "task_id": task_id,
                "actor": actor_user_id,
                "source_message_id": None,
                "source_instruction": None,
                "project_version": project.project_version,
            }
        command = StartExecution(
            request_id=request_id,
            workspace_id=workspace_id,
            conversation_id=f"crew_project:{project_id}",
            channel_id=f"crew_channel:{project_id}",
            subject_ref=f"crew_task:{project_id}:{task_id}",
            trigger_ref=trigger_ref,
            worker_profile_ref=f"member:{task.assignee_member_id}",
            run_profile_ref="crew.query_engine.v1",
            input=command_input,
        )
        try:
            return execution_store.dispatch(command, max_queue_depth=max_queue_depth)
        except ActiveExecutionConflictError as exc:
            if exc.existing_execution_id is None:
                raise
            if source_message_id and source_instruction:
                existing = execution_store.get(exc.existing_execution_id)
                signal_kind = (
                    "answer" if _is_awaiting_crew_worker_answer(existing) else "steer"
                )
                try:
                    execution_store.dispatch(
                        SignalExecution(
                            request_id=(
                                f"crew:{signal_kind}:{project_id}:{task_id}:{source_message_id}"
                            ),
                            workspace_id=workspace_id,
                            execution_id=exc.existing_execution_id,
                            kind=signal_kind,
                            payload={
                                "text": source_instruction,
                                "source_message_id": source_message_id,
                                "actor": actor_user_id,
                            },
                        ),
                        max_queue_depth=max_queue_depth,
                    )
                except TerminalStateError:
                    logger.info(
                        "crew active execution finished before %s signal could be accepted",
                        signal_kind,
                    )
            return execution_store.get(exc.existing_execution_id)

    def _run(action):
        try:
            return action().model_dump(mode="json")
        except CrewLifecycleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ValueError as exc:
            # Invariant: the service raises ValueError ONLY for not-found entities.
            # Future input-validation errors must NOT rely on this path — they would
            # be mis-mapped to 404 instead of 400. Use CrewLifecycleError for those.
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get("/api/crew/templates")
    def templates() -> dict:
        return {"templates": [t.model_dump(mode="json") for t in list_templates()]}

    @router.post("/api/crew/projects")
    def create_project(
        request: CreateProjectRequest, authorization: str | None = Header(default=None)
    ) -> dict:
        session = _session(authorization)
        try:
            project = crew.create_project(
                workspace_id=session.workspace_id,
                owner_user_id=session.user_id,
                goal_text=request.goal_text,
                template_id=request.sop_template_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return project.model_dump(mode="json")

    @router.post("/api/crew/projects/decompose")
    def decompose_project(
        request: CreateProjectRequest, authorization: str | None = Header(default=None)
    ) -> dict:
        session = _session(authorization)
        decomposer = decomposition or CrewDecompositionService()
        try:
            project = crew.create_project_ai(
                workspace_id=session.workspace_id,
                owner_user_id=session.user_id,
                goal_text=request.goal_text,
                template_id=request.sop_template_id,
                decomposition=decomposer,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return project.model_dump(mode="json")

    @router.get("/api/crew/projects")
    def list_projects(authorization: str | None = Header(default=None)) -> dict:
        session = _session(authorization)
        projects = crew.list_projects(session.workspace_id, session.user_id)
        return {"projects": [p.model_dump(mode="json") for p in projects]}

    @router.post("/api/crew/showcase/ensure")
    def ensure_showcase(
        request: ShowcaseEnsureRequest | None = None,
        authorization: str | None = Header(default=None),
    ) -> dict:
        session = _session(authorization)
        body = request or ShowcaseEnsureRequest()
        try:
            result = crew.ensure_showcase(
                workspace_id=session.workspace_id,
                owner_user_id=session.user_id,
                members=identity.list_members(session.workspace_id),
                scenario_id=body.scenario_id,
                locale=body.locale,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "scenario_id": result.scenario_id,
            "scenario_version": result.scenario_version,
            "project": result.project.model_dump(mode="json"),
            "created": result.created,
            "migrated": result.migrated,
            "warnings": result.warnings,
        }

    @router.get("/api/crew/projects/{project_id}")
    def get_project(project_id: str, authorization: str | None = Header(default=None)) -> dict:
        session = _session(authorization)
        data = _guard_project(project_id, session).model_dump(mode="json")
        active_by_task: set[str] = set()
        if execution_store is not None:
            for snapshot in execution_store.list_active(
                workspace_id=session.workspace_id,
                subject_ref_prefix=f"crew_task:{project_id}:",
            ):
                parts = snapshot.subject_ref.split(":")
                if len(parts) >= 3 and parts[0] == "crew_task" and parts[1] == project_id:
                    active_by_task.add(":".join(parts[2:]))
        for task in data["tasks"]:
            task["run_inflight"] = task["id"] in active_by_task
            if product_mode and harness_client is not None and task.get("run_ref"):
                try:
                    task["run_inflight"] = not harness_client.get(task["run_ref"]).terminal
                except HarnessHostError:
                    # The persisted task remains readable when the Host is down;
                    # do not turn a status probe failure into fabricated progress.
                    pass
        return data

    @router.post("/api/crew/projects/{project_id}/tasks/{task_id}/assign")
    async def assign(
        project_id: str, task_id: str, request: AssignRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        # async so a resulting auto-run can durably dispatch during this request.
        session = _session(authorization)
        project = _guard_project(project_id, session)
        task = next((t for t in project.tasks if t.id == task_id), None)
        # 接管/改派 友好守卫,ordered: missing → 404; gate → 409 (评审人固定=负责人,
        # 不接受指派); 已开工/待审/返工/完成 → 409 引导频道协调(不静默夺权)。
        # todo|blocked|assigned 放行——assigned=接管未开工任务,由 service 全程留痕。
        # lifecycle 的守卫仍是英文 backstop(直调 service 时)。
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        if task.is_gate:
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”是评审门——评审人固定为项目负责人，不接受指派。",
                "code": "task_is_gate",
                "task_status": task.status,
            })
        if task.status in ("running", "submitted", "in_review", "rework", "done"):
            raise HTTPException(status_code=409, detail={
                "detail": (
                    f"“{task.title}”{_assign_conflict_zh(task.status)}"
                    "——不能直接改派；让当前执行者推进，或先在频道协调。"
                ),
                "code": "task_not_assignable",
                "task_status": task.status,
            })
        if product_mode:
            return await asyncio.to_thread(
                _run, lambda: crew.assign(project_id, task_id, request.member_id)
            )
        return _run(lambda: crew.assign(project_id, task_id, request.member_id))

    @router.post("/api/crew/projects/{project_id}/tasks/{task_id}/start")
    def start(
        project_id: str, task_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        session = _session(authorization)
        project = _guard_project(project_id, session)
        task = next((t for t in project.tasks if t.id == task_id), None)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        # 可用性收束:评审门永不「开始」——门是裁定不是干活(用户真机曾把门
        # 认领→开始→撞提交守卫,一路误导)。机器码 task_is_gate 供 FE 人话。
        if task.is_gate:
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”是评审门——不用开始，直接评审：通过或驳回。",
                "code": "task_is_gate",
                "task_status": task.status,
            })
        # C2 友好守卫:a task the Boss clicks「开始」on may have already been
        # auto-advanced by Anna (e.g. an agent produced it → submitted). Return a
        # friendly, machine-readable 409 instead of a bare 400 lifecycle string.
        # startable = assigned (→running) or rework (直接→running). Lifecycle's own
        # guard (incl. the deps-not-satisfied case) remains the backstop → 400.
        if task.status not in ("assigned", "rework"):
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”当前状态为{_status_zh(task.status)}，无法开始。",
                "code": "task_not_startable",
                "task_status": task.status,
            })
        return _run(lambda: crew.start(project_id, task_id))

    @router.post("/api/crew/projects/{project_id}/tasks/{task_id}/submit")
    async def submit(
        project_id: str, task_id: str, request: SubmitRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        # async: a submit that unlocks a pre-assigned Agent auto-runs it (R-B #2).
        session = _session(authorization)
        project = _guard_project(project_id, session)
        task = next((t for t in project.tasks if t.id == task_id), None)
        if task is not None and task.is_gate:
            # 可用性收束:门不提交产物(lifecycle 守卫仍是英文 backstop,这里给中文人话)
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”是评审门——门不提交产物，请直接评审：通过或驳回。",
                "code": "task_is_gate",
                "task_status": task.status,
            })
        if product_mode:
            return await asyncio.to_thread(
                _run, lambda: crew.submit(project_id, task_id, request.artifact)
            )
        return _run(lambda: crew.submit(project_id, task_id, request.artifact))

    @router.post("/api/crew/projects/{project_id}/tasks/{task_id}/review")
    async def review(
        project_id: str, task_id: str, request: ReviewRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        # async: approve auto-advances downstream + auto-runs agents (R-B #3).
        session = _session(authorization)
        _guard_project(project_id, session)
        if product_mode:
            return await asyncio.to_thread(
                _run,
                lambda: crew.review(project_id, task_id, request.approved, request.comment),
            )
        return _run(lambda: crew.review(project_id, task_id, request.approved, request.comment))

    @router.post("/api/crew/projects/{project_id}/tasks/{task_id}/run-agent")
    async def run_agent(
        project_id: str, task_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        """Durably dispatch an Agent worker and return its execution id as run_ref."""
        session = _session(authorization)
        project = _guard_project(project_id, session)
        task = next((t for t in project.tasks if t.id == task_id), None)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        existing = _active_execution_for_task(session.workspace_id, project_id, task_id)
        if existing is not None:
            return {
                "run_ref": existing.execution_id,
                "task_id": task_id,
                "status": existing.status,
            }
        if task.status not in ("assigned", "rework") or not _is_agent_member(
            task.assignee_member_id
        ):
            raise HTTPException(status_code=409, detail={
                "detail": f"“{task.title}”当前状态为{_status_zh(task.status)}，无法交给 Agent 执行。",
                "code": "task_not_runnable",
                "task_status": task.status,
            })
        if product_mode:
            if harness_client is None:
                raise HTTPException(status_code=503, detail="Harness Host is not configured")
            run_ref = f"crew:{project_id}:{task_id}:v{project.project_version}:manual"
            try:
                submitted = await asyncio.to_thread(
                    harness_client.submit,
                    _host_worker_task(
                        project_id,
                        task_id,
                        session.user_id,
                        run_ref=run_ref,
                    ),
                )
            except HarnessHostError as exc:
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            host_runs[(project_id, task_id)] = submitted.run_id
            executor = HarnessWorkerExecutor(
                harness_client,
                memory_store=memory_store,
                submitted_run_id=submitted.run_id,
            )

            def _finish_host_worker() -> None:
                try:
                    crew.run_agent(project_id, task_id, executor, run_ref=submitted.run_id)
                except Exception:  # noqa: BLE001 - service records truthful failure
                    logger.warning("crew manual host worker failed for %s/%s", project_id, task_id, exc_info=True)
                finally:
                    host_runs.pop((project_id, task_id), None)

            if host_workers is None:
                raise HTTPException(status_code=503, detail="Harness worker manager is not configured")
            host_workers.submit(_finish_host_worker)
            return {"run_ref": submitted.run_id, "task_id": task_id, "status": submitted.status}
        if execution_store is None:
            raise HTTPException(status_code=503, detail="execution runtime not configured")
        snapshot = _dispatch_start_execution_sync(
            project_id=project_id,
            task_id=task_id,
            workspace_id=session.workspace_id,
            actor_user_id=session.user_id,
            source_message_id=None,
            source_instruction=None,
        )
        if execution_runtime is not None:
            execution_runtime.wake()
        return {"run_ref": snapshot.execution_id, "task_id": task_id, "status": snapshot.status}

    @router.get("/api/crew/runs/{run_ref}/frames")
    async def get_run_frames(
        run_ref: str,
        from_seq: int = 0,
        authorization: str | None = Header(default=None),
    ) -> dict:
        """Project durable execution events into the legacy frame polling shape."""
        session = _session(authorization)
        if product_mode:
            if harness_client is None:
                raise HTTPException(status_code=503, detail="Harness Host is not configured")
            _guard_run_ref(run_ref, session)
            try:
                host_run = await asyncio.to_thread(harness_client.get, run_ref)
                events = await asyncio.to_thread(harness_client.events, run_ref, after_seq=from_seq)
            except HarnessHostError as exc:
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            return {"run_ref": run_ref, "frames": _host_events_to_frames(events), "status": host_run.status}
        if execution_kernel is None:
            raise HTTPException(status_code=503, detail="execution runtime not configured")
        try:
            snapshot = await execution_kernel.get(run_ref)
        except ExecutionNotFoundError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        if snapshot.workspace_id != session.workspace_id:
            raise HTTPException(status_code=404, detail="run not found")
        events = await execution_kernel.read_events(run_ref, after_seq=from_seq)
        return {"run_ref": run_ref, "frames": _events_to_frames(events)}

    @router.get("/api/crew/projects/{project_id}/channel")
    def list_channel(
        project_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        session = _session(authorization)
        _guard_project(project_id, session)
        messages = crew.list_channel(project_id)
        return {"messages": [m.model_dump(mode="json") for m in messages]}

    @router.post("/api/crew/projects/{project_id}/channel")
    async def post_channel(
        project_id: str, request: SayRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        # async:「@Agent 再改改」re-dispatches the agent's task on this loop (R-B #2).
        session = _session(authorization)
        _guard_project(project_id, session)
        if product_mode:
            # ``crew.say`` may fan out a Host-backed @Worker dispatch. Keep that
            # synchronous service transition off the event loop so a Host callback
            # into /_business can be served without deadlock.
            message = await asyncio.to_thread(
                crew.say, project_id, session.user_id, request.body, request.mentions
            )
        else:
            message = crew.say(project_id, session.user_id, request.body, request.mentions)
        # C3 coordination card: only @Anna + task intent spawns a DRAFT command
        # card in the background. @Human remains notify-only; @Worker steers the
        # active execution path.
        if crew.should_draft_intent(message):
            async def _draft_intent() -> None:
                try:
                    await asyncio.to_thread(
                        crew.draft_intent_card, project_id, message
                    )
                except Exception:  # noqa: BLE001 — drafting must not break the say
                    logger.warning("crew intent drafting failed", exc_info=True)
            asyncio.create_task(_draft_intent())
        if product_mode and harness_client is not None and crew.is_contextual_question(message):
            # Ordinary @Anna questions are answered through the same Host loop
            # and appended to the existing channel; no second UI conversation is
            # created. The context is assembled from persisted Crew facts only.
            project = crew.get_project(project_id)
            if project is not None:
                memory_items = (
                    memory_store.list_items(
                        project.workspace_id,
                        scope="project",
                        project_id=project.id,
                        limit=100,
                    )
                    if memory_store is not None
                    else []
                )
                context = {
                    "source": "crew.contextual_answer",
                    "project_id": project.id,
                    "source_message_id": message.id,
                    "project": project.model_dump(mode="json"),
                    "channel_messages": [
                        item.model_dump(mode="json") for item in crew.list_channel(project.id)
                    ],
                    "project_memory": [
                        item.model_dump(mode="json") for item in reversed(memory_items)
                    ],
                }
                task = ProductTask(
                    run_id=f"crew-context:{project.id}:{message.id}",
                    workspace_id=project.workspace_id,
                    actor_user_id=session.user_id,
                    surface="crew",
                    prompt=message.body,
                    channel_id=f"crew_channel:{project.id}",
                    conversation_id=f"crew_project:{project.id}",
                    context=context,
                    permission_mode="readonly",
                    source_event_id=message.id,
                )
                try:
                    answer_run = await asyncio.to_thread(
                        harness_client.submit_and_wait, task
                    )
                    answer = _host_answer(answer_run)
                    if answer:
                        await asyncio.to_thread(
                            crew.append_anna_message,
                            project.id,
                            answer,
                            run_ref=answer_run.run_id,
                        )
                except HarnessHostError:
                    logger.warning(
                        "crew contextual answer failed for %s/%s",
                        project_id,
                        message.id,
                        exc_info=True,
                    )
        return message.model_dump(mode="json")

    @router.get("/api/crew/notifications")
    def list_notifications(
        unread: bool = False, authorization: str | None = Header(default=None)
    ) -> dict:
        session = _session(authorization)
        notes = crew.list_notifications(
            session.workspace_id, session.user_id, unread_only=unread
        )
        return {"notifications": [n.model_dump(mode="json") for n in notes]}

    @router.patch("/api/crew/notifications/{notification_id}/read")
    def mark_notification_read(
        notification_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        session = _session(authorization)
        note = crew.mark_read(notification_id, session.user_id)
        if note is None:
            raise HTTPException(status_code=404, detail="notification not found")
        return note.model_dump(mode="json")

    # --- B3 · channel「+任务」command (two-phase: draft → Boss-confirm) --------

    @router.post("/api/crew/projects/{project_id}/channel/command")
    def channel_command(
        project_id: str, request: ChannelCommandRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        """Phase 1: draft 1..N≤3 tasks from a channel message (any member).

        Returns the command draft row's ``message_id`` + the drafts; the row also
        lands on the channel for the composer's confirm checklist."""
        session = _session(authorization)
        _guard_project(project_id, session)
        command, drafts = crew.draft_tasks_from_message(
            project_id, request.text, session.user_id,
            source_message_id=request.source_message_id,
        )
        return {
            "message_id": command.id,
            "drafts": [d.model_dump(mode="json") for d in drafts],
        }

    @router.post("/api/crew/projects/{project_id}/channel/command/confirm")
    def channel_command_confirm(
        project_id: str, request: ChannelCommandConfirmRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        """Phase 2 (Boss-only): push a chosen subset of a command's drafts.

        Drafts are resolved server-side from the command row (零捏造 — the client
        selects by index, never re-sends arbitrary tasks)."""
        session = _session(authorization)
        project = _guard_project(project_id, session)
        _require_owner(project, session)  # Boss-only → 403
        command = crew.get_channel_message(request.message_id)
        if command is None or command.project_id != project_id or command.kind != "command":
            raise HTTPException(status_code=404, detail="command draft not found")
        all_drafts = (command.payload or {}).get("drafts", [])
        indexes = (
            request.draft_indexes
            if request.draft_indexes is not None
            else list(range(len(all_drafts)))
        )
        try:
            selected = [TaskDraft.model_validate(all_drafts[i]) for i in indexes]
        except (IndexError, TypeError, KeyError) as exc:
            raise HTTPException(status_code=400, detail="invalid draft index") from exc
        # R4b adopt-and-assign: only Anna coordination/legacy intent cards may
        # carry a suggested assignee into the normal confirm path.
        payload = command.payload or {}
        suggested = (
            payload.get("suggested_assignee")
            if payload.get("origin") in {"anna_coordination", "intent"}
            else None
        )
        try:
            updated = crew.confirm_drafts(
                project_id, selected, session.user_id, source_message_id=command.id,
                suggested_assignee=suggested,
            )
        except CrewPermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    # --- B3 · inbox aggregation + reimbursement approval projection -----------

    def _workspace_boss_ids(projects) -> list[str]:
        """Bosses = distinct crew-project owners (the codebase's boss = owner)."""
        return sorted({p.owner_user_id for p in projects})

    def _non_showcase_projects(projects):
        """Projects that should participate in actionable inbox/approval routing."""
        return [p for p in projects if getattr(p, "source", "user") != "showcase"]

    def _sync_approval_notifications(
        workspace_id: str, cards: list[dict], boss_ids: list[str]
    ) -> None:
        """Emit idempotent ``approval`` notifications for awaiting-approval cards.

        Hung on the projection READ (simplest per B3): every awaiting_approval
        run notifies each Boss once (dedup key = run_id+step+member), so repeated
        inbox/approvals polls never duplicate. Does not touch reimbursement."""
        for card in cards:
            if card.get("step") != approvals_projection.STEP_AWAITING_APPROVAL:
                continue
            for boss_id in boss_ids:
                crew.notify_approval(
                    workspace_id=workspace_id,
                    to_member_id=boss_id,
                    run_id=card["run_id"],
                    step=card["step"],
                    title=f"报销 {card['run_id']} 待你审批。",
                    deep_link=card["deep_link"],
                )

    @router.get("/api/crew/approvals")
    def list_approvals(authorization: str | None = Header(default=None)) -> dict:
        """The workspace's reimbursement runs projected to the 4-step stepper.

        Read-only over reimbursement; awaiting_approval cards also (idempotently)
        raise a Boss approval notification."""
        session = _session(authorization)
        if reimbursement is None:
            return {"approvals": []}
        cards = approvals_projection.workspace_approvals(
            reimbursement, session.workspace_id
        )
        projects = _non_showcase_projects(
            crew.list_workspace_projects(session.workspace_id)
        )
        _sync_approval_notifications(
            session.workspace_id, cards, _workspace_boss_ids(projects)
        )
        return {"approvals": cards}

    @router.get("/api/crew/inbox")
    def get_inbox(authorization: str | None = Header(default=None)) -> dict:
        """The current member's three inbox lanes: todo / review / mentions."""
        session = _session(authorization)
        projects = _non_showcase_projects(
            crew.list_workspace_projects(session.workspace_id)
        )
        todo = inbox_agg.todo_cards(projects, session.user_id)
        review = inbox_agg.review_cards(projects, session.user_id)

        messages_by_project = {p.id: crew.list_channel(p.id) for p in projects}
        titles = {p.id: p.goal_text for p in projects}
        mentions = inbox_agg.mention_cards(
            messages_by_project, session.user_id, titles
        )

        # Reimbursement approval cards belong to a Boss (a project owner). Fold
        # the actionable awaiting_approval ones into「等我审」and fire notifications.
        boss_ids = _workspace_boss_ids(projects)
        if reimbursement is not None and session.user_id in boss_ids:
            cards = approvals_projection.workspace_approvals(
                reimbursement, session.workspace_id
            )
            _sync_approval_notifications(session.workspace_id, cards, boss_ids)
            review = review + [
                {**card, "card_kind": "reimbursement"}
                for card in cards
                if card["step"] == approvals_projection.STEP_AWAITING_APPROVAL
            ]

        return {"todo": todo, "review": review, "mentions": mentions}

    # --- B1b · project consensus memory (scope="project" BusinessMemory) ------

    def _memory() -> BusinessMemoryStore:
        if memory_store is None:
            raise HTTPException(
                status_code=503, detail="business memory store not configured"
            )
        return memory_store

    def _require_owner(project, session) -> None:
        """Boss-only write: the project owner maintains its 共识 entries."""
        if project.owner_user_id != session.user_id:
            raise HTTPException(
                status_code=403, detail="只有项目负责人可以维护项目共识"
            )

    def _project_consensus_item(
        store: BusinessMemoryStore, item_id: str, project_id: str, session
    ) -> BusinessMemoryItem:
        item = store.get(item_id)
        if (
            item is None
            or item.scope != "project"
            or item.project_id != project_id
            or item.workspace_id != session.workspace_id
        ):
            raise HTTPException(status_code=404, detail="consensus item not found")
        return item

    @router.get("/api/crew/projects/{project_id}/memory")
    def list_project_memory(
        project_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        """The project's 共识 entries, oldest first (matches the worker's
        1..N prompt numbering). Readable by any workspace member."""
        session = _session(authorization)
        _guard_project(project_id, session)
        items = _memory().list_items(
            session.workspace_id, scope="project", project_id=project_id, limit=100
        )
        # Store order is newest-first with a deterministic insertion tiebreak;
        # reversed = true insertion order, matching the worker's numbering.
        items = list(reversed(items))
        return {
            "items": [_consensus_entry(item) for item in items],
            "count": len(items),
        }

    @router.put("/api/crew/projects/{project_id}/memory")
    def upsert_project_memory(
        project_id: str,
        request: ConsensusUpsertRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        session = _session(authorization)
        project = _guard_project(project_id, session)
        _require_owner(project, session)
        store = _memory()
        text = request.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="共识条目不能为空")
        if request.id:
            _project_consensus_item(store, request.id, project_id, session)
            item = store.update(
                request.id,
                memory_type=request.kind,
                title=text[:_CONSENSUS_TITLE_CHARS],
                content=text,
            )
        else:
            item = store.add(
                workspace_id=session.workspace_id,
                memory_type=request.kind,
                title=text[:_CONSENSUS_TITLE_CHARS],
                content=text,
                source="crew",
                confidence=1.0,
                scope="project",
                project_id=project_id,
            )
        return _consensus_entry(item)

    @router.delete("/api/crew/projects/{project_id}/memory/{item_id}")
    def delete_project_memory(
        project_id: str, item_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict:
        session = _session(authorization)
        project = _guard_project(project_id, session)
        _require_owner(project, session)
        store = _memory()
        _project_consensus_item(store, item_id, project_id, session)
        store.delete(item_id)
        return {"id": item_id, "deleted": True}

    @router.post("/api/crew/projects/{project_id}/suggest-assignments")
    def suggest_assignments(
        project_id: str, authorization: str | None = Header(default=None)
    ) -> dict:
        from services.runtime.app.config import RuntimeSettings
        session = _session(authorization)
        project = _guard_project(project_id, session)
        members = identity.list_members(session.workspace_id)
        proposals = (matching or CrewMatchingService()).propose(project, members)
        s = RuntimeSettings.from_env()
        source = "model" if (s.model_endpoint and s.model_api_key) else "fallback"
        return {"proposals": [p.model_dump(mode="json") for p in proposals], "source": source}

    return router


def _host_events_to_frames(events: list[dict]) -> list[dict]:
    frames: list[dict] = []
    for event in events:
        event_type = event.get("type")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event_type in {"run.text.delta", "assistant.text.delta", "text_delta"}:
            text = payload.get("text") or event.get("text")
            if isinstance(text, str):
                frame = {"type": "text_delta", "text": text}
            else:
                frame = {"type": "event", "event": event}
        elif event_type in {"run.tool.started", "tool_start"}:
            name = payload.get("tool") or payload.get("name") or event.get("name")
            frame = {"type": "tool_start", "name": name} if isinstance(name, str) else {"type": "event", "event": event}
        elif event_type in {"run.tool.completed", "tool_done"}:
            name = payload.get("tool") or payload.get("name") or event.get("name")
            frame = {"type": "tool_done", "name": name} if isinstance(name, str) else {"type": "event", "event": event}
        else:
            frame = {"type": "event", "event": event}
        if isinstance(event.get("seq"), int):
            frame["seq"] = event["seq"]
        frames.append(frame)
    return frames


def _host_answer(run) -> str | None:
    result = run.result or {}
    for key in ("answer", "assistant_message", "text", "output"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
