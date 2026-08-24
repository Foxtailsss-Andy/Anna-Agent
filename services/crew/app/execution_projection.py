from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from services.crew.app import lifecycle
from services.crew.app.schemas import ChannelMessage, CrewProject, CrewTask, Notification
from services.crew.app.store import ProjectionEffects, SQLiteCrewStore
from services.runtime.app.execution.models import ExecutionSnapshot
from services.runtime.app.execution.store import ExecutionOutboxEvent, SQLiteExecutionStore

_STARTED_EVENT_TYPES = frozenset({"execution.started"})
_CLAIMED_EVENT_TYPES = frozenset({"execution.claimed"})
_FAILED_EVENT_TYPES = frozenset({"execution.failed"})
_DEAD_LETTER_EVENT_TYPES = frozenset({"execution.dead_lettered"})
_CANCELLED_EVENT_TYPES = frozenset({"execution.cancelled"})
_ARTIFACT_EVENT_TYPES = frozenset(
    {
        "artifact_produced",
        "crew.artifact_produced",
        "crew.task.artifact_produced",
        "execution.artifact_produced",
    }
)
_BLOCKED_EVENT_TYPES = frozenset(
    {
        "agent_blocked",
        "crew.agent_blocked",
        "crew.task.agent_blocked",
        "execution.agent_blocked",
    }
)
_QUESTION_EVENT_TYPES = frozenset({"crew.worker.question"})
_RECOVERY_BLOCKED_EVENT_TYPES = frozenset({"execution.recovery_blocked"})
_RETRY_SCHEDULED_EVENT_TYPES = frozenset({"execution.retry_scheduled"})


@dataclass(frozen=True)
class CrewExecutionTaskRef:
    project_id: str
    task_id: str


@dataclass(frozen=True)
class ProjectionRunResult:
    claimed: int = 0
    applied: int = 0
    skipped: int = 0
    acked: int = 0
    failed: int = 0


class CrewExecutionProjector:
    """Project durable AgentExecution events into core CrewProject task state.

    Project mutation, audit rows, channel rows, notifications and the projection
    receipt are written through one Crew SQLite transaction, so replay is
    idempotent and failed projection attempts leave no half-applied Crew state.
    """

    def __init__(
        self,
        *,
        crew_store: SQLiteCrewStore,
        execution_store: SQLiteExecutionStore,
    ) -> None:
        self._crew_store = crew_store
        self._execution_store = execution_store

    def run_once(
        self,
        *,
        owner_id: str,
        limit: int = 100,
        lease_ttl_seconds: float = 30.0,
    ) -> ProjectionRunResult:
        events = self._execution_store.claim_outbox_events(
            owner_id=owner_id,
            limit=limit,
            lease_ttl_seconds=lease_ttl_seconds,
            subject_ref_prefix="crew_task:",
        )
        applied = 0
        skipped = 0
        acked = 0
        failed = 0
        failed_executions: set[str] = set()
        for event in events:
            if event.execution_id in failed_executions:
                failed += 1
                continue
            try:
                did_apply = self.project_event(event)
            except Exception:
                failed += 1
                failed_executions.add(event.execution_id)
                continue
            if did_apply:
                applied += 1
            else:
                skipped += 1
            acked += self._execution_store.ack_outbox_events(
                [event],
                owner_id=event.claim_owner,
                claim_token=event.claim_token,
            )
        return ProjectionRunResult(
            claimed=len(events),
            applied=applied,
            skipped=skipped,
            acked=acked,
            failed=failed,
        )

    def project_event(self, event: ExecutionOutboxEvent) -> bool:
        snapshot = self._execution_store.get(event.execution_id)
        ref = resolve_crew_task_ref(event, snapshot)
        if ref is None:
            return False

        def mutate(project: CrewProject) -> ProjectionEffects:
            return mutate_project_for_execution_event(project, event, snapshot, ref)

        return self._crew_store.apply_execution_projection(
            project_id=ref.project_id,
            task_id=ref.task_id,
            execution_id=event.execution_id,
            seq=event.seq,
            mutate=mutate,
        )


def mutate_project_for_execution_event(
    project: CrewProject,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
    ref: CrewExecutionTaskRef,
) -> ProjectionEffects:
    task = _find_task(project, ref.task_id)
    if task is None:
        raise ValueError(f"Task {ref.task_id!r} not found in project {project.id!r}")

    effects = _EffectBuilder(project, task, event, snapshot)
    if event.type in _STARTED_EVENT_TYPES:
        effects.changed = _project_started(task, event, snapshot)
        if effects.changed:
            audit_ref = effects.audit(
                "crew.task.execution_started",
                {"task_id": task.id, "run_ref": event.execution_id},
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”已进入 Worker 执行队列。",
                audit_ref=audit_ref,
            )
    elif event.type in _CLAIMED_EVENT_TYPES:
        effects.changed = _project_claimed(project, task, event, snapshot)
        if effects.changed:
            audit_ref = effects.audit(
                "crew.task.execution_claimed",
                {"task_id": task.id, "run_ref": event.execution_id},
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”开始由 @{_member_name(task.assignee_member_id)} 执行。",
                mentions=[task.assignee_member_id] if task.assignee_member_id else [],
                audit_ref=audit_ref,
                author_kind="worker",
            )
    elif event.type in _ARTIFACT_EVENT_TYPES:
        blocked_before = _blocked_task_ids(project)
        effects.changed = _project_artifact(project, task, event, snapshot)
        if effects.changed:
            audit_ref = effects.audit(
                "crew.task.agent_run",
                {
                    "task_id": task.id,
                    "artifact_chars": len(task.artifact or ""),
                    "run_ref": event.execution_id,
                    "memory_hits": _memory_hits(event, snapshot),
                },
            )
            effects.channel(
                kind="artifact",
                body=f"“{task.title}”已由 @{_member_name(task.assignee_member_id)} 产出。",
                mentions=[task.assignee_member_id] if task.assignee_member_id else [],
                audit_ref=audit_ref,
                author_kind="worker",
            )
            effects.notify_newly_active(blocked_before, audit_ref)
    elif event.type in _BLOCKED_EVENT_TYPES:
        effects.changed = _project_blocked(task, event, snapshot)
        if effects.changed:
            reason = task.blocker or "Agent execution blocked"
            audit_ref = effects.audit(
                "crew.task.agent_blocked",
                {
                    "task_id": task.id,
                    "run_ref": event.execution_id,
                    "reason": reason,
                    "error_code": event.payload.get("error_code"),
                    "memory_hits": _memory_hits(event, snapshot),
                },
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”执行受阻：{reason}",
                audit_ref=audit_ref,
                author_kind="worker",
            )
            effects.notification(
                to=project.owner_user_id,
                kind="blocked",
                title=f"“{task.title}”执行受阻，需要处理。",
                task_id=task.id,
                ref=audit_ref,
            )
    elif event.type in _QUESTION_EVENT_TYPES:
        if _project_question(project, task, event, snapshot):
            question = _question_text(event)
            target = _question_target(project, event)
            audit_ref = effects.audit(
                "crew.worker.question",
                {
                    "task_id": task.id,
                    "run_ref": event.execution_id,
                    "question": question,
                    "target": target,
                    "tool": event.payload.get("tool"),
                    "tool_call_id": event.payload.get("tool_call_id"),
                },
            )
            effects.channel(
                kind="say",
                body=question,
                mentions=[target],
                audit_ref=audit_ref,
                author_kind="worker",
                payload={
                    "question": question,
                    "target": target,
                    "reason": event.payload.get("reason") or "awaiting_input",
                },
            )
            effects.notification(
                to=target,
                kind="mention",
                title=f"“{task.title}”需要你补充信息。",
                task_id=task.id,
                ref=audit_ref,
            )
    elif event.type in _RECOVERY_BLOCKED_EVENT_TYPES:
        effects.changed = _project_recovery_blocked(task, event, snapshot)
        if effects.changed:
            reason = task.blocker or event.payload.get("reason") or "manual recovery required"
            audit_ref = effects.audit(
                "crew.task.recovery_blocked",
                {
                    "task_id": task.id,
                    "run_ref": event.execution_id,
                    "reason": reason,
                    "manual_recovery_required": event.payload.get("manual_recovery_required"),
                },
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”需要人工恢复：{reason}",
                audit_ref=audit_ref,
                author_kind="worker",
                payload={
                    "reason": reason,
                    "manual_recovery_required": True,
                },
            )
            effects.notification(
                to=project.owner_user_id,
                kind="blocked",
                title=f"“{task.title}”需要人工恢复。",
                task_id=task.id,
                ref=audit_ref,
            )
    elif event.type in _RETRY_SCHEDULED_EVENT_TYPES:
        if _project_retry_scheduled(task, event, snapshot):
            attempt = event.payload.get("attempt")
            max_attempts = event.payload.get("max_attempts")
            reason = event.payload.get("message") or event.payload.get("reason") or "retry scheduled"
            audit_ref = effects.audit(
                "crew.task.retry_scheduled",
                {
                    "task_id": task.id,
                    "run_ref": event.execution_id,
                    "reason": reason,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "not_before": event.payload.get("not_before"),
                },
            )
            effects.channel(
                kind="event",
                body=(
                    f"“{task.title}”将重试"
                    f"（{attempt}/{max_attempts}）：{reason}"
                ),
                audit_ref=audit_ref,
                author_kind="worker",
                payload={
                    "reason": reason,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "not_before": event.payload.get("not_before"),
                },
            )
    elif event.type in _FAILED_EVENT_TYPES:
        effects.changed = _project_terminal_failed(task, event, snapshot)
        if effects.changed:
            reason = task.blocker or event.payload.get("message") or "Execution failed"
            audit_ref = effects.audit(
                "crew.task.agent_failed",
                {
                    "task_id": task.id,
                    "run_ref": event.execution_id,
                    "reason": reason,
                    "error_code": event.payload.get("error_code") or snapshot.last_error_code,
                },
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”执行失败：{reason}",
                audit_ref=audit_ref,
                author_kind="worker",
            )
            effects.notification(
                to=project.owner_user_id,
                kind="blocked",
                title=f"“{task.title}”执行失败，需要处理。",
                task_id=task.id,
                ref=audit_ref,
            )
    elif event.type in _DEAD_LETTER_EVENT_TYPES:
        effects.changed = _project_terminal_failed(task, event, snapshot)
        if effects.changed:
            reason = task.blocker or event.payload.get("message") or "Execution dead-lettered"
            audit_ref = effects.audit(
                "crew.task.agent_dead_lettered",
                {
                    "task_id": task.id,
                    "run_ref": event.execution_id,
                    "reason": reason,
                    "error_code": event.payload.get("error_code") or snapshot.last_error_code,
                    "attempt": event.payload.get("attempt"),
                    "max_attempts": event.payload.get("max_attempts"),
                },
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”进入死信：{reason}",
                audit_ref=audit_ref,
                author_kind="worker",
            )
            effects.notification(
                to=project.owner_user_id,
                kind="blocked",
                title=f"“{task.title}”进入死信，需要处理。",
                task_id=task.id,
                ref=audit_ref,
            )
    elif event.type in _CANCELLED_EVENT_TYPES:
        effects.changed = _project_terminal_cancelled(task, event, snapshot)
        if effects.changed:
            reason = task.blocker or "执行已取消"
            audit_ref = effects.audit(
                "crew.task.agent_cancelled",
                {"task_id": task.id, "run_ref": event.execution_id, "reason": reason},
            )
            effects.channel(
                kind="event",
                body=f"“{task.title}”{reason}",
                audit_ref=audit_ref,
                author_kind="worker",
            )
            effects.notification(
                to=project.owner_user_id,
                kind="blocked",
                title=f"“{task.title}”执行已取消。",
                task_id=task.id,
                ref=audit_ref,
            )
    return effects.to_projection()


def resolve_crew_task_ref(
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> CrewExecutionTaskRef | None:
    candidates: list[dict[str, Any]] = [event.payload, snapshot.input]
    for payload in candidates:
        ref = _ref_from_payload(payload)
        if ref is not None:
            return ref
    for subject_ref in (event.payload.get("subject_ref"), snapshot.subject_ref):
        ref = _ref_from_subject(subject_ref, snapshot.input)
        if ref is not None:
            return ref
    return None


def _ref_from_payload(payload: dict[str, Any]) -> CrewExecutionTaskRef | None:
    nested = payload.get("crew")
    if isinstance(nested, dict):
        ref = _ref_from_payload(nested)
        if ref is not None:
            return ref
    project_id = payload.get("project_id") or payload.get("crew_project_id")
    task_id = payload.get("task_id") or payload.get("crew_task_id")
    if isinstance(project_id, str) and isinstance(task_id, str):
        return CrewExecutionTaskRef(project_id=project_id, task_id=task_id)
    return None


def _ref_from_subject(
    subject_ref: object,
    execution_input: dict[str, Any],
) -> CrewExecutionTaskRef | None:
    if not isinstance(subject_ref, str):
        return None
    parts = subject_ref.split(":")
    if len(parts) >= 3 and parts[0] in {"crew_task", "crew-task", "crew", "task"}:
        return CrewExecutionTaskRef(project_id=parts[1], task_id=":".join(parts[2:]))
    if len(parts) == 2 and parts[0] == "task":
        project_id = execution_input.get("project_id") or execution_input.get("crew_project_id")
        if isinstance(project_id, str):
            return CrewExecutionTaskRef(project_id=project_id, task_id=parts[1])
    return None


def _find_task(project: CrewProject, task_id: str) -> CrewTask | None:
    return next((task for task in project.tasks if task.id == task_id), None)


def _project_started(
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    before = _task_state(task)
    task.run_ref = event.execution_id
    return before != _task_state(task)


def _project_claimed(
    project: CrewProject,
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    before = _task_state(task)
    if task.status in ("assigned", "rework"):
        lifecycle.start_task(project, task.id)
    elif task.status in ("submitted", "in_review", "done"):
        return False
    elif task.status != "running":
        raise lifecycle.CrewLifecycleError(
            f"Cannot project claimed task {task.id!r}: status is {task.status!r}"
        )
    task.run_ref = event.execution_id
    if task.run_started_at is None:
        task.run_started_at = _event_time(event)
    return before != _task_state(task)


def _project_artifact(
    project: CrewProject,
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    before = _task_state(task)
    artifact = (
        event.payload.get("artifact")
        or event.payload.get("content")
        or event.payload.get("summary")
    )
    if not isinstance(artifact, str) or not artifact.strip():
        raise ValueError("artifact event must include non-empty artifact/content/summary")
    if task.status in ("assigned", "rework"):
        lifecycle.start_task(project, task.id)
    elif task.status != "running":
        raise lifecycle.CrewLifecycleError(
            f"Cannot project artifact task {task.id!r}: status is {task.status!r}"
        )
    task.run_ref = event.execution_id
    lifecycle.submit_task(project, task.id, artifact)
    task.run_started_at = None
    return before != _task_state(task)


def _project_blocked(
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    before = _task_state(task)
    if task.status in ("submitted", "in_review", "done"):
        return False
    reason = event.payload.get("reason") or event.payload.get("message") or "Agent execution blocked"
    task.status = "blocked"
    task.blocker = str(reason)
    task.run_ref = event.execution_id
    task.run_started_at = None
    return before != _task_state(task)


def _project_recovery_blocked(
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    before = _task_state(task)
    if task.status in ("submitted", "in_review", "done"):
        return False
    reason = event.payload.get("reason") or "manual recovery required"
    task.status = "blocked"
    task.blocker = str(reason)
    task.run_ref = event.execution_id
    task.run_started_at = None
    return before != _task_state(task)


def _project_retry_scheduled(
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    if task.status in ("submitted", "in_review", "done"):
        return False
    task.run_ref = event.execution_id
    return True


def _project_question(
    project: CrewProject,
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    if task.status in ("submitted", "in_review", "done"):
        return False
    if task.status in ("assigned", "rework"):
        lifecycle.start_task(project, task.id)
    elif task.status != "running":
        raise lifecycle.CrewLifecycleError(
            f"Cannot project question task {task.id!r}: status is {task.status!r}"
        )
    task.run_ref = event.execution_id
    if task.run_started_at is None:
        task.run_started_at = _event_time(event)
    return True


def _project_terminal_failed(
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    error_code = event.payload.get("error_code") or snapshot.last_error_code
    message = event.payload.get("message")
    reason = message or error_code or "Execution failed"
    return _block_if_open(task, event, str(reason))


def _project_terminal_cancelled(
    task: CrewTask,
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> bool:
    reason = event.payload.get("reason")
    message = "执行已取消"
    if reason:
        message = f"{message}: {reason}"
    return _block_if_open(task, event, message)


def _block_if_open(task: CrewTask, event: ExecutionOutboxEvent, reason: str) -> bool:
    before = _task_state(task)
    if task.status in ("submitted", "in_review", "done"):
        return False
    if task.status == "blocked":
        return False
    if task.status not in ("assigned", "running", "rework"):
        return False
    task.status = "blocked"
    task.blocker = reason
    task.run_ref = event.execution_id
    task.run_started_at = None
    return before != _task_state(task)


def _event_time(event: ExecutionOutboxEvent) -> str:
    return datetime.fromtimestamp(event.created_at, timezone.utc).isoformat()


def _task_state(task: CrewTask) -> tuple[Any, ...]:
    return (
        task.status,
        task.artifact,
        len(task.artifact_versions),
        task.blocker,
        task.run_ref,
        task.run_started_at,
    )


class _EffectBuilder:
    def __init__(
        self,
        project: CrewProject,
        task: CrewTask,
        event: ExecutionOutboxEvent,
        snapshot: ExecutionSnapshot,
    ) -> None:
        self.project = project
        self.task = task
        self.event = event
        self.snapshot = snapshot
        self.changed = False
        self._channels: list[ChannelMessage] = []
        self._notifications: list[Notification] = []

    def audit(self, event_type: str, payload: dict[str, Any]) -> str:
        self.project.audit_events.append(
            {
                "type": event_type,
                "run_id": self.project.id,
                "payload": payload,
                "created_at": _event_time(self.event),
            }
        )
        self.changed = True
        return f"#a{len(self.project.audit_events)}"

    def channel(
        self,
        *,
        kind: str,
        body: str,
        audit_ref: str,
        mentions: list[str] | None = None,
        author_kind: str = "anna",
        author_member_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self._channels.append(
            ChannelMessage(
                id=f"{self.project.id}:exec:{self.event.execution_id}:e{self.event.seq}:{kind}:{len(self._channels) + 1}",
                project_id=self.project.id,
                workspace_id=self.project.workspace_id,
                seq=0,
                author_kind=author_kind,
                author_member_id=author_member_id,
                worker_profile_ref=(
                    self.snapshot.worker_profile_ref
                    if author_kind == "worker"
                    else None
                ),
                caused_by_execution_id=(
                    self.event.execution_id if author_kind == "worker" else None
                ),
                kind=kind,
                body=body,
                task_id=self.task.id,
                run_ref=self.event.execution_id,
                mentions=[m for m in list(mentions or []) if m],
                audit_ref=audit_ref,
                payload=payload,
                created_at=_event_time(self.event),
            )
        )

    def notification(
        self,
        *,
        to: str,
        kind: str,
        title: str,
        task_id: str | None,
        ref: str,
    ) -> None:
        key = f"execution:{self.event.execution_id}:{self.event.seq}:{kind}:{task_id}:{to}:{ref}"
        self._notifications.append(
            Notification(
                id=f"note_exec_{self.event.execution_id}_{self.event.seq}_{kind}_{len(self._notifications) + 1}",
                workspace_id=self.project.workspace_id,
                to_member_id=to,
                kind=kind,
                title=title,
                deep_link=_deep_link(self.project.id, task_id),
                project_id=self.project.id,
                task_id=task_id,
                read_at=None,
                idempotency_key=key,
                created_at=_event_time(self.event),
            )
        )

    def notify_newly_active(self, blocked_before: set[str], audit_ref: str) -> None:
        for task in _newly_active(self.project, blocked_before):
            if task.is_gate and task.status == "todo":
                version = _reviewed_version(self.project, task)
                self._channels.append(
                    ChannelMessage(
                        id=f"{self.project.id}:exec:{self.event.execution_id}:e{self.event.seq}:review:{task.id}:v{version}",
                        project_id=self.project.id,
                        workspace_id=self.project.workspace_id,
                        seq=0,
                        author_kind="anna",
                        author_member_id=None,
                        kind="review",
                        body=f"“{task.title}”待评审",
                        task_id=task.id,
                        run_ref=self.event.execution_id,
                        mentions=[],
                        audit_ref=audit_ref,
                        payload={"review_version": version},
                        created_at=_event_time(self.event),
                    )
                )
                self.notification(
                    to=self.project.owner_user_id,
                    kind="review_due",
                    title=f"“{task.title}”待你评审。",
                    task_id=task.id,
                    ref=audit_ref,
                )
            elif not task.is_gate and task.assignee_member_id and task.status == "assigned":
                self.notification(
                    to=task.assignee_member_id,
                    kind="unlocked",
                    title=f"“{task.title}”已解锁，可以开始。",
                    task_id=task.id,
                    ref=audit_ref,
                )

    def to_projection(self) -> ProjectionEffects:
        return ProjectionEffects(
            changed=self.changed,
            channel_messages=self._channels,
            notifications=self._notifications,
        )


def _blocked_task_ids(project: CrewProject) -> set[str]:
    return {task.id for task in project.tasks if task.status == "blocked"}


def _newly_active(project: CrewProject, blocked_before: set[str]) -> list[CrewTask]:
    return [
        task
        for task in project.tasks
        if task.id in blocked_before and task.status != "blocked"
    ]


def _reviewed_version(project: CrewProject, gate: CrewTask) -> int:
    if not gate.reviews_task_id:
        return 0
    reviewed = _find_task(project, gate.reviews_task_id)
    if reviewed is None or not reviewed.artifact_versions:
        return 0
    return reviewed.artifact_versions[-1].version


def _deep_link(project_id: str, task_id: str | None = None) -> str:
    link = f"/crew/projects/{project_id}"
    if task_id:
        link += f"?task={task_id}"
    return link


def _question_text(event: ExecutionOutboxEvent) -> str:
    question = event.payload.get("question")
    if isinstance(question, str) and question.strip():
        return question.strip()
    return "需要人工补充信息。"


def _question_target(project: CrewProject, event: ExecutionOutboxEvent) -> str:
    target = event.payload.get("target")
    if isinstance(target, str):
        target = target.strip()
    else:
        target = ""
    if target and target in _known_member_ids(project):
        return target
    return project.owner_user_id


def _known_member_ids(project: CrewProject) -> set[str]:
    ids = {project.owner_user_id}
    ids.update(
        task.assignee_member_id
        for task in project.tasks
        if task.assignee_member_id
    )
    return ids


def _member_name(member_id: str | None) -> str:
    return member_id or "Worker"


def _memory_hits(
    event: ExecutionOutboxEvent,
    snapshot: ExecutionSnapshot,
) -> list[str]:
    for payload in (event.payload, snapshot.state.get("crew", {})):
        value = payload.get("memory_hits") if isinstance(payload, dict) else None
        if isinstance(value, list):
            return [str(item) for item in value]
    return []
