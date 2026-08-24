"""L5 concurrency governance — unit + wiring tests (P4 并行隔离).

Covers the two primitives in ``services/runtime/app/concurrency.py`` and their
wiring:

* ``WorkspaceRunGate`` — waited-only-when-full semantics, ``on_queued`` fired
  BEFORE the wait completes, cross-workspace independence;
* ``ModelCallBucket`` — burst/refill math on an injected deterministic clock
  (a fake ``sleep`` advances the fake clock: zero real waiting), blocking
  acquire that delays but never rejects, timeout escape hatch, thread-safe
  admissions, and the async fast-path/contended split;
* the shared per-rate registry (+ ``install`` / ``reset`` test seams);
* config: ``runtime.json → concurrency`` nested block, env override, defaults,
  invalid-value coercion;
* chokepoint wiring: the REAL ``stream_model`` (async), ``call_model`` (sync)
  and autocompact's summary single-shot each take the SAME shared bucket;
* manager wiring: a failed run releases its workspace slot; stopping a QUEUED
  run leaks no slot; a resumed (``continue``) run re-competes for a slot and
  carries the honest ``run.queued`` audit when it truly waits; the default
  limit (3) never queues today's flows.
"""
from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import replace
from pathlib import Path

import httpx

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.autocompact import _build_summarize
from services.runtime.app.concurrency import (
    ModelCallBucket,
    WorkspaceRunGate,
    install_shared_model_call_bucket,
    reset_shared_model_call_buckets,
    shared_model_call_bucket,
)
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.engine.streaming_model import stream_model
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelResponse,
    ModelToolCall,
    OpenAICompatibleModelProvider,
)
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel

_TIMEOUT = 10.0  # loud-failure guard for event waits; healthy paths never near it


# --- WorkspaceRunGate ---------------------------------------------------------


def test_workspace_gate_waited_only_when_full_and_on_queued_fires_first():
    async def _run() -> None:
        gate = WorkspaceRunGate(1)
        queued: list[str] = []

        async def first_on_queued() -> None:  # pragma: no cover - must not fire
            queued.append("first")

        assert await gate.acquire("ws", on_queued=first_on_queued) is False
        assert queued == []  # a free slot never announces a queue

        queued_seen = asyncio.Event()
        finished = asyncio.Event()

        async def second() -> bool:
            async def on_queued() -> None:
                queued.append("second")
                queued_seen.set()

            waited = await gate.acquire("ws", on_queued=on_queued)
            finished.set()
            return waited

        task = asyncio.create_task(second())
        # on_queued fires BEFORE the wait completes (queue start, not queue end).
        await asyncio.wait_for(queued_seen.wait(), _TIMEOUT)
        assert queued == ["second"]
        assert not finished.is_set()  # still parked on the semaphore
        gate.release("ws")
        assert await asyncio.wait_for(task, _TIMEOUT) is True
        gate.release("ws")

    asyncio.run(_run())


def test_workspace_gate_workspaces_are_independent():
    async def _run() -> None:
        gate = WorkspaceRunGate(1)
        assert await gate.acquire("ws_a") is False
        # A full workspace A never delays workspace B.
        assert await gate.acquire("ws_b") is False
        gate.release("ws_a")
        gate.release("ws_b")

    asyncio.run(_run())


def test_workspace_gate_coerces_nonpositive_limit_to_one():
    assert WorkspaceRunGate(0).limit == 1
    assert WorkspaceRunGate(-3).limit == 1
    assert WorkspaceRunGate(5).limit == 5


# --- ModelCallBucket (deterministic clock — zero real waiting) ------------------


class _FakeClock:
    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_bucket_burst_equals_capacity_and_refill_math():
    clock = _FakeClock()
    bucket = ModelCallBucket(3, clock=clock, sleep=clock.advance)
    assert [bucket.try_acquire() for _ in range(3)] == [True, True, True]
    assert bucket.try_acquire() is False  # burst (== capacity) drained
    clock.advance(20.0)  # 3/min → 0.05 tokens/s → exactly one token back
    assert bucket.try_acquire() is True
    assert bucket.try_acquire() is False
    clock.advance(3_600.0)  # refill CAPS at capacity, no unbounded hoarding
    assert [bucket.try_acquire() for _ in range(3)] == [True, True, True]
    assert bucket.try_acquire() is False


def test_bucket_blocking_acquire_delays_exactly_one_token_and_never_rejects():
    clock = _FakeClock()
    sleeps: list[float] = []

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.advance(seconds)

    bucket = ModelCallBucket(1, clock=clock, sleep=fake_sleep)
    assert bucket.try_acquire() is True  # burst
    # Empty bucket: blocking acquire waits exactly one whole-token refill (60s
    # at 1/min) on the injected clock — admitted, never rejected. Float dust in
    # 60 * (1/60) may cost one negligible extra loop spin; the wait itself is
    # the 60s refill either way.
    assert bucket.acquire() is True
    assert sleeps and abs(sleeps[0] - 60.0) < 1e-6
    assert len(sleeps) <= 2 and abs(sum(sleeps) - 60.0) < 1e-6


def test_bucket_acquire_timeout_is_an_escape_hatch():
    clock = _FakeClock()

    def fake_sleep(seconds: float) -> None:
        clock.advance(seconds)

    bucket = ModelCallBucket(1, clock=clock, sleep=fake_sleep)
    assert bucket.try_acquire() is True
    # 10s timeout against a 60s refill: bounded wait, honest False on expiry.
    assert bucket.acquire(timeout=10.0) is False
    # No token was consumed by the failed wait; the refill it DID wait out stays.
    clock.advance(51.0)  # 10 (waited) + 51 > 60 — comfortably one full token
    assert bucket.try_acquire() is True


def test_bucket_thread_safe_admissions_exact_count():
    clock = _FakeClock()
    bucket = ModelCallBucket(60, clock=clock, sleep=clock.advance)
    results: list[bool] = []

    def worker() -> None:
        results.append(bucket.acquire())

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [True] * 20
    # Frozen clock → no refill: exactly capacity-20 tokens remain.
    assert sum(1 for _ in range(60) if bucket.try_acquire()) == 40


def test_bucket_acquire_async_fast_path_and_contended_path():
    async def _run() -> None:
        clock = _FakeClock()
        bucket = ModelCallBucket(2, clock=clock, sleep=clock.advance)
        await bucket.acquire_async()  # fast path (token available, no thread)
        await bucket.acquire_async()  # fast path drains the burst
        # Contended: offloaded to a worker thread; the fake sleep advances the
        # fake clock, so the "60s/2 = 30s" refill wait costs zero real time.
        await bucket.acquire_async()
        assert bucket.try_acquire() is False

    asyncio.run(_run())


# --- shared registry ------------------------------------------------------------


def test_shared_bucket_keyed_by_rate_with_install_and_reset_seams():
    reset_shared_model_call_buckets()
    settings_30 = RuntimeSettings(concurrency_model_calls_per_minute=30)
    settings_12 = RuntimeSettings(concurrency_model_calls_per_minute=12)
    bucket_30 = shared_model_call_bucket(settings_30)
    assert shared_model_call_bucket(settings_30) is bucket_30
    assert shared_model_call_bucket(settings_12) is not bucket_30
    # Settings COPIES (model profiles / the autocompact summary variant) land on
    # the SAME bucket — the gate follows the rate, not object identity.
    assert shared_model_call_bucket(replace(settings_30, model_name="other")) is bucket_30

    custom = ModelCallBucket(12)
    install_shared_model_call_bucket(12, custom)
    assert shared_model_call_bucket(settings_12) is custom
    reset_shared_model_call_buckets()
    assert shared_model_call_bucket(settings_12) is not custom


# --- config ----------------------------------------------------------------------


def test_concurrency_config_defaults(monkeypatch):
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("ANNA_CONCURRENCY_PER_WORKSPACE_RUNS", raising=False)
    monkeypatch.delenv("ANNA_CONCURRENCY_MODEL_CALLS_PER_MINUTE", raising=False)
    settings = RuntimeSettings.from_env()
    assert settings.concurrency_per_workspace_runs == 3
    assert settings.concurrency_model_calls_per_minute == 30


def test_concurrency_config_nested_block_and_env_override(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"concurrency": {"per_workspace_runs": 2, "model_calls_per_minute": 12}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_CONCURRENCY_PER_WORKSPACE_RUNS", raising=False)
    monkeypatch.delenv("ANNA_CONCURRENCY_MODEL_CALLS_PER_MINUTE", raising=False)
    settings = RuntimeSettings.from_env()
    assert settings.concurrency_per_workspace_runs == 2
    assert settings.concurrency_model_calls_per_minute == 12

    # Env wins over the file, matching every other setting's precedence.
    monkeypatch.setenv("ANNA_CONCURRENCY_PER_WORKSPACE_RUNS", "5")
    monkeypatch.setenv("ANNA_CONCURRENCY_MODEL_CALLS_PER_MINUTE", "45")
    settings = RuntimeSettings.from_env()
    assert settings.concurrency_per_workspace_runs == 5
    assert settings.concurrency_model_calls_per_minute == 45


def test_concurrency_config_invalid_values_coerce_to_defaults(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps({"concurrency": {"per_workspace_runs": 0, "model_calls_per_minute": "abc"}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_CONCURRENCY_PER_WORKSPACE_RUNS", raising=False)
    monkeypatch.delenv("ANNA_CONCURRENCY_MODEL_CALLS_PER_MINUTE", raising=False)
    settings = RuntimeSettings.from_env()
    assert settings.concurrency_per_workspace_runs == 3
    assert settings.concurrency_model_calls_per_minute == 30

    # A malformed (non-dict) block reads as absent → defaults.
    config_path.write_text(json.dumps({"concurrency": "nope"}), encoding="utf-8")
    settings = RuntimeSettings.from_env()
    assert settings.concurrency_per_workspace_runs == 3
    assert settings.concurrency_model_calls_per_minute == 30


# --- chokepoint wiring: all three model chokepoints share ONE bucket -------------


class _RecordingBucket(ModelCallBucket):
    """A huge-capacity bucket that counts admissions (never delays a test)."""

    def __init__(self) -> None:
        super().__init__(1_000_000)
        self.admitted = 0

    def try_acquire(self) -> bool:
        admitted = super().try_acquire()
        if admitted:
            self.admitted += 1
        return admitted

    def acquire(self, timeout: float | None = None) -> bool:
        admitted = super().acquire(timeout)
        if admitted:
            self.admitted += 1
        return admitted


_RATE = 7  # a distinctive test rate so the installed bucket is unambiguous

_WIRED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    concurrency_model_calls_per_minute=_RATE,
)


def _sse_body(*events: str) -> bytes:
    return ("\n\n".join([*events, "data: [DONE]"]) + "\n\n").encode("utf-8")


def _content_event(text: str) -> str:
    return "data: " + json.dumps(
        {"choices": [{"delta": {"content": text}, "finish_reason": None}]},
        ensure_ascii=False,
    )


def _finish_event(reason: str) -> str:
    return "data: " + json.dumps(
        {"choices": [{"delta": {}, "finish_reason": reason}]}, ensure_ascii=False
    )


def _single_shot_completion(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
            ]
        },
    )


def test_stream_model_takes_the_shared_bucket_once_per_logical_call():
    async def _run() -> None:
        recording = _RecordingBucket()
        install_shared_model_call_bucket(_RATE, recording)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=_sse_body(_content_event("你好。"), _finish_event("stop")),
                headers={"content-type": "text/event-stream"},
            )

        chunks = [
            chunk
            async for chunk in stream_model(
                "run_stream",
                [],
                ModelRequest(messages=[{"role": "user", "content": "问好"}], tools=[]),
                settings=_WIRED_SETTINGS,
                transport=httpx.MockTransport(handler),
            )
        ]
        assert chunks[-1].kind == "final"
        assert recording.admitted == 1

    asyncio.run(_run())


def test_call_model_takes_the_shared_bucket():
    recording = _RecordingBucket()
    install_shared_model_call_bucket(_RATE, recording)
    provider = OpenAICompatibleModelProvider(
        _WIRED_SETTINGS,
        transport=httpx.MockTransport(lambda request: _single_shot_completion("好的。")),
    )
    result = AnnaHarnessRuntime(provider).call_model(
        "run_sync",
        [],
        ModelRequest(messages=[{"role": "user", "content": "问好"}], tools=[]),
    )
    assert result.error_code is None
    assert result.response is not None
    assert recording.admitted == 1


def test_autocompact_summarize_takes_the_shared_bucket():
    # The L4a summary single-shot is a REAL provider call on a separate provider
    # instance — it must not be a side door around the rate gate.
    recording = _RecordingBucket()
    install_shared_model_call_bucket(_RATE, recording)
    summarize = _build_summarize(
        _WIRED_SETTINGS,
        httpx.MockTransport(lambda request: _single_shot_completion("对话摘要。")),
    )
    assert summarize("很长的历史片段……") == "对话摘要。"
    assert recording.admitted == 1


# --- manager wiring: gate release paths, stop-while-queued, continue re-competes --


def _settings(per_workspace_runs: int) -> RuntimeSettings:
    return RuntimeSettings(
        model_endpoint="https://model.example/v1/chat/completions",
        model_api_key="model-key",
        concurrency_per_workspace_runs=per_workspace_runs,
    )


def _manager(fake, settings: RuntimeSettings, store: SQLiteRunStore | None = None):
    chat = ChatOrchestrator(
        engine=QueryEngine(settings=settings, deps=QueryDeps(stream_model=fake)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
        run_store=store,
    )
    return chat, BackgroundRunManager(chat)


def _last_user(request: ModelRequest) -> str:
    last = ""
    for message in request.messages:
        if message.get("role") == "user":
            last = str(message.get("content") or "")
    return last


class _KeyedParkModel(FakeStreamModel):
    """Parks any call whose last user message contains a key in ``parked``."""

    def __init__(self, parked: dict[str, tuple[asyncio.Event, asyncio.Event]]):
        super().__init__()
        self._parked = parked  # key → (started, release)

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message="办妥。", tool_calls=[], finish_reason="stop"
        )

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        base = super().__call__(
            run_id, audit_events, request,
            settings=settings, config_error_message=config_error_message,
        )
        last_user = _last_user(request)
        for key, (started, release) in self._parked.items():
            if key in last_user:
                async def _gated(started=started, release=release):
                    started.set()
                    await release.wait()
                    async for chunk in base:
                        yield chunk

                return _gated()
        return base


class _ExplodingModel:
    """Raises mid-stream — the run must fail AND release its workspace slot."""

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        async def _boom():
            raise RuntimeError("model exploded")
            yield  # pragma: no cover — makes this an async generator

        return _boom()


def _queued_events(run) -> list:
    return [event for event in run.audit_events if event.type == "run.queued"]


def test_manager_default_limit_never_queues_todays_flows(tmp_path):
    async def _run() -> None:
        parked = {
            "任务一": (asyncio.Event(), asyncio.Event()),
            "任务二": (asyncio.Event(), asyncio.Event()),
        }
        chat, manager = _manager(
            _KeyedParkModel(parked), _settings(3), SQLiteRunStore(tmp_path / "runs.sqlite3")
        )
        run_1 = manager.submit(workspace_id="demo", actor_user_id="u", message="任务一")
        run_2 = manager.submit(workspace_id="demo", actor_user_id="u", message="任务二")
        # Grab the handles NOW — a finished task pops itself from the registry.
        tasks = [manager.get_task(run_1.id), manager.get_task(run_2.id)]
        assert all(task is not None for task in tasks)
        # Both under the default limit: running CONCURRENTLY, neither queued.
        await asyncio.wait_for(parked["任务一"][0].wait(), _TIMEOUT)
        await asyncio.wait_for(parked["任务二"][0].wait(), _TIMEOUT)
        for key in parked:
            parked[key][1].set()
        for task in tasks:
            await asyncio.wait_for(task, _TIMEOUT)
        for run in (run_1, run_2):
            finished = chat.get_run(run.id)
            assert finished.status == "ready"
            assert _queued_events(finished) == []

    asyncio.run(_run())


def test_manager_releases_slot_when_a_run_crashes(tmp_path):
    async def _run() -> None:
        chat, manager = _manager(
            _ExplodingModel(), _settings(1), SQLiteRunStore(tmp_path / "runs.sqlite3")
        )
        crashed = manager.submit(workspace_id="demo", actor_user_id="u", message="崩溃任务")
        crashed_task = manager.get_task(crashed.id)
        assert crashed_task is not None
        await asyncio.wait_for(crashed_task, _TIMEOUT)
        assert chat.get_run(crashed.id).status == "failed"

        # The single slot MUST have been released: a follow-up run acquires it
        # immediately (no run.queued) — with a leak this would deadlock (the
        # wait_for guard fails loudly instead of hanging).
        parked = {"后续任务": (asyncio.Event(), asyncio.Event())}
        chat.engine.deps = QueryDeps(stream_model=_KeyedParkModel(parked))
        follow_up = manager.submit(workspace_id="demo", actor_user_id="u", message="后续任务")
        follow_up_task = manager.get_task(follow_up.id)
        assert follow_up_task is not None
        await asyncio.wait_for(parked["后续任务"][0].wait(), _TIMEOUT)
        parked["后续任务"][1].set()
        await asyncio.wait_for(follow_up_task, _TIMEOUT)
        finished = chat.get_run(follow_up.id)
        assert finished.status == "ready"
        assert _queued_events(finished) == []

    asyncio.run(_run())


def test_manager_stop_while_queued_leaks_no_slot(tmp_path):
    async def _run() -> None:
        parked = {
            "占位任务": (asyncio.Event(), asyncio.Event()),
            "第三任务": (asyncio.Event(), asyncio.Event()),
        }
        store = SQLiteRunStore(tmp_path / "runs.sqlite3")
        chat, manager = _manager(_KeyedParkModel(parked), _settings(1), store)

        holder = manager.submit(workspace_id="demo", actor_user_id="u", message="占位任务")
        holder_task = manager.get_task(holder.id)
        assert holder_task is not None
        await asyncio.wait_for(parked["占位任务"][0].wait(), _TIMEOUT)
        queued_run = manager.submit(workspace_id="demo", actor_user_id="u", message="排队任务")
        # Deterministic queue observation: drive the loop until the queued task
        # has audited run.queued (its task only needs loop iterations, no time).
        for _ in range(100):
            if _queued_events(chat.get_run(queued_run.id)):
                break
            await asyncio.sleep(0)
        assert len(_queued_events(chat.get_run(queued_run.id))) == 1

        # Stop the QUEUED run: it finalizes stopped_by_user; its cancelled wait
        # consumed no slot, so nothing may be released for it.
        stopped = await manager.stop(queued_run.id)
        assert stopped.status == "failed"
        assert stopped.error_code == "stopped_by_user"

        # The holder still owns the only slot; release it and prove the slot
        # count is intact: a third run acquires and completes.
        parked["占位任务"][1].set()
        await asyncio.wait_for(holder_task, _TIMEOUT)
        third = manager.submit(workspace_id="demo", actor_user_id="u", message="第三任务")
        third_task = manager.get_task(third.id)
        assert third_task is not None
        await asyncio.wait_for(parked["第三任务"][0].wait(), _TIMEOUT)
        parked["第三任务"][1].set()
        await asyncio.wait_for(third_task, _TIMEOUT)
        assert chat.get_run(third.id).status == "ready"

        # The stopped run's journal replays to a clean error terminal with
        # contiguous seqs (created → queued → error).
        frames = store.list_frames("chat", queued_run.id, 0)
        assert [frame["seq"] for frame in frames] == list(range(1, len(frames) + 1))
        assert frames[-1]["type"] == "error"
        assert frames[-1]["run"]["error_code"] == "stopped_by_user"

    asyncio.run(_run())


class _ParkOrSuspendModel(FakeStreamModel):
    """「占位」 parks on an event; anything else tool-loops until the resume
    nudge (「继续完成剩余任务」) appears, then finishes — the continue-gate fake
    plus a parked slot-holder, for the re-compete scenario."""

    def __init__(self, started: asyncio.Event, release: asyncio.Event):
        super().__init__()
        self._started = started
        self._release = release

    def respond(self, request: ModelRequest) -> ModelResponse:
        last_user = _last_user(request)
        if "占位" in last_user:
            return ModelResponse(
                assistant_message="占位完成。", tool_calls=[], finish_reason="stop"
            )
        if "继续完成剩余任务" in last_user:
            return ModelResponse(
                assistant_message="续办完成。", tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message=None,
            tool_calls=[
                ModelToolCall(
                    id="call_plan",
                    name="plan.update",
                    arguments={
                        "items": [{"id": "1", "title": "推进", "status": "in_progress"}]
                    },
                )
            ],
            finish_reason="tool_calls",
        )

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        base = super().__call__(
            run_id, audit_events, request,
            settings=settings, config_error_message=config_error_message,
        )
        if "占位" not in _last_user(request):
            return base

        async def _gated():
            self._started.set()
            await self._release.wait()
            async for chunk in base:
                yield chunk

        return _gated()


def test_manager_continue_recompetes_for_workspace_slot(tmp_path):
    async def _run() -> None:
        started, release = asyncio.Event(), asyncio.Event()
        store = SQLiteRunStore(tmp_path / "runs.sqlite3")
        chat, manager = _manager(_ParkOrSuspendModel(started, release), _settings(1), store)

        # 1. A run spends its max_turns budget and parks awaiting_continue —
        #    its suspension releases the workspace slot (finally path).
        suspended = manager.submit(workspace_id="demo", actor_user_id="u", message="多步任务")
        first_segment = manager.get_task(suspended.id)
        assert first_segment is not None
        await asyncio.wait_for(first_segment, _TIMEOUT)
        assert chat.get_run(suspended.id).status == "awaiting_continue"

        # 2. A fresh run takes the (single) freed slot and parks mid-model-call.
        holder = manager.submit(workspace_id="demo", actor_user_id="u", message="占位任务")
        holder_task = manager.get_task(holder.id)
        assert holder_task is not None
        await asyncio.wait_for(started.wait(), _TIMEOUT)

        # 3. Continue: the resumed run RE-COMPETES for a slot → truly queues →
        #    honest run.queued audit on the resumed segment, status generating.
        resumed = await manager.continue_run(suspended.id)
        assert resumed.status == "generating"
        resume_task = manager.get_task(suspended.id)  # grab BEFORE it can finish
        assert resume_task is not None
        for _ in range(100):
            if _queued_events(chat.get_run(suspended.id)):
                break
            await asyncio.sleep(0)
        queued = _queued_events(chat.get_run(suspended.id))
        assert len(queued) == 1
        assert queued[0].payload == {"workspace_id": "demo"}

        # 4. Free the slot → the continuation runs to ready.
        release.set()
        await asyncio.wait_for(holder_task, _TIMEOUT)
        await asyncio.wait_for(resume_task, _TIMEOUT)
        finished = chat.get_run(suspended.id)
        assert finished.status == "ready"
        assert finished.assistant_message == "续办完成。"

        # seq stays strictly contiguous across suspend → queued resume → done.
        frames = store.list_frames("chat", suspended.id, 0)
        assert [frame["seq"] for frame in frames] == list(range(1, len(frames) + 1))
        assert frames[-1]["type"] == "done"

    asyncio.run(_run())
