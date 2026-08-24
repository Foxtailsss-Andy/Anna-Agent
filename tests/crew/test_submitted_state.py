"""B4 · submit→submitted 待审态 + 门就绪=上游 submitted|done + 评审卡事实源 (RED).

A producer with a downstream review gate no longer lands ``done`` on submit — it
lands ``submitted`` (待审) and only becomes ``done`` at the moment its gate is
approved. A gate's upstream dep is satisfied by ``submitted`` OR ``done`` (so the
gate becomes reviewable), but a NON-gate task's dep must be ``done`` (下推必须过门).
A producer with NO downstream gate (the「验收合并」endpoint) keeps landing ``done``
directly — otherwise its submitted state would hang forever with no gate to clear it.

The event bridge also drops a ``kind="review"`` chronicle row when a gate becomes
reviewable (backing the design's 金线评审卡 with a server-side fact): task_id=gate,
body naming the review target + version, idempotent per gate+version, retained
after the review decision.

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

from pathlib import Path

from services.crew.app.lifecycle import (
    assign_task,
    instantiate_project,
    review_task,
    start_task,
    submit_task,
)
from services.crew.app.service import CrewService
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore


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


def _produce(project, key, member="m"):
    t = _task(project, key)
    assign_task(project, t.id, member)
    start_task(project, t.id)
    submit_task(project, t.id, f"{key} 交付物")
    return t


def _approve(project, key):
    review_task(project, _task(project, key).id, approved=True)


# --- state machine (lifecycle level) -----------------------------------------


def test_producer_with_gate_lands_submitted_not_done():
    project = _project()
    _produce(project, "brief")                    # no gate -> done
    prd = _produce(project, "prd")                # has prd_review gate
    assert prd.status == "submitted"


def test_gate_becomes_ready_when_upstream_submitted():
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")                       # prd -> submitted
    # The gate's upstream (prd) is submitted|done -> the gate is reviewable.
    assert _task(project, "prd_review").status == "todo"


def test_downstream_nongate_still_waits_for_done_not_submitted():
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")                       # prd submitted, gate ready
    # design depends on the gate (not prd); a submitted upstream must NOT leak
    # past the gate — 下推必须过门.
    assert _task(project, "design").status == "blocked"


def test_approve_lands_producer_done_at_approve_moment():
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")
    assert _task(project, "prd").status == "submitted"
    _approve(project, "prd_review")
    # Completion moment = approve moment.
    assert _task(project, "prd").status == "done"
    assert _task(project, "prd_review").status == "done"
    assert _task(project, "design").status == "todo"   # now advanced past the gate


def test_reject_sends_producer_to_rework():
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")
    review_task(project, _task(project, "prd_review").id, approved=False, comment="改")
    assert _task(project, "prd").status == "rework"
    assert _task(project, "prd").blocker == "改"


def test_rework_resubmit_reactivates_gate():
    project = _project()
    _produce(project, "brief")
    prd = _produce(project, "prd")
    review_task(project, _task(project, "prd_review").id, approved=False, comment="改")
    start_task(project, prd.id)
    submit_task(project, prd.id, "prd v2")
    assert prd.status == "submitted"
    assert _task(project, "prd_review").status == "todo"   # gate re-armed


def test_endpoint_producer_without_gate_lands_done_directly():
    """验收合并 has no downstream gate → submit lands done (never a hung submitted)."""
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")
    _approve(project, "prd_review")
    _produce(project, "design")
    _produce(project, "tech_research")   # 双父门:两条并行支都须产出
    _approve(project, "design_review")
    _produce(project, "build")
    _approve(project, "code_review")
    accept = _produce(project, "accept")
    assert accept.status == "done"


# --- multi-parent gate (parallel join) ---------------------------------------


import pytest  # noqa: E402

from services.crew.app.lifecycle import CrewLifecycleError  # noqa: E402


def test_dual_parent_gate_not_ready_until_both_upstream_satisfied():
    """设计评审是双父门:设计稿 submitted + 技术预研 done 两者齐备才 ready。"""
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")
    _approve(project, "prd_review")            # 分叉:design ∥ tech_research 解锁
    assert _task(project, "design").status == "todo"
    assert _task(project, "tech_research").status == "todo"

    # 只产出设计稿:门仍未 ready(技术预研这条支未完成)。
    _produce(project, "design")                # design -> submitted
    assert _task(project, "design_review").status == "blocked"

    # 技术预研无下游门 → submit 直接 done;此刻双父齐备,门 arms。
    _produce(project, "tech_research")         # tech_research -> done
    assert _task(project, "tech_research").status == "done"
    assert _task(project, "design_review").status == "todo"


def test_dual_parent_gate_rejects_premature_approve():
    """设计稿已 submitted 但技术预研未完成时,不得批准设计评审门(上游未齐)。"""
    project = _project()
    _produce(project, "brief")
    _produce(project, "prd")
    _approve(project, "prd_review")
    _produce(project, "design")                # design submitted, tech_research 仍 blocked
    gate = _task(project, "design_review")
    with pytest.raises(CrewLifecycleError):
        review_task(project, gate.id, approved=True)


# --- review chronicle row (service level, event bridge) ----------------------


def _svc(tmp_path: Path) -> CrewService:
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))


def _svc_produce(svc, pid, key, artifact, assignee):
    task = next(t for t in svc.get_project(pid).tasks if t.key == key)
    svc.assign(pid, task.id, assignee)
    svc.start(pid, task.id)
    svc.submit(pid, task.id, artifact)
    return task


def test_gate_activation_emits_review_row_with_target_and_version(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "登录页重设计", "feature_iteration")
    pid = project.id
    _svc_produce(svc, pid, "brief", "需求", "acc_boss")
    prd = _svc_produce(svc, pid, "prd", "PRD v1", "acc_agent_scribe")
    prd_review = next(t for t in svc.get_project(pid).tasks if t.key == "prd_review")

    review_rows = [m for m in svc.list_channel(pid) if m.kind == "review"]
    assert len(review_rows) == 1
    row = review_rows[0]
    assert row.task_id == prd_review.id          # points at the gate
    assert "PRD 起草" in row.body                 # names the review target (producer)
    assert "v1" in row.body                       # and its version
    assert row.audit_ref.startswith("#a")         # audited (B1a rule)


def test_review_row_versioned_across_rework_and_retained_and_idempotent(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "登录页重设计", "feature_iteration")
    pid = project.id
    _svc_produce(svc, pid, "brief", "需求", "acc_boss")
    prd = _svc_produce(svc, pid, "prd", "PRD v1", "acc_agent_scribe")
    prd_review = next(t for t in svc.get_project(pid).tasks if t.key == "prd_review")

    # reject -> rework -> resubmit v2 re-arms the gate -> a v2 review row lands.
    svc.review(pid, prd_review.id, approved=False, comment="改")
    svc.start(pid, prd.id)
    svc.submit(pid, prd.id, "PRD v2")

    rows = [m for m in svc.list_channel(pid) if m.kind == "review"]
    assert len(rows) == 2                                   # v1 retained + v2 added
    assert any("v1" in m.body for m in rows)
    assert any("v2" in m.body for m in rows)

    # Idempotent: re-emitting for the same gate+version does NOT duplicate.
    loaded = svc.get_project(pid)
    gate = next(t for t in loaded.tasks if t.id == prd_review.id)
    svc._emit_review_row(loaded, gate, "#a99")
    assert len([m for m in svc.list_channel(pid) if m.kind == "review"]) == 2

    # Approving keeps the chronicle rows (编年史不删).
    svc.review(pid, prd_review.id, approved=True)
    assert len([m for m in svc.list_channel(pid) if m.kind == "review"]) == 2
