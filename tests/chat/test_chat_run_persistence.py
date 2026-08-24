"""L2 · ChatOrchestrator run-store wiring (P2 状态外置).

Beyond the minutes-level gate: write-through on creation + terminal, the read
fallback (registry first, store on a miss, registry wins on a dupe), the
persist-failure swallow (a store error never breaks a live run), and thread
history surviving a simulated restart via the L2 seam.
"""
from pathlib import Path

import pytest

from services.chat.app.orchestrator import ChatOrchestrator, ChatRunNotFoundError
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused here
        raise AssertionError("these tests never dispatch a tool")


def _answer(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


def _orchestrator(fake: FakeStreamModel, run_store) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=run_store,
    )


# --- write-through: creation + terminal ----------------------------------------


def test_terminal_run_is_written_through_to_the_store(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    orchestrator = _orchestrator(FakeStreamModel([_answer("答案。")]), store)

    run = orchestrator.start_run(workspace_id="demo", actor_user_id="u_demo", message="问")

    persisted = store.get_run("chat", run.id)
    assert persisted is not None
    assert persisted["status"] == "ready"
    assert persisted["assistant_message"] == "答案。"


def test_failed_run_is_written_through_as_failed(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    # Empty response → chat_response_empty → failed terminal.
    orchestrator = _orchestrator(FakeStreamModel([[ModelChunk("final", finish_reason="stop")]]), store)

    run = orchestrator.start_run(workspace_id="demo", actor_user_id="u_demo", message="问")

    assert run.status == "failed"
    assert store.get_run("chat", run.id)["status"] == "failed"


# --- read fallback: registry first, store on a miss, registry wins -------------


def test_get_and_list_fall_back_to_store_after_a_restart(tmp_path):
    db = tmp_path / "anna-runs.sqlite3"
    store = SQLiteRunStore(db)
    first = _orchestrator(FakeStreamModel([_answer("答案。")]), store)
    run = first.start_run(workspace_id="demo", actor_user_id="u_demo", message="问")

    # Fresh process: cold registry, same on-disk store.
    restarted = _orchestrator(FakeStreamModel([]), SQLiteRunStore(db))
    assert not restarted._runs
    assert restarted.get_run(run.id).id == run.id
    assert [r.id for r in restarted.list_runs("demo", "u_demo")] == [run.id]


def test_list_dedupes_registry_and_store_with_registry_winning(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    orchestrator = _orchestrator(FakeStreamModel([_answer("鲜活答案。")]), store)
    run = orchestrator.start_run(workspace_id="demo", actor_user_id="u_demo", message="问")

    # Diverge the store copy from the live registry copy under the SAME run id.
    stale = store.get_run("chat", run.id)
    stale["assistant_message"] = "过期答案。"
    store.save_run(
        surface="chat",
        run_id=run.id,
        thread_id=run.thread_id,
        workspace_id="demo",
        actor_user_id="u_demo",
        status="ready",
        created_at=run.audit_events[0].created_at,
        payload=stale,
    )

    listed = orchestrator.list_runs("demo", "u_demo")
    assert len(listed) == 1  # one entry, not two
    assert listed[0].assistant_message == "鲜活答案。"  # the in-memory version wins


# --- persist-failure swallow ---------------------------------------------------


def test_persist_failure_does_not_break_the_run(tmp_path):
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")

    def _boom(*args, **kwargs):
        raise RuntimeError("disk on fire")

    store.save_run = _boom  # every write-through now raises
    orchestrator = _orchestrator(FakeStreamModel([_answer("答案。")]), store)

    run = orchestrator.start_run(workspace_id="demo", actor_user_id="u_demo", message="问")

    # The run still completes and stays live in the registry — honest degradation.
    assert run.status == "ready"
    assert run.assistant_message == "答案。"
    assert orchestrator.get_run(run.id) is run


# --- thread history survives a restart via the L2 seam -------------------------


def test_thread_history_merges_store_runs_after_a_restart(tmp_path):
    db = tmp_path / "anna-runs.sqlite3"
    first = _orchestrator(FakeStreamModel([_answer("记住了：42。")]), SQLiteRunStore(db))
    run_a = first.start_run(workspace_id="demo", actor_user_id="u_demo", message="记住 42")

    # Restart: a NEW turn on the same thread, cold registry, history from disk.
    fake_b = FakeStreamModel([_answer("42 加 3 = 45。")])
    restarted = _orchestrator(fake_b, SQLiteRunStore(db))
    run_b = restarted.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="它加 3？",
        thread_id=run_a.thread_id,
    )

    assert run_b.status == "ready"
    # B's model request carried A's prior turn — recovered purely from the store.
    pairs = [(m["role"], m.get("content")) for m in fake_b.requests[0].messages]
    assert ("user", "记住 42") in pairs
    assert ("assistant", "记住了：42。") in pairs
    continued = [e for e in run_b.audit_events if e.type == "chat.thread.continued"]
    assert continued and continued[0].payload == {"thread_id": run_a.thread_id, "prior_turns": 1}


# --- corrupt store row is skipped, never sinks recovery (guarded rehydration) ---


def test_corrupt_store_row_is_skipped_by_get_list_and_thread_history(tmp_path):
    db = tmp_path / "anna-runs.sqlite3"
    store = SQLiteRunStore(db)
    orchestrator = _orchestrator(FakeStreamModel([_answer("记住了：42。")]), store)
    healthy = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="记住 42"
    )

    # Inject a corrupt payload row directly — same owner + thread as the healthy
    # run, but a payload that no longer validates as a ChatRun (schema drift or a
    # truncated write). One bad row must never sink the healthy run.
    store.save_run(
        surface="chat",
        run_id="chat_run_corrupt",
        thread_id=healthy.thread_id,
        workspace_id="demo",
        actor_user_id="u_demo",
        status="ready",
        created_at="2026-07-13T00:00:00Z",
        payload={"id": "chat_run_corrupt", "corrupt": True},
    )

    # Fresh process (cold registry) so every read goes through the store guard.
    restarted = _orchestrator(
        FakeStreamModel([_answer("42 加 3 = 45。")]), SQLiteRunStore(db)
    )

    # list_runs skips the corrupt row, keeps the healthy one.
    assert [r.id for r in restarted.list_runs("demo", "u_demo")] == [healthy.id]

    # get_run on the corrupt id treats it as ABSENT (not-found), not a crash.
    with pytest.raises(ChatRunNotFoundError):
        restarted.get_run("chat_run_corrupt")
    assert restarted.get_run(healthy.id).id == healthy.id

    # Thread history survives: a new turn on the same thread still recovers the
    # healthy prior turn, skipping the corrupt sibling row.
    run_b = restarted.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="它加 3？",
        thread_id=healthy.thread_id,
    )
    assert run_b.status == "ready"
    continued = [e for e in run_b.audit_events if e.type == "chat.thread.continued"]
    assert continued and continued[0].payload == {
        "thread_id": healthy.thread_id,
        "prior_turns": 1,
    }
