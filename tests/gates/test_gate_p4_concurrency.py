"""L5 · concurrency-governance gate (P4 并行隔离, the RED).

A minutes-level, code-judged gate for the Harness Runtime long-running round,
slice L5 (per-workspace run semaphore + honest queueing visibility). It is the
executable acceptance criterion the implementation must turn green — written and
committed BEFORE any production change.

Scenario (deterministic, EVENT-GATED fake models — every model call parks on its
own ``asyncio.Event``, so the interleaving is proved by event ordering, never by
sleeps; a test config pins ``per_workspace_runs=1`` so the second run of each
workspace MUST queue):

1. submit 4 background runs — A1/A2 in workspace ``ws_a``, B1/B2 in ``ws_b``;
2. honest queueing visibility: while A1/B1 are still parked mid-model-call, A2/B2
   carry a ``run.queued {workspace_id}`` audit event AND that event frame is
   already journaled (write-through visible to a live subscriber) — the queue is
   observable WHILE it is happening, not after;
3. cross-workspace independence: with A1 still parked (workspace A fully
   occupied), workspace B's queue drains completely — B1 finishes, B2 acquires
   B's slot, runs, and finishes — while A2 provably never started (its model
   call never began). A's queue cannot delay B;
4. all 4 runs reach terminal ``ready``; the second run of EACH workspace carries
   exactly one ``run.queued`` audit event (and exactly one journaled event
   frame) while the first of each carries none;
5. audit isolation: every audit event on each run's ``audit_events`` references
   that run's ``run_id`` only (no cross-run bleed);
6. journal isolation: each run's journaled frame ``seq`` is contiguous from 1,
   and every journaled audit-event frame belongs to that run.

This gate must stay green in every later slice.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel

def _gate_settings() -> RuntimeSettings:
    """Per-workspace limit 1: the second run of each workspace MUST truly queue.

    Built lazily (not at module scope) so the pre-implementation RED is a test
    FAILURE, not a collection error, while the field is still missing.
    """
    return RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key",
        erp_mcp_server="https://erp.example/mcp",
        concurrency_per_workspace_runs=1,
    )

# Generous guard so a regression FAILS loudly instead of hanging the suite; the
# healthy path never comes near it (everything is event-gated, no sleeps).
_STEP_TIMEOUT_SECONDS = 10.0

_MESSAGES = {
    "A1": "任务甲一:盘点本月营收。",
    "A2": "任务甲二:盘点本月成本。",
    "B1": "任务乙一:盘点客户合同。",
    "B2": "任务乙二:盘点回款进度。",
}


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


class _PerRunGatedModel(FakeStreamModel):
    """Governed fake where EVERY model call parks on its own ``asyncio.Event``.

    The call is keyed by which scripted task message appears in the request's
    last user message (each run has a distinct message), so the test can release
    each run individually and observe ``started`` per run — deterministic
    event-gated ordering, no positional-script coupling to scheduling order.
    """

    def __init__(self, release: dict[str, asyncio.Event], started: dict[str, asyncio.Event]):
        super().__init__()
        self._release = release
        self._started = started

    def _key(self, request: ModelRequest) -> str:
        last_user = ""
        for message in request.messages:
            if message.get("role") == "user":
                last_user = str(message.get("content") or "")
        for key, text in _MESSAGES.items():
            if text in last_user:
                return key
        raise AssertionError(f"request carries no known task message: {last_user!r}")

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=f"{self._key(request)} 已办妥。",
            tool_calls=[],
            finish_reason="stop",
        )

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        key = self._key(request)
        base = super().__call__(
            run_id,
            audit_events,
            request,
            settings=settings,
            config_error_message=config_error_message,
        )
        started, release = self._started[key], self._release[key]

        async def _gated():
            started.set()
            await release.wait()
            async for chunk in base:
                yield chunk

        return _gated()


def _orchestrator(fake: FakeStreamModel, store: SQLiteRunStore) -> ChatOrchestrator:
    settings = _gate_settings()
    return ChatOrchestrator(
        engine=QueryEngine(settings=settings, deps=QueryDeps(stream_model=fake)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
        run_store=store,
    )


async def _wait(event: asyncio.Event) -> None:
    await asyncio.wait_for(event.wait(), timeout=_STEP_TIMEOUT_SECONDS)


async def _finish(task: asyncio.Task) -> None:
    await asyncio.wait_for(task, timeout=_STEP_TIMEOUT_SECONDS)


def _queued_events(run) -> list:
    return [event for event in run.audit_events if event.type == "run.queued"]


def _queued_frames(frames: list[dict]) -> list[dict]:
    return [
        frame
        for frame in frames
        if frame.get("type") == "event"
        and frame.get("event", {}).get("type") == "run.queued"
    ]


async def _run_gate(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    release = {key: asyncio.Event() for key in _MESSAGES}
    started = {key: asyncio.Event() for key in _MESSAGES}
    fake = _PerRunGatedModel(release, started)
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    workspaces = {"A1": "ws_a", "A2": "ws_a", "B1": "ws_b", "B2": "ws_b"}
    runs = {
        key: manager.submit(
            workspace_id=workspaces[key],
            actor_user_id="u_demo",
            message=_MESSAGES[key],
        )
        for key in ("A1", "A2", "B1", "B2")
    }
    tasks = {key: manager.get_task(runs[key].id) for key in runs}
    assert all(task is not None for task in tasks.values())

    # (2) Both first runs hold their workspace slots concurrently (parked
    #     mid-model-call); the second run of each workspace has NOT started.
    await _wait(started["A1"])
    await _wait(started["B1"])
    assert not started["A2"].is_set()
    assert not started["B2"].is_set()

    # Honest queueing visibility — WHILE A2/B2 are still queued: the run carries
    # the run.queued audit event and the event frame is already journaled
    # (write-through), so a live subscriber sees the queue as it happens.
    for key in ("A2", "B2"):
        queued_now = _queued_events(chat.get_run(runs[key].id))
        assert len(queued_now) == 1, f"{key} must carry run.queued while parked"
        assert queued_now[0].payload == {"workspace_id": workspaces[key]}
        journaled_now = _queued_frames(store.list_frames("chat", runs[key].id, 0))
        assert len(journaled_now) == 1, f"{key}'s run.queued frame must journal live"
    for key in ("A1", "B1"):
        assert _queued_events(chat.get_run(runs[key].id)) == []

    # (3) Cross-workspace independence: workspace B's queue drains COMPLETELY
    #     while A1 keeps A's only slot parked — A2 must never start throughout.
    release["B1"].set()
    await _finish(tasks["B1"])
    await _wait(started["B2"])  # B2 acquired B's freed slot...
    assert not started["A2"].is_set()  # ...while A's queue is provably untouched
    release["B2"].set()
    await _finish(tasks["B2"])
    assert not started["A2"].is_set()

    # Now drain workspace A: A1 finishes → A2 acquires and finishes.
    release["A1"].set()
    await _finish(tasks["A1"])
    await _wait(started["A2"])
    release["A2"].set()
    await _finish(tasks["A2"])

    # (4) All 4 reach terminal ready; queued audit exactly-once on A2/B2 only.
    for key, run in runs.items():
        finished = chat.get_run(run.id)
        assert finished.status == "ready", f"{key}: {finished.error_code}"
        assert finished.assistant_message == f"{key} 已办妥。"
        expected_queued = 1 if key in ("A2", "B2") else 0
        assert len(_queued_events(finished)) == expected_queued, key

    # (5) Audit isolation: every audit event on each run references ONLY that
    #     run's run_id — no cross-run bleed under concurrency.
    for key, run in runs.items():
        finished = chat.get_run(run.id)
        assert finished.audit_events, key
        assert {event.run_id for event in finished.audit_events} == {run.id}, key

    # (6) Journal isolation: per-run frame seqs contiguous from 1; every
    #     journaled audit-event frame belongs to that run; queued frame count
    #     matches (4); the terminal done frame closes each journal.
    for key, run in runs.items():
        frames = store.list_frames("chat", run.id, 0)
        assert frames, key
        assert [frame["seq"] for frame in frames] == list(range(1, len(frames) + 1)), key
        event_run_ids = {
            frame["event"]["run_id"] for frame in frames if frame.get("type") == "event"
        }
        assert event_run_ids == {run.id}, key
        expected_queued = 1 if key in ("A2", "B2") else 0
        assert len(_queued_frames(frames)) == expected_queued, key
        assert frames[-1]["type"] == "done", key
        assert frames[-1]["run"]["status"] == "ready", key


def test_gate_p4_concurrency_workspace_isolation_and_queueing(tmp_path):
    asyncio.run(_run_gate(tmp_path))
