"""``CrewService.propose_changes`` + confirm (ticket P · AC5, service seam)."""
from __future__ import annotations

from pathlib import Path

import pytest

from services.crew.app.schemas import AssignmentProposal, TaskDraft
from services.crew.app.service import CrewProposalError, CrewService
from services.crew.app.store import SQLiteCrewStore


def _svc(tmp_path: Path, roster: set[str]) -> CrewService:
    # Same shape as the route wiring: workspace members plus the system actor.
    return CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        roster=lambda _ws: roster | {"anna"},
    )


def _marketing(svc: CrewService):
    return svc.create_project("ws_crew_demo", "acc_boss", "秋季营销物料", "marketing_collateral")


def _task(project, title):
    return next(t for t in project.tasks if t.title == title)


def _propose(svc, project, **arguments):
    return svc.propose_changes(
        workspace_id="ws_crew_demo",
        run_id="wb-run-1",
        tool_call_id=None,
        arguments={"project_id": project.id, "summary": "调整计划", **arguments},
    )


@pytest.mark.parametrize(
    "new_tasks",
    [
        [
            {"title": "甲", "role": "设计", "depends_on": ["乙"]},
            {"title": "乙", "role": "设计", "depends_on": ["甲"]},
        ],
        [{"title": "甲", "role": "设计", "depends_on": ["文案撰写"], "insert_before": ["营销 Brief"]}],
    ],
    ids=["between_new_tasks", "through_existing_tasks"],
)
def test_proposal_that_closes_a_dependency_cycle_is_rejected(tmp_path, new_tasks):
    svc = _svc(tmp_path, {"acc_boss", "acc_andy"})
    project = _marketing(svc)

    with pytest.raises(CrewProposalError) as error:
        _propose(svc, project, new_tasks=new_tasks)

    assert error.value.code == "dependency_cycle:甲"
    assert svc.list_channel(project.id) == []


def test_member_removed_before_confirm_is_skipped_and_noted(tmp_path):
    roster = {"acc_boss", "acc_andy"}
    svc = _svc(tmp_path, roster)
    project = _marketing(svc)
    card = _propose(
        svc, project,
        new_tasks=[{"title": "竞品调研", "role": "设计", "assignee_id": "acc_andy"}],
    )
    roster.discard("acc_andy")

    updated = svc.confirm_drafts(
        project.id,
        [TaskDraft.model_validate(d) for d in card.payload["drafts"]],
        confirmed_by="acc_boss",
        source_message_id=card.id,
    )

    research = _task(updated, "竞品调研")
    assert research.assignee_member_id is None and research.status == "todo"
    assert "未执行指派：“竞品调研”→@acc_andy（成员无效）" in svc.list_channel(project.id)[-1].body


def test_assignment_only_confirm_uses_assign_path_once(tmp_path):
    svc = _svc(tmp_path, {"acc_boss", "acc_andy"})
    project = _marketing(svc)
    brief = _task(project, "营销 Brief")
    card = _propose(svc, project, assignments=[{"task_id": brief.id, "member_id": "acc_andy"}])
    proposals = [AssignmentProposal.model_validate(a) for a in card.payload["assignments"]]

    first = svc.confirm_drafts(
        project.id, [], confirmed_by="acc_boss", source_message_id=card.id, assignments=proposals
    )
    rows = len(svc.list_channel(project.id))
    second = svc.confirm_drafts(
        project.id, [], confirmed_by="acc_boss", source_message_id=card.id, assignments=proposals
    )

    assert _task(first, "营销 Brief").assignee_member_id == "acc_andy"
    assert _task(first, "营销 Brief").status == "assigned"
    assert len(first.tasks) == len(project.tasks)
    assert len(svc.list_channel(project.id)) == rows
    assert len(second.audit_events) == len(first.audit_events)
    andy_notes = svc.list_notifications("ws_crew_demo", "acc_andy")
    assert [n.title for n in andy_notes] == ["“营销 Brief”已派给你。"]
