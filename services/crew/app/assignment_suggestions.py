from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Protocol

from pydantic import BaseModel, ConfigDict

from services.business.harness_client import (
    AssigneeDecisionRequest,
    AssigneeDecisionResult,
    HarnessHostError,
)
from services.crew.app.actors import SYSTEM_ANNA_ACTOR_ID
from services.crew.app.schemas import CrewProject, CrewTask
from services.identity.app.schemas import Account


QUESTION_VERSION = "crew-assignee-v1"
MAX_CANDIDATES = 20
MAX_STATE_BYTES = 16 * 1024
TTL = timedelta(minutes=5)
MAX_RECORDS = 128


class AssigneeHost(Protocol):
    async def decide_assignee_async(
        self, request: AssigneeDecisionRequest | dict[str, Any]
    ) -> AssigneeDecisionResult: ...


class SuggestionEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_role: str
    member_role: str | None
    member_kind: str | None


class AssignmentSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_id: str
    project_id: str
    task_id: str
    status: Literal["suggested", "abstained", "unavailable"]
    source: Literal["role_rule", "jev", "none"]
    member_id: str | None
    reason_code: str
    expires_at: str
    evidence: SuggestionEvidence
    meta: dict[str, Any] | None


@dataclass(frozen=True)
class SuggestionAdoptionContext:
    suggestion: AssignmentSuggestion
    input_hash: str
    candidate_facts: tuple[dict[str, str], ...]
    question_version: str = QUESTION_VERSION


@dataclass
class _Record:
    expires_at: datetime
    task: asyncio.Task[AssignmentSuggestion] | None = None
    loop: asyncio.AbstractEventLoop | None = None
    result: AssignmentSuggestion | None = None
    canceled: bool = False
    applied: bool = False
    input_hash: str | None = None
    candidate_facts: tuple[dict[str, str], ...] = ()


class AssignmentSuggestionService:
    """Short-lived, scope-bound collaborator for one Crew task suggestion."""

    def __init__(
        self,
        *,
        identity: Any,
        host_client: AssigneeHost | None,
        now: Any | None = None,
    ) -> None:
        self._identity = identity
        self._host_client = host_client
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._records: dict[tuple[str, str, str, str, str], _Record] = {}
        self._lock = threading.RLock()

    async def suggest(
        self,
        *,
        workspace_id: str,
        actor_user_id: str,
        project: CrewProject,
        task: CrewTask,
        decision_id: str,
    ) -> AssignmentSuggestion:
        key = (workspace_id, actor_user_id, project.id, task.id, decision_id)
        with self._lock:
            self._purge_locked()
            record = self._records.get(key)
            if record is None:
                if len(self._records) >= MAX_RECORDS:
                    raise SuggestionStoreFull
                record = _Record(expires_at=self._now() + TTL, loop=asyncio.get_running_loop())
                self._records[key] = record
                record.task = asyncio.create_task(
                    self._evaluate(
                        record=record,
                        workspace_id=workspace_id,
                        actor_user_id=actor_user_id,
                        project=project,
                        task=task,
                        decision_id=decision_id,
                    )
                )
            if record.result is not None:
                return record.result
            task_handle = record.task
        assert task_handle is not None
        result = await asyncio.shield(task_handle)
        with self._lock:
            if record.result is None:
                record.result = result
            return record.result

    async def cancel(
        self,
        *,
        workspace_id: str,
        actor_user_id: str,
        project_id: str,
        task_id: str,
        decision_id: str,
    ) -> str:
        return await asyncio.to_thread(
            self.cancel_sync,
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            task_id=task_id,
            decision_id=decision_id,
        )

    def cancel_sync(
        self,
        *,
        workspace_id: str,
        actor_user_id: str,
        project_id: str,
        task_id: str,
        decision_id: str,
    ) -> str:
        key = (workspace_id, actor_user_id, project_id, task_id, decision_id)
        with self._lock:
            self._purge_locked()
            record = self._records.get(key)
            if record is None:
                if len(self._records) >= MAX_RECORDS:
                    raise SuggestionStoreFull
                record = _Record(expires_at=self._now() + TTL, canceled=True)
                record.result = self._canceled_result(
                    project_id=project_id, task_id=task_id, decision_id=decision_id,
                    expires_at=record.expires_at,
                )
                self._records[key] = record
                return "canceled"
            if record.applied:
                return "already_applied"
            if record.result is not None and record.result.reason_code == "already_applied":
                return "already_applied"
            if record.canceled:
                return "canceled"
            record.canceled = True
            if record.result is not None:
                record.result = self._canceled_result(
                    project_id=project_id, task_id=task_id, decision_id=decision_id,
                    expires_at=record.expires_at,
                )
                return "canceled"
            task_handle = record.task
        if task_handle is not None:
            if record.loop is not None:
                record.loop.call_soon_threadsafe(task_handle.cancel)
            else:
                task_handle.cancel()
        return "canceled"

    def adopt(
        self,
        *,
        workspace_id: str,
        actor_user_id: str,
        project_id: str,
        task_id: str,
        decision_id: str,
        member_id: str,
        apply: Callable[[SuggestionAdoptionContext | None], Any],
        receipt_exists: Callable[[], bool] | None = None,
    ) -> Any:
        """Serialize cache validation, business commit, and applied marking."""
        key = (workspace_id, actor_user_id, project_id, task_id, decision_id)
        with self._lock:
            self._purge_locked()
            record = self._records.get(key)
            context = None
            durable_receipt = receipt_exists() if receipt_exists is not None else False
            if record is not None:
                if durable_receipt:
                    context = None
                elif record.canceled:
                    raise SuggestionCanceled
                elif (
                    not record.applied
                    and (
                        record.result is None
                        or record.result.status != "suggested"
                        or record.result.member_id != member_id
                        or record.input_hash is None
                    )
                ):
                    raise SuggestionConflict
                if not durable_receipt and not record.applied:
                    context = SuggestionAdoptionContext(
                        suggestion=record.result,
                        input_hash=record.input_hash,
                        candidate_facts=record.candidate_facts,
                    )
            result = apply(context)
            if record is not None:
                record.applied = True
            return result

    async def _evaluate(
        self,
        *,
        record: _Record,
        workspace_id: str,
        actor_user_id: str,
        project: CrewProject,
        task: CrewTask,
        decision_id: str,
    ) -> AssignmentSuggestion:
        try:
            members = self._identity.list_members(workspace_id)
            candidates = sorted(
                (
                    member
                    for member in members
                    if member.workspace_id == workspace_id
                    and member.kind in {"human", "agent"}
                    and member.id != SYSTEM_ANNA_ACTOR_ID
                ),
                key=lambda member: member.id,
            )
            record.input_hash = self._input_hash(project, task, candidates)
            record.candidate_facts = tuple(
                {"id": member.id, "role": member.role, "kind": member.kind}
                for member in candidates
            )
            if not candidates:
                return self._result(
                    project, task, decision_id, record.expires_at,
                    status="abstained", source="none", member_id=None,
                    reason_code="no_candidates", meta=None,
                )
            if len(candidates) > MAX_CANDIDATES:
                return self._result(
                    project, task, decision_id, record.expires_at,
                    status="unavailable", source="none", member_id=None,
                    reason_code="candidate_limit_exceeded", meta=None,
                )
            state = {
                "project_goal": project.goal_text,
                "task": {
                    "title": task.title,
                    "description": task.description,
                    "role_required": task.role_required,
                    "acceptance_criteria": task.acceptance_criteria,
                },
                "candidates": [
                    {"id": member.id, "role": member.role, "kind": member.kind}
                    for member in candidates
                ],
            }
            provider_state = {
                **state,
                "candidates": [
                    {**candidate, "id": f"c{index + 1}"}
                    for index, candidate in enumerate(state["candidates"])
                ],
            }
            if len(json.dumps(provider_state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_STATE_BYTES:
                return self._result(
                    project, task, decision_id, record.expires_at,
                    status="unavailable", source="none", member_id=None,
                    reason_code="input_too_large", meta=None,
                )
            exact = [member for member in candidates if member.role == task.role_required]
            if task.role_required and len(exact) == 1:
                member = exact[0]
                return self._result(
                    project, task, decision_id, record.expires_at,
                    status="suggested", source="role_rule", member_id=member.id,
                    reason_code="exact_role_match", meta=None,
                    member=member,
                )
            request = AssigneeDecisionRequest.model_validate(
                {
                    "schema_version": 1,
                    "decision_id": decision_id,
                    "workspace_id": workspace_id,
                    "actor_user_id": actor_user_id,
                    "project_id": project.id,
                    "task_id": task.id,
                    "input_hash": record.input_hash,
                    "question_version": QUESTION_VERSION,
                    "state": state,
                }
            )
            if self._host_client is None:
                return self._result(
                    project, task, decision_id, record.expires_at,
                    status="unavailable", source="none", member_id=None,
                    reason_code="jev_unavailable", meta=None,
                )
            host_result = await self._host_client.decide_assignee_async(request)
            return self._from_host_result(project, task, record.expires_at, host_result, candidates)
        except asyncio.CancelledError:
            return self._canceled_result(
                project_id=project.id, task_id=task.id, decision_id=decision_id,
                expires_at=record.expires_at,
            )
        except HarnessHostError as exc:
            return self._result(
                project, task, decision_id, record.expires_at,
                status="unavailable", source="none", member_id=None,
                reason_code=exc.code or "jev_unavailable", meta=None,
            )
        except ValueError:
            return self._result(
                project, task, decision_id, record.expires_at,
                status="unavailable", source="none", member_id=None,
                reason_code="invalid_request", meta=None,
            )
        finally:
            with self._lock:
                if record.canceled and record.result is None:
                    record.result = self._canceled_result(
                        project_id=project.id, task_id=task.id, decision_id=decision_id,
                        expires_at=record.expires_at,
                    )

    def _from_host_result(
        self,
        project: CrewProject,
        task: CrewTask,
        expires_at: datetime,
        host_result: AssigneeDecisionResult,
        candidates: list[Account],
    ) -> AssignmentSuggestion:
        member = next((item for item in candidates if item.id == host_result.member_id), None)
        indistinguishable = bool(
            member is not None
            and any(
                item.id != member.id
                and item.role == member.role
                and item.kind == member.kind
                for item in candidates
            )
        )
        member_id = (
            member.id
            if host_result.status == "suggested" and member and not indistinguishable
            else None
        )
        status = host_result.status if member_id is not None else (
            "abstained" if host_result.status == "suggested" else host_result.status
        )
        reason = host_result.reason_code if member_id is not None else (
            "insufficient_information"
            if indistinguishable
            else "invalid_member" if host_result.status == "suggested" else host_result.reason_code
        )
        return self._result(
            project, task, host_result.decision_id, expires_at,
            status=status, source=host_result.source, member_id=member_id,
            reason_code=reason, meta=host_result.meta.model_dump(mode="json"),
            member=member,
        )

    def _result(self, project, task, decision_id, expires_at, *, status, source, member_id, reason_code, meta, member=None):
        result = AssignmentSuggestion(
            decision_id=decision_id,
            project_id=project.id,
            task_id=task.id,
            status=status,
            source=source,
            member_id=member_id,
            reason_code=reason_code,
            expires_at=expires_at.isoformat(),
            evidence=SuggestionEvidence(
                task_role=task.role_required,
                member_role=member.role if member is not None else None,
                member_kind=member.kind if member is not None else None,
            ),
            meta=meta,
        )
        return result

    def _canceled_result(self, *, project_id, task_id, decision_id, expires_at):
        return AssignmentSuggestion(
            decision_id=decision_id,
            project_id=project_id,
            task_id=task_id,
            status="unavailable",
            source="none",
            member_id=None,
            reason_code="canceled",
            expires_at=expires_at.isoformat(),
            evidence=SuggestionEvidence(task_role="", member_role=None, member_kind=None),
            meta=None,
        )

    def _input_hash(self, project: CrewProject, task: CrewTask, candidates: list[Account]) -> str:
        return assignment_input_hash(project, task, candidates)

    def _purge_locked(self) -> None:
        now = self._now()
        self._records = {
            key: value for key, value in self._records.items()
            if value.expires_at > now
        }


def assignment_input_hash(
    project: CrewProject,
    task: CrewTask,
    candidates: list[Account] | tuple[dict[str, str], ...],
) -> str:
    candidate_facts = [
        {"id": member.id, "role": member.role, "kind": member.kind}
        if isinstance(member, Account) else dict(member)
        for member in candidates
    ]
    facts = {
            "workspace_id": project.workspace_id,
            "project_id": project.id,
            "project_owner_user_id": project.owner_user_id,
            "project_goal": project.goal_text,
            "task_id": task.id,
            "task_title": task.title,
            "task_description": task.description,
            "task_role_required": task.role_required,
            "task_acceptance_criteria": task.acceptance_criteria,
            "task_status": task.status,
            "task_assignee_member_id": task.assignee_member_id,
            "task_is_gate": task.is_gate,
            "task_depends_on": sorted(task.depends_on),
            "task_dependencies": [
                {"id": dependency.id, "status": dependency.status}
                for dependency in sorted(
                    (item for item in project.tasks if item.id in set(task.depends_on)),
                    key=lambda item: item.id,
                )
            ],
            "candidates": candidate_facts,
        }
    encoded = json.dumps(facts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class SuggestionStoreFull(RuntimeError):
    pass


class SuggestionExpired(RuntimeError):
    pass


class SuggestionCanceled(RuntimeError):
    pass


class SuggestionConflict(RuntimeError):
    pass
