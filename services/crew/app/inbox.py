"""B3 · 收件箱聚合 (pure functions).

Aggregates a member's actionable Crew surface into the three inbox lanes the
design (1e) shows — ``todo`` / ``review`` / ``mentions`` — from the real project
DAGs + channel rows. No fabrication: every card derives from a task's true state
or a real channel message.

* **todo**   — tasks assigned to me (``assigned``/``rework``; rework carries the
  driver's rejection reason) PLUS「排队中」: work「已派」to me that is not ready
  yet (a blocked task PRE-assigned to me — the Boss lined the team up front),
  each annotated with「『某门』通过后解锁」.
* **review** — review gates awaiting my decision in projects I own (Boss view).
  Reimbursement approval cards are folded in by the route (they come from the
  read-only projection, not the crew DAG).
* **mentions** — channel「say」rows where a teammate @-ed me (with the quote and
  the project/message anchor).
"""
from __future__ import annotations

from typing import Any

from services.crew.app.schemas import ChannelMessage, CrewProject, CrewTask


def _project_meta(project: CrewProject) -> dict[str, Any]:
    return {"project_id": project.id, "project_goal": project.goal_text}


def _find(project: CrewProject, task_id: str | None) -> CrewTask | None:
    if task_id is None:
        return None
    return next((t for t in project.tasks if t.id == task_id), None)


def _latest_version(task: CrewTask) -> int | None:
    """The latest submitted artifact version, or None if never submitted (B4).

    Feeds the UI's v{n}→v{n+1} rework pill (1e Andy 返工卡「v1→v2」); zero
    fabrication — a task with no submit history carries no version."""
    if not task.artifact_versions:
        return None
    return max(v.version for v in task.artifact_versions)


def _unlock_reason(project: CrewProject, task: CrewTask) -> str:
    """Explain what unblocks a queued task, preferring the blocking gate.

    A gate dep reads「『门』通过后解锁」; a plain producer dep「『任务』完成后解锁」."""
    done_ids = {t.id for t in project.tasks if t.status == "done"}
    pending = [dep for dep in (_find(project, d) for d in task.depends_on) if dep is not None]
    pending = [dep for dep in pending if dep.id not in done_ids]
    if not pending:
        return ""
    target = next((dep for dep in pending if dep.is_gate), pending[0])
    verb = "通过" if target.is_gate else "完成"
    return f"“{target.title}”{verb}后解锁"


def todo_cards(projects: list[CrewProject], member_id: str) -> list[dict[str, Any]]:
    """My assigned/rework task cards, followed by my queued (pre-assigned) cards.

    「排队中」is assignee-based (「已派」): a task PRE-assigned to me that is still
    blocked. It stays out of the ready lane until its blocking gate/dep clears."""
    assigned: list[dict[str, Any]] = []
    queued: list[dict[str, Any]] = []
    for project in projects:
        for task in project.tasks:
            if task.assignee_member_id != member_id:
                continue
            if task.status in ("assigned", "rework"):
                card = {
                    **_project_meta(project),
                    "task_id": task.id,
                    "title": task.title,
                    "role_required": task.role_required,
                    "status": task.status,
                    "card_kind": "rework" if task.status == "rework" else "assigned",
                    # F6: origin drives the UI「由频道生长」row (1e); latest
                    # submitted version drives the rework v{n}→v{n+1} pill.
                    "origin": task.origin,
                }
                version = _latest_version(task)
                if version is not None:
                    card["artifact_version"] = version
                if task.status == "rework":
                    # The reviewer's rejection note lands on the reviewed task's
                    # blocker (lifecycle.review_task); fall back to the gate note.
                    card["rework_reason"] = task.blocker or task.review_comment or ""
                assigned.append(card)
            elif task.status == "blocked" and not task.is_gate:
                queued.append({
                    **_project_meta(project),
                    "task_id": task.id,
                    "title": task.title,
                    "role_required": task.role_required,
                    "status": "blocked",
                    "card_kind": "queued",
                    "unlocked_after": _unlock_reason(project, task),
                    "origin": task.origin,
                })
    return assigned + queued


def review_cards(projects: list[CrewProject], member_id: str) -> list[dict[str, Any]]:
    """Review gates awaiting my decision in the projects I own (owner = Boss)."""
    cards: list[dict[str, Any]] = []
    for project in projects:
        if project.owner_user_id != member_id:
            continue
        for task in project.tasks:
            # A gate becomes ready (todo, or assigned if someone claimed the
            # review) once the work it reviews is done — that is「等我审」.
            if task.is_gate and task.status in ("todo", "assigned"):
                reviewed = _find(project, task.reviews_task_id)
                cards.append({
                    **_project_meta(project),
                    "gate_task_id": task.id,
                    "gate_title": task.title,
                    "reviews_title": reviewed.title if reviewed else None,
                    "acceptance_criteria": task.acceptance_criteria,
                    "card_kind": "gate",
                })
    return cards


def mention_cards(
    messages_by_project: dict[str, list[ChannelMessage]],
    member_id: str,
    project_titles: dict[str, str],
) -> list[dict[str, Any]]:
    """Channel「say」rows where a teammate @-ed me (newest first)."""
    cards: list[dict[str, Any]] = []
    for project_id, messages in messages_by_project.items():
        for message in messages:
            if (
                message.kind == "say"
                and member_id in message.mentions
                and message.author_member_id != member_id
            ):
                cards.append({
                    "project_id": project_id,
                    "project_goal": project_titles.get(project_id, project_id),
                    "message_id": message.id,
                    "author_member_id": message.author_member_id,
                    "body": message.body,
                    "task_id": message.task_id,
                    "created_at": message.created_at,
                })
    cards.sort(key=lambda card: card.get("created_at") or "", reverse=True)
    return cards
