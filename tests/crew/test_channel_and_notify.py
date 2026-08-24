from __future__ import annotations

from pathlib import Path

import pytest

from services.crew.app.service import CrewService
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.seed import DEMO_ACCOUNTS


@pytest.fixture
def svc(tmp_path: Path) -> CrewService:
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))


@pytest.fixture
def project(svc: CrewService):
    return svc.create_project(
        workspace_id="ws_demo",
        owner_user_id="acc_boss",
        goal_text="登录页重设计",
        template_id="feature_iteration",
    )


def _task(project, key: str):
    return next(t for t in project.tasks if t.key == key)


def _submit(svc: CrewService, pid: str, task_id: str, artifact: str, assignee: str):
    svc.assign(pid, task_id, assignee)
    svc.start(pid, task_id)
    return svc.submit(pid, task_id, artifact)


# ---------------------------------------------------------------------------
# The 6 minimal tests from the plan (Step 1)
# ---------------------------------------------------------------------------

def test_assign_emits_channel_event_and_notification(svc, project):
    task1 = next(t for t in project.tasks if t.status == "todo")
    svc.assign(project.id, task1.id, "acc_andy")

    ch = svc.list_channel(project.id)
    assert ch[-1].kind == "event" and "acc_andy" in ch[-1].mentions
    assert ch[-1].audit_ref.startswith("#a")

    notes = svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    assert notes and notes[0].kind == "assigned" and notes[0].task_id == task1.id


def test_notification_idempotent_and_read_lifecycle(svc, project):
    task1 = next(t for t in project.tasks if t.status == "todo")
    svc.assign(project.id, task1.id, "acc_andy")

    notes = svc.list_notifications(project.workspace_id, "acc_andy")
    assert len(notes) == 1
    note = notes[0]

    # Re-appending the identical notification (same idempotency_key) is a no-op.
    svc._store.append_notification(note)
    assert len(svc.list_notifications(project.workspace_id, "acc_andy")) == 1

    # Read lifecycle: unread -> mark_read -> no longer unread, read_at stamped.
    assert svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    svc.mark_read(note.id, "acc_andy")
    assert svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True) == []
    reread = svc.list_notifications(project.workspace_id, "acc_andy")
    assert reread[0].read_at is not None


def test_say_appends_message_with_mentions(svc, project):
    msg = svc.say(project.id, "acc_boss", "麻烦看下这个 @acc_andy", mentions=["acc_andy"])
    assert msg.kind == "say" and msg.author_kind == "member" and msg.author_member_id == "acc_boss"

    ch = svc.list_channel(project.id)
    assert ch[-1].id == msg.id and "acc_andy" in ch[-1].mentions

    notes = svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    assert any(n.kind == "mention" for n in notes)


def test_say_notifies_every_mentioned_recipient(svc, project):
    """终审 #2:一条 say @两人 → 两人各收到 1 条 mention 通知。

    幂等键须含收件人;否则同一 message id 的第二个 @ 会与第一个撞键被去重,
    只有第一人收到(多 @ 只通知第一人的 bug)。"""
    svc.say(
        project.id, "acc_boss", "看下这个 @acc_andy @acc_agent_scribe",
        mentions=["acc_andy", "acc_agent_scribe"],
    )

    andy = svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    scribe = svc.list_notifications(project.workspace_id, "acc_agent_scribe", unread_only=True)
    assert len([n for n in andy if n.kind == "mention"]) == 1
    assert len([n for n in scribe if n.kind == "mention"]) == 1


def test_channel_isolated_by_workspace(svc):
    p1 = svc.create_project("ws_a", "acc_boss", "项目 A", "feature_iteration")
    p2 = svc.create_project("ws_b", "acc_boss", "项目 B", "feature_iteration")

    svc.say(p1.id, "acc_boss", "只属于 A 的一条", mentions=[])

    assert len(svc.list_channel(p1.id)) == 1
    assert svc.list_channel(p2.id) == []


def test_template_feature_iteration_has_9_nodes_and_3_gates():
    template = get_template("feature_iteration")
    assert template is not None
    assert template.name == "功能迭代与设计"
    assert len(template.tasks) == 9  # R-B #4:并行段新增「技术预研」
    gates = [t for t in template.tasks if t.is_gate]
    assert len(gates) == 3
    # every gate carries real acceptance criteria文案
    assert all(g.acceptance_criteria for g in gates)


def test_seed_has_two_humans_three_agents():
    humans = [a for a in DEMO_ACCOUNTS if a[4] == "human"]
    agents = [a for a in DEMO_ACCOUNTS if a[4] == "agent"]
    assert len(humans) == 2 and len(agents) == 3
    ids = {a[0] for a in DEMO_ACCOUNTS}
    assert ids == {
        "acc_boss", "acc_andy",
        "acc_agent_scribe", "acc_agent_design", "acc_agent_check",
    }


# ---------------------------------------------------------------------------
# Extra bridge coverage (allowed to add, not to remove)
# ---------------------------------------------------------------------------

def test_submit_unlocking_gate_notifies_boss_review_due(svc, project):
    brief, prd, prd_review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    _submit(svc, project.id, brief.id, "需求简报 v1", "acc_boss")
    _submit(svc, project.id, prd.id, "PRD v1", "acc_agent_scribe")

    ch = svc.list_channel(project.id)
    assert any(m.kind == "artifact" for m in ch)

    boss_notes = svc.list_notifications(project.workspace_id, "acc_boss", unread_only=True)
    assert any(n.kind == "review_due" and n.task_id == prd_review.id for n in boss_notes)


def test_reject_emits_event_with_comment_and_rejected_notification(svc, project):
    brief, prd, prd_review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    _submit(svc, project.id, brief.id, "b", "acc_boss")
    _submit(svc, project.id, prd.id, "PRD v1", "acc_agent_scribe")
    svc.review(project.id, prd_review.id, approved=False, comment="目标不清")

    last = svc.list_channel(project.id)[-1]
    assert last.kind == "event" and "目标不清" in last.body

    notes = svc.list_notifications(project.workspace_id, "acc_agent_scribe", unread_only=True)
    assert any(n.kind == "rejected" and n.task_id == prd.id for n in notes)


def test_approve_emits_unlock_event_row(svc, project):
    brief, prd, prd_review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    _submit(svc, project.id, brief.id, "b", "acc_boss")
    _submit(svc, project.id, prd.id, "PRD v1", "acc_agent_scribe")
    svc.review(project.id, prd_review.id, approved=True)

    last = svc.list_channel(project.id)[-1]
    assert last.kind == "event" and "解锁" in last.body


# ---------------------------------------------------------------------------
# DEV-8 · say filters ghost mentions to real workspace members
# ---------------------------------------------------------------------------

def test_say_drops_ghost_mentions_no_notification(tmp_path):
    """A mention id that is not a real workspace member is silently dropped: it
    never lands on the row and never earns a notification; real members stay."""
    roster = {"acc_boss", "acc_andy"}
    svc = CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        roster=lambda ws: roster,
    )
    project = svc.create_project("ws_demo", "acc_boss", "登录页重设计", "feature_iteration")

    msg = svc.say(
        project.id, "acc_boss", "看下 @Andy 顺带 @Ghost",
        mentions=["acc_andy", "acc_ghost"],
    )

    # Only the real member survives on the persisted row.
    assert msg.mentions == ["acc_andy"]
    # The real member is notified; the ghost gets nothing at all.
    assert svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    assert svc.list_notifications(project.workspace_id, "acc_ghost") == []


def test_say_without_roster_wired_keeps_all_mentions(tmp_path):
    """Legacy construction (no roster): mentions pass through unchanged."""
    svc = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    project = svc.create_project("ws_demo", "acc_boss", "g", "feature_iteration")
    msg = svc.say(project.id, "acc_boss", "@X @Y", mentions=["x", "y"])
    assert msg.mentions == ["x", "y"]


# ---------------------------------------------------------------------------
# 接管/改派:未开工任务换人 → 一行改派事件 + 双方各一通知(全程留痕)
# ---------------------------------------------------------------------------

def test_reassign_assigned_task_emits_change_event_and_notifies_both(svc, project):
    """Boss 已认领的任务被改派给 Andy:频道一行「改派给…(原…)」+ 新旧双方各一条通知。"""
    task1 = next(t for t in project.tasks if t.status == "todo")
    svc.assign(project.id, task1.id, "acc_boss")     # 首次认领(fresh)
    svc.assign(project.id, task1.id, "acc_andy")     # 改派/接管

    reloaded = next(t for t in svc.get_project(project.id).tasks if t.id == task1.id)
    assert reloaded.assignee_member_id == "acc_andy"  # 受派人被替换
    assert reloaded.status == "assigned"              # 未开工,状态不变

    last = svc.list_channel(project.id)[-1]
    assert last.kind == "event"
    assert "改派给" in last.body and "原" in last.body
    assert set(last.mentions) == {"acc_andy", "acc_boss"}

    # 新任受派:『…』已派给你。
    andy = svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    assert any(n.kind == "assigned" and "已派给你" in n.title for n in andy)
    # 原任被转派:『…』已转派给 @acc_andy。
    boss = svc.list_notifications(project.workspace_id, "acc_boss", unread_only=True)
    assert any(n.kind == "assigned" and "已转派给" in n.title for n in boss)


def test_reassign_to_same_member_is_quiet_idempotent(svc, project):
    """重复认领到同一人:不追加任何频道行、不追加通知(静默幂等)。"""
    task1 = next(t for t in project.tasks if t.status == "todo")
    svc.assign(project.id, task1.id, "acc_andy")
    ch_before = len(svc.list_channel(project.id))
    n_before = len(svc.list_notifications(project.workspace_id, "acc_andy"))

    svc.assign(project.id, task1.id, "acc_andy")     # 同员重派 → no-op

    assert len(svc.list_channel(project.id)) == ch_before
    assert len(svc.list_notifications(project.workspace_id, "acc_andy")) == n_before
