"""B3 · inbox aggregation + reimbursement approval projection (RED).

Three inbox lanes (todo/review/mentions) derived from real task state + channel
rows, and a read-only 4-step projection of reimbursement runs (with an idempotent
Boss approval notification for awaiting-approval runs).

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

from services.crew.app import approvals_projection, inbox
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.reimbursement.app.audit import AuditEvent
from services.reimbursement.app.schemas import (
    ApprovalRequest,
    ReimbursementDraft,
    ReimbursementRun,
    ReimbursementWriteAction,
)


def _svc(tmp_path: Path) -> CrewService:
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))


def _task(project, key):
    return next(t for t in project.tasks if t.key == key)


# ---------------------------------------------------------------------------
# Inbox lanes
# ---------------------------------------------------------------------------


def test_todo_lane_has_assigned_and_queued_with_unlock_reason(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "登录页重设计", "feature_iteration")
    brief, prd = _task(project, "brief"), _task(project, "prd")
    svc.assign(project.id, brief.id, "acc_andy")          # ready -> assigned
    svc.assign(project.id, prd.id, "acc_andy")            # blocked -> PRE-assigned (queued)

    projects = svc.list_workspace_projects("ws_demo")
    cards = inbox.todo_cards(projects, "acc_andy")

    assigned = [c for c in cards if c["card_kind"] == "assigned"]
    queued = [c for c in cards if c["card_kind"] == "queued"]
    assert [c["task_id"] for c in assigned] == [brief.id]
    # queued is assignee-based (「已派」): only the PRE-assigned prd, not the
    # unassigned role-matched build task.
    assert [c["task_id"] for c in queued] == [prd.id]
    assert "需求简报" in queued[0]["unlocked_after"]


def test_todo_lane_rework_carries_rejection_reason(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "g", "feature_iteration")
    brief, prd, prd_review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    for tid, who in ((brief.id, "acc_boss"), (prd.id, "acc_andy")):
        svc.assign(project.id, tid, who)
        svc.start(project.id, tid)
        svc.submit(project.id, tid, "x")
    svc.review(project.id, prd_review.id, approved=False, comment="目标不清")

    projects = svc.list_workspace_projects("ws_demo")
    cards = inbox.todo_cards(projects, "acc_andy")
    rework = [c for c in cards if c["card_kind"] == "rework"]
    assert rework and rework[0]["task_id"] == prd.id
    assert rework[0]["rework_reason"] == "目标不清"


def test_todo_cards_carry_origin(tmp_path):
    """F6: every todo card exposes ``origin`` so the UI renders「由频道生长」for
    channel-grown tasks (1e Andy「性能验收:50 节点」) and nothing for SOP tasks."""
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "登录页重设计", "feature_iteration")
    brief = _task(project, "brief")
    svc.assign(project.id, brief.id, "acc_andy")  # SOP-instantiated task

    # Grow a task from a channel「+任务」command, then pre-assign it to Andy.
    _cmd, drafts = svc.draft_tasks_from_message(
        project.id, "补一个 50 节点性能验收", author_member_id="acc_andy"
    )
    svc.confirm_drafts(project.id, drafts, confirmed_by="acc_boss")
    project = svc.list_workspace_projects("ws_demo")[0]
    grown = next(t for t in project.tasks if t.origin == "channel")
    svc.assign(project.id, grown.id, "acc_andy")

    cards = inbox.todo_cards(svc.list_workspace_projects("ws_demo"), "acc_andy")
    by_id = {c["task_id"]: c for c in cards}
    assert by_id[brief.id]["origin"] == "sop"
    assert by_id[grown.id]["origin"] == "channel"


def test_todo_rework_card_carries_latest_version(tmp_path):
    """F6: a rework card carries the latest submitted version so the UI can show
    the v{n}→v{n+1} pill (1e Andy 返工卡「v1→v2」). One submit → version 1."""
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "g", "feature_iteration")
    brief, prd, prd_review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    for tid, who in ((brief.id, "acc_boss"), (prd.id, "acc_andy")):
        svc.assign(project.id, tid, who)
        svc.start(project.id, tid)
        svc.submit(project.id, tid, "初稿")
    svc.review(project.id, prd_review.id, approved=False, comment="目标不清")

    cards = inbox.todo_cards(svc.list_workspace_projects("ws_demo"), "acc_andy")
    rework = next(c for c in cards if c["card_kind"] == "rework")
    assert rework["artifact_version"] == 1


def test_review_lane_shows_owner_ready_gates(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "g", "feature_iteration")
    brief, prd, prd_review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    for tid, who in ((brief.id, "acc_boss"), (prd.id, "acc_agent_scribe")):
        svc.assign(project.id, tid, who)
        svc.start(project.id, tid)
        svc.submit(project.id, tid, "x")

    projects = svc.list_workspace_projects("ws_demo")
    # Boss owns the project -> sees the ready PRD gate.
    boss_cards = inbox.review_cards(projects, "acc_boss")
    assert any(c["gate_task_id"] == prd_review.id for c in boss_cards)
    assert boss_cards[0]["reviews_title"] == "PRD 起草"
    # A non-owner sees no review gates.
    assert inbox.review_cards(projects, "acc_andy") == []


def test_mentions_lane_is_say_only_and_excludes_self(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws_demo", "acc_boss", "登录页重设计", "feature_iteration")
    svc.say(project.id, "acc_boss", "看下这个 @acc_andy", mentions=["acc_andy"])
    svc.say(project.id, "acc_andy", "自己 @acc_andy", mentions=["acc_andy"])  # self -> excluded
    svc.assign(project.id, _task(project, "brief").id, "acc_andy")  # event @andy -> excluded

    messages = {project.id: svc.list_channel(project.id)}
    titles = {project.id: project.goal_text}
    cards = inbox.mention_cards(messages, "acc_andy", titles)
    assert len(cards) == 1
    assert cards[0]["author_member_id"] == "acc_boss"
    assert cards[0]["project_goal"] == "登录页重设计"
    assert "看下这个" in cards[0]["body"]


# ---------------------------------------------------------------------------
# Reimbursement projection — real-status → four-step mapping
# ---------------------------------------------------------------------------


def _run(run_id, status, *, external=None, approval_status=None, verify=None, amount=88.0):
    approval = None
    if approval_status is not None:
        approval = ApprovalRequest(
            id=f"approval_{run_id}", run_id=run_id, action_type="reimbursement.submit",
            risk_level="medium", status=approval_status, payload={},
        )
    write_action = None
    if verify is not None:
        write_action = ReimbursementWriteAction(
            id=f"write_{run_id}", run_id=run_id, approval_id=f"approval_{run_id}",
            external_reimbursement_id=external or "EXT", idempotency_key="k",
            status="success", verify_status=verify,
        )
    return ReimbursementRun(
        id=run_id, workspace_id="ws_demo", actor_user_id="acc_andy",
        input_text="打车 88", status=status,
        draft=ReimbursementDraft(amount=amount, currency="CNY", external_reimbursement_id=external),
        approval=approval, write_action=write_action,
        audit_events=[AuditEvent(type="reimbursement.run.created", run_id=run_id)],
    )


def test_four_step_mapping(tmp_path):
    assert approvals_projection.project_step(_run("r1", "validating")) == "submitted"
    assert approvals_projection.project_step(_run("r2", "collecting")) == "submitted"
    assert approvals_projection.project_step(
        _run("r3", "draft_created", external="EXT-3")
    ) == "drafted"
    assert approvals_projection.project_step(
        _run("r4", "waiting_confirmation", external="EXT-4", approval_status="pending")
    ) == "awaiting_approval"
    # post-approval in-flight / not-yet-verified -> honest "drafted", never "verified"
    assert approvals_projection.project_step(
        _run("r5", "verify_pending", external="EXT-5", approval_status="approved", verify="verify_pending")
    ) == "drafted"
    assert approvals_projection.project_step(
        _run("r6", "completed", external="EXT-6", approval_status="approved", verify="verified")
    ) == "verified"
    # failed -> excluded (no failure step in the 4-step model)
    assert approvals_projection.project_step(_run("r7", "failed")) is None


def test_project_run_card_shape_and_failed_excluded():
    card = approvals_projection.project_run(
        _run("r4", "waiting_confirmation", external="EXT-4", approval_status="pending")
    )
    assert card["run_id"] == "r4"
    assert card["applicant"] == "acc_andy"
    assert card["amount"] == 88.0 and card["currency"] == "CNY"
    assert card["step"] == "awaiting_approval"
    assert card["approval_id"] == "approval_r4"
    assert card["deep_link"].endswith("/r4")
    assert card["updated_at"]  # last audit event time

    assert approvals_projection.project_run(_run("r7", "failed")) is None
    cards = approvals_projection.project_runs([_run("r7", "failed")])
    assert cards == []


# ---------------------------------------------------------------------------
# Approval notification — idempotency
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Projection read robustness — OperationalError classification (终审 #6)
# ---------------------------------------------------------------------------


class _StubReimbursement:
    """Minimal reimbursement stub exposing a state_store.db_path (the DB read path)."""

    def __init__(self, db_path: str) -> None:
        class _Store:
            pass

        self.state_store = _Store()
        self.state_store.db_path = db_path


def test_projection_no_such_table_returns_empty_without_retry(tmp_path, monkeypatch):
    """终审 #6:『no such table』= 尚无报销活动的诚实空态 → [](不重试)。"""
    calls = {"n": 0}

    def _fake_read(_db_path):
        calls["n"] += 1
        raise sqlite3.OperationalError("no such table: reimbursement_runs")

    monkeypatch.setattr(approvals_projection, "_read_run_payloads", _fake_read)
    reimb = _StubReimbursement(str(tmp_path / "reimb.sqlite3"))
    assert approvals_projection.load_workspace_runs(reimb, "ws_demo") == []
    assert calls["n"] == 1  # no such table is expected — no retry


def test_projection_retries_once_on_locked_then_projects(tmp_path, monkeypatch):
    """终审 #6:『database is locked』不误当空表——短等重试一次,重试成功则正常投影。"""
    run = _run("run_x", "waiting_confirmation", external="EXT", approval_status="pending")
    payload = json.dumps(run.model_dump(mode="json"))
    calls = {"n": 0}

    def _fake_read(_db_path):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return [payload]

    monkeypatch.setattr(approvals_projection, "_read_run_payloads", _fake_read)
    reimb = _StubReimbursement(str(tmp_path / "reimb.sqlite3"))
    runs = approvals_projection.load_workspace_runs(reimb, "ws_demo")
    assert calls["n"] == 2  # retried exactly once
    assert [r.id for r in runs] == ["run_x"]


def test_projection_persistent_lock_returns_empty_but_warns(tmp_path, monkeypatch, caplog):
    """终审 #6:重试仍 locked → [] 但发 WARNING(不静默吞掉未知失败模式)。"""

    def _fake_read(_db_path):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(approvals_projection, "_read_run_payloads", _fake_read)
    reimb = _StubReimbursement(str(tmp_path / "reimb.sqlite3"))
    with caplog.at_level(logging.WARNING, logger="services.crew.app.approvals_projection"):
        assert approvals_projection.load_workspace_runs(reimb, "ws_demo") == []
    assert caplog.records, "persistent projection read failure must be logged, not swallowed"


def test_approval_notification_is_idempotent(tmp_path):
    svc = _svc(tmp_path)
    inserted_first = svc.notify_approval(
        workspace_id="ws_demo", to_member_id="acc_boss", run_id="r4",
        step="awaiting_approval", title="报销 r4 待你审批。",
        deep_link="/cowork/reimbursements/runs/r4",
    )
    inserted_second = svc.notify_approval(
        workspace_id="ws_demo", to_member_id="acc_boss", run_id="r4",
        step="awaiting_approval", title="报销 r4 待你审批。",
        deep_link="/cowork/reimbursements/runs/r4",
    )
    assert inserted_first is True and inserted_second is False
    notes = svc.list_notifications("ws_demo", "acc_boss")
    approvals = [n for n in notes if n.kind == "approval" and "r4" in n.idempotency_key]
    assert len(approvals) == 1
