"""L2 · CreateOrchestrator run-store wiring (P2 状态外置).

Create's persistent unit is the ``CreateDraftRun`` — it fits the same
write-through shape as chat (creation "generating" → terminal
"ready_for_review"/"saved"/"failed"), with NO conversation thread (thread_id is
always None). Pins write-through, the restart read fallback, and the
persist-failure swallow.
"""
from pathlib import Path

import pytest

from services.create.app.orchestrator import CreateOrchestrator, CreateRunNotFoundError
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.run_store import SQLiteRunStore
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


def _prompt_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_prompt",
                            name="create.emit_prompt_draft",
                            arguments={
                                "prompt_id": "finance/monthly-review",
                                "title": "月度复盘 Prompt",
                                "description": "Summarize monthly data.",
                                "body": "请基于 {period} 生成复盘。",
                                "variables": ["period"],
                            },
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ]
        ]
    )


def _orchestrator(fake: FakeStreamModel, run_store, tmp_path) -> CreateOrchestrator:
    project_root = tmp_path / "project"
    project_root.mkdir(exist_ok=True)
    return CreateOrchestrator(
        engine=QueryEngine(settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)),
        settings=_CONFIGURED_SETTINGS,
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
        run_store=run_store,
    )


def test_terminal_draft_is_written_through_to_the_store(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    orchestrator = _orchestrator(_prompt_stream(), store, tmp_path)

    run = orchestrator.create_draft(
        workspace_id="demo", actor_user_id="u_demo", prompt="做个复盘 Prompt", kind="prompt"
    )

    assert run.status == "ready_for_review"
    persisted = store.get_run("create", run.id)
    assert persisted is not None
    assert persisted["status"] == "ready_for_review"
    assert persisted["kind"] == "prompt"


def test_invalid_kind_run_is_written_through_as_failed(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    orchestrator = _orchestrator(_prompt_stream(), store, tmp_path)

    run = orchestrator.create_draft(
        workspace_id="demo", actor_user_id="u_demo", prompt="x", kind="not_a_kind"
    )

    assert run.status == "failed"
    assert store.get_run("create", run.id)["status"] == "failed"


def test_get_and_list_fall_back_to_store_after_a_restart(tmp_path):
    db = tmp_path / "anna-runs.sqlite3"
    first = _orchestrator(_prompt_stream(), SQLiteRunStore(db), tmp_path)
    run = first.create_draft(
        workspace_id="demo", actor_user_id="u_demo", prompt="做个复盘 Prompt", kind="prompt"
    )

    restarted = _orchestrator(_prompt_stream(), SQLiteRunStore(db), tmp_path)
    assert not restarted._runs
    assert restarted.get_run(run.id).id == run.id
    assert [r.id for r in restarted.list_runs("demo", "u_demo")] == [run.id]


def test_persist_failure_does_not_break_the_draft(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")

    def _boom(*args, **kwargs):
        raise RuntimeError("disk on fire")

    store.save_run = _boom
    orchestrator = _orchestrator(_prompt_stream(), store, tmp_path)

    run = orchestrator.create_draft(
        workspace_id="demo", actor_user_id="u_demo", prompt="做个复盘 Prompt", kind="prompt"
    )

    assert run.status == "ready_for_review"  # completes despite every write failing
    assert orchestrator.get_run(run.id) is run


# --- corrupt store row is skipped, never sinks recovery (guarded rehydration) ---


def test_corrupt_store_row_is_skipped_by_get_and_list(tmp_path):
    db = tmp_path / "anna-runs.sqlite3"
    store = SQLiteRunStore(db)
    orchestrator = _orchestrator(_prompt_stream(), store, tmp_path)
    healthy = orchestrator.create_draft(
        workspace_id="demo", actor_user_id="u_demo", prompt="做个复盘 Prompt", kind="prompt"
    )

    # Inject a corrupt payload row (same owner) that no longer validates as a
    # CreateDraftRun — it must not sink the healthy draft on a restart read.
    store.save_run(
        surface="create",
        run_id="create_run_corrupt",
        thread_id=None,
        workspace_id="demo",
        actor_user_id="u_demo",
        status="ready_for_review",
        created_at="2026-07-13T00:00:00Z",
        payload={"id": "create_run_corrupt", "corrupt": True},
    )

    restarted = _orchestrator(_prompt_stream(), SQLiteRunStore(db), tmp_path)

    # list_runs skips the corrupt row, keeps the healthy draft.
    assert [r.id for r in restarted.list_runs("demo", "u_demo")] == [healthy.id]

    # get_run on the corrupt id treats it as ABSENT (not-found), not a crash.
    with pytest.raises(CreateRunNotFoundError):
        restarted.get_run("create_run_corrupt")
    assert restarted.get_run(healthy.id).id == healthy.id
