from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from services.crew.app.schemas import (
    ArtifactVersion,
    CrewProject,
    CrewTask,
    SopTemplate,
)


class CrewLifecycleError(Exception):
    """Raised on illegal task lifecycle transitions."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def instantiate_project(
    *,
    project_id: str,
    workspace_id: str,
    owner_user_id: str,
    goal_text: str,
    template: SopTemplate,
    task_id: Callable[[str], str],
) -> CrewProject:
    """Turn a SopTemplate into a CrewProject with a concrete task DAG."""
    # First pass: build key -> generated id mapping
    key_to_id: dict[str, str] = {}
    for spec in template.tasks:
        key_to_id[spec.key] = task_id(spec.key)

    tasks: list[CrewTask] = []
    for spec in template.tasks:
        tid = key_to_id[spec.key]
        dep_ids = [key_to_id[dep_key] for dep_key in spec.depends_on]
        reviews_task_id = key_to_id[spec.reviews] if spec.reviews else None
        # Tasks with no deps start ready (todo); others start blocked
        initial_status = "todo" if not dep_ids else "blocked"
        tasks.append(CrewTask(
            id=tid,
            project_id=project_id,
            key=spec.key,
            title=spec.title,
            role_required=spec.role_required,
            status=initial_status,
            depends_on=dep_ids,
            is_gate=spec.is_gate,
            reviews_task_id=reviews_task_id,
            acceptance_criteria=spec.acceptance_criteria,
        ))

    return CrewProject(
        id=project_id,
        workspace_id=workspace_id,
        owner_user_id=owner_user_id,
        goal_text=goal_text,
        sop_template_id=template.id,
        tasks=tasks,
    )


def _get_task(project: CrewProject, task_id: str) -> CrewTask:
    for t in project.tasks:
        if t.id == task_id:
            return t
    raise CrewLifecycleError(f"Task {task_id!r} not found in project {project.id!r}")


def _has_downstream_gate(project: CrewProject, task: CrewTask) -> bool:
    """True if some review gate reviews this task (``reviews_task_id == task.id``).

    A producer WITH a downstream gate submits to ``submitted`` (待审) and only
    reaches ``done`` when that gate is approved; one WITHOUT (e.g. the「验收合并」
    endpoint) lands ``done`` directly — nothing would ever clear a hung submitted."""
    return any(g.is_gate and g.reviews_task_id == task.id for g in project.tasks)


def _deps_satisfied(project: CrewProject, task: CrewTask) -> bool:
    """Whether ``task``'s dependencies are met.

    A GATE's upstream is satisfied by ``submitted`` OR ``done`` — the gate becomes
    reviewable the moment the work it reviews is submitted. Every OTHER task needs
    its deps ``done``: a submitted-but-unapproved producer must NOT push work past
    its gate (下推必须过门)."""
    ok = {"submitted", "done"} if task.is_gate else {"done"}
    status_by_id = {t.id: t.status for t in project.tasks}
    return all(status_by_id.get(dep_id) in ok for dep_id in task.depends_on)


def recompute_readiness(project: CrewProject) -> None:
    """Flip any blocked task whose dependencies are satisfied to a ready state.

    Gate-aware (see ``_deps_satisfied``): a gate arms on a ``submitted`` upstream;
    a plain task waits for ``done``. A blocked task that was PRE-assigned (an
    assignee set while still blocked — the「先派好整队」workflow) activates straight
    to ``assigned`` when it unblocks; an unassigned one becomes ``todo`` (ready to
    claim). This is what makes the inbox's「排队中」(assigned-but-not-ready) real and
    lets the review unlock fan a ``unlocked`` notification to the waiting assignee."""
    for task in project.tasks:
        if task.status == "blocked" and _deps_satisfied(project, task):
            task.status = "assigned" if task.assignee_member_id else "todo"


def assign_task(project: CrewProject, task_id: str, member_id: str) -> str | None:
    """Assign — or REASSIGN (接管/改派) — a member to a task; return the PREVIOUS assignee.

    ``todo`` (ready) → ``assigned``. A ``blocked`` task may be PRE-assigned (the
    Boss lines up the whole team up front): the assignee is recorded but the task
    STAYS blocked until its deps clear, at which point ``recompute_readiness``
    activates it to ``assigned`` directly. An ``assigned`` (未开工) task may be
    RE-assigned in place — 接管 by another member — with the assignee replaced and
    the status kept ``assigned``; a task past ``assigned`` (running/submitted/…) is
    NOT silently takeable (the guard rejects it; the API surfaces a friendly 409
    pointing to 频道协调). A GATE is never assignable — its reviewer is fixed as the
    project owner (评审门评审人固定为负责人).

    Returns the PREVIOUS ``assignee_member_id`` (str | None) so the caller can tell
    a reassignment (a different, non-None previous) from a fresh assign and record
    留痕 for BOTH the new and the previous assignee."""
    task = _get_task(project, task_id)
    if task.is_gate:
        raise CrewLifecycleError(
            f"Task {task_id!r} is a gate task; gates are not assignable"
        )
    if task.status not in ("todo", "blocked", "assigned"):
        raise CrewLifecycleError(
            f"Cannot assign task {task_id!r}: status is {task.status!r}, "
            "expected 'todo', 'blocked' or 'assigned'"
        )
    previous = task.assignee_member_id
    task.assignee_member_id = member_id
    if task.status == "todo":
        task.status = "assigned"
    return previous


def start_task(project: CrewProject, task_id: str) -> None:
    """Move task from assigned to running."""
    task = _get_task(project, task_id)
    if task.is_gate:
        raise CrewLifecycleError(
            f"Task {task_id!r} is a gate task; gates are reviewed, not started"
        )
    # rework tasks can be started directly (no assignee check needed again)
    if task.status == "rework":
        task.status = "running"
        return
    if task.status != "assigned":
        raise CrewLifecycleError(
            f"Cannot start task {task_id!r}: status is {task.status!r}, expected 'assigned'"
        )
    if not _deps_satisfied(project, task):
        raise CrewLifecycleError(
            f"Cannot start task {task_id!r}: not all dependencies are done"
        )
    task.status = "running"


def submit_task(project: CrewProject, task_id: str, artifact: str) -> None:
    """Submit a completed artifact for a non-gate task (B4: versioned + 待审态).

    Appends the artifact as the next ``ArtifactVersion`` (1-based) and mirrors it
    into the flat ``artifact`` field. A producer WITH a downstream review gate
    lands ``submitted`` (待审 — done only when the gate approves); one WITHOUT lands
    ``done`` directly. Either way, readiness is recomputed (a submitted upstream
    arms its gate; a done upstream clears a plain dependent)."""
    task = _get_task(project, task_id)
    if task.status not in ("running", "rework"):
        raise CrewLifecycleError(
            f"Cannot submit task {task_id!r}: status is {task.status!r}, expected 'running' or 'rework'"
        )
    if task.is_gate:
        raise CrewLifecycleError(
            f"Task {task_id!r} is a gate task; use review_task() instead of submit_task()"
        )
    version = len(task.artifact_versions) + 1
    task.artifact_versions.append(
        ArtifactVersion(version=version, content=artifact, submitted_at=_now())
    )
    task.artifact = artifact
    task.blocker = None
    task.status = "submitted" if _has_downstream_gate(project, task) else "done"
    recompute_readiness(project)


def review_task(
    project: CrewProject,
    gate_task_id: str,
    approved: bool,
    comment: str | None = None,
) -> None:
    """Approve or reject a gate task (B4: the reviewed producer lands done here).

    - approved=True: reviewed task -> done (completion = approve moment), gate ->
      done; recompute readiness (unblocks next tasks).
    - approved=False: gate -> blocked; reviewed task -> rework with blocker=comment.
    """
    gate = _get_task(project, gate_task_id)
    if not gate.is_gate:
        raise CrewLifecycleError(
            f"Task {gate_task_id!r} is not a gate task"
        )
    if gate.status == "done":
        raise CrewLifecycleError(
            f"Gate task {gate_task_id!r} has already been reviewed (done)"
        )
    # A gate may only be reviewed once the work it reviews is actually SUBMITTED
    # (待审) — otherwise approving would advance the DAG past un-produced work.
    if gate.reviews_task_id is not None:
        reviewed = _get_task(project, gate.reviews_task_id)
        if reviewed.status != "submitted":
            raise CrewLifecycleError(
                f"Cannot review gate {gate_task_id!r}: reviewed task "
                f"{gate.reviews_task_id!r} is {reviewed.status!r}, expected 'submitted'"
            )
    # Multi-parent join (R-B #4): a gate with >1 upstream (设计评审 depends on
    # 设计稿 ∥ 技术预研) only arms when EVERY upstream is submitted|done. Reviewing
    # the「reviews」target alone must not let the DAG skip a sibling parallel branch
    # that has not produced yet.
    if not _deps_satisfied(project, gate):
        raise CrewLifecycleError(
            f"Cannot review gate {gate_task_id!r}: not all upstream dependencies are "
            "satisfied (a multi-parent gate arms only when every upstream is "
            "submitted or done)"
        )

    if approved:
        # The producer completes at the moment its gate approves.
        if gate.reviews_task_id is not None:
            _get_task(project, gate.reviews_task_id).status = "done"
        gate.status = "done"
        gate.review_comment = comment
        recompute_readiness(project)
    else:
        gate.status = "blocked"
        gate.review_comment = comment
        if gate.reviews_task_id is not None:
            reviewed = _get_task(project, gate.reviews_task_id)
            reviewed.status = "rework"
            reviewed.blocker = comment
