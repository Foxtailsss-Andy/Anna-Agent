"""B3 · channel「+任务」command — two-phase draft/confirm (RED).

Phase 1 ``draft_tasks_from_message`` distils a channel message into 1..N≤3 task
drafts (model-drafted, roster-aware; absent/failed → one deterministic fallback)
and drops a ``kind="command"`` draft row carrying the drafts + source id. Phase 2
``confirm_drafts`` is Boss-only and materializes the confirmed subset as real
tasks with ``origin="channel"`` + ``created_from_message_id``, emitting a growth
event row + a ``grown`` notification.

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.actors import SYSTEM_ANNA_ACTOR_ID
from services.crew.app.schemas import TaskDraft
from services.crew.app.service import CrewPermissionError, CrewService
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelResponse, ModelToolCall


class _DraftProvider:
    """A configured fake harness provider that emits the given raw drafts."""

    def __init__(self, drafts):
        self.settings = RuntimeSettings(
            model_endpoint="https://m.example/v1", model_api_key="k"
        )
        self._drafts = drafts

    async def create_response(self, request):
        return ModelResponse(
            tool_calls=[ModelToolCall(
                id="c1", name="crew.emit_task_drafts",
                arguments={"drafts": self._drafts},
            )],
            finish_reason="tool_calls",
        )


class _DeadProvider:
    def __init__(self):
        self.settings = RuntimeSettings()  # unconfigured -> fallback

    async def create_response(self, request):  # pragma: no cover - never called
        raise AssertionError("model must not be called when unconfigured")


def _svc(tmp_path: Path, drafter=None) -> CrewService:
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"), drafter=drafter)


def _project(svc: CrewService, owner="acc_boss"):
    return svc.create_project("ws_demo", owner, "登录页重设计", "feature_iteration")


# --- Phase 1: drafting -------------------------------------------------------


def test_draft_falls_back_to_single_task_without_model(tmp_path):
    svc = _svc(tmp_path, drafter=CommandDraftingService(AnnaHarnessRuntime(_DeadProvider())))
    project = _project(svc)
    long_text = "把登录页的错误态文案统一，覆盖远程 4xx 的三种情况并补齐真实截图给设计参考"

    command, drafts = svc.draft_tasks_from_message(project.id, long_text, "acc_boss")

    # One deterministic draft: title clipped to 40, role 产品, acceptance = raw.
    assert len(drafts) == 1
    assert drafts[0].role == "产品"
    assert len(drafts[0].title) <= 40
    assert drafts[0].acceptance == long_text

    # A command draft row landed on the channel carrying the drafts payload.
    assert command.kind == "command"
    assert command.payload and len(command.payload["drafts"]) == 1
    assert svc.list_channel(project.id)[-1].id == command.id


def test_draft_without_drafter_still_falls_back(tmp_path):
    """Service with no drafter wired uses the inline deterministic fallback."""
    svc = _svc(tmp_path)  # _drafter=None
    project = _project(svc)
    _command, drafts = svc.draft_tasks_from_message(project.id, "改一下登录按钮", "acc_boss")
    assert len(drafts) == 1 and drafts[0].role == "产品"


def test_draft_model_path_truncates_to_three(tmp_path):
    raw = [
        {"title": f"任务{i}", "role": "工程", "depends_on": [], "acceptance": ""}
        for i in range(5)
    ]
    svc = _svc(tmp_path, drafter=CommandDraftingService(AnnaHarnessRuntime(_DraftProvider(raw))))
    project = _project(svc)
    _command, drafts = svc.draft_tasks_from_message(project.id, "拆一下", "acc_boss")
    assert len(drafts) == 3  # 1..N≤3
    assert [d.title for d in drafts] == ["任务0", "任务1", "任务2"]


# --- Phase 2: confirm --------------------------------------------------------


def test_confirm_is_boss_only(tmp_path):
    svc = _svc(tmp_path)
    project = _project(svc, owner="acc_boss")
    drafts = [TaskDraft(title="新任务", role="工程")]
    with pytest.raises(CrewPermissionError):
        svc.confirm_drafts(project.id, drafts, confirmed_by="acc_andy")


def test_confirm_creates_channel_origin_tasks_and_growth_event(tmp_path):
    svc = _svc(tmp_path)
    project = _project(svc)
    command, drafts = svc.draft_tasks_from_message(
        project.id, "补一个埋点校验任务", "acc_boss"
    )
    before = len(project.tasks)

    updated = svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss", source_message_id=command.id
    )

    grown = [t for t in updated.tasks if t.origin == "channel"]
    assert len(grown) == len(drafts) == 1
    assert len(updated.tasks) == before + 1
    assert grown[0].created_from_message_id == command.id
    assert grown[0].status == "todo"  # no deps -> ready

    # A growth event row + a grown notification were emitted.
    last = svc.list_channel(project.id)[-1]
    assert last.kind == "event" and "已确认下推" in last.body
    notes = svc.list_notifications(project.workspace_id, "acc_boss")
    assert any(n.kind == "grown" for n in notes)
    # Audited.
    assert any(e["type"] == "crew.channel.tasks_confirmed" for e in updated.audit_events)


def test_confirm_is_idempotent_by_source_message(tmp_path):
    """终审 #3:同命令行二次 confirm 是 200 幂等空操作(双标签页友好)。

    命中既有任务的 created_from_message_id 即短路:不重复建任务、不重复频道行、
    不重复通知,返回现 project(响应仍含既有任务)。"""
    svc = _svc(tmp_path)
    project = _project(svc)
    command, drafts = svc.draft_tasks_from_message(
        project.id, "补一个埋点校验任务", "acc_boss"
    )

    first = svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss", source_message_id=command.id
    )
    grown_first = [t for t in first.tasks if t.origin == "channel"]
    channel_len = len(svc.list_channel(project.id))
    notes_len = len(svc.list_notifications(project.workspace_id, "acc_boss"))
    audit_len = len(first.audit_events)

    second = svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss", source_message_id=command.id
    )
    grown_second = [t for t in second.tasks if t.origin == "channel"]

    # No new tasks, channel rows, notifications, or audit events on the replay.
    assert len(grown_second) == len(grown_first) == 1
    assert len(svc.list_channel(project.id)) == channel_len
    assert len(svc.list_notifications(project.workspace_id, "acc_boss")) == notes_len
    assert len(second.audit_events) == audit_len
    # The existing grown task is still present in the returned project (幂等语义).
    assert grown_second[0].created_from_message_id == command.id


def test_confirm_resolves_depends_on_by_title(tmp_path):
    svc = _svc(tmp_path)
    project = _project(svc)
    drafts = [
        TaskDraft(title="接口契约", role="工程"),
        TaskDraft(title="前端接线", role="工程", depends_on=["接口契约"]),
    ]
    updated = svc.confirm_drafts(project.id, drafts, confirmed_by="acc_boss")

    contract = next(t for t in updated.tasks if t.title == "接口契约")
    wiring = next(t for t in updated.tasks if t.title == "前端接线")
    assert wiring.depends_on == [contract.id]
    assert contract.status == "todo" and wiring.status == "blocked"


def test_confirm_subset_by_indexes(tmp_path):
    """Only the selected drafts are pushed (server-side source of truth)."""
    raw = [
        {"title": "任务A", "role": "工程"},
        {"title": "任务B", "role": "设计"},
        {"title": "任务C", "role": "文案"},
    ]
    svc = _svc(tmp_path, drafter=CommandDraftingService(AnnaHarnessRuntime(_DraftProvider(raw))))
    project = _project(svc)
    command, drafts = svc.draft_tasks_from_message(project.id, "拆一下", "acc_boss")

    selected = [drafts[0], drafts[2]]  # A and C
    updated = svc.confirm_drafts(
        project.id, selected, confirmed_by="acc_boss", source_message_id=command.id
    )
    grown_titles = {t.title for t in updated.tasks if t.origin == "channel"}
    assert grown_titles == {"任务A", "任务C"}


# --- C3 · @Anna coordination confirm card ------------------------------------

# member kind lookup so should_draft_intent can exclude agent authors.
_INTENT_KIND = {
    "acc_boss": "human", "acc_andy": "human",
    "acc_agent_scribe": "agent", "acc_agent_design": "agent",
}


def _intent_svc(tmp_path: Path, drafter=None) -> CrewService:
    return CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        drafter=drafter,
        member_kind=lambda mid: _INTENT_KIND.get(mid),
    )


def test_say_at_anna_with_intent_phrase_drafts_coordination_card(tmp_path):
    svc = _intent_svc(tmp_path)
    project = _project(svc)
    before_tasks = len(project.tasks)
    before_audit = len(project.audit_events)

    msg = svc.say(
        project.id, "acc_boss", "@Anna 帮我加个任务:回归测试登录页三态",
        mentions=[SYSTEM_ANNA_ACTOR_ID],
    )
    assert svc.should_draft_intent(msg) is True

    card = svc.draft_intent_card(project.id, msg)
    assert card is not None
    assert card.kind == "command" and card.author_kind == "anna"
    assert card.payload["origin"] == "anna_coordination"
    assert card.payload["origin_message_id"] == msg.id
    assert card.payload["coordination_actor_id"] == SYSTEM_ANNA_ACTOR_ID
    assert card.payload["caused_by"]["message_id"] == msg.id
    assert card.payload["suggested_assignee"] is None
    assert card.payload["drafts"]  # ≥1 draft carried

    # DRAFT STATE ONLY: no task created, no task audit event written.
    updated = svc.get_project(project.id)
    assert len(updated.tasks) == before_tasks
    assert len(updated.audit_events) == before_audit
    assert not any(e["type"].startswith("crew.task") for e in updated.audit_events)


def test_say_without_anna_or_by_agent_or_chatter_no_intent_card(tmp_path):
    svc = _intent_svc(tmp_path)
    project = _project(svc)

    no_mention = svc.say(project.id, "acc_boss", "帮我加个任务", mentions=[])
    assert svc.should_draft_intent(no_mention) is False

    human_only = svc.say(project.id, "acc_boss", "帮我加个任务 @Andy", mentions=["acc_andy"])
    assert svc.should_draft_intent(human_only) is False

    by_agent = svc.say(
        project.id, "acc_agent_scribe", "帮我加个任务 @Anna", mentions=[SYSTEM_ANNA_ACTOR_ID]
    )
    assert svc.should_draft_intent(by_agent) is False

    chatter = svc.say(project.id, "acc_boss", "收到,辛苦 @Anna", mentions=[SYSTEM_ANNA_ACTOR_ID])
    assert svc.should_draft_intent(chatter) is False


def test_say_at_anna_persists_mention_but_creates_no_notification(tmp_path):
    svc = _intent_svc(tmp_path)
    project = _project(svc)

    msg = svc.say(
        project.id,
        "acc_boss",
        "@Anna 帮我加个任务:补登录页回归",
        mentions=[SYSTEM_ANNA_ACTOR_ID],
    )

    assert msg.mentions == [SYSTEM_ANNA_ACTOR_ID]
    assert svc.list_notifications(project.workspace_id, SYSTEM_ANNA_ACTOR_ID) == []


def test_worker_mention_with_task_intent_steers_without_coordination_card(tmp_path):
    calls = []
    svc = CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        member_kind=lambda mid: _INTENT_KIND.get(mid),
        agent_dispatcher=lambda *args: calls.append(args),
    )
    project = _project(svc)
    task = project.tasks[0]
    task.assignee_member_id = "acc_agent_scribe"
    task.status = "running"
    svc._store.save_project(project)

    msg = svc.say(
        project.id,
        "acc_boss",
        "@Scribe 帮我补充失败态和重试策略",
        mentions=["acc_agent_scribe"],
    )

    assert svc.should_draft_intent(msg) is False
    assert [m.kind for m in svc.list_channel(project.id)].count("command") == 0
    assert calls == [
        (
            project.id,
            task.id,
            project.workspace_id,
            "acc_boss",
            msg.id,
            msg.body,
        )
    ]


def test_intent_card_idempotent_by_origin_message(tmp_path):
    svc = _intent_svc(tmp_path)
    project = _project(svc)
    msg = svc.say(
        project.id, "acc_boss", "@Anna 请你负责登录页回归测试", mentions=[SYSTEM_ANNA_ACTOR_ID]
    )

    first = svc.draft_intent_card(project.id, msg)
    assert first is not None
    channel_len = len(svc.list_channel(project.id))

    second = svc.draft_intent_card(project.id, msg)
    assert second is None  # no duplicate card for the same say
    assert len(svc.list_channel(project.id)) == channel_len


def test_intent_card_is_adoptable_via_existing_confirm(tmp_path):
    """The intent card's drafts flow through the UNCHANGED confirm path."""
    svc = _intent_svc(tmp_path)
    project = _project(svc)
    msg = svc.say(
        project.id, "acc_boss", "@Anna 帮我加个任务:补登录页无障碍检查",
        mentions=[SYSTEM_ANNA_ACTOR_ID],
    )
    card = svc.draft_intent_card(project.id, msg)
    drafts = [TaskDraft.model_validate(d) for d in card.payload["drafts"]]
    before = len(project.tasks)

    updated = svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss", source_message_id=card.id
    )
    grown = [t for t in updated.tasks if t.origin == "channel"]
    assert len(grown) == len(drafts) >= 1
    assert len(updated.tasks) == before + len(drafts)


def test_intent_adopt_assigns_suggested_assignee_to_first_task(tmp_path):
    """R4b 采纳即派:suggested_assignee 派给首个下推任务,走正规 assign 通道
    (频道「已派给」事件随之出现)。"""
    svc = _intent_svc(tmp_path)
    project = _project(svc)
    msg = svc.say(
        project.id,
        "acc_boss",
        "@Anna 新任务:九屏回归走查,建议 Andy 跟进",
        mentions=[SYSTEM_ANNA_ACTOR_ID, "acc_andy"],
    )
    card = svc.draft_intent_card(project.id, msg)
    drafts = [TaskDraft.model_validate(d) for d in card.payload["drafts"]]

    updated = svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss",
        source_message_id=card.id,
        suggested_assignee=card.payload["suggested_assignee"],
    )
    grown = [t for t in updated.tasks if t.origin == "channel"]
    assert grown[0].assignee_member_id == "acc_andy"
    bodies = [m.body for m in svc.list_channel(project.id)]
    assert any("已派给" in b for b in bodies)


def test_intent_adopt_ghost_assignee_silently_skipped(tmp_path):
    """幽灵负责人:不在 roster → 静默跳过,任务保持未指派,确认不失败。"""
    svc = CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        member_kind=lambda mid: _INTENT_KIND.get(mid),
        roster=lambda ws: ["acc_boss", "acc_andy"],
    )
    project = _project(svc)
    msg = svc.say(
        project.id,
        "acc_boss",
        "@Anna 新任务:走查",
        mentions=[SYSTEM_ANNA_ACTOR_ID],
    )
    card = svc.draft_intent_card(project.id, msg)
    drafts = [TaskDraft.model_validate(d) for d in card.payload["drafts"]]

    updated = svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss", source_message_id=card.id,
        suggested_assignee="acc_ghost",
    )
    grown = [t for t in updated.tasks if t.origin == "channel"]
    assert grown[0].assignee_member_id is None
