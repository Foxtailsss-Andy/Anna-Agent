from __future__ import annotations

from pathlib import Path

import pytest

from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore


def _make_service(tmp_path: Path) -> CrewService:
    store = SQLiteCrewStore(tmp_path / "crew.db")
    return CrewService(store=store)


def _task(project, key):
    return next(t for t in project.tasks if t.key == key)


def test_create_project_from_feature_iteration(tmp_path: Path):
    service = _make_service(tmp_path)
    project = service.create_project(
        workspace_id="ws1",
        owner_user_id="owner1",
        goal_text="做一个新功能",
        template_id="feature_iteration",
    )
    assert project.id is not None
    assert project.sop_template_id == "feature_iteration"
    assert len(project.tasks) == 9  # R-B #4:并行段新增「技术预研」
    # brief starts ready, others blocked
    assert _task(project, "brief").status == "todo"
    assert _task(project, "prd").status == "blocked"
    # at least one audit event recorded
    assert len(project.audit_events) >= 1
    assert project.audit_events[0]["type"] == "crew.project.created"


def test_create_project_unknown_template_raises(tmp_path: Path):
    service = _make_service(tmp_path)
    with pytest.raises(ValueError, match="unknown"):
        service.create_project(
            workspace_id="ws1",
            owner_user_id="owner1",
            goal_text="x",
            template_id="nonexistent_template",
        )


def test_list_projects_workspace_scoped(tmp_path: Path):
    service = _make_service(tmp_path)
    service.create_project("ws1", "owner1", "goal A", "feature_iteration")
    service.create_project("ws2", "owner1", "goal B", "feature_iteration")

    ws1 = service.list_projects("ws1", "owner1")
    ws2 = service.list_projects("ws2", "owner1")
    assert len(ws1) == 1
    assert len(ws2) == 1
    assert ws1[0].workspace_id == "ws1"
    assert ws2[0].workspace_id == "ws2"


def test_full_happy_path_with_reject_then_approve(tmp_path: Path):
    """
    Full money-shot: brief -> prd -> prd_review reject -> rework -> prd_review approve
    -> design unlocked. Audit events recorded throughout.
    """
    service = _make_service(tmp_path)
    project = service.create_project("ws1", "boss", "做一个新功能", "feature_iteration")
    pid = project.id

    # Step 1: assign + start + submit brief
    brief = _task(project, "brief")
    project = service.assign(pid, brief.id, "m_pm")
    project = service.start(pid, brief.id)
    project = service.submit(pid, brief.id, artifact="需求文档")
    assert _task(project, "brief").status == "done"
    assert _task(project, "prd").status == "todo"

    # Step 2: assign + start + submit prd
    prd = _task(project, "prd")
    project = service.assign(pid, prd.id, "m_agent")
    project = service.start(pid, prd.id)
    project = service.submit(pid, prd.id, artifact="PRD v1")
    assert _task(project, "prd").status == "submitted"   # 待审 (has downstream gate)
    assert _task(project, "prd_review").status == "todo"

    # Step 3: reject at prd_review (a gate is never assigned — reviewer = owner)
    review = _task(project, "prd_review")
    project = service.review(pid, review.id, approved=False, comment="目标不清")
    assert _task(project, "prd").status == "rework"
    assert _task(project, "prd").blocker == "目标不清"
    assert _task(project, "design").status == "blocked"

    # Step 4: rework prd — start directly (rework state)
    project = service.start(pid, prd.id)
    project = service.submit(pid, prd.id, artifact="PRD v2")
    assert _task(project, "prd").status == "submitted"   # 待审 again (v2)

    # Step 5: approve prd_review → producer done at approve, design unlocked
    project = service.review(pid, review.id, approved=True)
    assert _task(project, "prd").status == "done"
    assert _task(project, "prd_review").status == "done"
    assert _task(project, "design").status == "todo"

    # Audit events should include multiple entries
    assert len(project.audit_events) > 5
    event_types = {e["type"] for e in project.audit_events}
    assert "crew.project.created" in event_types
    assert "crew.task.assign" in event_types
    assert "crew.task.submit" in event_types
    assert "crew.task.review" in event_types


def test_project_persisted_after_each_transition(tmp_path: Path):
    """Verify that transitions survive a fresh service reload (persistence)."""
    store = SQLiteCrewStore(tmp_path / "crew.db")
    service = CrewService(store=store)
    project = service.create_project("ws1", "owner1", "goal", "feature_iteration")
    pid = project.id

    brief = _task(project, "brief")
    service.assign(pid, brief.id, "m_pm")

    # Reload via a fresh service with the same store
    service2 = CrewService(store=store)
    loaded = service2.get_project(pid)
    assert loaded is not None
    assert _task(loaded, "brief").status == "assigned"
