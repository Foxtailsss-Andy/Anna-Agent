from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from services.crew.app import lifecycle
from services.crew.app.assignment_suggestions import (
    SuggestionAdoptionContext,
    assignment_input_hash,
)
from services.crew.app.actors import (
    SYSTEM_ANNA_ACTOR_ID,
    SYSTEM_ACTOR_IDS,
    is_system_actor,
)
from services.crew.app.agent_worker import CrewAgentError, CrewRunSkipped
from services.crew.app.schemas import (
    AssignmentProposal,
    ChannelMessage,
    CrewProject,
    CrewTask,
    Notification,
    TaskDraft,
)
from services.crew.app.showcase import SHOWCASE_SCENARIO_ID
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore

logger = logging.getLogger(__name__)

# directory(member_id) -> display_name | None. Optional; lets Anna's channel rows
# read with real names (e.g. "@Agent·Scribe"). Falls back to the member id when
# unavailable, so the crew service stays decoupled from identity in tests.
MemberDirectory = Callable[[str], str | None]

# member_kind(member_id) -> "human" | "agent" | None. Auto-run decides "is this an
# Agent worker?" by this lookup; None (unknown) is treated conservatively as NOT
# an agent, so we never auto-run a member we cannot classify (R-B #1).
MemberKind = Callable[[str], str | None]

# agent_dispatcher(project_id, task_id, workspace_id, actor_user_id,
# source_message_id, source_instruction) -> None. It must durably accept the run
# before returning; execution itself is driven by AgentExecutionRuntime.
AgentDispatcher = Callable[[str, str, str, str, str | None, str | None], None]

# propose_assignments(project) -> list of proposals (each carrying .task_id and
# .member_id | None). Auto-advance (R-B #3) uses this to role-match newly-ready
# downstream tasks. Wired to the deterministic role-matcher (fast, no model call
# in the transition path); None disables auto-advance (downstream stays claimable).
ProposeAssignments = Callable[[CrewProject], list]

# roster(workspace_id) -> the set of accepted mention ids in that workspace.
# Real members are notification/assignee targets; system actors (currently
# ``anna``) are coordination handles and must never become identity accounts.
# None keeps every legacy construction byte-identical: no filtering.
WorkspaceRoster = Callable[[str], set[str]]
MemberFacts = Callable[[str], list[dict[str, str]]]

# C3 意图确认卡:the task-intent祈使 regex family. A human-authored say that
# @-mentions someone AND hits one of these phrases spawns a background draft card
# (零模型意图门控;drafting itself may use the model). Case-insensitive; a
# superset of the plan's mandated minimum. Kept deliberately tight (imperative /
# request verbs) so ordinary chatter never fabricates a task card.
_INTENT_PATTERN = re.compile(
    r"新任务|新增任务|加个任务|加一个任务|建个任务|需要你|请你|麻烦你|帮我|"
    r"负责|去做|做一下|测试|回归|验收|"
    r"新增.{0,4}任务|加.{0,4}任务|指派|派给|安排给|放在.{1,16}(?:之前|前面|之后|后面)|"
    r"new mission|need you|please|task|test all|assign",
    re.IGNORECASE,
)
# A question asks Anna for facts unless it explicitly asks to create work:
# "谁在负责哪些任务？" must be answered, "能帮我新增一个任务吗？" is still a draft.
_QUESTION_PATTERN = re.compile(r"[?？]|吗|如何|怎么|怎样|什么|哪些|哪个|谁|多少|进展|状态", re.IGNORECASE)
_EXPLICIT_CREATE_PATTERN = re.compile(
    r"新任务|新增|新建|创建|加个任务|加一个任务|建个任务|添加.{0,6}任务|拆成|拆分|指派给|派给|"
    r"new (?:mission|task)|add (?:a )?task|create",
    re.IGNORECASE,
)

# Visible Anna failure rows (never silence): one row per (stage, source say).
# Only a short machine reason code reaches the channel — exception text may
# carry upstream detail and stays in the server log.
_ANNA_FAILURE_COPY = {
    "intent": "Anna 未能整理协调提案：{code}",
    "answer": "Anna 暂时无法回答：{code}",
}
_SAFE_REASON_CODE = re.compile(r"[a-z][a-z0-9_.:-]{0,63}")


def safe_reason_code(value: Any, default: str) -> str:
    """A channel-safe reason code: a short lowercase token, else ``default``."""
    if isinstance(value, str) and _SAFE_REASON_CODE.fullmatch(value):
        return value
    return default


class CrewPermissionError(Exception):
    """Raised when a non-owner attempts a Boss-only crew action (确认下推).

    Boss-ness is project ownership (the seed's own definition): the API maps
        this to 403, and the service enforces it too so the guard survives any
        caller."""


class SuggestionAdoptionError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class CrewProposalError(ValueError):
    """``crew.propose_changes`` arguments failed validation; ``code`` is public."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


# crew.propose_changes bounds (CONTRACTS.md §2).
_MAX_PROPOSED_TASKS = 5
_MAX_PROPOSED_ASSIGNMENTS = 5
_MAX_PROPOSAL_TEXT = 500
_DEFAULT_PROPOSED_ROLE = "产品"
# Statuses the normal ``assign`` path accepts for a non-gate task.
_ASSIGNABLE_STATUSES = frozenset({"todo", "blocked", "assigned"})


@dataclass(frozen=True)
class SuggestionAssignmentCommit:
    project: CrewProject
    first: bool
    project_id: str
    task_id: str
    member_id: str
    actor_user_id: str
    decision_id: str
    audit_ref: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _find_task(project: CrewProject, task_id: str) -> CrewTask | None:
    return next((t for t in project.tasks if t.id == task_id), None)


# ``insert_before`` may only re-order work that has not started yet.
_INSERT_BEFORE_STATUSES = frozenset({"todo", "blocked"})
# Short labels for why a proposed change was skipped at confirm time.
_TASK_STATUS_LABEL = {
    "todo": "待办", "assigned": "已指派", "running": "执行中", "submitted": "待审",
    "in_review": "评审中", "rework": "返工中", "done": "已完成", "blocked": "受阻",
}


def _depends_transitively(project: CrewProject, start_id: str, target_id: str) -> bool:
    """Whether ``start_id`` (directly or transitively) depends on ``target_id``."""
    depends_on = {t.id: t.depends_on for t in project.tasks}
    stack, seen = [start_id], set()
    while stack:
        current = stack.pop()
        if current == target_id:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(depends_on.get(current, []))
    return False


def _title_list(raw: Any) -> list[str] | None:
    """A proposal title list (stripped, deduped); None when malformed."""
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        return None
    values: list[str] = []
    for item in raw:
        text = item.strip()
        if text and text not in values:
            values.append(text)
    return values


def _proposal_cycle(project: CrewProject, drafts: list[TaskDraft]) -> str | None:
    """Title of a proposed task that would sit on a dependency cycle, if any."""
    new_titles = {d.title for d in drafts}
    existing = {t.title: t.id for t in project.tasks}
    edges: dict[str, list[str]] = {t.id: list(t.depends_on) for t in project.tasks}
    for draft in drafts:
        node = f"new:{draft.title}"
        edges[node] = [
            f"new:{dep}" if dep in new_titles else existing[dep] for dep in draft.depends_on
        ]
        for target in draft.insert_before:
            edges[existing[target]].append(node)
    for draft in drafts:
        start = f"new:{draft.title}"
        stack, seen = list(edges[start]), set()
        while stack:
            current = stack.pop()
            if current == start:
                return draft.title
            if current in seen:
                continue
            seen.add(current)
            stack.extend(edges.get(current, []))
    return None


def _deep_link(project_id: str, task_id: str | None = None) -> str:
    link = f"/crew/projects/{project_id}"
    if task_id:
        link += f"?task={task_id}"
    return link


def _assignment_receipt(
    project: CrewProject,
    *,
    task_id: str,
    actor_user_id: str,
    decision_id: str,
) -> dict[str, Any] | None:
    for event in project.audit_events:
        if event.get("type") != "crew.task.assign":
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict):
            continue
        if (
            payload.get("task_id") == task_id
            and payload.get("actor_user_id") == actor_user_id
            and payload.get("decision_id") == decision_id
        ):
            return payload
    return None


class CrewService:
    """Orchestrates CrewProject lifecycle: template → tasks → persist → audit.

    Every lifecycle transition is also the single source of truth for the project
    channel and member notifications: at the same call site where the audit event
    is appended, the transition derives its channel row(s) and notification(s)
    from the very same fact, tagged with ``audit_ref = "#a" + <audit seq>`` so the
    UI row and the audit entry correspond one-to-one. Nothing is fabricated.
    """

    def __init__(
        self,
        store: SQLiteCrewStore,
        audit: Any = None,
        directory: MemberDirectory | None = None,
        drafter: Any = None,
        member_kind: MemberKind | None = None,
        agent_dispatcher: AgentDispatcher | None = None,
        propose_assignments: ProposeAssignments | None = None,
        roster: WorkspaceRoster | None = None,
        member_facts: MemberFacts | None = None,
    ) -> None:
        self._store = store
        # audit is kept for interface compatibility but we write dicts directly
        # to project.audit_events to avoid coupling to AuditEvent model type.
        self._audit = audit
        self._directory = directory
        # B3: model-backed「+任务」drafting collaborator (CommandDraftingService).
        # None -> draft_tasks_from_message uses only the deterministic fallback.
        self._drafter = drafter
        # R-B auto-pilot collaborators (all optional; None = feature off, so every
        # legacy construction and test stays byte-identical). Injected in the API
        # layer under `auto_pilot` — see routes/crew.build_router.
        self._member_kind = member_kind
        self._agent_dispatcher = agent_dispatcher
        self._propose_assignments = propose_assignments
        # DEV-8: workspace roster source for ghost-mention filtering. None = no
        # filtering (legacy constructions unchanged).
        self._roster = roster
        self._member_facts = member_facts

    # ------------------------------------------------------------------
    # Project creation
    # ------------------------------------------------------------------

    def create_project(
        self,
        workspace_id: str,
        owner_user_id: str,
        goal_text: str,
        template_id: str,
    ) -> CrewProject:
        template = get_template(template_id)
        if template is None:
            raise ValueError(f"Template {template_id!r} unknown; no matching SOP template found")

        proj_seq = self._store.next_project_sequence()
        project_id = f"proj_{proj_seq}"

        def task_id(key: str) -> str:
            seq = self._store.next_task_sequence()
            return f"task_{seq}_{key}"

        project = lifecycle.instantiate_project(
            project_id=project_id,
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            goal_text=goal_text,
            template=template,
            task_id=task_id,
        )
        self._append_event(project, "crew.project.created", {
            "template_id": template_id,
            "goal_text": goal_text,
        })
        self._store.save_project(project)
        return project

    def create_project_ai(
        self,
        workspace_id: str,
        owner_user_id: str,
        goal_text: str,
        template_id: str,
        decomposition: Any,
    ) -> CrewProject:
        """Create a project whose DAG is refined by the model from the SOP template.

        ``decomposition.decompose`` falls back to the deterministic template when
        the model is unavailable, so this never fabricates or crashes.
        """
        template = get_template(template_id)
        if template is None:
            raise ValueError(f"Template {template_id!r} unknown; no matching SOP template found")

        project_id = f"proj_{self._store.next_project_sequence()}"

        def task_id(key: str) -> str:
            seq = self._store.next_task_sequence()
            return f"task_{seq}_{key}"

        bind_scope = getattr(decomposition, "bind_scope", None)
        if callable(bind_scope):
            bind_scope(project_id, workspace_id, owner_user_id)
        project = decomposition.decompose(
            project_id=project_id,
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            goal_text=goal_text,
            template=template,
            task_id=task_id,
        )
        self._append_event(project, "crew.project.created", {
            "template_id": template_id,
            "goal_text": goal_text,
            "mode": "ai",
        })
        self._store.save_project(project)
        return project

    def ensure_showcase(
        self,
        *,
        workspace_id: str,
        owner_user_id: str,
        members: list[Any],
        scenario_id: str = SHOWCASE_SCENARIO_ID,
        locale: str = "zh-CN",
    ) -> Any:
        """Ensure the built-in Crew showcase exists for this owner.

        The showcase is ordinary Crew data, but the seed/reset implementation is
        kept behind the service so routes and UI do not depend on store details.
        """
        from services.crew.app.showcase import CrewShowcaseService

        return CrewShowcaseService(self._store).ensure(
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            members=members,
            scenario_id=scenario_id,
            locale=locale,
        )

    # ------------------------------------------------------------------
    # Task transitions (load → mutate → audit + bridge → save → return)
    # ------------------------------------------------------------------

    def assign(self, project_id: str, task_id: str, member_id: str) -> CrewProject:
        project = self._load(project_id)
        previous = lifecycle.assign_task(project, task_id, member_id)
        # 同员重派 = 静默幂等:目标未变 → 不写审计 / 不发频道行 / 不发通知 / 不重跑
        #(重复点「认领 / 改派」到同一人不刷屏)。
        if previous == member_id:
            return project
        title = self._task_title(project, task_id)
        if previous is not None:
            # 接管 / 改派:未开工的任务被换人(assigned 就地换人,或 blocked 预派改派)。
            # 全程留痕——一行改派事件(@新 @旧)+ 双方各一条通知:新任受派、原任被转派。
            audit_ref = self._append_event(project, "crew.task.assign", {
                "task_id": task_id,
                "member_id": member_id,
                "previous_member_id": previous,
                "reassigned": True,
            })
            self._emit_channel(
                project, kind="event",
                body=f"“{title}”已改派给 @{self._name(member_id)}（原 @{self._name(previous)}）。",
                task_id=task_id, mentions=[member_id, previous], audit_ref=audit_ref,
            )
            self._emit_notification(
                project, to=member_id, kind="assigned",
                title=f"“{title}”已派给你。", task_id=task_id, ref=audit_ref,
            )
            self._emit_notification(
                project, to=previous, kind="assigned",
                title=f"“{title}”已转派给 @{self._name(member_id)}。",
                task_id=task_id, ref=audit_ref,
            )
        else:
            audit_ref = self._append_event(project, "crew.task.assign", {
                "task_id": task_id,
                "member_id": member_id,
            })
            self._emit_channel(
                project, kind="event",
                body=f"“{title}”已派给 @{self._name(member_id)}。",
                task_id=task_id, mentions=[member_id], audit_ref=audit_ref,
            )
            self._emit_notification(
                project, to=member_id, kind="assigned",
                title=f"“{title}”已派给你。", task_id=task_id, ref=audit_ref,
            )
        self._store.save_project(project)
        # R-B #1: an Agent (re)assigned to a READY task runs at once; a pre-assigned
        # (still-blocked) task is a no-op here and runs later when it unlocks.
        self._autorun(project, _find_task(project, task_id))
        return project

    def commit_from_suggestion(
        self,
        project_id: str,
        task_id: str,
        member_id: str,
        decision_id: str,
        actor_user_id: str,
        suggestion_context: SuggestionAdoptionContext | None = None,
        *,
        workspace_id: str | None = None,
    ) -> SuggestionAssignmentCommit:
        """Atomically adopt one server-held suggestion and return its commit."""
        outcome: dict[str, Any] = {}

        def mutate(project: CrewProject) -> bool:
            task = _find_task(project, task_id)
            if workspace_id is not None and project.workspace_id != workspace_id:
                raise SuggestionAdoptionError("suggestion_stale")
            receipt = _assignment_receipt(
                project, task_id=task_id, actor_user_id=actor_user_id, decision_id=decision_id
            )
            if receipt is not None:
                if receipt.get("member_id") == member_id:
                    outcome["duplicate"] = True
                    return False
                raise SuggestionAdoptionError("suggestion_conflict")
            if suggestion_context is None:
                raise SuggestionAdoptionError("suggestion_expired")
            suggestion = suggestion_context.suggestion
            if (
                suggestion.status != "suggested"
                or suggestion.decision_id != decision_id
                or suggestion.member_id != member_id
                or suggestion_context.question_version != "crew-assignee-v1"
            ):
                raise SuggestionAdoptionError("suggestion_conflict")
            if task is None or task.is_gate or task.status not in ("todo", "blocked"):
                raise SuggestionAdoptionError("suggestion_stale")
            if task.assignee_member_id is not None:
                raise SuggestionAdoptionError("suggestion_stale")
            current_facts = self._current_member_facts(project.workspace_id)
            selected = next((item for item in current_facts if item["id"] == member_id), None)
            if selected is None:
                raise SuggestionAdoptionError("suggestion_stale")
            if (
                selected.get("role") != suggestion.evidence.member_role
                or selected.get("kind") != suggestion.evidence.member_kind
                or assignment_input_hash(project, task, tuple(current_facts))
                != suggestion_context.input_hash
            ):
                raise SuggestionAdoptionError("suggestion_stale")
            lifecycle.assign_task(project, task_id, member_id)
            audit_ref = self._append_event(project, "crew.task.assign", {
                "task_id": task_id,
                "member_id": member_id,
                "decision_id": decision_id,
                "actor_user_id": actor_user_id,
                "source": suggestion.source,
                "input_hash": suggestion_context.input_hash,
                "question_version": suggestion_context.question_version,
                "decision_record_ref": decision_id,
            })
            outcome.update({"audit_ref": audit_ref, "first": True})
            return True

        updated = self._store.update_project(project_id, mutate)
        return SuggestionAssignmentCommit(
            project=updated,
            first=bool(outcome.get("first")),
            project_id=project_id,
            task_id=task_id,
            member_id=member_id,
            actor_user_id=actor_user_id,
            decision_id=decision_id,
            audit_ref=outcome.get("audit_ref", ""),
        )

    def assign_from_suggestion(
        self,
        project_id: str,
        task_id: str,
        member_id: str,
        decision_id: str,
        actor_user_id: str,
        suggestion_context: SuggestionAdoptionContext | None = None,
        *,
        workspace_id: str | None = None,
    ) -> CrewProject:
        commit = self.commit_from_suggestion(
            project_id,
            task_id,
            member_id,
            decision_id,
            actor_user_id,
            suggestion_context,
            workspace_id=workspace_id,
        )
        if commit.first:
            self.emit_suggestion_effects(commit)
        return commit.project

    def emit_suggestion_effects(self, commit: SuggestionAssignmentCommit) -> None:
        updated = commit.project
        task_id = commit.task_id
        member_id = commit.member_id
        actor_user_id = commit.actor_user_id
        decision_id = commit.decision_id
        task = _find_task(updated, task_id)
        title = task.title if task is not None else task_id
        audit_ref = commit.audit_ref
        try:
            self._emit_channel(
                updated,
                kind="event",
                body=f"“{title}”已派给 @{self._name(member_id)}。",
                task_id=task_id,
                mentions=[member_id],
                audit_ref=audit_ref,
                message_id=f"{updated.workspace_id}:{updated.id}:{task_id}:{actor_user_id}:{decision_id}",
            )
        except Exception:  # pragma: no cover - commit already succeeded
            logger.warning("suggestion assignment channel effect failed", exc_info=True)
        try:
            self._emit_notification(
                updated,
                to=member_id,
                kind="assigned",
                title=f"“{title}”已派给你。",
                task_id=task_id,
                ref=f"assignment:{updated.workspace_id}:{updated.id}:{task_id}:{actor_user_id}:{decision_id}",
            )
        except Exception:  # pragma: no cover - effects are independent
            logger.warning("suggestion assignment notification effect failed", exc_info=True)
        try:
            self._autorun(updated, task)
        except Exception:  # pragma: no cover - dispatch must not undo assignment
            logger.warning("suggestion assignment dispatch effect failed", exc_info=True)
        return None

    def assignment_receipt_exists(
        self, project_id: str, task_id: str, actor_user_id: str, decision_id: str
    ) -> bool:
        project = self._load(project_id)
        return _assignment_receipt(
            project,
            task_id=task_id,
            actor_user_id=actor_user_id,
            decision_id=decision_id,
        ) is not None

    def start(self, project_id: str, task_id: str) -> CrewProject:
        project = self._load(project_id)
        lifecycle.start_task(project, task_id)
        self._append_event(project, "crew.task.start", {"task_id": task_id})
        self._store.save_project(project)
        return project

    def submit(self, project_id: str, task_id: str, artifact: str) -> CrewProject:
        project = self._load(project_id)
        blocked_before = self._blocked_task_ids(project)
        lifecycle.submit_task(project, task_id, artifact)
        audit_ref = self._append_event(project, "crew.task.submit", {
            "task_id": task_id,
            "artifact": artifact,
        })
        task = _find_task(project, task_id)
        title = task.title if task else task_id
        producer = task.assignee_member_id if task else None
        self._emit_channel(
            project, kind="artifact",
            body=f"“{title}”已提交产物。",
            task_id=task_id,
            author_kind="member" if producer else "anna",
            author_member_id=producer,
            mentions=[producer] if producer else [],
            audit_ref=audit_ref,
        )
        self._notify_newly_active(project, blocked_before, audit_ref)
        self._store.save_project(project)
        # R-B #2: a pre-assigned Agent whose upstream just completed is now ready —
        # run it (a gate that unblocked is a no-op:「链路在评审门自然暂停」).
        self._autorun_tasks(project, self._newly_active(project, blocked_before))
        return project

    def review(
        self,
        project_id: str,
        task_id: str,
        approved: bool,
        comment: str | None = None,
    ) -> CrewProject:
        project = self._load(project_id)
        blocked_before = self._blocked_task_ids(project)
        lifecycle.review_task(project, task_id, approved=approved, comment=comment)
        audit_ref = self._append_event(project, "crew.task.review", {
            "task_id": task_id,
            "approved": approved,
            "comment": comment,
        })
        gate = _find_task(project, task_id)
        gate_title = gate.title if gate else task_id
        reviewed = (
            _find_task(project, gate.reviews_task_id)
            if gate and gate.reviews_task_id else None
        )

        newly_active = self._newly_active(project, blocked_before)  # only non-empty on approve
        if approved:
            if newly_active:
                names = "、".join(f"“{t.title}”" for t in newly_active)
                body = f"“{gate_title}”通过——{names}解锁。"
            else:
                body = f"“{gate_title}”通过。"
            self._emit_channel(
                project, kind="event", body=body, task_id=task_id, audit_ref=audit_ref,
            )
            # Fan review_due (newly-ready gates) + unlocked (pre-assigned tasks
            # that just activated) from the same fact — single source of truth.
            self._notify_newly_active(project, blocked_before, audit_ref)
            # R-B #3: auto-advance — role-match + assign the newly-ready UNASSIGNED
            # downstream tasks (a pre-assigned one keeps its assignee). Agent vs
            # human auto-RUN is settled after save by ``_autorun_tasks``.
            self._auto_advance(project, newly_active, audit_ref)
        else:
            quote = f"批注：“{comment}”" if comment else ""
            if reviewed:
                body = f"“{reviewed.title}”被驳回，退回返工。{quote}"
                mentions = [reviewed.assignee_member_id] if reviewed.assignee_member_id else []
            else:
                body = f"“{gate_title}”驳回。{quote}"
                mentions = []
            self._emit_channel(
                project, kind="event", body=body, task_id=task_id,
                mentions=mentions, audit_ref=audit_ref,
            )
            if reviewed and reviewed.assignee_member_id:
                self._emit_notification(
                    project, to=reviewed.assignee_member_id, kind="rejected",
                    title=f"“{reviewed.title}”被驳回，请返工。",
                    task_id=reviewed.id, ref=audit_ref,
                )
        self._store.save_project(project)
        if approved:
            # Auto-run every newly-ready agent producer — both the pre-assigned
            # ones (#2) and the just auto-assigned ones (#3, they now sit in
            # ``newly_active`` with an assignee). Humans are assigned, not run.
            self._autorun_tasks(project, newly_active)
        return project

    def run_agent(
        self,
        project_id: str,
        task_id: str,
        executor: Any,
        run_ref: str | None = None,
    ) -> tuple[CrewProject, Any]:
        """Execute a task via an Agent worker on the real ReAct engine (B2).

        The isolated read-only Worker Profile loop produces the deliverable, submitted
        through the same lifecycle/gate as a human's output; the produced run's
        ``run_ref`` links the task to its trace. Returns ``(project, result)``.

        Failure semantics (绝不假完成): if the Worker Profile fails or exhausts, the
        executor has already BLOCKED the task with a blocker reason and raised
        ``CrewAgentError`` — here we emit a 阻塞 channel event row + a blocked
        notification to the Boss, persist the blocked project, and re-raise so the
        background driver can journal the terminal error.
        """
        project = self._load(project_id)
        blocked_before = self._blocked_task_ids(project)
        try:
            updated, result = executor.run_task(project, task_id, run_ref=run_ref)
        except CrewRunSkipped:
            # C2 良性竞态:the task advanced past a runnable state before this run's
            # thread started. NO alarm — no「执行受阻」channel event, no blocked
            # notification, no state change, no persist. Re-raise so the background
            # driver journals a calm terminal (never a scary error frame).
            raise
        except CrewAgentError as exc:
            blocked = _find_task(project, task_id)
            title = blocked.title if blocked else task_id
            audit_ref = self._append_event(project, "crew.task.agent_blocked", {
                "task_id": task_id,
                "run_ref": run_ref,
                "reason": str(exc),
                "error_code": getattr(exc, "error_code", None),
                # B1b 命中审计:a blocked run is still a run — record which 共识
                # entries had been injected into its prompt.
                "memory_hits": list(getattr(exc, "memory_hits", []) or []),
            })
            self._emit_channel(
                project, kind="event",
                body=f"“{title}”执行受阻：{exc}",
                task_id=task_id, run_ref=run_ref, audit_ref=audit_ref,
            )
            self._emit_notification(
                project, to=project.owner_user_id, kind="blocked",
                title=f"“{title}”执行受阻，需要处理。", task_id=task_id, ref=audit_ref,
            )
            self._store.save_project(project)
            raise
        audit_ref = self._append_event(updated, "crew.task.agent_run", {
            "task_id": task_id,
            "artifact_chars": len(result.summary),
            "run_ref": run_ref,
            # B1b 命中审计:exactly the 共识 item ids injected into this run's
            # prompt (empty list when the project has none). API-readable via
            # the project's audit trail — F4's「注入共识 n 条」chips read this.
            "memory_hits": list(getattr(result, "memory_hits", []) or []),
        })
        task = _find_task(updated, task_id)
        title = task.title if task else task_id
        agent_id = task.assignee_member_id if task else None
        self._emit_channel(
            updated, kind="artifact",
            body=f"“{title}”已由 @{self._name(agent_id)} 产出。",
            task_id=task_id, run_ref=run_ref,
            author_kind="member" if agent_id else "anna",
            author_member_id=agent_id,
            mentions=[agent_id] if agent_id else [],
            audit_ref=audit_ref,
        )
        # 单一事实源:Agent 产出经内部 submit 亦可解锁下游评审门,同样通知 Boss。
        self._notify_newly_active(updated, blocked_before, audit_ref)
        self._store.save_project(updated)
        return updated, result

    # ------------------------------------------------------------------
    # Channel + notifications
    # ------------------------------------------------------------------

    def say(
        self,
        project_id: str,
        author_member_id: str,
        body: str,
        mentions: list[str] | None = None,
    ) -> ChannelMessage:
        """Post a member-authored message to the project channel.

        Not a lifecycle transition, so no audit event is written; ``@`` mentions
        still fan out mention notifications (deduped by the message id).

        Mentions are filtered to workspace members plus system actors. Ghost ids
        are silently dropped before the row is stored; system actors are kept as
        structured coordination handles, but never receive notifications.
        """
        project = self._load(project_id)
        mentions = self._filter_mentions(project, list(mentions or []))
        msg = self._emit_channel(
            project, kind="say", body=body,
            author_kind="member", author_member_id=author_member_id,
            mentions=mentions, audit_ref="",
        )
        for m in mentions:
            if m == author_member_id or is_system_actor(m):
                continue
            self._emit_notification(
                project, to=m, kind="mention",
                title=f"{self._name(author_member_id)} 在“{project.goal_text}”提到你。",
                task_id=None, ref=msg.id,
            )
        # R-B #2:「@Scribe 再改改」— @-mentioning an agent re-dispatches its open
        # task (a re-run supersedes the last artifact with a new version).
        self._redispatch_mentioned_agents(project, mentions, author_member_id, msg)
        return msg

    def should_answer_contextually(self, message: ChannelMessage) -> bool:
        """Whether a member's @Anna say is answered by a contextual Host task.

        Every member say that @-mentions Anna gets one visible Anna outcome:
        task intent → the coordination draft card; anything else → a contextual
        answer appended to this same channel (or a visible failure row). No
        second UI conversation is invented."""
        return (
            message.kind == "say"
            and message.author_kind == "member"
            and SYSTEM_ANNA_ACTOR_ID in message.mentions
            and not self.should_draft_intent(message)
        )

    def append_anna_message(
        self,
        project_id: str,
        body: str,
        *,
        task_id: str | None = None,
        run_ref: str | None = None,
    ) -> ChannelMessage:
        """Append a Host-produced contextual answer to the existing channel.

        Channel rows persist on their own; the project itself is unchanged, so
        it is not re-saved (a background answer must not race a concurrent
        lifecycle transition into a version conflict)."""
        project = self._load(project_id)
        return self._emit_channel(
            project,
            kind="say",
            body=body,
            task_id=task_id,
            run_ref=run_ref,
            author_kind="anna",
            author_member_id=None,
            audit_ref="",
        )

    def append_anna_failure(
        self,
        project_id: str,
        source_message_id: str,
        *,
        stage: str,
        reason_code: str,
    ) -> ChannelMessage:
        """Write ONE visible Anna failure row for a say Anna could not handle.

        ``stage`` is ``"intent"`` (coordination drafting) or ``"answer"``
        (contextual Host answer). Idempotent per ``(stage, source say)`` via a
        deterministic row id; only the safe reason code reaches the channel."""
        project = self._load(project_id)
        code = safe_reason_code(reason_code, f"{stage}_failed")
        return self._emit_channel(
            project,
            kind="event",
            body=_ANNA_FAILURE_COPY[stage].format(code=code),
            author_kind="anna",
            author_member_id=None,
            audit_ref="",
            payload={
                "anna_failure": {
                    "stage": stage,
                    "reason_code": code,
                    "source_message_id": source_message_id,
                }
            },
            message_id=self._anna_failure_id(project.id, stage, source_message_id),
        )

    @staticmethod
    def _anna_failure_id(project_id: str, stage: str, source_message_id: str) -> str:
        return f"{project_id}:anna-failure:{stage}:{source_message_id}"

    def _is_assignable_member(self, workspace_id: str, member_id: str) -> bool:
        """A real workspace member (never a system actor such as ``anna``).

        No roster wired keeps legacy constructions permissive; a roster lookup
        failure is treated conservatively (not a member)."""
        if not member_id or is_system_actor(member_id):
            return False
        if self._roster is None:
            return True
        try:
            return member_id in set(self._roster(workspace_id))
        except Exception:  # pragma: no cover - roster is best-effort
            logger.warning("crew roster lookup failed; member not validated", exc_info=True)
            return False

    def _filter_mentions(self, project: CrewProject, mentions: list[str]) -> list[str]:
        """Keep only real members plus system actors (order preserved)."""
        if self._roster is None:
            return mentions
        try:
            members = set(self._roster(project.workspace_id))
        except Exception:  # pragma: no cover - roster is best-effort, never breaks say
            logger.warning("crew roster lookup failed; skipping mention filter", exc_info=True)
            return mentions
        accepted = members | SYSTEM_ACTOR_IDS
        return [m for m in mentions if m in accepted]

    # ------------------------------------------------------------------
    # C3 · intent confirm card (Anna 监察:mention + 祈使 → draft card)
    # ------------------------------------------------------------------

    def should_draft_intent(self, message: ChannelMessage) -> bool:
        """Whether a persisted say row should spawn a background intent-draft card.

        True iff the row is a human-authored say to @Anna, and its body hits the
        task-intent regex family. @Human remains a notification only; @Worker is
        execution steering/dispatch only. DAG changes go through Anna's draft
        card and the existing confirm endpoint.
        """
        if message.kind != "say" or message.author_kind != "member":
            return False
        if self._is_agent(message.author_member_id):
            return False
        if SYSTEM_ANNA_ACTOR_ID not in message.mentions:
            return False
        body = message.body or ""
        if _QUESTION_PATTERN.search(body) and not _EXPLICIT_CREATE_PATTERN.search(body):
            return False
        return bool(_INTENT_PATTERN.search(body))

    def draft_intent_card(
        self, project_id: str, source_message: ChannelMessage
    ) -> ChannelMessage | None:
        """Distil a mention+intent say into a DRAFT command card authored by Anna.

        Reuses ``CommandDraftingService`` (model when configured, deterministic
        fallback otherwise) seeded with the say body + project context, and emits
        ONE ``kind="command"`` row whose payload carries the drafts PLUS
        ``origin="anna_coordination"`` + ``origin_message_id`` (the source say)
        + ``caused_by`` (structured provenance) + ``suggested_assignee`` (first
        real member mention, if any). Idempotent by
        ``origin_message_id`` (at most one card per say). DRAFT STATE ONLY: no
        task is created, no graph mutated, no audit event written — the command
        row is the only artifact. Adoption goes through the existing confirm
        endpoint unchanged (it reads ``payload["drafts"]``). Returns the row, or
        None when a card for this say already exists.

        Designed as a synchronous seam: the route schedules it on a thread so it
        never blocks the say response, while a test can invoke it directly.

        If drafting raises, the exception is logged and ONE Anna-authored
        failure row (``kind="event"``) is written instead of silence; that row
        also counts as this say's outcome, so a repeat call writes nothing."""
        # Idempotency: at most one intent card (or failure row) per source say.
        if self._store.get_channel_message(
            self._anna_failure_id(project_id, "intent", source_message.id)
        ) is not None:
            return None
        for existing in self._store.list_channel_messages(project_id):
            if (
                existing.kind == "command"
                and existing.payload
                and existing.payload.get("origin_message_id") == source_message.id
            ):
                return None

        project = self._load(project_id)
        roster_roles = sorted({t.role_required for t in project.tasks if t.role_required})
        try:
            if self._drafter is not None:
                bind_scope = getattr(
                    getattr(self._drafter, "harness_runtime", None), "bind_scope", None
                )
                if callable(bind_scope):
                    bind_scope(
                        project.id, project.workspace_id, source_message.author_member_id
                    )
                drafts = self._drafter.draft(
                    project_id=project.id,
                    goal_text=project.goal_text,
                    message_text=source_message.body,
                    roster_roles=roster_roles,
                    existing_tasks=self._drafting_task_facts(project),
                )
            else:
                from services.crew.app.command_drafting import deterministic_task_drafts
                drafts = deterministic_task_drafts(source_message.body)
        except Exception as exc:  # noqa: BLE001 - surfaced as a visible row below
            logger.warning(
                "crew intent drafting failed for %s/%s",
                project_id,
                source_message.id,
                exc_info=True,
            )
            return self.append_anna_failure(
                project_id,
                source_message.id,
                stage="intent",
                reason_code=safe_reason_code(
                    getattr(exc, "code", None), "intent_drafting_failed"
                ),
            )

        suggested = next(
            (mention for mention in source_message.mentions if not is_system_actor(mention)),
            None,
        )
        return self._emit_channel(
            project,
            kind="command",
            body=f"Anna 已整理协调提案，起草了 {len(drafts)} 项待确认。",
            author_kind="anna",
            author_member_id=None,
            audit_ref="",
            payload={
                "drafts": [d.model_dump() for d in drafts],
                "origin": "anna_coordination",
                "origin_message_id": source_message.id,
                # The confirm endpoint anchors on the command row's OWN id; this
                # mirror keeps provenance parity with「+任务」command rows.
                "created_from_message_id": source_message.id,
                "coordination_actor_id": SYSTEM_ANNA_ACTOR_ID,
                "caused_by": {
                    "type": "channel_message",
                    "message_id": source_message.id,
                    "author_member_id": source_message.author_member_id,
                    "mentions": list(source_message.mentions),
                },
                "suggested_assignee": suggested,
                "text": source_message.body,
            },
        )

    def list_channel(self, project_id: str) -> list[ChannelMessage]:
        return self._store.list_channel_messages(project_id)

    def get_channel_message(self, message_id: str) -> ChannelMessage | None:
        return self._store.get_channel_message(message_id)

    def list_notifications(
        self, workspace_id: str, member_id: str, unread_only: bool = False
    ) -> list[Notification]:
        return self._store.list_notifications(workspace_id, member_id, unread_only)

    def mark_read(self, notification_id: str, member_id: str) -> Notification | None:
        return self._store.mark_read(notification_id, member_id)

    # ------------------------------------------------------------------
    # Channel「+任务」command — two-phase (draft, then Boss-confirm) (B3)
    # ------------------------------------------------------------------

    def draft_tasks_from_message(
        self,
        project_id: str,
        text: str,
        author_member_id: str,
        source_message_id: str | None = None,
    ) -> tuple[ChannelMessage, list[TaskDraft]]:
        """Phase 1: distil a channel message into 1..N≤3 task drafts.

        The model drafts (roster-aware); absent/failed → the single deterministic
        fallback (title = text clipped to 40, role = 产品, no deps). A
        ``kind="command"`` draft row is dropped on the channel carrying the
        drafts + the source message id, so the composer can render the checklist
        and ``confirm_drafts`` can resolve the subset. Returns
        ``(command_row, drafts)`` — the row's id is the confirm anchor.
        """
        project = self._load(project_id)
        roster_roles = sorted({t.role_required for t in project.tasks if t.role_required})
        if self._drafter is not None:
            bind_scope = getattr(getattr(self._drafter, "harness_runtime", None), "bind_scope", None)
            if callable(bind_scope):
                bind_scope(project.id, project.workspace_id, author_member_id)
            drafts = self._drafter.draft(
                project_id=project.id,
                goal_text=project.goal_text,
                message_text=text,
                roster_roles=roster_roles,
                existing_tasks=self._drafting_task_facts(project),
            )
        else:
            # No model collaborator wired: the honest single-task fallback.
            from services.crew.app.command_drafting import deterministic_task_drafts
            drafts = deterministic_task_drafts(text)

        command = self._emit_channel(
            project,
            kind="command",
            body=f"起草了 {len(drafts)} 项任务，待确认下推。",
            author_kind="member",
            author_member_id=author_member_id,
            audit_ref="",
            payload={
                "drafts": [d.model_dump() for d in drafts],
                "created_from_message_id": source_message_id,
                "text": text,
            },
        )
        return command, drafts

    def propose_changes(
        self,
        *,
        workspace_id: str,
        run_id: str,
        tool_call_id: str | None,
        arguments: dict[str, Any],
    ) -> ChannelMessage:
        """Record Anna's ``crew.propose_changes`` as ONE confirmable command card.

        Validates the proposal against the current project (raising
        ``CrewProposalError`` with a public code) and writes a single
        ``kind="command"`` Anna row whose payload the existing confirm endpoint
        consumes. Proposal only: no task, graph edge or assignment changes and
        no audit event until the owner confirms. Idempotent by
        ``(run_id, tool_call_id)`` when a tool call id is given."""
        project_id = arguments.get("project_id")
        project = (
            self._store.get_project(project_id)
            if isinstance(project_id, str) and project_id.strip()
            else None
        )
        if project is None or project.workspace_id != workspace_id:
            raise CrewProposalError("project_not_found")
        message_id = (
            f"{project.id}:proposal:{run_id}:{tool_call_id}" if tool_call_id else None
        )
        if message_id is not None:
            existing_card = self._store.get_channel_message(message_id)
            if existing_card is not None:
                return existing_card

        raw_tasks = arguments.get("new_tasks")
        raw_assignments = arguments.get("assignments")
        raw_tasks = [] if raw_tasks is None else raw_tasks
        raw_assignments = [] if raw_assignments is None else raw_assignments
        if not isinstance(raw_tasks, list):
            raise CrewProposalError("invalid_new_tasks")
        if not isinstance(raw_assignments, list):
            raise CrewProposalError("invalid_assignments")
        if not raw_tasks and not raw_assignments:
            raise CrewProposalError("empty_proposal")
        if len(raw_tasks) > _MAX_PROPOSED_TASKS:
            raise CrewProposalError("too_many_new_tasks")
        if len(raw_assignments) > _MAX_PROPOSED_ASSIGNMENTS:
            raise CrewProposalError("too_many_assignments")
        summary = arguments.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            raise CrewProposalError("summary_required")
        summary = summary.strip()
        if len(summary) > _MAX_PROPOSAL_TEXT:
            raise CrewProposalError("summary_too_long")

        existing = {t.title: t for t in project.tasks}
        drafts: list[TaskDraft] = []
        for index, raw in enumerate(raw_tasks):
            if not isinstance(raw, dict):
                raise CrewProposalError(f"invalid_new_task:{index}")
            title = raw.get("title")
            depends_on = _title_list(raw.get("depends_on"))
            insert_before = _title_list(raw.get("insert_before"))
            assignee_id = raw.get("assignee_id")
            if (
                not isinstance(title, str)
                or not title.strip()
                or depends_on is None
                or insert_before is None
                or (assignee_id is not None and not isinstance(assignee_id, str))
            ):
                raise CrewProposalError(f"invalid_new_task:{index}")
            title = title.strip()
            if title in existing or any(d.title == title for d in drafts):
                raise CrewProposalError(f"duplicate_title:{title}")
            if assignee_id is not None and not self._is_assignable_member(
                project.workspace_id, assignee_id
            ):
                raise CrewProposalError(f"assignee_not_member:{assignee_id}")
            drafts.append(TaskDraft(
                title=title,
                role=str(raw.get("role") or "").strip() or _DEFAULT_PROPOSED_ROLE,
                depends_on=depends_on,
                acceptance=str(raw.get("acceptance") or "").strip(),
                insert_before=insert_before,
                assignee_id=assignee_id,
            ))
        new_titles = {d.title for d in drafts}
        for draft in drafts:
            for dep in draft.depends_on:
                if dep not in new_titles and dep not in existing:
                    raise CrewProposalError(f"unknown_task_title:{dep}")
            for target_title in draft.insert_before:
                target = existing.get(target_title)
                if target is None:
                    raise CrewProposalError(f"unknown_task_title:{target_title}")
                if target.status not in _INSERT_BEFORE_STATUSES:
                    raise CrewProposalError(f"insert_before_not_allowed:{target_title}")
        cycle_title = _proposal_cycle(project, drafts)
        if cycle_title is not None:
            raise CrewProposalError(f"dependency_cycle:{cycle_title}")

        assignments: list[AssignmentProposal] = []
        for index, raw in enumerate(raw_assignments):
            if not isinstance(raw, dict):
                raise CrewProposalError(f"invalid_assignment:{index}")
            task_id, member_id = raw.get("task_id"), raw.get("member_id")
            reason = raw.get("reason") or ""
            if (
                not isinstance(task_id, str)
                or not task_id.strip()
                or not isinstance(member_id, str)
                or not member_id.strip()
                or not isinstance(reason, str)
                or len(reason) > _MAX_PROPOSAL_TEXT
            ):
                raise CrewProposalError(f"invalid_assignment:{index}")
            task = _find_task(project, task_id)
            if task is None:
                raise CrewProposalError(f"unknown_task:{task_id}")
            if not self._is_assignable_member(project.workspace_id, member_id):
                raise CrewProposalError(f"assignee_not_member:{member_id}")
            if task.is_gate or task.status not in _ASSIGNABLE_STATUSES:
                raise CrewProposalError(f"assignment_not_allowed:{task_id}")
            if any(a.task_id == task_id for a in assignments):
                raise CrewProposalError(f"duplicate_assignment:{task_id}")
            assignments.append(
                AssignmentProposal(task_id=task_id, member_id=member_id, reason=reason.strip())
            )

        return self._emit_channel(
            project,
            kind="command",
            body=f"Anna 提议：{summary}",
            author_kind="anna",
            author_member_id=None,
            audit_ref="",
            payload={
                "drafts": [d.model_dump() for d in drafts],
                "assignments": [a.model_dump() for a in assignments],
                "origin": "anna_coordination",
                "source": {
                    "type": "workbench_run",
                    "run_id": run_id,
                    "tool_call_id": tool_call_id,
                },
                "text": summary,
                "suggested_assignee": None,
            },
            message_id=message_id,
        )

    def confirm_drafts(
        self,
        project_id: str,
        drafts: list[TaskDraft],
        confirmed_by: str,
        source_message_id: str | None = None,
        suggested_assignee: str | None = None,
        assignments: list[AssignmentProposal] | None = None,
    ) -> CrewProject:
        """Phase 2 (Boss-only): materialize a confirmed subset of a command card.

        Boss-ness = project ownership; a non-owner ``confirmed_by`` raises
        ``CrewPermissionError``. New tasks carry ``origin="channel"`` +
        ``created_from_message_id`` (provenance back to the command row) and
        resolve ``depends_on`` by title (against the confirmed drafts, then
        existing task titles). ``insert_before`` makes not-yet-started existing
        tasks wait for the new task. Per-draft ``assignee_id`` and the chosen
        ``assignments`` go through the normal ``assign`` path. Anything that
        cannot be applied is skipped and named on the confirmation row. Emits an
        「已确认·已下推」event row (+ a ``grown`` notification when tasks were
        created); the whole push is audited and idempotent per command row.
        """
        project = self._load(project_id)
        if confirmed_by != project.owner_user_id:
            raise CrewPermissionError("只有项目负责人可以确认下推任务")
        assignments = list(assignments or [])
        if not drafts and not assignments:
            return project

        # 幂等短路(终审 #3):一条命令行只下推一次。若已有任务的血缘指回同一
        # source_message_id,或该命令行已有确认审计(仅指派、无新任务的提议),
        # 直接返回现 project,不重复建任务 / 改派 / 频道行 / 通知。
        if source_message_id is not None and (
            any(t.created_from_message_id == source_message_id for t in project.tasks)
            or any(
                event.get("type") == "crew.channel.tasks_confirmed"
                and (event.get("payload") or {}).get("created_from_message_id")
                == source_message_id
                for event in project.audit_events
            )
        ):
            return project

        existing_by_title = {t.title: t.id for t in project.tasks}
        # First pass: mint an id + key per draft (dedupe by title, last wins).
        title_to_id: dict[str, str] = {}
        title_to_key: dict[str, str] = {}
        for draft in drafts:
            seq = self._store.next_task_sequence()
            title_to_id[draft.title] = f"task_{seq}_ch"
            title_to_key[draft.title] = f"ch_{seq}"

        new_tasks: list[CrewTask] = []
        seen: set[str] = set()
        for draft in drafts:
            if draft.title in seen:
                continue
            seen.add(draft.title)
            dep_ids: list[str] = []
            for dep_title in draft.depends_on:
                if dep_title in title_to_id and title_to_id[dep_title] != title_to_id[draft.title]:
                    dep_ids.append(title_to_id[dep_title])
                elif dep_title in existing_by_title:
                    dep_ids.append(existing_by_title[dep_title])
            new_tasks.append(CrewTask(
                id=title_to_id[draft.title],
                project_id=project.id,
                key=title_to_key[draft.title],
                title=draft.title,
                role_required=draft.role,
                status="todo" if not dep_ids else "blocked",
                depends_on=dep_ids,
                acceptance_criteria=draft.acceptance or None,
                origin="channel",
                created_from_message_id=source_message_id,
            ))

        existing_tasks = {t.title: t for t in project.tasks}
        project.tasks.extend(new_tasks)
        # ``insert_before``: each named EXISTING task now also waits for the new
        # task. Only not-yet-started targets (todo/blocked) are re-ordered; any
        # other target, an unknown title, or an edge that would close a cycle is
        # skipped and reported on the confirmation row (never silently dropped).
        drafts_by_title = {d.title: d for d in drafts}
        reordered: list[tuple[CrewTask, CrewTask]] = []  # (target, new task)
        skipped_order: list[tuple[str, str]] = []  # (title, reason label)
        for new_task in new_tasks:
            for target_title in drafts_by_title[new_task.title].insert_before:
                target = existing_tasks.get(target_title)
                if target is None:
                    skipped_order.append((target_title, "未找到"))
                elif target.status not in _INSERT_BEFORE_STATUSES:
                    skipped_order.append(
                        (target_title, _TASK_STATUS_LABEL.get(target.status, target.status))
                    )
                elif _depends_transitively(project, new_task.id, target.id):
                    skipped_order.append((target_title, "会形成循环依赖"))
                elif new_task.id not in target.depends_on:
                    target.depends_on.append(new_task.id)
                    # The new task is never done yet, so the target must wait.
                    target.status = "blocked"
                    reordered.append((target, new_task))
        # A dependency referenced by title may already be done — recompute so a
        # newly-added task with satisfied deps starts ready, not stuck blocked.
        lifecycle.recompute_readiness(project)

        # Assignment plan: per-draft assignees, then the chosen assignments.
        # Validated against the post-push graph; applied after save through the
        # normal ``assign`` path (channel row, notification, auto-pilot).
        planned: list[tuple[str, str]] = []  # (task_id, member_id)
        skipped_assign: list[tuple[str, str, str]] = []  # (title, member, reason)
        requested = [
            (task.id, drafts_by_title[task.title].assignee_id)
            for task in new_tasks
            if drafts_by_title[task.title].assignee_id
        ] + [(item.task_id, item.member_id) for item in assignments]
        for task_id, member_id in requested:
            task = _find_task(project, task_id)
            if task is None:
                skipped_assign.append((task_id, member_id, "任务不存在"))
            elif not self._is_assignable_member(project.workspace_id, member_id):
                skipped_assign.append((task.title, member_id, "成员无效"))
            elif task.is_gate:
                skipped_assign.append((task.title, member_id, "评审门不可指派"))
            elif task.status not in _ASSIGNABLE_STATUSES:
                skipped_assign.append(
                    (task.title, member_id, _TASK_STATUS_LABEL.get(task.status, task.status))
                )
            elif any(planned_task == task_id for planned_task, _ in planned):
                skipped_assign.append((task.title, member_id, "重复指派"))
            else:
                planned.append((task_id, member_id))

        # Persist the grown graph, then apply the assignments through the normal
        # ``assign`` path (its own channel row, notification, auto-pilot). The
        # confirmation row and audit below describe what was actually applied; an
        # assignment that raced a transition is reported as skipped, not claimed.
        self._store.save_project(project)
        applied: list[tuple[str, str]] = []
        for task_id, member_id in planned:
            try:
                self.assign(project_id, task_id, member_id)
                applied.append((task_id, member_id))
            except lifecycle.CrewLifecycleError:
                logger.warning(
                    "confirmed assignment of %s to %s raced a transition; skipped",
                    task_id,
                    member_id,
                )
                raced = _find_task(self._load(project_id), task_id)
                skipped_assign.append((raced.title if raced else task_id, member_id, "状态已变化"))
        project = self._load(project_id)

        audit_ref = self._append_event(project, "crew.channel.tasks_confirmed", {
            "count": len(new_tasks),
            "task_ids": [t.id for t in new_tasks],
            "created_from_message_id": source_message_id,
            "confirmed_by": confirmed_by,
            "insert_before": [
                {"task_id": target.id, "waits_for": new_task.id}
                for target, new_task in reordered
            ],
            "assignments": [
                {"task_id": task_id, "member_id": member_id} for task_id, member_id in applied
            ],
            "skipped": [
                {"kind": "insert_before", "title": title, "reason": reason}
                for title, reason in skipped_order
            ] + [
                {"kind": "assignment", "title": title, "member_id": member, "reason": reason}
                for title, member, reason in skipped_assign
            ],
        })
        if new_tasks:
            names = "、".join(f"“{t.title}”" for t in new_tasks)
            body = f"已确认下推 {len(new_tasks)} 项任务：{names}。"
        else:
            body = "已确认 Anna 提议。"
        if reordered:
            body += "顺序调整：" + "、".join(
                f"“{target.title}”需等待“{new_task.title}”完成" for target, new_task in reordered
            ) + "。"
        if skipped_order:
            body += "未调整顺序：" + "、".join(
                f"“{title}”（{reason}）" for title, reason in skipped_order
            ) + "。"
        if applied:
            body += f"已按提议指派 {len(applied)} 项。"
        if skipped_assign:
            body += "未执行指派：" + "、".join(
                f"“{title}”→@{self._name(member)}（{reason}）"
                for title, member, reason in skipped_assign
            ) + "。"
        self._emit_channel(
            project, kind="event",
            body=body,
            audit_ref=audit_ref,
            # Lets the channel mark the source card as confirmed even when it
            # created no task (an assignments-only proposal).
            payload=None if source_message_id is None else {"confirms_message_id": source_message_id},
        )
        if new_tasks:
            self._emit_notification(
                project, to=project.owner_user_id, kind="grown",
                title=f"{len(new_tasks)} 项任务已由频道生长并下推。",
                task_id=None, ref=audit_ref,
            )
        self._store.save_project(project)
        # R4b 采纳即派:意图卡的建议负责人(发言中 @ 指定)下推后立即派给首任务,
        # 走正规 assign 通道(频道事件 / 收件通知 / auto-pilot 全部自然触发——
        # 「采纳并开跑」的开跑就在这里)。幽灵成员静默跳过;状态竞态导致不可派时
        # 保持「已下推未派」,确认本身不失败。草案自带 assignee_id 时以草案为准。
        if (
            suggested_assignee
            and new_tasks
            and not drafts_by_title[new_tasks[0].title].assignee_id
        ):
            valid = True
            if self._roster is not None:
                try:
                    valid = suggested_assignee in set(self._roster(project.workspace_id))
                except Exception:  # pragma: no cover - roster best-effort,不因它拒派
                    valid = True
            if valid:
                try:
                    return self.assign(project_id, new_tasks[0].id, suggested_assignee)
                except lifecycle.CrewLifecycleError:
                    logger.warning(
                        "intent adopt: first task not assignable; left unassigned",
                    )
        return project

    def notify_approval(
        self,
        *,
        workspace_id: str,
        to_member_id: str,
        run_id: str,
        step: str,
        title: str,
        deep_link: str,
    ) -> bool:
        """Append an idempotent reimbursement ``approval`` notification (B3).

        Deduped by ``approval:{run_id}:{step}:{to_member_id}`` — the same
        awaiting-approval run never re-notifies a Boss across repeated projection
        reads. Returns True on a fresh insert."""
        note = Notification(
            id=f"note_{self._store.next_notification_seq()}",
            workspace_id=workspace_id,
            to_member_id=to_member_id,
            kind="approval",
            title=title,
            deep_link=deep_link,
            project_id=None,
            task_id=None,
            read_at=None,
            idempotency_key=f"approval:{run_id}:{step}:{to_member_id}",
            created_at=_now(),
        )
        return self._store.append_notification(note)

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def list_workspace_projects(self, workspace_id: str) -> list[CrewProject]:
        """Every project in the workspace (all owners) — the inbox's task span."""
        return self._store.list_all_projects(workspace_id)

    def get_project(self, project_id: str) -> CrewProject | None:
        return self._store.get_project(project_id)

    def list_projects(
        self, workspace_id: str, owner_user_id: str
    ) -> list[CrewProject]:
        return self._store.list_projects(workspace_id, owner_user_id)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _load(self, project_id: str) -> CrewProject:
        project = self._store.get_project(project_id)
        if project is None:
            raise ValueError(f"Project {project_id!r} not found")
        return project

    @staticmethod
    def _drafting_task_facts(project: CrewProject) -> list[dict[str, str]]:
        """Existing tasks as the drafter sees them (title, role, status)."""
        return [
            {"title": t.title, "role": t.role_required, "status": t.status}
            for t in project.tasks
        ]

    def _current_member_facts(self, workspace_id: str) -> list[dict[str, str]]:
        if self._member_facts is None:
            return []
        facts = self._member_facts(workspace_id)
        return sorted(
            [
                {"id": item["id"], "role": item["role"], "kind": item["kind"]}
                for item in facts
                if item.get("kind") in {"human", "agent"} and item.get("id") != SYSTEM_ANNA_ACTOR_ID
            ],
            key=lambda item: item["id"],
        )

    @staticmethod
    def _blocked_task_ids(project: CrewProject) -> set[str]:
        """Snapshot of blocked tasks BEFORE a transition — the readiness baseline.

        A task that leaves this set after the transition (recompute) just
        unblocked: a gate → review_due to the Boss; a pre-assigned task → an
        unlocked notification to its waiting assignee."""
        return {t.id for t in project.tasks if t.status == "blocked"}

    @staticmethod
    def _newly_active(project: CrewProject, blocked_before: set[str]) -> list[CrewTask]:
        """Tasks that were blocked before the transition and no longer are."""
        return [
            t for t in project.tasks
            if t.id in blocked_before and t.status != "blocked"
        ]

    def _task_title(self, project: CrewProject, task_id: str) -> str:
        task = _find_task(project, task_id)
        return task.title if task else task_id

    def _name(self, member_id: str | None) -> str:
        if not member_id:
            return ""
        if self._directory is not None:
            try:
                name = self._directory(member_id)
            except Exception:  # pragma: no cover - directory is best-effort
                name = None
            if name:
                return name
        return member_id

    def _emit_channel(
        self,
        project: CrewProject,
        *,
        kind: str,
        body: str,
        task_id: str | None = None,
        run_ref: str | None = None,
        mentions: list[str] | None = None,
        audit_ref: str = "",
        author_kind: str = "anna",
        author_member_id: str | None = None,
        payload: dict[str, Any] | None = None,
        message_id: str | None = None,
    ) -> ChannelMessage:
        # An explicit ``message_id`` makes the row idempotent: if one already
        # exists (e.g. the review row for this gate+version), return it without
        # minting a new seq or duplicating the chronicle.
        if message_id is not None:
            existing = self._store.get_channel_message(message_id)
            if existing is not None:
                return existing
        seq = self._store.next_channel_seq(project.id)
        msg = ChannelMessage(
            id=message_id or f"{project.id}:m{seq}",
            project_id=project.id,
            workspace_id=project.workspace_id,
            seq=seq,
            author_kind=author_kind,
            author_member_id=author_member_id,
            kind=kind,
            body=body,
            task_id=task_id,
            run_ref=run_ref,
            mentions=list(mentions or []),
            audit_ref=audit_ref,
            payload=payload,
            created_at=_now(),
        )
        self._store.append_channel_message(msg)
        return msg

    def _emit_notification(
        self,
        project: CrewProject,
        *,
        to: str,
        kind: str,
        title: str,
        task_id: str | None,
        ref: str,
    ) -> Notification:
        note = Notification(
            id=f"note_{self._store.next_notification_seq()}",
            workspace_id=project.workspace_id,
            to_member_id=to,
            kind=kind,
            title=title,
            deep_link=_deep_link(project.id, task_id),
            project_id=project.id,
            task_id=task_id,
            read_at=None,
            # The recipient (``to``) is part of the key: a single event fanned to
            # several recipients (e.g. a say @-mentioning two members) must notify
            # EACH of them. Without it the second recipient collides with the
            # first on the same (kind, task_id, ref) and is silently deduped.
            idempotency_key=f"{kind}:{task_id}:{to}:{ref}",
            created_at=_now(),
        )
        self._store.append_notification(note)
        return note

    def _emit_review_row(self, project: CrewProject, gate: CrewTask, audit_ref: str) -> None:
        """Drop the ``kind="review"`` chronicle row backing the design's 评审卡 (B4).

        A gate that just became reviewable is a server-side fact (previously the
        channel produced no review row, so the review card had nothing behind it).
        The row names its review target (producer title + version) and is
        idempotent per gate + reviewed version: a rework re-submit re-arms the gate
        and adds a fresh v2 row, but a repeat activation for the same version does
        not duplicate. Retained after the review decision (编年史不删)."""
        reviewed = (
            _find_task(project, gate.reviews_task_id) if gate.reviews_task_id else None
        )
        version = (
            reviewed.artifact_versions[-1].version
            if reviewed and reviewed.artifact_versions else 0
        )
        target = f" · 对象 · {reviewed.title} v{version}" if reviewed else ""
        self._emit_channel(
            project, kind="review",
            body=f"“{gate.title}”待评审{target}",
            task_id=gate.id, audit_ref=audit_ref,
            message_id=f"{project.id}:review:{gate.id}:v{version}",
        )

    def _notify_newly_active(
        self, project: CrewProject, blocked_before: set[str], audit_ref: str
    ) -> None:
        """Fan notifications for every task that just unblocked (single fact).

        - a review gate → a ``kind="review"`` chronicle row + ``review_due`` to the
          Boss (it needs reviewing);
        - a pre-assigned non-gate task → ``unlocked`` to its assignee (their
          queued work is now startable). An unassigned task that merely became
          ready-to-claim gets no notification (nobody to tell yet)."""
        for t in self._newly_active(project, blocked_before):
            if t.is_gate and t.status == "todo":
                self._emit_review_row(project, t, audit_ref)
                self._emit_notification(
                    project, to=project.owner_user_id, kind="review_due",
                    title=f"“{t.title}”待你评审。", task_id=t.id, ref=audit_ref,
                )
            elif not t.is_gate and t.assignee_member_id and t.status == "assigned":
                self._emit_notification(
                    project, to=t.assignee_member_id, kind="unlocked",
                    title=f"“{t.title}”已解锁，可以开始。", task_id=t.id, ref=audit_ref,
                )

    # ------------------------------------------------------------------
    # R-B · Agent auto-trigger + auto-advance (loop-thread transition hooks)
    # ------------------------------------------------------------------

    def _is_agent(self, member_id: str | None) -> bool:
        """Whether a member is an Agent worker (kind=="agent").

        Conservative by design (R-B #1): no kind lookup wired, or a lookup that
        returns None/raises → NOT an agent, so we never auto-run a member we
        cannot classify."""
        if not member_id or self._member_kind is None:
            return False
        try:
            return self._member_kind(member_id) == "agent"
        except Exception:  # pragma: no cover - lookup is best-effort
            return False

    def _autorun(self, project: CrewProject, task: CrewTask | None) -> None:
        """Fire-and-forget: enqueue a background run for a READY agent task.

        Guards make this idempotent and safe to call at any hook: a gate, a
        non-agent assignee, or a task not in a runnable (assigned|rework) state is
        a no-op; durable execution idempotency/active-subject guards stop a
        second overlapping run. Dispatch failures never break the originating
        transition."""
        if self._agent_dispatcher is None or task is None or task.is_gate:
            return
        if task.status not in ("assigned", "rework"):
            return
        if not self._is_agent(task.assignee_member_id):
            return
        try:
            self._call_agent_dispatcher(
                project,
                task,
                project.owner_user_id,
                None,
                None,
            )
        except Exception:  # pragma: no cover - dispatch must not break a transition
            logger.warning(
                "crew auto-run dispatch failed for task %s", task.id, exc_info=True
            )

    def _autorun_tasks(self, project: CrewProject, tasks: list[CrewTask]) -> None:
        for task in tasks:
            self._autorun(project, task)

    def _auto_advance(
        self, project: CrewProject, newly_ready: list[CrewTask], audit_ref: str
    ) -> list[CrewTask]:
        """Role-match + assign the newly-ready UNASSIGNED downstream tasks (R-B #3).

        Only touches tasks with no assignee (idempotent: a task keeps its assignee
        once set — a pre-assigned or already-assigned task is never overwritten).
        A gate is never auto-assigned (it awaits the Boss's review). Each assignment
        drops the same event row + assigned notification a manual assign would, so
        the channel/inbox stay a single source of truth. Agent vs human auto-RUN is
        decided later by ``_autorun`` — here we only place the assignee."""
        if self._propose_assignments is None:
            return []
        targets = [
            t for t in newly_ready
            if not t.is_gate and t.assignee_member_id is None and t.status == "todo"
        ]
        if not targets:
            return []
        try:
            proposals = self._propose_assignments(project)
        except Exception:  # pragma: no cover - matcher is best-effort
            logger.warning("crew auto-advance matching failed", exc_info=True)
            return []
        member_by_task = {
            p.task_id: p.member_id
            for p in proposals
            if getattr(p, "member_id", None)
        }
        assigned: list[CrewTask] = []
        for task in targets:
            member_id = member_by_task.get(task.id)
            if not member_id:
                continue  # no role match → stays claimable (零捏造:不硬派)
            lifecycle.assign_task(project, task.id, member_id)
            self._emit_channel(
                project, kind="event",
                body=f"“{task.title}”已按角色自动指派给 @{self._name(member_id)}。",
                task_id=task.id, mentions=[member_id], audit_ref=audit_ref,
            )
            self._emit_notification(
                project, to=member_id, kind="assigned",
                title=f"“{task.title}”已派给你。", task_id=task.id, ref=audit_ref,
            )
            assigned.append(task)
        return assigned

    def _redispatch_mentioned_agents(
        self,
        project: CrewProject,
        mentions: list[str],
        author_member_id: str,
        source_message: ChannelMessage,
    ) -> None:
        """@-mentioning an agent re-dispatches its open task in this project (R-B #2).

        「@Scribe 再改改」→ re-run the agent's assigned|rework task (a re-run
        overwrites the previous artifact into a new version). Only fires for an
        agent (not a human), and only when that agent actually holds an open
        (assigned|rework, non-gate) task here."""
        if self._agent_dispatcher is None:
            return
        for member_id in mentions:
            if member_id == author_member_id or not self._is_agent(member_id):
                continue
            for task in project.tasks:
                if (
                    task.assignee_member_id == member_id
                    and not task.is_gate
                    and task.status in ("assigned", "rework", "running")
                ):
                    self._dispatch_agent_from_message(
                        project,
                        task,
                        author_member_id,
                        source_message,
                    )

    def _dispatch_agent_from_message(
        self,
        project: CrewProject,
        task: CrewTask,
        author_member_id: str,
        source_message: ChannelMessage,
    ) -> None:
        if self._agent_dispatcher is None:
            return
        self._call_agent_dispatcher(
            project,
            task,
            author_member_id,
            source_message.id,
            source_message.body,
        )

    def _call_agent_dispatcher(
        self,
        project: CrewProject,
        task: CrewTask,
        actor_user_id: str,
        source_message_id: str | None,
        source_instruction: str | None,
    ) -> None:
        assert self._agent_dispatcher is not None
        self._agent_dispatcher(
            project.id,
            task.id,
            project.workspace_id,
            actor_user_id,
            source_message_id,
            source_instruction,
        )

    def _append_event(
        self, project: CrewProject, event_type: str, payload: dict[str, Any]
    ) -> str:
        """Append an audit entry; return its ``audit_ref`` ("#a" + 1-based seq)."""
        event: dict[str, Any] = {
            "type": event_type,
            "run_id": project.id,
            "payload": payload,
            "created_at": _now(),
        }
        project.audit_events.append(event)
        return f"#a{len(project.audit_events)}"
