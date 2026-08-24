"""R-B #1/#2/#3 · Agent 自动触发 + @重派 + 自动推进 (RED).

The Crew service orchestrates three auto-behaviours through injected, thread-free
collaborators (a spy dispatcher makes them deterministic to test):

  #1 assign an AGENT to a READY task → auto-dispatch a background run at once;
     a pre-assigned (still-blocked) agent task does NOT run until it unlocks.
  #2 @-mentioning an agent that holds an assigned|rework task in the project
     re-dispatches that task (「@Scribe 再改改」→ a fresh run/version).
  #3 approving a review gate auto-advances: newly-ready UNASSIGNED downstream
     tasks are role-matched and assigned; an agent assignee auto-runs, a HUMAN
     one is only assigned (waits for the person). The chain pauses at the next gate.

Auto-run stays idempotent (a human/agent is only dispatched at the transition
that makes the task ready) and conservative (unknown member kind → no run).

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from services.crew.app.matching import deterministic_proposals
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.schemas import Account

_WS = "ws_crew_demo"

# Demo roster (kind + role) — the same shape identity.list_members returns.
_ROSTER = [
    Account(id="acc_boss", workspace_id=_WS, email="b@x", display_name="Boss", role="产品", kind="human"),
    Account(id="acc_andy", workspace_id=_WS, email="a@x", display_name="Andy", role="工程", kind="human"),
    Account(id="acc_agent_scribe", workspace_id=_WS, email="s@x", display_name="Agent·Scribe", role="文案", kind="agent"),
    Account(id="acc_agent_design", workspace_id=_WS, email="d@x", display_name="Agent·Design", role="设计", kind="agent"),
    Account(id="acc_agent_check", workspace_id=_WS, email="c@x", display_name="Agent·Check", role="验收", kind="agent"),
]
_KIND = {a.id: a.kind for a in _ROSTER}


class _Spy:
    """Records dispatch calls (project_id, task_id, workspace_id, actor)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str, str | None, str | None]] = []

    def __call__(
        self,
        project_id: str,
        task_id: str,
        workspace_id: str,
        actor: str,
        source_message_id: str | None,
        source_instruction: str | None,
    ) -> None:
        self.calls.append(
            (
                project_id,
                task_id,
                workspace_id,
                actor,
                source_message_id,
                source_instruction,
            )
        )

    def task_ids(self) -> list[str]:
        return [c[1] for c in self.calls]


def _svc(tmp_path: Path, spy: _Spy, *, kind=None, propose=True) -> CrewService:
    return CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        member_kind=(kind if kind is not None else (lambda mid: _KIND.get(mid))),
        agent_dispatcher=spy,
        propose_assignments=(
            (lambda project: deterministic_proposals(project, _ROSTER)) if propose else None
        ),
    )


def _project(svc: CrewService) -> str:
    return svc.create_project(_WS, "acc_boss", "登录页重设计", "feature_iteration").id


def _task(svc: CrewService, pid: str, key: str):
    return next(t for t in svc.get_project(pid).tasks if t.key == key)


def _drive_brief_done(svc: CrewService, pid: str) -> None:
    brief = _task(svc, pid, "brief")
    svc.assign(pid, brief.id, "acc_boss")  # human — no auto-run
    svc.start(pid, brief.id)
    svc.submit(pid, brief.id, "需求简报正文")


def _submit_prd(svc: CrewService, pid: str) -> None:
    """Drive PRD to submitted (待审) via manual transitions (spy doesn't really run)."""
    prd = _task(svc, pid, "prd")
    if prd.status == "assigned":
        svc.start(pid, prd.id)
    svc.submit(pid, prd.id, "PRD v1:登录页三态")


# --- #1 assign auto-run ------------------------------------------------------


def test_assign_agent_to_ready_task_auto_dispatches(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    _drive_brief_done(svc, pid)                 # prd now ready (todo)
    prd = _task(svc, pid, "prd")

    svc.assign(pid, prd.id, "acc_agent_scribe")  # agent + ready → run

    assert spy.calls == [(pid, prd.id, _WS, "acc_boss", None, None)]


def test_assign_human_to_ready_task_does_not_dispatch(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    brief = _task(svc, pid, "brief")

    svc.assign(pid, brief.id, "acc_boss")        # human + ready → NO run

    assert spy.calls == []


def test_preassigned_agent_runs_on_unlock_not_on_preassign(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    prd = _task(svc, pid, "prd")

    svc.assign(pid, prd.id, "acc_agent_scribe")  # blocked pre-assign → no run
    assert spy.calls == []

    _drive_brief_done(svc, pid)                  # brief submit unlocks prd → run now
    assert spy.calls == [(pid, prd.id, _WS, "acc_boss", None, None)]


def test_unknown_member_kind_does_not_auto_run(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy, kind=lambda mid: None)  # 拿不到 kind → 保守不跑
    pid = _project(svc)
    _drive_brief_done(svc, pid)
    prd = _task(svc, pid, "prd")

    svc.assign(pid, prd.id, "acc_agent_scribe")

    assert spy.calls == []
    assert _task(svc, pid, "prd").status == "assigned"  # still assigned, just not run


def test_no_dispatcher_wired_is_a_noop(tmp_path):
    """Legacy construction (no auto-pilot) never auto-runs and never crashes."""
    svc = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    pid = _project(svc)
    _drive_brief_done(svc, pid)
    prd = _task(svc, pid, "prd")
    svc.assign(pid, prd.id, "acc_agent_scribe")
    assert _task(svc, pid, "prd").status == "assigned"


def test_reassign_ready_task_from_human_to_agent_auto_runs(tmp_path):
    """接管:一个已派给人类(未开工)的就绪任务被改派给 Agent → 立即自动跑一次。"""
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    _drive_brief_done(svc, pid)                   # prd 就绪(todo)
    prd = _task(svc, pid, "prd")
    svc.assign(pid, prd.id, "acc_andy")           # 人类接手 → 不跑
    assert spy.calls == []

    svc.assign(pid, prd.id, "acc_agent_scribe")   # 改派给 agent → 自动跑

    assert spy.calls == [(pid, prd.id, _WS, "acc_boss", None, None)]
    assert _task(svc, pid, "prd").assignee_member_id == "acc_agent_scribe"


# --- #2 @-mention re-dispatch ------------------------------------------------


def test_say_at_agent_with_assigned_task_redispatches(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    _drive_brief_done(svc, pid)
    prd = _task(svc, pid, "prd")
    svc.assign(pid, prd.id, "acc_agent_scribe")   # 1st dispatch (assign)
    spy.calls.clear()

    msg = svc.say(pid, "acc_boss", "@Scribe 再改改方向", mentions=["acc_agent_scribe"])

    assert spy.calls == [
        (pid, prd.id, _WS, "acc_boss", msg.id, "@Scribe 再改改方向")
    ]


def test_say_at_agent_in_rework_redispatches(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    _prd_submitted(svc, pid)                        # prd assigned to scribe + submitted
    prd = _task(svc, pid, "prd")
    prd_review = _task(svc, pid, "prd_review")
    svc.review(pid, prd_review.id, approved=False, comment="重来")
    assert _task(svc, pid, "prd").status == "rework"
    spy.calls.clear()

    msg = svc.say(pid, "acc_boss", "@Scribe 按批注改", mentions=["acc_agent_scribe"])

    assert prd.id in spy.task_ids()
    assert spy.calls[-1] == (
        pid,
        prd.id,
        _WS,
        "acc_boss",
        msg.id,
        "@Scribe 按批注改",
    )


def test_say_at_human_or_agent_without_task_no_redispatch(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)

    svc.say(pid, "acc_boss", "@Andy 看下", mentions=["acc_andy"])               # human
    svc.say(pid, "acc_boss", "@Design 待命", mentions=["acc_agent_design"])     # agent, no task

    assert spy.calls == []


# --- #3 approve auto-advance -------------------------------------------------


def _prd_submitted(svc: CrewService, pid: str) -> None:
    _drive_brief_done(svc, pid)
    prd = _task(svc, pid, "prd")
    svc.assign(pid, prd.id, "acc_agent_scribe")
    _submit_prd(svc, pid)


def test_approve_auto_advances_and_runs_agent_downstream(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    _prd_submitted(svc, pid)
    prd_review = _task(svc, pid, "prd_review")
    spy.calls.clear()

    svc.review(pid, prd_review.id, approved=True)

    design = _task(svc, pid, "design")
    tech = _task(svc, pid, "tech_research")
    # Newly-ready downstream auto-assigned by role.
    assert design.assignee_member_id == "acc_agent_design"  # 设计 → agent
    assert tech.assignee_member_id == "acc_andy"            # 工程 → human
    assert design.status == "assigned" and tech.status == "assigned"
    # Agent downstream auto-runs; the human one is only assigned (waits).
    assert design.id in spy.task_ids()
    assert tech.id not in spy.task_ids()


def test_approve_runs_preassigned_agent_downstream_without_overwriting(tmp_path):
    spy = _Spy()
    svc = _svc(tmp_path, spy)
    pid = _project(svc)
    _prd_submitted(svc, pid)
    spy.calls.clear()   # forget the prd assign-dispatch from setup
    # PRE-assign design to a DIFFERENT agent (Boss lined up the team up front).
    design = _task(svc, pid, "design")
    svc.assign(pid, design.id, "acc_agent_check")   # blocked pre-assign → no run yet
    assert spy.calls == []
    prd_review = _task(svc, pid, "prd_review")

    svc.review(pid, prd_review.id, approved=True)

    design = _task(svc, pid, "design")
    assert design.assignee_member_id == "acc_agent_check"  # pre-assignment kept (not overwritten)
    assert design.id in spy.task_ids()                     # unlocked agent auto-runs


def test_approve_without_proposer_still_notifies_but_no_auto_assign(tmp_path):
    """Auto-advance degrades cleanly when no matcher is wired: downstream stays
    ready-to-claim (todo, unassigned), nothing auto-runs."""
    spy = _Spy()
    svc = _svc(tmp_path, spy, propose=False)
    pid = _project(svc)
    _prd_submitted(svc, pid)
    prd_review = _task(svc, pid, "prd_review")
    spy.calls.clear()

    svc.review(pid, prd_review.id, approved=True)

    design = _task(svc, pid, "design")
    assert design.status == "todo" and design.assignee_member_id is None
    assert spy.calls == []
