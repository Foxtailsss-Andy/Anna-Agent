from __future__ import annotations

import asyncio
import sqlite3
import threading

import pytest

from services.runtime.app.execution.clock import ManualClock
from services.runtime.app.execution.driver import (
    ExecutionDriver,
    RetryPolicy,
    RetryableLoopError,
    ScriptedLoopAdapter,
)
from services.runtime.app.execution.kernel import AgentExecutionKernel
from services.runtime.app.execution.models import (
    CancelExecution,
    LoopResult,
    SignalExecution,
    StartExecution,
)
from services.runtime.app.execution.store import SQLiteExecutionStore


def _kernel(tmp_path, *, clock: ManualClock | None = None, fault_hook=None):
    store = SQLiteExecutionStore(
        tmp_path / "executions.sqlite3",
        clock=clock or ManualClock(),
        fault_hook=fault_hook,
    )
    return AgentExecutionKernel(store), store


def _start(request_id: str = "req-start", *, subject_ref: str = "task:retry") -> StartExecution:
    return StartExecution(
        request_id=request_id,
        workspace_id="ws-1",
        conversation_id="conversation:c-1",
        channel_id="channel:crew",
        subject_ref=subject_ref,
        trigger_ref="message:m-1",
        worker_profile_ref="worker:scribe",
        run_profile_ref="run:crew-default",
        input={"prompt": "draft"},
    )


def _retry_policy(*, max_attempts: int = 3, base_delay_seconds: float = 5.0) -> RetryPolicy:
    return RetryPolicy(
        max_attempts=max_attempts,
        base_delay_seconds=base_delay_seconds,
        max_delay_seconds=60.0,
        jitter=lambda _execution_key, _attempt, _delay: 0.0,
    )


def test_default_retry_jitter_is_stable_and_bounded() -> None:
    policy = RetryPolicy(base_delay_seconds=10.0, max_delay_seconds=60.0)

    first = policy.delay_for_attempt("exec-a", 1)
    second = policy.delay_for_attempt("exec-a", 1)

    assert first == second
    assert 10.0 <= first <= 12.0


def test_retry_wait_is_durable_and_not_claimed_before_not_before(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        driver = ExecutionDriver(
            store,
            ScriptedLoopAdapter(
                [RetryableLoopError("temporary overload", error_code="provider_503")]
            ),
            retry_policy=_retry_policy(base_delay_seconds=5.0),
        )

        snapshot = await driver.run_once(owner_id="worker-a")

        assert snapshot is not None
        assert snapshot.execution_id == started.execution_id
        assert snapshot.status == "queued"
        assert snapshot.not_before == clock.now() + 5.0
        assert store.claim_next(owner_id="too-early") is None
        clock.advance(4.9)
        assert store.claim_next(owner_id="still-too-early") is None
        clock.advance(0.1)
        assert store.claim_next(owner_id="worker-b") is not None

    asyncio.run(_run())


def test_delayed_retry_due_is_claimed_once_across_two_store_instances(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"

    async def _run() -> None:
        store_a = SQLiteExecutionStore(db_path, clock=clock)
        store_b = SQLiteExecutionStore(db_path, clock=clock)
        kernel = AgentExecutionKernel(store_a)
        started = await kernel.dispatch(_start())
        driver = ExecutionDriver(
            store_a,
            ScriptedLoopAdapter([RetryableLoopError("temporary overload")]),
            retry_policy=_retry_policy(base_delay_seconds=5.0),
        )
        retried = await driver.run_once(owner_id="worker-a")
        assert retried is not None
        assert retried.status == "queued"
        assert retried.not_before == clock.now() + 5.0
        assert store_b.claim_next(owner_id="too-early") is None
        clock.advance(5.0)

        claims = []
        barrier = threading.Barrier(2)

        def claim(store: SQLiteExecutionStore, owner_id: str) -> None:
            barrier.wait()
            claims.append(store.claim_next(owner_id=owner_id, lease_ttl_seconds=30.0))

        threads = [
            threading.Thread(target=claim, args=(store_a, "worker-b")),
            threading.Thread(target=claim, args=(store_b, "worker-c")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        winners = [claim for claim in claims if claim is not None]
        assert len(winners) == 1
        assert winners[0].execution_id == started.execution_id
        assert store_a.get(started.execution_id).status == "running"
        store_a.close()
        store_b.close()

    asyncio.run(_run())


def test_retry_schedule_transaction_fault_rolls_back_state_and_event(tmp_path):
    clock = ManualClock()
    fired = False

    def fault(name: str) -> None:
        nonlocal fired
        if name == "before_schedule_retry_commit" and not fired:
            fired = True
            raise RuntimeError("injected retry schedule failure")

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock, fault_hook=fault)
        started = await kernel.dispatch(_start())
        lease = store.claim_next(owner_id="worker-a", lease_ttl_seconds=30.0)
        assert lease is not None

        with pytest.raises(RuntimeError, match="injected retry schedule failure"):
            store.schedule_retry_claimed(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                reason="loop_exception_retryable",
                error_code="provider_503",
                message="temporary overload",
                not_before=clock.now() + 5.0,
                max_attempts=3,
            )

        snapshot = await kernel.get(started.execution_id)
        assert snapshot.status == "running"
        assert snapshot.lease_owner == "worker-a"
        assert snapshot.lease_token == lease.lease_token
        assert snapshot.not_before is None
        assert snapshot.last_error_code is None
        assert "execution.retry_scheduled" not in [
            event.type for event in await kernel.read_events(started.execution_id)
        ]

        store._fault_hook = None  # type: ignore[attr-defined]
        retried = store.schedule_retry_claimed(
            started.execution_id,
            owner_id="worker-a",
            lease_token=lease.lease_token,
            reason="loop_exception_retryable",
            error_code="provider_503",
            message="temporary overload",
            not_before=clock.now() + 5.0,
            max_attempts=3,
        )
        assert retried.status == "queued"
        assert retried.not_before == clock.now() + 5.0

    asyncio.run(_run())


def test_retry_not_before_survives_store_restart(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"

    async def _run() -> None:
        store_a = SQLiteExecutionStore(db_path, clock=clock)
        kernel_a = AgentExecutionKernel(store_a)
        started = await kernel_a.dispatch(_start())
        driver = ExecutionDriver(
            store_a,
            ScriptedLoopAdapter([RetryableLoopError("retry later")]),
            retry_policy=_retry_policy(base_delay_seconds=10.0),
        )
        assert await driver.run_once(owner_id="worker-a") is not None
        store_a.close()

        store_b = SQLiteExecutionStore(db_path, clock=clock)
        assert store_b.claim_next(owner_id="worker-b") is None
        clock.advance(10.0)
        lease = store_b.claim_next(owner_id="worker-b")
        assert lease is not None
        assert lease.execution_id == started.execution_id

    asyncio.run(_run())


def test_retry_attempt_not_before_and_signal_survive_store_restart(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"

    async def _run() -> None:
        store_a = SQLiteExecutionStore(db_path, clock=clock)
        kernel_a = AgentExecutionKernel(store_a)
        started = await kernel_a.dispatch(_start())
        driver = ExecutionDriver(
            store_a,
            ScriptedLoopAdapter([RetryableLoopError("retry later")]),
            retry_policy=_retry_policy(base_delay_seconds=10.0),
        )
        retried = await driver.run_once(owner_id="worker-a")
        assert retried is not None
        assert retried.status == "queued"
        await kernel_a.dispatch(
            SignalExecution(
                request_id="req-signal-during-delay",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "adjust retry"},
            )
        )
        not_before = retried.not_before
        store_a.close()

        store_b = SQLiteExecutionStore(db_path, clock=clock)
        kernel_b = AgentExecutionKernel(store_b)
        restarted = await kernel_b.get(started.execution_id)
        assert restarted.status == "queued"
        assert restarted.attempt == 1
        assert restarted.not_before == not_before
        assert [signal.kind for signal in store_b.fetch_pending_signals(started.execution_id)] == [
            "steer"
        ]
        assert store_b.claim_next(owner_id="worker-b") is None
        clock.advance(10.0)
        lease = store_b.claim_next(owner_id="worker-b")
        assert lease is not None
        assert lease.attempt == 2
        assert [signal.kind for signal in store_b.fetch_pending_signals(started.execution_id)] == [
            "steer"
        ]
        store_b.close()

    asyncio.run(_run())


def test_retry_attempt_limit_goes_to_dead_letter_without_failed_terminal(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        adapter = ScriptedLoopAdapter(
            [
                RetryableLoopError("first retry", error_code="provider_503"),
                RetryableLoopError("second retry", error_code="provider_503"),
            ]
        )
        driver = ExecutionDriver(
            store,
            adapter,
            retry_policy=_retry_policy(max_attempts=2, base_delay_seconds=1.0),
        )

        assert (await driver.run_once(owner_id="worker-a")).status == "queued"
        clock.advance(1.0)
        snapshot = await driver.run_once(owner_id="worker-b")

        assert snapshot is not None
        assert snapshot.status == "failed"
        assert snapshot.last_error_code == "provider_503"
        assert store.claim_next(owner_id="worker-c") is None
        event_types = [event.type for event in await kernel.read_events(started.execution_id)]
        assert event_types[-1] == "execution.dead_lettered"
        assert event_types.count("execution.dead_lettered") == 1
        assert "execution.failed" not in event_types

    asyncio.run(_run())


def test_dead_letter_transaction_fault_rolls_back_and_can_retry_once(tmp_path):
    clock = ManualClock()
    fired = False

    def fault(name: str) -> None:
        nonlocal fired
        if name == "before_dead_letter_commit" and not fired:
            fired = True
            raise RuntimeError("injected dead-letter failure")

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock, fault_hook=fault)
        started = await kernel.dispatch(_start())
        lease = store.claim_next(owner_id="worker-a", lease_ttl_seconds=30.0)
        assert lease is not None

        with pytest.raises(RuntimeError, match="injected dead-letter failure"):
            store.dead_letter_claimed(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                reason="attempt_limit",
                error_code="provider_503",
                message="temporary overload",
                max_attempts=1,
            )

        snapshot = await kernel.get(started.execution_id)
        assert snapshot.status == "running"
        assert snapshot.lease_owner == "worker-a"
        assert snapshot.lease_token == lease.lease_token
        assert snapshot.last_error_code is None
        event_types = [event.type for event in await kernel.read_events(started.execution_id)]
        assert "execution.dead_lettered" not in event_types
        assert "execution.failed" not in event_types

        store._fault_hook = None  # type: ignore[attr-defined]
        failed = store.dead_letter_claimed(
            started.execution_id,
            owner_id="worker-a",
            lease_token=lease.lease_token,
            reason="attempt_limit",
            error_code="provider_503",
            message="temporary overload",
            max_attempts=1,
        )
        assert failed.status == "failed"
        event_types = [event.type for event in await kernel.read_events(started.execution_id)]
        assert event_types.count("execution.dead_lettered") == 1
        assert "execution.failed" not in event_types

    asyncio.run(_run())


def test_plain_adapter_exception_is_nonretryable_and_fails_immediately(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        driver = ExecutionDriver(store, ScriptedLoopAdapter([RuntimeError("boom")]))

        snapshot = await driver.run_once(owner_id="worker-a")

        assert snapshot is not None
        assert snapshot.status == "failed"
        event_types = [event.type for event in await kernel.read_events(started.execution_id)]
        assert event_types[-2:] == ["execution.error", "execution.failed"]
        assert "execution.retry_scheduled" not in event_types

    asyncio.run(_run())


def test_retryable_loop_result_can_schedule_retry(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        await kernel.dispatch(_start())
        driver = ExecutionDriver(
            store,
            ScriptedLoopAdapter(
                [
                    LoopResult(
                        status="failed",
                        last_error_code="model_timeout",
                        error_message="timeout before output",
                        retryable=True,
                        safe_to_retry=True,
                        retry_after_seconds=2.0,
                    )
                ]
            ),
            retry_policy=_retry_policy(),
        )

        snapshot = await driver.run_once(owner_id="worker-a")

        assert snapshot is not None
        assert snapshot.status == "queued"
        assert snapshot.last_error_code == "model_timeout"
        assert snapshot.not_before == clock.now() + 2.0

    asyncio.run(_run())


def test_late_signal_during_retryable_result_survives_until_retry_claim(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        adapter_started = asyncio.Event()
        release_adapter = asyncio.Event()

        class _SlowRetryableAdapter:
            async def run(self, snapshot, signals):  # noqa: ANN001
                assert signals == []
                adapter_started.set()
                await release_adapter.wait()
                return LoopResult(
                    status="failed",
                    last_error_code="model_timeout",
                    error_message="timeout before output",
                    retryable=True,
                    safe_to_retry=True,
                    retry_after_seconds=2.0,
                )

        task = asyncio.create_task(
            ExecutionDriver(
                store,
                _SlowRetryableAdapter(),
                retry_policy=_retry_policy(base_delay_seconds=2.0),
            ).run_once(owner_id="worker-a")
        )
        await adapter_started.wait()
        await kernel.dispatch(
            SignalExecution(
                request_id="req-late-steer",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "change course before retry"},
            )
        )
        release_adapter.set()

        retried = await task

        assert retried is not None
        assert retried.status == "queued"
        assert retried.not_before == clock.now() + 2.0
        assert [signal.kind for signal in store.fetch_pending_signals(started.execution_id)] == [
            "steer"
        ]
        assert store.claim_next(owner_id="too-early") is None
        clock.advance(2.0)

        seen: list[list[str]] = []

        def _consume_signals(_snapshot, signals):
            seen.append([signal.kind for signal in signals])
            return LoopResult(
                status="succeeded",
                applied_signal_ids=[signal.signal_id for signal in signals],
            )

        succeeded = await ExecutionDriver(
            store,
            ScriptedLoopAdapter([_consume_signals]),
            retry_policy=_retry_policy(base_delay_seconds=2.0),
        ).run_once(owner_id="worker-b")

        assert succeeded is not None
        assert succeeded.status == "succeeded"
        assert seen == [["steer"]]
        assert store.fetch_pending_signals(started.execution_id) == []

    asyncio.run(_run())


def test_cancelled_delayed_retry_is_never_claimed(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        driver = ExecutionDriver(
            store,
            ScriptedLoopAdapter([RetryableLoopError("temporary overload")]),
            retry_policy=_retry_policy(base_delay_seconds=5.0),
        )
        retried = await driver.run_once(owner_id="worker-a")
        assert retried is not None
        assert retried.status == "queued"
        assert retried.not_before == clock.now() + 5.0

        cancelled = await kernel.dispatch(
            CancelExecution(
                request_id="req-cancel-delayed",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                reason="operator cancelled delayed retry",
            )
        )

        assert cancelled.status == "cancelled"
        clock.advance(100.0)
        assert store.claim_next(owner_id="worker-b") is None
        event_types = [event.type for event in await kernel.read_events(started.execution_id)]
        assert event_types[-1] == "execution.cancelled"
        assert event_types.count("execution.cancelled") == 1

    asyncio.run(_run())


def test_unknown_external_effect_blocks_retry_for_manual_recovery(tmp_path):
    clock = ManualClock()

    class UnknownEffectAdapter:
        def __init__(self, store: SQLiteExecutionStore) -> None:
            self._store = store

        async def run(self, snapshot, signals):  # noqa: ANN001
            self._store.record_tool_effect(
                snapshot.execution_id,
                effect_key="effect-unknown",
                tool_name="external.write",
                request_hash="hash-1",
                status="unknown",
            )
            raise RetryableLoopError("transport outcome unknown", error_code="tool_timeout")

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        driver = ExecutionDriver(
            store,
            UnknownEffectAdapter(store),
            retry_policy=_retry_policy(base_delay_seconds=1.0),
        )

        snapshot = await driver.run_once(owner_id="worker-a")

        assert snapshot is not None
        assert snapshot.status == "awaiting_signal"
        assert snapshot.not_before is None
        clock.advance(10.0)
        assert store.claim_next(owner_id="worker-b") is None
        event_types = [event.type for event in await kernel.read_events(started.execution_id)]
        payloads = [event.payload for event in await kernel.read_events(started.execution_id)]
        assert event_types[-1] == "execution.recovery_blocked"
        assert payloads[-1]["reason"] == "effect_outcome_unknown"
        assert payloads[-1]["manual_recovery_required"] is True
        assert payloads[-1]["owner_id"] == "worker-a"
        assert "execution.retry_scheduled" not in event_types
        assert "execution.dead_lettered" not in event_types

    asyncio.run(_run())


def test_outbox_retry_and_dead_letter_events_preserve_hol_and_reclaim(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        driver = ExecutionDriver(
            store,
            ScriptedLoopAdapter(
                [
                    RetryableLoopError("first retry", error_code="provider_503"),
                    RetryableLoopError("second retry", error_code="provider_503"),
                ]
            ),
            retry_policy=_retry_policy(max_attempts=2, base_delay_seconds=1.0),
        )

        first = await driver.run_once(owner_id="worker-a")
        assert first is not None
        assert first.status == "queued"

        head = store.claim_outbox_events(
            owner_id="projector-a",
            limit=1,
            lease_ttl_seconds=10.0,
        )
        assert [(event.seq, event.type) for event in head] == [
            (1, "execution.started")
        ]
        assert store.claim_outbox_events(owner_id="projector-b", limit=10) == []
        clock.advance(11.0)
        reclaimed = store.claim_outbox_events(
            owner_id="projector-c",
            limit=1,
            lease_ttl_seconds=10.0,
        )
        assert [(event.seq, event.type) for event in reclaimed] == [
            (1, "execution.started")
        ]
        assert store.ack_outbox_events(
            reclaimed,
            owner_id=reclaimed[0].claim_owner,
            claim_token=reclaimed[0].claim_token,
        ) == 1

        retry_claimed = store.claim_outbox_events(
            owner_id="projector-d",
            limit=10,
            lease_ttl_seconds=10.0,
        )
        assert [(event.seq, event.type) for event in retry_claimed] == [
            (2, "execution.claimed"),
        ]
        assert store.ack_outbox_events(
            retry_claimed,
            owner_id=retry_claimed[0].claim_owner,
            claim_token=retry_claimed[0].claim_token,
        ) == len(retry_claimed)
        retry_scheduled = store.claim_outbox_events(
            owner_id="projector-d",
            limit=10,
            lease_ttl_seconds=10.0,
        )
        assert [(event.seq, event.type) for event in retry_scheduled] == [
            (3, "execution.retry_scheduled"),
        ]
        assert store.ack_outbox_events(
            retry_scheduled,
            owner_id=retry_scheduled[0].claim_owner,
            claim_token=retry_scheduled[0].claim_token,
        ) == len(retry_scheduled)

        clock.advance(1.0)
        failed = await driver.run_once(owner_id="worker-b")
        assert failed is not None
        assert failed.status == "failed"

        terminal_claimed = store.claim_outbox_events(
            owner_id="projector-e",
            limit=10,
            lease_ttl_seconds=10.0,
        )
        assert [(event.seq, event.type) for event in terminal_claimed] == [
            (4, "execution.claimed"),
        ]
        assert store.ack_outbox_events(
            terminal_claimed,
            owner_id=terminal_claimed[0].claim_owner,
            claim_token=terminal_claimed[0].claim_token,
        ) == len(terminal_claimed)
        terminal_dead_letter = store.claim_outbox_events(
            owner_id="projector-e",
            limit=10,
            lease_ttl_seconds=10.0,
        )
        assert [(event.seq, event.type) for event in terminal_dead_letter] == [
            (5, "execution.dead_lettered"),
        ]
        assert all(
            event.execution_id == started.execution_id
            for event in terminal_claimed + terminal_dead_letter
        )

    asyncio.run(_run())


def test_unknown_effect_survives_restart_and_reconcile_does_not_replay(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"

    async def _run() -> None:
        store_a = SQLiteExecutionStore(db_path, clock=clock)
        kernel_a = AgentExecutionKernel(store_a)
        started = await kernel_a.dispatch(_start())
        lease = store_a.claim_next(owner_id="worker-a", lease_ttl_seconds=10.0)
        assert lease is not None
        store_a.record_tool_effect(
            started.execution_id,
            effect_key="effect-unknown",
            tool_name="external.write",
            request_hash="hash-1",
            status="unknown",
        )
        clock.advance(11.0)
        store_a.close()

        store_b = SQLiteExecutionStore(db_path, clock=clock)
        kernel_b = AgentExecutionKernel(store_b)
        assert store_b.reconcile_startup() == 1
        snapshot = await kernel_b.get(started.execution_id)
        assert snapshot.status == "awaiting_signal"
        assert snapshot.lease_owner is None
        assert snapshot.lease_expires_at is None
        clock.advance(100.0)
        assert store_b.claim_next(owner_id="worker-b") is None
        event_types = [event.type for event in await kernel_b.read_events(started.execution_id)]
        assert event_types[-1] == "execution.recovery_blocked"
        assert event_types.count("execution.recovery_blocked") == 1
        assert "execution.retry_scheduled" not in event_types
        assert "execution.dead_lettered" not in event_types
        store_b.close()

    asyncio.run(_run())


def test_existing_sqlite_database_is_migrated_with_not_before_column(tmp_path):
    db_path = tmp_path / "old-executions.sqlite3"
    connection = sqlite3.connect(db_path)
    try:
        connection.execute(
            """
            CREATE TABLE executions (
                execution_id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                subject_ref TEXT NOT NULL,
                trigger_ref TEXT NOT NULL,
                status TEXT NOT NULL,
                worker_profile_ref TEXT NOT NULL,
                run_profile_ref TEXT NOT NULL,
                input_json TEXT NOT NULL,
                state_json TEXT NOT NULL,
                checkpoint_json TEXT NOT NULL,
                version INTEGER NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                attempt INTEGER NOT NULL,
                lease_owner TEXT,
                lease_token INTEGER NOT NULL,
                lease_expires_at REAL,
                last_error_code TEXT,
                linked_execution_id TEXT,
                redrive_metadata_json TEXT NOT NULL
            )
            """
        )
        connection.commit()
    finally:
        connection.close()

    store = SQLiteExecutionStore(db_path, clock=ManualClock())
    try:
        columns = {
            row["name"]
            for row in store._connection.execute("PRAGMA table_info(executions)").fetchall()
        }
    finally:
        store.close()

    assert "not_before" in columns
