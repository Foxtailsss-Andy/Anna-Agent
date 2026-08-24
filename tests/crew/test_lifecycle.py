import pytest

from services.crew.app.lifecycle import (
    CrewLifecycleError, assign_task, instantiate_project, review_task,
    start_task, submit_task,
)
from services.crew.app.sop_templates import get_template


def _project():
    counter = {"n": 0}
    def task_id(key):
        counter["n"] += 1
        return f"task_{counter['n']}_{key}"
    return instantiate_project(
        project_id="proj1", workspace_id="ws1", owner_user_id="boss",
        goal_text="做一个新功能", template=get_template("feature_iteration"),
        task_id=task_id,
    )


def _task(project, key):
    return next(t for t in project.tasks if t.key == key)


def test_instantiate_sets_ready_and_blocked():
    project = _project()
    assert _task(project, "brief").status == "todo"      # no deps -> ready
    assert _task(project, "prd").status == "blocked"        # depends on brief
    prd_review = _task(project, "prd_review")
    assert prd_review.is_gate and prd_review.reviews_task_id == _task(project, "prd").id


def test_cannot_start_before_assigned():
    project = _project()
    with pytest.raises(CrewLifecycleError):
        start_task(project, _task(project, "brief").id)


def test_completing_brief_unblocks_prd():
    project = _project()
    brief = _task(project, "brief")
    assign_task(project, brief.id, "m_pm")
    start_task(project, brief.id)
    submit_task(project, brief.id, artifact="需求文档")
    assert _task(project, "brief").status == "done"
    assert _task(project, "prd").status == "todo"           # now ready


def test_review_reject_sends_reviewed_task_to_rework_then_approve_advances():
    project = _project()
    # drive brief -> prd submitted
    for key, member in [("brief", "m_pm")]:
        t = _task(project, key)
        assign_task(project, t.id, member); start_task(project, t.id)
        submit_task(project, t.id, artifact="x")
    prd = _task(project, "prd")
    assign_task(project, prd.id, "m_agent"); start_task(project, prd.id)
    submit_task(project, prd.id, artifact="PRD v1")
    assert prd.status == "submitted"                        # 待审 (has downstream gate)
    review = _task(project, "prd_review")
    assert review.status == "todo"                          # gate ready
    # (a gate is never assigned — its reviewer is fixed as the owner; review directly)
    # reject
    review_task(project, review.id, approved=False, comment="目标不清")
    assert _task(project, "prd").status == "rework"
    assert _task(project, "prd").blocker == "目标不清"
    assert _task(project, "design").status == "blocked"     # not advanced
    # rework: resubmit prd
    start_task(project, prd.id)
    submit_task(project, prd.id, artifact="PRD v2")
    assert prd.status == "submitted"                        # 待审 again (v2)
    # approve
    review_task(project, review.id, approved=True)
    assert _task(project, "prd").status == "done"           # producer done at approve
    assert _task(project, "prd_review").status == "done"
    assert _task(project, "design").status == "todo"        # advanced!


def test_cannot_review_gate_before_reviewed_task_is_done():
    project = _project()
    review = _task(project, "prd_review")
    assert review.status == "blocked"            # reviewed task (prd) not done yet
    with pytest.raises(CrewLifecycleError):
        review_task(project, review.id, approved=True)
    with pytest.raises(CrewLifecycleError):
        review_task(project, review.id, approved=False, comment="x")
    assert _task(project, "design").status == "blocked"      # DAG must not advance


def test_cannot_review_a_gate_twice():
    project = _project()
    brief = _task(project, "brief")
    assign_task(project, brief.id, "m_pm"); start_task(project, brief.id)
    submit_task(project, brief.id, artifact="x")
    prd = _task(project, "prd")
    assign_task(project, prd.id, "m_agent"); start_task(project, prd.id)
    submit_task(project, prd.id, artifact="PRD")
    review = _task(project, "prd_review")
    review_task(project, review.id, approved=True)
    assert review.status == "done"
    with pytest.raises(CrewLifecycleError):
        review_task(project, review.id, approved=True)


# --- 接管/改派:未开工任务允许换人,门永不指派 -------------------------------


def test_assign_returns_none_on_fresh_assign_and_previous_on_reassign():
    """assign_task 返回原受派人:首次派 None,接管返回上一个人。"""
    project = _project()
    prd = _task(project, "prd")          # blocked (depends on brief)
    assert assign_task(project, prd.id, "m_a") is None      # fresh pre-assign
    assert prd.assignee_member_id == "m_a" and prd.status == "blocked"
    assert assign_task(project, prd.id, "m_b") == "m_a"     # 改派 → returns previous
    assert prd.assignee_member_id == "m_b" and prd.status == "blocked"


def test_reassign_assigned_task_replaces_in_place():
    """一个已 assigned(未开工)的任务可被接管:换人、状态仍 assigned。"""
    project = _project()
    brief = _task(project, "brief")      # todo (ready)
    assign_task(project, brief.id, "m_a")
    assert brief.status == "assigned"
    prev = assign_task(project, brief.id, "m_b")
    assert prev == "m_a"
    assert brief.assignee_member_id == "m_b"
    assert brief.status == "assigned"    # 接管未开工任务,状态不变


def test_cannot_reassign_a_running_task():
    """已开工(running)不再是「未开工」,不许静默换人(API 侧转 409)。"""
    project = _project()
    brief = _task(project, "brief")
    assign_task(project, brief.id, "m_a"); start_task(project, brief.id)
    assert brief.status == "running"
    with pytest.raises(CrewLifecycleError):
        assign_task(project, brief.id, "m_b")


def test_gate_task_is_not_assignable():
    """评审门评审人固定为负责人 —— 门永不可被指派(任何状态)。"""
    project = _project()
    gate = _task(project, "prd_review")
    with pytest.raises(CrewLifecycleError, match="gate"):
        assign_task(project, gate.id, "boss")
