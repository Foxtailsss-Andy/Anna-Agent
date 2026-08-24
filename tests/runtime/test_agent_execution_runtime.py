from __future__ import annotations

import asyncio
import time

import pytest

from services.runtime.app.execution.clock import ManualClock
from services.runtime.app.execution.driver import ExecutionDriver
from services.runtime.app.execution.kernel import AgentExecutionKernel
from services.runtime.app.execution.models import LoopResult, StartExecution
from services.runtime.app.execution.runtime import AgentExecutionRuntime
from services.runtime.app.execution.store import SQLiteExecutionStore


def _start(request_id: str = "req-1") -> StartExecution:
    return StartExecution(
        request_id=request_id,
        workspace_id="ws-1",
        conversation_id="crew_project:p1",
        channel_id="crew_channel:p1",
        subject_ref="crew_task:p1:t1",
        trigger_ref="manual:test",
        worker_profile_ref="member:worker-1",
        run_profile_ref="crew.query_engine.v1",
        input={"project_id": "p1", "task_id": "t1"},
    )


async def _until(predicate, *, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("predicate did not become true")


class _SuccessAdapter:
    async def run(self, snapshot, signals) -> LoopResult:
        return LoopResult(status="succeeded")


def test_runtime_startup_reconcile_requeues_and_runs_expired_claim(tmp_path):
    clock = ManualClock()
    store = SQLiteExecutionStore(tmp_path / "executions.sqlite3", clock=clock)
    started = store.dispatch(_start(), max_queue_depth=10)
    assert store.claim_next(owner_id="stale-worker", lease_ttl_seconds=1.0) is not None
    clock.advance(2.0)
    runtime = AgentExecutionRuntime(
        store=store,
        adapter=_SuccessAdapter(),
        worker_count=1,
        lease_ttl_seconds=1.0,
        heartbeat_interval_seconds=0.1,
        idle_poll_seconds=0.01,
    )

    async def _run():
        await runtime.start()
        try:
            await _until(lambda: store.get(started.execution_id).status == "succeeded")
        finally:
            await runtime.stop()

    asyncio.run(_run())
    events = store.read_events(started.execution_id)
    assert "execution.requeued" in [event.type for event in events]


def test_driver_heartbeat_keeps_second_worker_from_claiming(tmp_path):
    store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    started = store.dispatch(_start(), max_queue_depth=10)
    release = asyncio.Event()

    class _ParkingAdapter:
        async def run(self, snapshot, signals) -> LoopResult:
            await release.wait()
            return LoopResult(status="succeeded")

    async def _run():
        driver_task = asyncio.create_task(
            ExecutionDriver(
                store,
                _ParkingAdapter(),
                lease_ttl_seconds=0.2,
                heartbeat_interval_seconds=0.05,
            ).run_once(owner_id="worker-a")
        )
        await _until(lambda: store.get(started.execution_id).status == "running")
        await asyncio.sleep(0.35)
        assert store.claim_next(owner_id="worker-b", lease_ttl_seconds=0.2) is None
        release.set()
        await driver_task

    asyncio.run(_run())
    assert store.get(started.execution_id).status == "succeeded"


def test_driver_cancels_adapter_when_heartbeat_fails(tmp_path):
    store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    started = store.dispatch(_start(), max_queue_depth=10)
    original_heartbeat = store.heartbeat
    cancelled = False

    def failing_heartbeat(*args, **kwargs):
        original_heartbeat(*args, **kwargs)
        raise RuntimeError("heartbeat storage fault")

    store.heartbeat = failing_heartbeat  # type: ignore[method-assign]

    class _NeverFinishesAdapter:
        async def run(self, snapshot, signals) -> LoopResult:
            nonlocal cancelled
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled = True
                raise

    async def _run():
        result = await ExecutionDriver(
            store,
            _NeverFinishesAdapter(),
            lease_ttl_seconds=1.0,
            heartbeat_interval_seconds=0.01,
        ).run_once(owner_id="worker-a")
        assert result is not None
        assert result.status == "queued"
        assert result.lease_owner is None
        assert result.lease_expires_at is None

    asyncio.run(_run())
    assert cancelled
    snapshot = store.get(started.execution_id)
    assert snapshot.status == "queued"
    assert snapshot.lease_owner is None
    assert snapshot.lease_expires_at is None
    events = store.read_events(started.execution_id)
    assert events[-1].type == "execution.requeued"
    assert events[-1].payload["reason"] == "heartbeat_lost"


def test_runtime_shutdown_requeues_claimed_execution_with_valid_fence(tmp_path):
    store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    started = store.dispatch(_start(), max_queue_depth=10)

    class _ParkingAdapter:
        async def run(self, snapshot, signals) -> LoopResult:
            await asyncio.Event().wait()
            return LoopResult(status="succeeded")

    runtime = AgentExecutionRuntime(
        store=store,
        adapter=_ParkingAdapter(),
        worker_count=1,
        lease_ttl_seconds=5.0,
        heartbeat_interval_seconds=0.05,
        idle_poll_seconds=0.01,
    )

    async def _run():
        await runtime.start()
        await _until(lambda: store.get(started.execution_id).status == "running")
        await runtime.stop()

    asyncio.run(_run())
    snapshot = store.get(started.execution_id)
    assert snapshot.status == "queued"
    assert snapshot.lease_owner is None
    assert [event.type for event in store.read_events(started.execution_id)][-1] == (
        "execution.requeued"
    )


def test_runtime_worker_and_projector_loop_survive_one_exception(tmp_path):
    store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    started = store.dispatch(_start(), max_queue_depth=10)
    original_claim = store.claim_next
    failures = {"claim": 0, "projector": 0}

    def flaky_claim(*args, **kwargs):
        if failures["claim"] == 0:
            failures["claim"] += 1
            raise RuntimeError("claim fault")
        return original_claim(*args, **kwargs)

    class _FlakyProjector:
        def run_once(self, **kwargs):
            if failures["projector"] == 0:
                failures["projector"] += 1
                raise RuntimeError("projector fault")
            return type("Result", (), {"claimed": 0})()

    store.claim_next = flaky_claim  # type: ignore[method-assign]
    runtime = AgentExecutionRuntime(
        store=store,
        adapter=_SuccessAdapter(),
        projector=_FlakyProjector(),
        worker_count=1,
        lease_ttl_seconds=1.0,
        heartbeat_interval_seconds=0.05,
        idle_poll_seconds=0.01,
        projector_poll_seconds=0.01,
    )

    async def _run():
        await runtime.start()
        try:
            await _until(lambda: store.get(started.execution_id).status == "succeeded")
            await _until(lambda: failures["projector"] == 1)
        finally:
            await runtime.stop()

    asyncio.run(_run())
    assert failures == {"claim": 1, "projector": 1}


def test_runtime_parameter_validation(tmp_path):
    store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    with pytest.raises(ValueError):
        AgentExecutionRuntime(store=store, adapter=_SuccessAdapter(), worker_count=0)
    with pytest.raises(ValueError):
        AgentExecutionRuntime(store=store, adapter=_SuccessAdapter(), idle_poll_seconds=0)
    with pytest.raises(ValueError):
        ExecutionDriver(store, _SuccessAdapter(), heartbeat_interval_seconds=float("inf"))
