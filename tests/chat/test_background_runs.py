"""L3a background runs — submit / resumable subscribe / stop (pillar P3 恢复力).

Two layers:

* manager-level (deterministic via ``asyncio.run`` + an EVENT-GATED fake model
  that parks mid-stream): submit returns immediately while the run progresses;
  an explicit stop finalizes ``stopped_by_user`` + cancels the task + journals a
  closing frame; a dropped subscriber never cancels the background task; a
  finished run replays purely from the SQLite store (no live journal).
* route-level (``TestClient``): the HTTP contract for ``/submit`` and ``/stop``
  (immediate ``generating``, identity 403, unknown 404, terminal no-op) and a
  resumable ``/stream`` replay of a finished run from disk.

The gate (``tests/gates/test_gate_p3_disconnect.py``) covers the end-to-end
disconnect-survival scenario; these pin the individual pieces.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)

HEADERS = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"}


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused
        raise AssertionError("these tests never dispatch a tool")


class _GatedStreamModel(FakeStreamModel):
    """Governed fake that parks after ``pause_after`` text deltas on an Event."""

    def __init__(self, scripts, *, resume: asyncio.Event, pause_after: int):
        super().__init__(scripts)
        self._resume = resume
        self._pause_after = pause_after

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        base = super().__call__(
            run_id, audit_events, request,
            settings=settings, config_error_message=config_error_message,
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


def _plain_script(deltas: list[str]) -> list[list[ModelChunk]]:
    return [
        [ModelChunk("text_delta", text=t) for t in deltas]
        + [ModelChunk("final", finish_reason="stop")]
    ]


def _orchestrator(fake: FakeStreamModel, run_store: SQLiteRunStore | None) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=run_store,
    )


class _FrameWriteFailureStore(SQLiteRunStore):
    def __init__(self, db_path):
        super().__init__(db_path)
        self.fail_frame_writes = True

    def append_frame(self, surface, run_id, seq, frame):
        if self.fail_frame_writes:
            raise OSError("frame journal database is unavailable")
        super().append_frame(surface, run_id, seq, frame)


# --- manager level (deterministic) ------------------------------------------


def test_submit_returns_immediately_while_run_progresses(tmp_path):
    async def _run():
        resume = asyncio.Event()
        fake = _GatedStreamModel(_plain_script(["本月", "营收", "上升。"]), resume=resume, pause_after=1)
        chat = _orchestrator(fake, SQLiteRunStore(tmp_path / "runs.sqlite3"))
        manager = BackgroundRunManager(chat)

        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="营收？")
        # Immediate return: the background task has not run yet (still generating).
        assert run.status == "generating"
        task = manager.get_task(run.id)

        # Drive the loop until the model parks: consume the first streamed delta.
        subscription = manager.subscribe(run.id, from_seq=0)
        saw_delta = False
        async for frame in subscription:
            if frame["type"] == "text_delta":
                saw_delta = True
                break
        await subscription.aclose()
        assert saw_delta  # the run progressed (a token streamed) while generating
        assert chat.get_run(run.id).status == "generating"  # still mid-run (parked)

        resume.set()
        await task
        assert chat.get_run(run.id).status == "ready"
        assert chat.get_run(run.id).assistant_message == "本月营收上升。"

    asyncio.run(_run())


def test_frame_persistence_failure_terminates_with_explicit_gap_telemetry(tmp_path):
    async def _run():
        store = _FrameWriteFailureStore(tmp_path / "runs.sqlite3")
        chat = _orchestrator(FakeStreamModel(_plain_script(["完成"])), store)
        manager = BackgroundRunManager(chat)

        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="运行")
        task = manager.get_task(run.id)
        assert task is not None
        await task

        finished = chat.get_run(run.id)
        telemetry = manager.telemetry(run.id)
        frames_before_recovery = store.list_frames("chat", run.id)
        store.fail_frame_writes = False
        restarted_chat = _orchestrator(FakeStreamModel([]), store)
        restarted_manager = BackgroundRunManager(restarted_chat)
        recovered = [
            frame async for frame in restarted_manager.subscribe(run.id, from_seq=0)
        ]
        restarted_state = restarted_chat.get_run(run.id)
        return (
            finished,
            telemetry,
            frames_before_recovery,
            store,
            run.id,
            recovered,
            restarted_state,
        )

    (
        finished,
        telemetry,
        frames_before_recovery,
        store,
        run_id,
        recovered,
        restarted_state,
    ) = asyncio.run(_run())
    assert finished.status == "ready"
    assert telemetry["terminal"] is True
    assert telemetry["durability_degraded"] is True
    assert telemetry["durable_seq"] is None
    assert telemetry["pending_persistence_seqs"] == list(
        range(1, telemetry["last_seq"] + 1)
    )
    assert frames_before_recovery == []
    assert [frame["type"] for frame in recovered] == ["event", "error"]
    assert recovered[0]["event"]["type"] == "run.durability_gap"
    assert recovered[-1]["error_code"] == "durable_gap"
    assert recovered[-1]["run"]["status"] == "failed"
    assert recovered[-1]["run"]["error_code"] == "durable_gap"
    assert restarted_state.status == "failed"
    assert restarted_state.error_code == "durable_gap"
    assert [frame["seq"] for frame in store.list_frames("chat", run_id)] == [1, 2]


def test_stop_mid_run_finalizes_stopped_by_user_and_closes(tmp_path):
    async def _run():
        resume = asyncio.Event()
        fake = _GatedStreamModel(_plain_script(["本月", "营收", "上升。"]), resume=resume, pause_after=1)
        chat = _orchestrator(fake, SQLiteRunStore(tmp_path / "runs.sqlite3"))
        manager = BackgroundRunManager(chat)

        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="营收？")
        task = manager.get_task(run.id)

        # Drive until the model parks (one streamed delta received).
        subscription = manager.subscribe(run.id, from_seq=0)
        async for frame in subscription:
            if frame["type"] == "text_delta":
                break
        await subscription.aclose()

        stopped = await manager.stop(run.id)
        assert stopped.status == "failed"
        assert stopped.error_code == "stopped_by_user"

        # The background task is cancelled and cleaned up.
        with contextlib.suppress(asyncio.CancelledError):
            await task
        assert task.cancelled()
        assert manager.get_task(run.id) is None

        # Subscribers see closure: replay from disk ends on a terminal error frame
        # carrying the stopped_by_user run.
        replay = [frame async for frame in manager.subscribe(run.id, from_seq=0)]
        assert replay[-1]["type"] == "error"
        assert replay[-1]["run"]["error_code"] == "stopped_by_user"
        # The run itself is finalized stopped_by_user, never client_disconnected.
        finalized = chat.get_run(run.id)
        assert finalized.status == "failed"
        assert finalized.error_code == "stopped_by_user"
        assert "client_disconnected" not in [
            e.payload.get("error_code") for e in finalized.audit_events
        ]

    asyncio.run(_run())


def test_stop_already_terminal_run_is_a_noop(tmp_path):
    async def _run():
        fake = FakeStreamModel(_plain_script(["完成。"]))
        chat = _orchestrator(fake, SQLiteRunStore(tmp_path / "runs.sqlite3"))
        manager = BackgroundRunManager(chat)
        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="hi")
        await manager.get_task(run.id)  # let it finish naturally
        assert chat.get_run(run.id).status == "ready"

        stopped = await manager.stop(run.id)  # no-op on a terminal run
        assert stopped.status == "ready"
        assert stopped.error_code is None

    asyncio.run(_run())


def test_dropped_subscriber_does_not_cancel_the_background_task(tmp_path):
    async def _run():
        resume = asyncio.Event()
        fake = _GatedStreamModel(_plain_script(["本月", "营收", "上升。"]), resume=resume, pause_after=1)
        chat = _orchestrator(fake, SQLiteRunStore(tmp_path / "runs.sqlite3"))
        manager = BackgroundRunManager(chat)

        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="营收？")
        task = manager.get_task(run.id)

        subscription = manager.subscribe(run.id, from_seq=0)
        async for frame in subscription:
            if frame["type"] == "text_delta":
                break
        await subscription.aclose()  # client disconnect — close ONLY the subscription

        assert not task.done()  # the background task is untouched by the drop
        resume.set()
        await task
        assert task.cancelled() is False
        assert chat.get_run(run.id).status == "ready"

    asyncio.run(_run())


def test_finished_run_replays_purely_from_the_store(tmp_path):
    async def _run():
        fake = FakeStreamModel(_plain_script(["本月", "营收", "上升。"]))
        chat = _orchestrator(fake, SQLiteRunStore(tmp_path / "runs.sqlite3"))
        manager = BackgroundRunManager(chat)
        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="营收？")
        await manager.get_task(run.id)  # run to completion

        # No live journal remains — replay is a pure SQLite read-through.
        assert run.id not in manager._journals
        replay = [frame async for frame in manager.subscribe(run.id, from_seq=0)]
        seqs = [f["seq"] for f in replay]
        assert seqs == list(range(1, len(replay) + 1))  # contiguous from 1
        assert replay[-1]["type"] == "done"
        assert replay[-1]["run"]["status"] == "ready"
        # A mid-stream from_seq replays only the tail (no gap, no duplicate).
        tail = [frame async for frame in manager.subscribe(run.id, from_seq=3)]
        assert [f["seq"] for f in tail] == list(range(4, len(replay) + 1))
        telemetry = manager.telemetry(run.id)
        assert telemetry["resume_subscription_count"] >= 1
        assert telemetry["frames_emitted"] >= len(replay) + len(tail)

    asyncio.run(_run())


# --- L4a 续办: awaiting_continue resume / restart / stop ----------------------

_CONTINUE_MARKER = "继续完成剩余任务"


class _ToolUntilContinueModel(FakeStreamModel):
    """Tool-loops every turn until the resume nudge appears, then finishes."""

    def respond(self, request):
        last_user = ""
        for message in request.messages:
            if message.get("role") == "user":
                last_user = str(message.get("content") or "")
        if _CONTINUE_MARKER in last_user:
            return ModelResponse(
                assistant_message="收尾完成。", tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message=None,
            tool_calls=[
                ModelToolCall(
                    id="call_plan",
                    name="plan.update",
                    arguments={"items": [{"id": "1", "title": "推进", "status": "in_progress"}]},
                )
            ],
            finish_reason="tool_calls",
        )


def test_awaiting_continue_run_survives_restart_and_still_continues(tmp_path):
    async def _run():
        db = tmp_path / "runs.sqlite3"
        chat = _orchestrator(_ToolUntilContinueModel(), SQLiteRunStore(db))
        manager = BackgroundRunManager(chat)
        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="多步任务")
        await manager.get_task(run.id)
        assert chat.get_run(run.id).status == "awaiting_continue"

        # Simulated process restart: a cold store + a brand-new orchestrator /
        # manager (empty in-memory registry). The run rehydrates from disk.
        restarted_chat = _orchestrator(_ToolUntilContinueModel(), SQLiteRunStore(db))
        restarted_manager = BackgroundRunManager(restarted_chat)
        assert not restarted_chat._runs  # nothing survived in memory
        assert restarted_chat.get_run(run.id).status == "awaiting_continue"
        assert restarted_chat.get_run(run.id).suspended_messages  # snapshot on disk

        # Continue works after the restart: messages come from the payload.
        await restarted_manager.continue_run(run.id)
        await restarted_manager.get_task(run.id)
        assert restarted_chat.get_run(run.id).status == "ready"
        assert restarted_chat.get_run(run.id).assistant_message == "收尾完成。"

    asyncio.run(_run())


def test_stop_on_awaiting_continue_run_finalizes_stopped_by_user(tmp_path):
    async def _run():
        store = SQLiteRunStore(tmp_path / "runs.sqlite3")
        chat = _orchestrator(_ToolUntilContinueModel(), store)
        manager = BackgroundRunManager(chat)
        run = manager.submit(workspace_id="demo", actor_user_id="u_demo", message="多步任务")
        await manager.get_task(run.id)
        assert chat.get_run(run.id).status == "awaiting_continue"

        # Stop a parked run (no live task/journal): allowed → stopped_by_user.
        stopped = await manager.stop(run.id)
        assert stopped.status == "failed"
        assert stopped.error_code == "stopped_by_user"
        # A reconnecting subscriber still sees closure (terminal error on disk).
        replay = [frame async for frame in manager.subscribe(run.id, from_seq=0)]
        assert replay[-1]["type"] == "error"
        assert replay[-1]["run"]["error_code"] == "stopped_by_user"
        seqs = [frame["seq"] for frame in replay]
        assert seqs == list(range(1, len(replay) + 1))  # closing frame kept seq order

    asyncio.run(_run())


# --- route level (HTTP contract) --------------------------------------------


def _poll_until_ready(client: TestClient, run_id: str, deadline_s: float = 3.0) -> dict:
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        run = client.get(f"/api/chat/runs/{run_id}", headers=HEADERS).json()
        if run.get("status") != "generating":
            return run
        time.sleep(0.02)  # let the portal loop advance the background task
    return run


def test_submit_route_returns_immediately_generating(tmp_path):
    chat = _orchestrator(FakeStreamModel(_plain_script(["答复。"])), SQLiteRunStore(tmp_path / "r.sqlite3"))
    client = TestClient(create_app(chat_orchestrator=chat))

    response = client.post(
        "/api/chat/runs/submit",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "你好"},
    )
    body = response.json()
    assert response.status_code == 200
    assert set(body) == {"run_id", "thread_id", "status"}
    assert body["status"] == "generating"  # returned before the run finished
    assert body["thread_id"] == body["run_id"]  # first turn self-references

    ready = _poll_until_ready(client, body["run_id"])  # drain the task cleanly
    assert ready["status"] == "ready"


def test_submit_route_rejects_identity_mismatch(tmp_path):
    chat = _orchestrator(FakeStreamModel(_plain_script(["答复。"])), SQLiteRunStore(tmp_path / "r.sqlite3"))
    client = TestClient(create_app(chat_orchestrator=chat))
    response = client.post(
        "/api/chat/runs/submit",
        headers=HEADERS,
        json={"workspace_id": "other", "actor_user_id": "u_demo", "message": "你好"},
    )
    assert response.status_code == 403


def test_stop_route_noops_on_terminal_and_guards_access(tmp_path):
    chat = _orchestrator(FakeStreamModel(_plain_script(["答复。"])), SQLiteRunStore(tmp_path / "r.sqlite3"))
    client = TestClient(create_app(chat_orchestrator=chat))
    submitted = client.post(
        "/api/chat/runs/submit",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "你好"},
    ).json()
    run_id = submitted["run_id"]
    _poll_until_ready(client, run_id)

    # Stop on a finished run → idempotent no-op returning its terminal status.
    stop = client.post(f"/api/chat/runs/{run_id}/stop", headers=HEADERS)
    assert stop.status_code == 200
    assert stop.json() == {"run_id": run_id, "status": "ready"}

    # Access guards: cross-identity 403, unknown 404.
    stranger = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_other"}
    assert client.post(f"/api/chat/runs/{run_id}/stop", headers=stranger).status_code == 403
    assert client.post("/api/chat/runs/nope/stop", headers=HEADERS).status_code == 404


def test_continue_route_resumes_awaiting_continue_run(tmp_path):
    # L4a 续办:submit 顶到 max_turns → awaiting_continue → POST .../continue → ready.
    chat = _orchestrator(_ToolUntilContinueModel(), SQLiteRunStore(tmp_path / "r.sqlite3"))
    client = TestClient(create_app(chat_orchestrator=chat))
    submitted = client.post(
        "/api/chat/runs/submit",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "多步任务"},
    ).json()
    run_id = submitted["run_id"]
    parked = _poll_until_ready(client, run_id)
    assert parked["status"] == "awaiting_continue"

    resumed = client.post(f"/api/chat/runs/{run_id}/continue", headers=HEADERS)
    assert resumed.status_code == 200
    assert resumed.json()["status"] in {"generating", "ready"}  # resuming or done
    finished = _poll_until_ready(client, run_id)
    assert finished["status"] == "ready"

    # Continue on a now-terminal run → idempotent no-op returning its status.
    again = client.post(f"/api/chat/runs/{run_id}/continue", headers=HEADERS)
    assert again.json() == {"run_id": run_id, "status": "ready"}
    # Access guards: cross-identity 403, unknown 404.
    stranger = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_other"}
    assert client.post(f"/api/chat/runs/{run_id}/continue", headers=stranger).status_code == 403
    assert client.post("/api/chat/runs/nope/continue", headers=HEADERS).status_code == 404


def test_stream_route_replays_a_finished_run_from_disk(tmp_path):
    chat = _orchestrator(
        FakeStreamModel(_plain_script(["本月", "营收", "上升。"])),
        SQLiteRunStore(tmp_path / "r.sqlite3"),
    )
    client = TestClient(create_app(chat_orchestrator=chat))
    submitted = client.post(
        "/api/chat/runs/submit",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "营收？"},
    ).json()
    run_id = submitted["run_id"]
    _poll_until_ready(client, run_id)

    # Resumable subscription on a finished run: a pure disk replay that closes.
    response = client.get(f"/api/chat/runs/{run_id}/stream", headers=HEADERS)
    assert response.status_code == 200
    frames = [
        json.loads(line[len("data:"):].strip())
        for line in response.text.splitlines()
        if line.startswith("data:")
    ]
    seqs = [f["seq"] for f in frames]
    assert seqs == list(range(1, len(frames) + 1))  # contiguous, gap-free
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"]["status"] == "ready"

    # from_seq replays only the tail.
    mid = seqs[len(seqs) // 2]
    tail_response = client.get(
        f"/api/chat/runs/{run_id}/stream?from_seq={mid}", headers=HEADERS
    )
    tail_frames = [
        json.loads(line[len("data:"):].strip())
        for line in tail_response.text.splitlines()
        if line.startswith("data:")
    ]
    assert [f["seq"] for f in tail_frames] == list(range(mid + 1, len(frames) + 1))

    telemetry_response = client.get(f"/api/chat/runs/{run_id}/telemetry", headers=HEADERS)
    assert telemetry_response.status_code == 200
    assert telemetry_response.json() == {
        "run_id": run_id,
        "subscription_count": 2,
        "resume_subscription_count": 1,
        "frames_emitted": len(frames) + len(tail_frames),
        "gap_recovery_count": 0,
        "persistence_failure_count": 0,
        "durable_seq": len(frames),
        "pending_persistence_seqs": [],
        "durability_degraded": False,
        "last_seq": len(frames),
        "terminal": True,
    }
