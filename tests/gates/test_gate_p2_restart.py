"""L2 · run-persistence restart-survival gate (P2 状态外置, the RED).

A minutes-level, code-judged gate for the Harness Runtime long-running round,
slice L2 (Run persistence, pillar **P2 状态外置**). It is the executable
acceptance criterion the implementation must turn green — written and committed
BEFORE any production change.

Scenario (single task, single run, deterministic fake model, on-disk SQLite):

* run a chat run to terminal ``ready`` through an orchestrator wired to a
  SQLite ``SQLiteRunStore`` (write-through persists creation + terminal);
* insert one NON-terminal run (status ``running``) directly into the store — a
  run whose process died mid-flight;
* construct a FRESH store instance + FRESH orchestrator pointing at the SAME
  SQLite file (= a simulated process restart: empty in-memory registry, cold
  store) and run the startup ``mark_stale_interrupted`` sweep;
* assert (a) ``list_runs`` returns the completed run after the restart;
* assert (b) ``get_run`` returns it with ``audit_events`` / ``plan`` /
  ``artifacts`` / ``thread_id`` / ``assistant_message`` intact — deep-equal on
  the whole rehydrated model, not just presence;
* assert (c) the run left non-terminal is reported as ``interrupted`` after the
  sweep (both at the store layer and through the rehydrating orchestrator).

The fake ``stream_model`` (``tests.support.engine_fakes.FakeStreamModel``)
answers from text so the run reaches ``ready`` without any network. This gate
must stay green in every later slice.
"""
from pathlib import Path

from services.chat.app.orchestrator import ChatOrchestrator
from services.chat.app.schemas import ChatRun
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
    """A connected ERP gateway so chat preflight passes (no tool is called here)."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused in this gate
        raise AssertionError("this gate never dispatches a tool")


def _text_answer(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


def _orchestrator(fake: FakeStreamModel, run_store: SQLiteRunStore) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=run_store,
    )


def test_gate_p2_chat_run_survives_a_simulated_process_restart(tmp_path):
    db_path = tmp_path / "anna-runs.sqlite3"

    # --- pre-restart process: run a chat run to terminal, persisted write-through
    store = SQLiteRunStore(db_path)
    fake = FakeStreamModel([_text_answer("记住了，答案是 42。")])
    orchestrator = _orchestrator(fake, store)
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="答案是多少？",
    )
    assert run.status == "ready"
    assert run.assistant_message  # a real answer that must survive the restart

    # A run whose process died mid-flight: left in a non-terminal status. Insert
    # it directly so the sweep — not the orchestrator — is what must heal it.
    zombie_payload = ChatRun(
        id="chat_run_zombie",
        workspace_id="demo",
        actor_user_id="u_demo",
        message="半路中断的问题",
        thread_id="chat_run_zombie",
        status="generating",
    ).model_dump(mode="json")
    zombie_payload["status"] = "running"
    store.save_run(
        surface="chat",
        run_id="chat_run_zombie",
        thread_id="chat_run_zombie",
        workspace_id="demo",
        actor_user_id="u_demo",
        status="running",
        created_at="2020-01-01T00:00:00+00:00",
        payload=zombie_payload,
    )

    # --- simulated process restart: cold store instance + startup sweep + a
    #     brand-new orchestrator whose in-memory registry is empty.
    restarted_store = SQLiteRunStore(db_path)
    swept = restarted_store.mark_stale_interrupted("chat")
    assert swept == 1  # only the zombie was non-terminal; the ready run is untouched
    restarted = _orchestrator(FakeStreamModel([]), restarted_store)
    assert restarted.list_runs("demo", "u_demo") is not None  # registry is cold
    assert not restarted._runs  # nothing survived in memory — everything is from store

    # (a) list survives the restart.
    listed_ids = [item.id for item in restarted.list_runs("demo", "u_demo")]
    assert run.id in listed_ids

    # (b) get returns the run with every field intact — deep-equal, not presence.
    restored = restarted.get_run(run.id)
    assert restored.model_dump(mode="json") == run.model_dump(mode="json")
    assert restored.audit_events == run.audit_events
    assert restored.plan == run.plan
    assert restored.artifacts == run.artifacts
    assert restored.thread_id == run.thread_id
    assert restored.assistant_message == run.assistant_message

    # (c) the run left non-terminal is reported as interrupted after the sweep.
    assert restarted_store.get_run("chat", "chat_run_zombie")["status"] == "interrupted"
    assert restarted.get_run("chat_run_zombie").status == "interrupted"
    # the completed run stays terminal — the sweep never touches it.
    assert restarted_store.get_run("chat", run.id)["status"] == "ready"
