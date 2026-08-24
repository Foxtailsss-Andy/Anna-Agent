"""L3 · disconnect-survival gate (P3 恢复力, the RED).

A minutes-level, code-judged gate for the Harness Runtime long-running round,
slice L3a (background runs + frame journal + resumable subscription, pillar
**P3 恢复力**). It is the executable acceptance criterion the implementation
must turn green — written and committed BEFORE any production change.

Scenario (single task, single run, deterministic EVENT-GATED fake model — the
model parks on an ``asyncio.Event`` mid-stream instead of sleeping, so the drop
is deterministic, never a timing race):

1. submit a run via the NEW background path (``BackgroundRunManager.submit``);
2. open a stream subscription, consume a few frames, then DROP the subscription
   mid-run — close ONLY the consumer (simulated client disconnect), never the
   run;
3. assert the run still reaches terminal ``ready`` (the background task drives it
   to completion, independent of the dropped subscriber — verified via GET run);
4. re-subscribe with ``from_seq=<last seq received>`` — assert the replayed
   frames continue EXACTLY from ``seq+1`` (no gap, no duplicate) through the
   terminal ``done`` frame;
5. assert NO ``client_disconnected`` failure was recorded — the disconnect
   closed the subscription, not the run.

This gate must stay green in every later slice.
"""
from pathlib import Path

import asyncio

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
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


class _GatedStreamModel(FakeStreamModel):
    """Governed fake that PARKS after N text deltas on an ``asyncio.Event``.

    Wraps the governed ``FakeStreamModel`` generator (so ``model.call.started`` /
    ``model.call.completed`` audit stays byte-identical) and, after yielding
    ``pause_after`` text deltas, blocks on ``resume`` — no sleep, so the test
    interleaves the subscriber drop deterministically while the run is provably
    mid-flight (the terminal ``final`` is produced only AFTER ``resume`` is set).
    """

    def __init__(self, scripts, *, resume: asyncio.Event, pause_after: int):
        super().__init__(scripts)
        self._resume = resume
        self._pause_after = pause_after

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        base = super().__call__(
            run_id,
            audit_events,
            request,
            settings=settings,
            config_error_message=config_error_message,
        )
        resume, pause_after = self._resume, self._pause_after

        async def _gated():
            delivered = 0
            async for chunk in base:
                yield chunk
                if chunk.kind == "text_delta":
                    delivered += 1
                    if delivered == pause_after:
                        await resume.wait()

        return _gated()


def _orchestrator(fake: FakeStreamModel, run_store: SQLiteRunStore) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=run_store,
    )


async def _run_gate(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    resume = asyncio.Event()
    deltas = ["本月", "营收", "上升", "，同比", "增长", "12%。"]
    script = [
        [ModelChunk("text_delta", text=text) for text in deltas]
        + [ModelChunk("final", finish_reason="stop")]
    ]
    fake = _GatedStreamModel(script, resume=resume, pause_after=2)
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    # (1) submit via the background path — returns immediately with the run id.
    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="本月营收多少？",
    )
    run_id = run.id
    task = manager.get_task(run_id)  # grab the handle before it can self-clean
    assert task is not None

    # (2) subscribe, consume until we have two streamed deltas, then DROP the
    #     subscription mid-run (close ONLY the consumer — the client disconnect).
    received: list[dict] = []
    subscription = manager.subscribe(run_id, from_seq=0)
    async for frame in subscription:
        received.append(frame)
        if len([f for f in received if f.get("type") == "text_delta"]) >= 2:
            break
    await subscription.aclose()
    last_seq = received[-1]["seq"]
    # Every delivered frame carried a monotonically increasing seq from 1.
    assert [f["seq"] for f in received] == list(range(1, last_seq + 1))

    # (3) the run keeps running to terminal, independent of the dropped consumer.
    resume.set()
    await task
    finished = chat.get_run(run_id)
    assert finished.status == "ready"
    assert finished.assistant_message == "".join(deltas)

    # (5) NO client_disconnected failure — the disconnect closed the subscription,
    #     not the run.
    assert finished.error_code is None
    assert finished.status != "failed"
    audit_types = [event.type for event in finished.audit_events]
    assert "chat.run.failed" not in audit_types
    assert "client_disconnected" not in [
        event.payload.get("error_code") for event in finished.audit_events
    ]

    # (4) re-subscribe from the last received seq: contiguous replay from seq+1
    #     through the terminal done frame (no gap, no duplicate).
    replay: list[dict] = []
    resumed = manager.subscribe(run_id, from_seq=last_seq)
    async for frame in resumed:
        replay.append(frame)
    replay_seqs = [f["seq"] for f in replay]
    assert replay_seqs == list(range(last_seq + 1, last_seq + 1 + len(replay)))
    assert replay[-1]["type"] == "done"
    assert replay[-1]["run"]["status"] == "ready"

    # The union of the two subscriptions covers every seq exactly once, no gap.
    all_seqs = [f["seq"] for f in received] + replay_seqs
    assert all_seqs == list(range(1, all_seqs[-1] + 1))


def test_gate_p3_disconnect_survival(tmp_path):
    asyncio.run(_run_gate(tmp_path))
