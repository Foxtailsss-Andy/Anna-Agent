from __future__ import annotations

import asyncio
import sqlite3
import threading

import pytest

from services.runtime.app.execution import (
    ActiveExecutionConflictError,
    AgentExecutionKernel,
    CancelExecution,
    ExecutionNotFoundError,
    FencingError,
    IdempotencyConflictError,
    QueueOverflowError,
    RedriveExecution,
    SignalExecution,
    StartExecution,
    TerminalStateError,
    ToolEffectConflictError,
    ToolEffectTransitionError,
)
from services.runtime.app.execution.clock import ManualClock
from services.runtime.app.execution.driver import (
    ExecutionDriver,
    ScriptedLoopAdapter,
    ScriptedLoopDriver,
)
from services.runtime.app.execution.models import LoopResult
from services.runtime.app.execution.store import SQLiteExecutionStore


def _kernel(
    tmp_path,
    *,
    clock: ManualClock | None = None,
    max_queue_depth: int = 10,
    fault_hook=None,
):
    store = SQLiteExecutionStore(
        tmp_path / "executions.sqlite3",
        clock=clock or ManualClock(),
        fault_hook=fault_hook,
    )
    return AgentExecutionKernel(store, max_queue_depth=max_queue_depth), store


def _start(
    request_id: str = "req-start",
    *,
    workspace_id: str = "ws-1",
    subject_ref: str = "task:1",
    trigger_ref: str = "message:m-1",
    input: dict | None = None,
) -> StartExecution:
    return StartExecution(
        request_id=request_id,
        workspace_id=workspace_id,
        conversation_id="conversation:c-1",
        channel_id="channel:crew",
        subject_ref=subject_ref,
        trigger_ref=trigger_ref,
        worker_profile_ref="worker:scribe",
        run_profile_ref="run:crew-default",
        input=input or {"prompt": "draft"},
    )


def test_start_is_workspace_scoped_idempotent_and_conflicts(tmp_path):
    async def _run() -> None:
        kernel, _store = _kernel(tmp_path)

        first = await kernel.dispatch(_start("req-1", workspace_id="ws-a"))
        second = await kernel.dispatch(_start("req-1", workspace_id="ws-a"))
        other_workspace = await kernel.dispatch(
            _start("req-1", workspace_id="ws-b", subject_ref="task:1")
        )

        assert second.execution_id == first.execution_id
        assert other_workspace.execution_id != first.execution_id
        assert first.workspace_id == "ws-a"
        assert first.conversation_id == "conversation:c-1"
        assert first.channel_id == "channel:crew"
        assert first.subject_ref == "task:1"
        assert first.trigger_ref == "message:m-1"
        assert first.input == {"prompt": "draft"}

        with pytest.raises(IdempotencyConflictError):
            await kernel.dispatch(
                _start(
                    "req-1",
                    workspace_id="ws-a",
                    input={"prompt": "changed"},
                )
            )

    asyncio.run(_run())


def test_same_workspace_subject_allows_only_one_active_execution(tmp_path):
    async def _run() -> None:
        kernel, _store = _kernel(tmp_path)

        existing = await kernel.dispatch(_start("req-1", subject_ref="task:active"))

        with pytest.raises(ActiveExecutionConflictError) as exc:
            await kernel.dispatch(_start("req-2", subject_ref="task:active"))
        assert exc.value.existing_execution_id == existing.execution_id

    asyncio.run(_run())


def test_same_subject_conflict_is_typed_across_two_store_instances(tmp_path):
    db_path = tmp_path / "executions.sqlite3"
    store_a = SQLiteExecutionStore(db_path, clock=ManualClock())
    store_b = SQLiteExecutionStore(db_path, clock=ManualClock())
    kernel_a = AgentExecutionKernel(store_a)
    kernel_b = AgentExecutionKernel(store_b)
    barrier = threading.Barrier(2)
    results = []

    def start(kernel: AgentExecutionKernel, request_id: str) -> None:
        async def _run() -> None:
            barrier.wait()
            try:
                results.append(await kernel.dispatch(_start(request_id, subject_ref="task:race")))
            except Exception as exc:  # noqa: BLE001 - assert typed outcome below
                results.append(exc)

        asyncio.run(_run())

    threads = [
        threading.Thread(target=start, args=(kernel_a, "req-race-a")),
        threading.Thread(target=start, args=(kernel_b, "req-race-b")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    successes = [result for result in results if not isinstance(result, Exception)]
    conflicts = [result for result in results if isinstance(result, ActiveExecutionConflictError)]
    assert len(successes) == 1
    assert len(conflicts) == 1
    assert conflicts[0].existing_execution_id == successes[0].execution_id
    store_a.close()
    store_b.close()


def test_non_active_index_integrity_error_is_not_misreported(tmp_path, monkeypatch):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        created = await kernel.dispatch(_start("req-1", subject_ref="task:done"))
        await ScriptedLoopDriver(
            store,
            ScriptedLoopAdapter([LoopResult(status="succeeded")]),
        ).run_once(owner_id="worker-a")

        import services.runtime.app.execution.store as store_module

        class _FixedUuid:
            hex = created.execution_id.removeprefix("exec_")

        monkeypatch.setattr(store_module.uuid, "uuid4", lambda: _FixedUuid())

        with pytest.raises(sqlite3.IntegrityError):
            await kernel.dispatch(_start("req-2", subject_ref="task:new"))

    asyncio.run(_run())


def test_event_seq_is_monotonic_and_terminal_is_immutable(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        driver = ScriptedLoopDriver(
            store,
            ScriptedLoopAdapter(
                [
                    LoopResult(
                        status="succeeded",
                        state={"answer": "done"},
                        checkpoint={"turn": 1},
                        events=[("execution.progressed", {"step": "final"})],
                    )
                ]
            ),
        )

        await driver.run_once(owner_id="worker-a")
        snapshot = await kernel.get(started.execution_id)
        assert snapshot.status == "succeeded"

        with pytest.raises(TerminalStateError):
            await kernel.dispatch(
                CancelExecution(
                    request_id="req-cancel-terminal",
                    workspace_id="ws-1",
                    execution_id=started.execution_id,
                    reason="too late",
                )
            )

        events = await kernel.read_events(started.execution_id)
        assert [event.seq for event in events] == list(range(1, len(events) + 1))
        assert [event.type for event in events].count("execution.succeeded") == 1

    asyncio.run(_run())


def test_claim_is_safe_across_two_store_instances(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"

    async def _run() -> None:
        store_a = SQLiteExecutionStore(db_path, clock=clock)
        store_b = SQLiteExecutionStore(db_path, clock=clock)
        kernel = AgentExecutionKernel(store_a)
        started = await kernel.dispatch(_start())
        claims = []
        barrier = threading.Barrier(2)

        def claim(store: SQLiteExecutionStore, owner_id: str) -> None:
            barrier.wait()
            claims.append(store.claim_next(owner_id=owner_id, lease_ttl_seconds=30.0))

        threads = [
            threading.Thread(target=claim, args=(store_a, "worker-a")),
            threading.Thread(target=claim, args=(store_b, "worker-b")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        winners = [claim for claim in claims if claim is not None]
        assert len(winners) == 1
        assert winners[0].execution_id == started.execution_id
        assert (await kernel.get(started.execution_id)).status == "running"
        store_a.close()
        store_b.close()

    asyncio.run(_run())


def test_outbox_claim_and_ack_are_fenced_across_two_consumers(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"
    store_a = SQLiteExecutionStore(db_path, clock=clock)
    store_b = SQLiteExecutionStore(db_path, clock=clock)
    kernel = AgentExecutionKernel(store_a)
    claims = []
    barrier = threading.Barrier(2)

    async def _dispatch() -> None:
        await kernel.dispatch(_start())

    asyncio.run(_dispatch())

    def claim(store: SQLiteExecutionStore, owner_id: str) -> None:
        barrier.wait()
        claims.append(store.claim_outbox_events(owner_id=owner_id, lease_ttl_seconds=30.0))

    threads = [
        threading.Thread(target=claim, args=(store_a, "projector-a")),
        threading.Thread(target=claim, args=(store_b, "projector-b")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    winners = [claim for claim in claims if claim]
    losers = [claim for claim in claims if not claim]
    assert len(winners) == 1
    assert len(losers) == 1
    claimed = winners[0]
    assert len(claimed) == 1
    event = claimed[0]

    assert store_b.ack_outbox_events(
        [event],
        owner_id="not-the-owner",
        claim_token=event.claim_token,
    ) == 0
    assert store_a.ack_outbox_events(
        [event],
        owner_id=event.claim_owner,
        claim_token=event.claim_token,
    ) == 1
    assert store_a.claim_outbox_events(owner_id="projector-a") == []
    store_a.close()
    store_b.close()


def test_outbox_claim_preserves_per_execution_head_of_line(tmp_path):
    clock = ManualClock()
    db_path = tmp_path / "executions.sqlite3"
    store_a = SQLiteExecutionStore(db_path, clock=clock)
    store_b = SQLiteExecutionStore(db_path, clock=clock)

    first = store_a.dispatch(
        _start("req-outbox-1", subject_ref="task:outbox-1"),
        max_queue_depth=10,
    )
    assert store_a.claim_next(owner_id="worker-a", lease_ttl_seconds=60.0) is not None
    second = store_a.dispatch(
        _start("req-outbox-2", subject_ref="task:outbox-2"),
        max_queue_depth=10,
    )

    seq1 = store_a.claim_outbox_events(
        owner_id="projector-a",
        limit=1,
        lease_ttl_seconds=30.0,
    )
    assert [(event.execution_id, event.seq) for event in seq1] == [(first.execution_id, 1)]

    other_head = store_b.claim_outbox_events(
        owner_id="projector-b",
        limit=10,
        lease_ttl_seconds=30.0,
    )
    assert [(event.execution_id, event.seq) for event in other_head] == [
        (second.execution_id, 1)
    ]

    clock.advance(31.0)
    reclaimed = store_b.claim_outbox_events(
        owner_id="projector-c",
        limit=1,
        lease_ttl_seconds=30.0,
    )
    assert [(event.execution_id, event.seq) for event in reclaimed] == [
        (first.execution_id, 1)
    ]
    assert store_b.ack_outbox_events(
        reclaimed,
        owner_id=reclaimed[0].claim_owner,
        claim_token=reclaimed[0].claim_token,
    ) == 1

    restored = store_a.claim_outbox_events(
        owner_id="projector-d",
        limit=10,
        lease_ttl_seconds=30.0,
    )
    assert (first.execution_id, 2) in {
        (event.execution_id, event.seq) for event in restored
    }
    store_a.close()
    store_b.close()


def test_expired_lease_cannot_heartbeat_or_commit_even_before_reclaim(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())

        lease = store.claim_next(owner_id="worker-a", lease_ttl_seconds=10.0)
        assert lease is not None
        clock.advance(11.0)

        assert not store.heartbeat(
            started.execution_id,
            owner_id="worker-a",
            lease_token=lease.lease_token,
            lease_ttl_seconds=10.0,
        )
        with pytest.raises(FencingError):
            store.commit_loop_result(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                result=LoopResult(status="succeeded"),
            )

    asyncio.run(_run())


def test_invalid_lease_ttl_is_rejected_before_sqlite(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())

        with pytest.raises(ValueError):
            store.claim_next(owner_id="worker-a", lease_ttl_seconds=0)
        with pytest.raises(ValueError):
            store.heartbeat(
                started.execution_id,
                owner_id="worker-a",
                lease_token=1,
                lease_ttl_seconds=float("inf"),
            )

    asyncio.run(_run())


def test_expired_claim_marks_old_attempt_expired_and_reclaims(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        lease_a = store.claim_next(owner_id="worker-a", lease_ttl_seconds=10.0)
        assert lease_a is not None
        clock.advance(11.0)

        lease_b = store.claim_next(owner_id="worker-b", lease_ttl_seconds=10.0)

        assert lease_b is not None
        assert lease_b.lease_token == 2
        events = await kernel.read_events(started.execution_id)
        assert [event.type for event in events][-2:] == [
            "execution.lease_expired",
            "execution.claimed",
        ]

    asyncio.run(_run())


def test_signal_inbox_is_idempotent_and_consumed_once(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        signal = SignalExecution(
            request_id="req-signal",
            workspace_id="ws-1",
            execution_id=started.execution_id,
            kind="answer",
            payload={"text": "继续"},
        )

        await kernel.dispatch(signal)
        await kernel.dispatch(signal)

        with pytest.raises(IdempotencyConflictError):
            await kernel.dispatch(
                SignalExecution(
                    request_id="req-signal",
                    workspace_id="ws-1",
                    execution_id=started.execution_id,
                    kind="answer",
                    payload={"text": "换答案"},
                )
            )

        adapter = ScriptedLoopAdapter(
            [
                lambda _snapshot, signals: LoopResult(
                    status="awaiting_signal",
                    applied_signal_ids=[signal.signal_id for signal in signals],
                ),
                lambda _snapshot, signals: LoopResult(
                    status="succeeded",
                    applied_signal_ids=[signal.signal_id for signal in signals],
                ),
            ]
        )
        driver = ScriptedLoopDriver(store, adapter)
        await driver.run_once(owner_id="worker-a")
        await kernel.dispatch(
            SignalExecution(
                request_id="req-signal-2",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "第二次"},
            )
        )
        await driver.run_once(owner_id="worker-a")

        first_signals = adapter.calls[0][1]
        second_signals = adapter.calls[1][1]
        assert len(first_signals) == 1
        assert first_signals[0].kind == "answer"
        assert len(second_signals) == 1
        assert second_signals[0].kind == "steer"
        assert second_signals[0].signal_id != first_signals[0].signal_id

    asyncio.run(_run())


def test_driver_only_applies_loop_result_signal_ids(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        await kernel.dispatch(
            SignalExecution(
                request_id="req-signal",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "adjust"},
            )
        )

        driver = ScriptedLoopDriver(
            store,
            ScriptedLoopAdapter([LoopResult(status="awaiting_signal")]),
        )
        await driver.run_once(owner_id="worker-a")

        pending = store.fetch_pending_signals(started.execution_id)
        assert len(pending) == 1
        assert pending[0].kind == "steer"

    asyncio.run(_run())


def test_driver_can_apply_only_supported_steer_signals(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        await kernel.dispatch(
            SignalExecution(
                request_id="req-answer",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="answer",
                payload={"text": "answer"},
            )
        )
        await kernel.dispatch(
            SignalExecution(
                request_id="req-approval",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="approval",
                payload={"text": "approve"},
            )
        )
        await kernel.dispatch(
            SignalExecution(
                request_id="req-steer",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "steer"},
            )
        )

        def _apply_steer_only(_snapshot, signals):
            return LoopResult(
                status="awaiting_signal",
                applied_signal_ids=[
                    signal.signal_id for signal in signals if signal.kind == "steer"
                ],
            )

        driver = ScriptedLoopDriver(store, ScriptedLoopAdapter([_apply_steer_only]))
        await driver.run_once(owner_id="worker-a")

        pending = store.fetch_pending_signals(started.execution_id)
        assert [signal.kind for signal in pending] == ["answer", "approval"]

    asyncio.run(_run())


def test_terminal_result_defers_when_late_signal_arrives_after_claim(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        await kernel.dispatch(
            SignalExecution(
                request_id="req-answer",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="answer",
                payload={"text": "answer"},
            )
        )
        lease = store.claim_next(owner_id="worker-a")
        assert lease is not None
        fetched = store.fetch_pending_signals(started.execution_id)
        assert [signal.kind for signal in fetched] == ["answer"]

        await kernel.dispatch(
            SignalExecution(
                request_id="req-late-steer",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "change course"},
            )
        )

        snapshot = store.commit_loop_result(
            started.execution_id,
            owner_id="worker-a",
            lease_token=lease.lease_token,
            result=LoopResult(
                status="succeeded",
                state={"answer": "stale"},
                checkpoint={"turn": 1},
                events=[("crew.task.artifact_produced", {"artifact_id": "stale"})],
                applied_signal_ids=[signal.signal_id for signal in fetched],
            ),
            signal_ids=[signal.signal_id for signal in fetched],
        )

        assert snapshot.status == "queued"
        assert snapshot.lease_owner is None
        assert snapshot.state == {}
        assert snapshot.checkpoint == {}
        pending = store.fetch_pending_signals(started.execution_id)
        assert [signal.kind for signal in pending] == ["steer"]

        events = await kernel.read_events(started.execution_id)
        assert "crew.task.artifact_produced" not in [event.type for event in events]
        assert "execution.succeeded" not in [event.type for event in events]
        assert events[-1].type == "execution.result_deferred"
        assert events[-1].payload["reason"] == "late_signal"
        assert events[-1].payload["deferred_status"] == "succeeded"
        assert events[-1].payload["pending_signal_kinds"] == ["steer"]
        assert events[-1].payload["applied_signal_ids"] == [
            signal.signal_id for signal in fetched
        ]

    asyncio.run(_run())


def test_driver_defers_terminal_result_when_signal_is_dispatched_during_adapter_run(
    tmp_path,
):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        adapter_started = asyncio.Event()
        release_adapter = asyncio.Event()

        class _SlowTerminalAdapter:
            async def run(self, snapshot, signals) -> LoopResult:
                assert signals == []
                adapter_started.set()
                await release_adapter.wait()
                return LoopResult(
                    status="succeeded",
                    events=[("crew.task.artifact_produced", {"artifact_id": "stale"})],
                )

        task = asyncio.create_task(
            ExecutionDriver(store, _SlowTerminalAdapter()).run_once(owner_id="worker-a")
        )
        await adapter_started.wait()
        await kernel.dispatch(
            SignalExecution(
                request_id="req-late-steer",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "change course"},
            )
        )
        release_adapter.set()

        deferred = await task

        assert deferred is not None
        assert deferred.status == "queued"
        assert [signal.kind for signal in store.fetch_pending_signals(started.execution_id)] == [
            "steer"
        ]
        events = await kernel.read_events(started.execution_id)
        assert events[-1].type == "execution.result_deferred"
        assert "execution.succeeded" not in [event.type for event in events]

        second = await ScriptedLoopDriver(
            store,
            ScriptedLoopAdapter(
                [
                    lambda _snapshot, signals: LoopResult(
                        status="succeeded",
                        applied_signal_ids=[signal.signal_id for signal in signals],
                    )
                ]
            ),
        ).run_once(owner_id="worker-b")

        assert second is not None
        assert second.status == "succeeded"
        assert store.fetch_pending_signals(started.execution_id) == []

    asyncio.run(_run())


def test_invalid_signal_kind_is_rejected_before_sqlite(tmp_path):
    async def _run() -> None:
        kernel, _store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())

        with pytest.raises(ValueError):
            await kernel.dispatch(
                SignalExecution(
                    request_id="req-bad-signal",
                    workspace_id="ws-1",
                    execution_id=started.execution_id,
                    kind="bad",  # type: ignore[arg-type]
                    payload={},
                )
            )

    asyncio.run(_run())


def test_signal_consumption_rolls_back_with_commit_failure(tmp_path):
    fired = False

    def fault(name: str) -> None:
        nonlocal fired
        if name == "before_commit_loop_result" and not fired:
            fired = True
            raise RuntimeError("injected commit failure")

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, fault_hook=fault)
        started = await kernel.dispatch(_start())
        await kernel.dispatch(
            SignalExecution(
                request_id="req-signal",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                kind="steer",
                payload={"text": "adjust"},
            )
        )
        lease = store.claim_next(owner_id="worker-a")
        assert lease is not None
        pending = store.fetch_pending_signals(started.execution_id)

        with pytest.raises(RuntimeError, match="injected commit failure"):
            store.commit_loop_result(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                result=LoopResult(status="running", state={"phase": "half"}),
                signal_ids=[signal.signal_id for signal in pending],
            )

        assert len(store.fetch_pending_signals(started.execution_id)) == 1
        snapshot = await kernel.get(started.execution_id)
        assert snapshot.state == {}

    asyncio.run(_run())


def test_queued_and_awaiting_signal_release_lease(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        lease = store.claim_next(owner_id="worker-a")
        assert lease is not None

        snapshot = store.commit_loop_result(
            started.execution_id,
            owner_id="worker-a",
            lease_token=lease.lease_token,
            result=LoopResult(status="awaiting_signal"),
        )

        assert snapshot.status == "awaiting_signal"
        assert snapshot.lease_owner is None
        assert snapshot.lease_expires_at is None

    asyncio.run(_run())


def test_loop_result_validation_and_terminal_event_rejection(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        lease = store.claim_next(owner_id="worker-a")
        assert lease is not None

        with pytest.raises(ValueError):
            store.commit_loop_result(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                result=LoopResult(status="cancelled"),
            )
        with pytest.raises(ValueError):
            store.commit_loop_result(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                result=LoopResult(
                    status="running",
                    events=[("execution.succeeded", {"fake": True})],
                ),
            )

    asyncio.run(_run())


def test_driver_cancel_race_does_not_second_fail(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        adapter = ScriptedLoopAdapter([LoopResult(status="succeeded")])
        lease = store.claim_next(owner_id="worker-a")
        assert lease is not None
        await kernel.dispatch(
            CancelExecution(
                request_id="req-cancel",
                workspace_id="ws-1",
                execution_id=started.execution_id,
                reason="operator",
            )
        )

        with pytest.raises(FencingError):
            store.commit_loop_result(
                started.execution_id,
                owner_id="worker-a",
                lease_token=lease.lease_token,
                result=LoopResult(status="succeeded"),
            )
        assert adapter.calls == []
        events = await kernel.read_events(started.execution_id)
        assert events[-1].type == "execution.cancelled"

    asyncio.run(_run())


def test_startup_reconcile_requeues_safe_expired_running(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        assert store.claim_next(owner_id="worker-a", lease_ttl_seconds=10.0) is not None
        clock.advance(11.0)

        assert store.reconcile_startup() == 1
        snapshot = await kernel.get(started.execution_id)

        assert snapshot.status == "queued"
        assert [event.type for event in await kernel.read_events(started.execution_id)][-1] == (
            "execution.requeued"
        )

    asyncio.run(_run())


def test_startup_reconcile_blocks_unknown_external_effects(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        started = await kernel.dispatch(_start())
        assert store.claim_next(owner_id="worker-a", lease_ttl_seconds=10.0) is not None
        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-1",
            tool_name="external.write",
            request_hash="hash-1",
            status="unknown",
        )
        clock.advance(11.0)

        assert store.reconcile_startup() == 1
        snapshot = await kernel.get(started.execution_id)
        events = await kernel.read_events(started.execution_id)
        assert snapshot.status == "awaiting_signal"
        assert events[-1].type == "execution.recovery_blocked"

    asyncio.run(_run())


def test_claim_blocks_expired_running_with_unknown_effect_and_claims_next_safe(tmp_path):
    clock = ManualClock()

    async def _run() -> None:
        kernel, store = _kernel(tmp_path, clock=clock)
        blocked = await kernel.dispatch(_start("req-blocked", subject_ref="task:blocked"))
        assert store.claim_next(owner_id="worker-a", lease_ttl_seconds=10.0) is not None
        store.record_tool_effect(
            blocked.execution_id,
            effect_key="effect-blocked",
            tool_name="external.write",
            request_hash="hash-1",
            status="unknown",
        )
        clock.advance(1.0)
        safe = await kernel.dispatch(_start("req-safe", subject_ref="task:safe"))
        clock.advance(11.0)

        lease = store.claim_next(owner_id="worker-b", lease_ttl_seconds=10.0)

        assert lease is not None
        assert lease.execution_id == safe.execution_id
        blocked_snapshot = await kernel.get(blocked.execution_id)
        assert blocked_snapshot.status == "awaiting_signal"
        assert blocked_snapshot.lease_owner is None
        assert blocked_snapshot.lease_expires_at is None
        assert (await kernel.read_events(blocked.execution_id))[-1].type == (
            "execution.recovery_blocked"
        )

    asyncio.run(_run())


def test_tool_effect_ledger_idempotency_status_validation_and_monotonicity(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-1",
            tool_name="external.write",
            request_hash="hash-1",
            status="pending",
        )
        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-1",
            tool_name="external.write",
            request_hash="hash-1",
            status="unknown",
        )
        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-1",
            tool_name="external.write",
            request_hash="hash-1",
            status="unknown",
        )

        with pytest.raises(ToolEffectTransitionError) as unknown_to_pending:
            store.record_tool_effect(
                started.execution_id,
                effect_key="effect-1",
                tool_name="external.write",
                request_hash="hash-1",
                status="pending",
            )
        assert unknown_to_pending.value.effect_key == "effect-1"
        assert unknown_to_pending.value.from_status == "unknown"
        assert unknown_to_pending.value.to_status == "pending"

        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-1",
            tool_name="external.write",
            request_hash="hash-1",
            status="succeeded",
        )
        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-1",
            tool_name="external.write",
            request_hash="hash-1",
            status="succeeded",
        )

        with pytest.raises(ToolEffectTransitionError) as terminal_change:
            store.record_tool_effect(
                started.execution_id,
                effect_key="effect-1",
                tool_name="external.write",
                request_hash="hash-1",
                status="failed",
            )
        assert terminal_change.value.from_status == "succeeded"
        assert terminal_change.value.to_status == "failed"

        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-failed",
            tool_name="external.write",
            request_hash="hash-failed",
            status="failed",
        )
        store.record_tool_effect(
            started.execution_id,
            effect_key="effect-failed",
            tool_name="external.write",
            request_hash="hash-failed",
            status="failed",
        )
        with pytest.raises(ToolEffectTransitionError):
            store.record_tool_effect(
                started.execution_id,
                effect_key="effect-failed",
                tool_name="external.write",
                request_hash="hash-failed",
                status="unknown",
            )

        with pytest.raises(ToolEffectConflictError):
            store.record_tool_effect(
                started.execution_id,
                effect_key="effect-1",
                tool_name="external.other",
                request_hash="hash-1",
                status="pending",
            )
        with pytest.raises(ValueError):
            store.record_tool_effect(
                started.execution_id,
                effect_key="effect-2",
                tool_name="external.write",
                request_hash="hash-2",
                status="bad",
            )

    asyncio.run(_run())


def test_queue_overflow_is_stable_for_start_and_redrive(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path, max_queue_depth=1)
        await kernel.dispatch(_start("req-start-1", subject_ref="task:1"))

        overflow_start = _start("req-start-2", subject_ref="task:2")
        with pytest.raises(QueueOverflowError):
            await kernel.dispatch(overflow_start)
        with pytest.raises(QueueOverflowError):
            await kernel.dispatch(overflow_start)
        blocker = store.claim_next(owner_id="worker-blocker")
        assert blocker is not None
        store.commit_loop_result(
            blocker.execution_id,
            owner_id="worker-blocker",
            lease_token=blocker.lease_token,
            result=LoopResult(status="awaiting_signal"),
        )

        roomy = AgentExecutionKernel(store, max_queue_depth=10)
        limited = AgentExecutionKernel(store, max_queue_depth=1)
        failed = await roomy.dispatch(
            _start("req-failed", workspace_id="ws-2", subject_ref="task:failed")
        )
        driver = ScriptedLoopDriver(store, ScriptedLoopAdapter([RuntimeError("boom")]))
        await driver.run_once(owner_id="worker-a")
        assert (await kernel.get(failed.execution_id)).status == "failed"
        await roomy.dispatch(
            _start("req-redrive-blocker", workspace_id="ws-2", subject_ref="task:blocker")
        )

        redrive = RedriveExecution(
            request_id="req-redrive-overflow",
            workspace_id="ws-2",
            execution_id=failed.execution_id,
            reason="retry",
        )
        with pytest.raises(QueueOverflowError):
            await limited.dispatch(redrive)
        with pytest.raises(QueueOverflowError):
            await limited.dispatch(redrive)

    asyncio.run(_run())


def test_loop_error_becomes_durable_event_and_snapshot(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())
        driver = ScriptedLoopDriver(store, ScriptedLoopAdapter([RuntimeError("boom")]))

        await driver.run_once(owner_id="worker-a")

        snapshot = await kernel.get(started.execution_id)
        events = await kernel.read_events(started.execution_id)
        assert snapshot.status == "failed"
        assert snapshot.last_error_code == "loop_error"
        assert events[-1].type == "execution.failed"
        assert events[-1].payload["message"] == "boom"

    asyncio.run(_run())


def test_redrive_copies_original_input_and_provenance_only_for_failed_or_cancelled(tmp_path):
    async def _run() -> None:
        kernel, store = _kernel(tmp_path)
        failed = await kernel.dispatch(
            _start(
                "req-failed",
                subject_ref="task:failed",
                input={"prompt": "original"},
            )
        )
        await ScriptedLoopDriver(
            store,
            ScriptedLoopAdapter([RuntimeError("boom")]),
        ).run_once(owner_id="worker-a")

        redriven = await kernel.dispatch(
            RedriveExecution(
                request_id="req-redrive",
                workspace_id="ws-1",
                execution_id=failed.execution_id,
                reason="operator retry",
            )
        )

        assert redriven.status == "queued"
        assert redriven.linked_execution_id == failed.execution_id
        assert redriven.input == {"prompt": "original"}
        assert redriven.subject_ref == "task:failed"
        assert redriven.redrive_metadata == {
            "redrive_of": failed.execution_id,
            "reason": "operator retry",
        }

        succeeded = await AgentExecutionKernel(store, max_queue_depth=10).dispatch(
            _start("req-succeeded", subject_ref="task:succeeded")
        )
        await ScriptedLoopDriver(
            store,
            ScriptedLoopAdapter([LoopResult(status="succeeded")]),
        ).run_once(owner_id="worker-a")
        with pytest.raises(TerminalStateError):
            await kernel.dispatch(
                RedriveExecution(
                    request_id="req-redrive-succeeded",
                    workspace_id="ws-1",
                    execution_id=succeeded.execution_id,
                    reason="retry",
                )
            )

    asyncio.run(_run())


def test_read_events_not_found_and_limit_clamp(tmp_path):
    async def _run() -> None:
        kernel, _store = _kernel(tmp_path)
        started = await kernel.dispatch(_start())

        with pytest.raises(ExecutionNotFoundError):
            await kernel.read_events("missing")
        assert len(await kernel.read_events(started.execution_id, limit=0)) == 1

    asyncio.run(_run())


def test_store_context_manager_closes(tmp_path):
    with SQLiteExecutionStore(tmp_path / "executions.sqlite3", clock=ManualClock()) as store:
        assert store.claim_next(owner_id="nobody") is None
