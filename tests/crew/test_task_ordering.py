"""「＋任务」ordering: ``insert_before`` (ticket P · AC4).

Seams: ``CrewService.draft_tasks_from_message`` / ``confirm_drafts`` with the
real ``CommandDraftingService``; the model is faked at the provider boundary.
"""
from __future__ import annotations

from pathlib import Path

from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.schemas import TaskDraft
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelResponse, ModelToolCall


class _DraftProvider:
    """Configured fake model provider: records requests, emits fixed drafts."""

    def __init__(self, drafts):
        self.settings = RuntimeSettings(model_endpoint="https://m.example/v1", model_api_key="k")
        self.requests = []
        self._drafts = drafts

    async def create_response(self, request):
        self.requests.append(request)
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="c1", name="crew.emit_task_drafts", arguments={"drafts": self._drafts}
                )
            ],
            finish_reason="tool_calls",
        )


def _svc(tmp_path: Path, provider=None) -> CrewService:
    drafter = CommandDraftingService(AnnaHarnessRuntime(provider)) if provider else None
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"), drafter=drafter)


def _marketing(svc: CrewService):
    return svc.create_project("ws_crew_demo", "acc_boss", "秋季营销物料", "marketing_collateral")


def _task(project, title):
    return next(t for t in project.tasks if t.title == title)


def _finish(svc: CrewService, project_id: str, task_id: str) -> None:
    svc.assign(project_id, task_id, "acc_boss")
    svc.start(project_id, task_id)
    svc.submit(project_id, task_id, "done")


def _confirm_command(svc, project, command):
    drafts = [TaskDraft.model_validate(d) for d in command.payload["drafts"]]
    return svc.confirm_drafts(
        project.id, drafts, confirmed_by="acc_boss", source_message_id=command.id
    )


def test_drafter_prompt_lists_existing_tasks_and_parses_insert_before(tmp_path):
    provider = _DraftProvider(
        [{"title": "竞品调研", "role": "设计", "insert_before": ["文案撰写"]}]
    )
    svc = _svc(tmp_path, provider)
    project = _marketing(svc)

    command, drafts = svc.draft_tasks_from_message(
        project.id, "加一个竞品调研，放在文案撰写之前", "acc_boss"
    )

    assert drafts[0].insert_before == ["文案撰写"]
    assert command.payload["drafts"][0]["insert_before"] == ["文案撰写"]
    user_prompt = next(
        m["content"] for m in provider.requests[0].messages if m["role"] == "user"
    )
    # Every existing task reaches the model with its role and current status.
    assert "营销 Brief（职能：PM，状态：todo）" in user_prompt
    assert "文案撰写（职能：文案，状态：blocked）" in user_prompt
    assert "insert_before" in user_prompt


def test_deterministic_fallback_has_no_ordering(tmp_path):
    svc = _svc(tmp_path)
    project = _marketing(svc)

    _command, drafts = svc.draft_tasks_from_message(project.id, "放在文案撰写之前", "acc_boss")

    assert drafts[0].insert_before == []


def test_confirmed_insert_before_makes_existing_task_wait_for_the_new_task(tmp_path):
    provider = _DraftProvider(
        [{"title": "竞品调研", "role": "设计", "insert_before": ["文案撰写"]}]
    )
    svc = _svc(tmp_path, provider)
    project = _marketing(svc)
    command, _drafts = svc.draft_tasks_from_message(project.id, "竞品调研放在文案撰写之前", "acc_boss")

    updated = _confirm_command(svc, project, command)

    research = _task(updated, "竞品调研")
    copy = _task(updated, "文案撰写")
    assert research.status == "todo"
    assert research.id in copy.depends_on
    assert copy.status == "blocked"

    # Replaying the same confirm changes nothing (no duplicate edge or rows).
    channel_len = len(svc.list_channel(project.id))
    replay = _confirm_command(svc, project, command)
    assert _task(replay, "文案撰写").depends_on.count(research.id) == 1
    assert len(svc.list_channel(project.id)) == channel_len

    # The original upstream finishing is no longer enough …
    _finish(svc, project.id, _task(updated, "营销 Brief").id)
    assert _task(svc.get_project(project.id), "文案撰写").status == "blocked"
    # … the copy task becomes ready only once the inserted task is done.
    _finish(svc, project.id, research.id)
    assert _task(svc.get_project(project.id), "文案撰写").status == "todo"


def test_ready_target_is_pushed_back_to_blocked(tmp_path):
    svc = _svc(tmp_path)
    project = _marketing(svc)
    _finish(svc, project.id, _task(project, "营销 Brief").id)
    assert _task(svc.get_project(project.id), "文案撰写").status == "todo"

    updated = svc.confirm_drafts(
        project.id,
        [TaskDraft(title="竞品调研", role="设计", insert_before=["文案撰写"])],
        confirmed_by="acc_boss",
    )

    assert _task(updated, "文案撰写").status == "blocked"


def test_started_or_done_targets_are_skipped_and_reported(tmp_path):
    svc = _svc(tmp_path)
    project = _marketing(svc)
    brief = _task(project, "营销 Brief")
    copy = _task(project, "文案撰写")
    _finish(svc, project.id, brief.id)  # 营销 Brief → done
    svc.assign(project.id, copy.id, "acc_boss")
    svc.start(project.id, copy.id)  # 文案撰写 → running

    updated = svc.confirm_drafts(
        project.id,
        [
            TaskDraft(
                title="竞品调研", role="设计", insert_before=["营销 Brief", "文案撰写", "不存在的任务"]
            )
        ],
        confirmed_by="acc_boss",
    )

    research = _task(updated, "竞品调研")
    assert research.id not in _task(updated, "营销 Brief").depends_on
    assert research.id not in _task(updated, "文案撰写").depends_on
    assert _task(updated, "营销 Brief").status == "done"
    assert _task(updated, "文案撰写").status == "running"
    confirmation = svc.list_channel(project.id)[-1]
    assert confirmation.kind == "event" and "已确认下推 1 项任务" in confirmation.body
    assert "“营销 Brief”（已完成）" in confirmation.body
    assert "“文案撰写”（执行中）" in confirmation.body
    assert "“不存在的任务”（未找到）" in confirmation.body


def test_insert_before_that_would_create_a_cycle_is_skipped(tmp_path):
    svc = _svc(tmp_path)
    project = _marketing(svc)

    updated = svc.confirm_drafts(
        project.id,
        [
            TaskDraft(
                title="竞品调研", role="设计",
                depends_on=["文案撰写"], insert_before=["营销 Brief"],
            )
        ],
        confirmed_by="acc_boss",
    )

    research = _task(updated, "竞品调研")
    assert research.id not in _task(updated, "营销 Brief").depends_on
    assert _task(updated, "营销 Brief").status == "todo"
    assert "“营销 Brief”（会形成循环依赖）" in svc.list_channel(project.id)[-1].body
