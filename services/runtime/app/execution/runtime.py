from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import uuid

from services.crew.app.execution_projection import CrewExecutionProjector
from services.runtime.app.execution.driver import ExecutionDriver, LoopAdapter, RetryPolicy
from services.runtime.app.execution.store import SQLiteExecutionStore

logger = logging.getLogger(__name__)


class AgentExecutionRuntime:
    """Async supervisor for durable AgentExecution workers and projections."""

    def __init__(
        self,
        *,
        store: SQLiteExecutionStore,
        adapter: LoopAdapter,
        projector: CrewExecutionProjector | None = None,
        worker_count: int = 2,
        lease_ttl_seconds: float = 30.0,
        heartbeat_interval_seconds: float | None = None,
        idle_poll_seconds: float = 0.5,
        projector_poll_seconds: float = 0.5,
        owner_prefix: str | None = None,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        if not isinstance(worker_count, int) or worker_count <= 0:
            raise ValueError("worker_count must be a positive integer")
        _validate_positive("lease_ttl_seconds", lease_ttl_seconds)
        if heartbeat_interval_seconds is not None:
            _validate_positive("heartbeat_interval_seconds", heartbeat_interval_seconds)
        _validate_positive("idle_poll_seconds", idle_poll_seconds)
        _validate_positive("projector_poll_seconds", projector_poll_seconds)
        self._store = store
        self._adapter = adapter
        self._projector = projector
        self._worker_count = worker_count
        self._lease_ttl_seconds = lease_ttl_seconds
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._idle_poll_seconds = idle_poll_seconds
        self._projector_poll_seconds = projector_poll_seconds
        self._owner_prefix = owner_prefix or f"agent-runtime-{uuid.uuid4().hex[:8]}"
        self._retry_policy = retry_policy
        self._wake = asyncio.Event()
        self._stopping = asyncio.Event()
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        if self._tasks:
            return
        self._store.reconcile_startup()
        self._stopping.clear()
        for index in range(self._worker_count):
            self._tasks.append(
                asyncio.create_task(self._worker_loop(f"{self._owner_prefix}:worker:{index}"))
            )
        if self._projector is not None:
            self._tasks.append(
                asyncio.create_task(self._projector_loop(f"{self._owner_prefix}:projector"))
            )
        self.wake()

    async def stop(self) -> None:
        if not self._tasks:
            return
        self._stopping.set()
        self.wake()
        for task in self._tasks:
            task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    def wake(self) -> None:
        self._wake.set()

    async def _worker_loop(self, owner_id: str) -> None:
        driver = ExecutionDriver(
            self._store,
            self._adapter,
            lease_ttl_seconds=self._lease_ttl_seconds,
            heartbeat_interval_seconds=self._heartbeat_interval_seconds,
            retry_policy=self._retry_policy,
        )
        while not self._stopping.is_set():
            try:
                snapshot = await driver.run_once(owner_id=owner_id)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - supervisor must keep running
                logger.warning("agent execution worker loop failed", exc_info=True)
                await self._wait_for_wake(self._idle_poll_seconds)
                continue
            if snapshot is not None:
                self.wake()
                continue
            await self._wait_for_wake(self._idle_poll_seconds)

    async def _projector_loop(self, owner_id: str) -> None:
        assert self._projector is not None
        while not self._stopping.is_set():
            try:
                result = self._projector.run_once(
                    owner_id=owner_id,
                    lease_ttl_seconds=self._lease_ttl_seconds,
                )
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - projection failures retry later
                logger.warning("agent execution projector loop failed", exc_info=True)
                await self._wait_for_wake(self._projector_poll_seconds)
                continue
            if result.claimed:
                continue
            await self._wait_for_wake(self._projector_poll_seconds)

    async def _wait_for_wake(self, timeout: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=max(0.01, timeout))
        except TimeoutError:
            pass


def _validate_positive(name: str, value: float) -> None:
    if (
        not isinstance(value, int | float)
        or not math.isfinite(float(value))
        or float(value) <= 0.0
    ):
        raise ValueError(f"{name} must be finite and > 0")
