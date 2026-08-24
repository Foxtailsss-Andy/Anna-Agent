from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from services.runtime.app.execution.models import ExecutionSnapshot, LoopResult, PendingSignal
from services.runtime.app.execution.store import FencingError, SQLiteExecutionStore


class RetryableLoopError(RuntimeError):
    """Typed adapter failure that is safe for the execution kernel to retry."""

    retryable = True
    safe_to_retry = True

    def __init__(
        self,
        message: str,
        *,
        error_code: str = "loop_transient_error",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_seconds: float = 1.0
    max_delay_seconds: float = 60.0
    jitter: Callable[[str, int, float], float] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.max_attempts, int) or self.max_attempts <= 0:
            raise ValueError("max_attempts must be a positive integer")
        _validate_positive("base_delay_seconds", self.base_delay_seconds)
        _validate_positive("max_delay_seconds", self.max_delay_seconds)
        if self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError("max_delay_seconds must be >= base_delay_seconds")

    def delay_for_attempt(
        self,
        execution_key: str,
        attempt: int,
        *,
        retry_after_seconds: float | None = None,
    ) -> float:
        if retry_after_seconds is not None:
            if (
                not isinstance(retry_after_seconds, int | float)
                or not math.isfinite(float(retry_after_seconds))
                or float(retry_after_seconds) < 0.0
            ):
                raise ValueError("retry_after_seconds must be finite and >= 0")
            base_delay = float(retry_after_seconds)
        else:
            exponent = max(0, int(attempt) - 1)
            base_delay = min(
                self.max_delay_seconds,
                self.base_delay_seconds * (2**exponent),
            )
        if self.jitter is None:
            jitter = _stable_jitter(execution_key, int(attempt), base_delay)
        else:
            jitter = float(self.jitter(execution_key, int(attempt), base_delay))
        if not math.isfinite(jitter):
            raise ValueError("retry jitter must be finite")
        return max(0.0, min(self.max_delay_seconds, base_delay + jitter))


class LoopAdapter(Protocol):
    async def run(
        self,
        snapshot: ExecutionSnapshot,
        signals: list[PendingSignal],
    ) -> LoopResult:
        ...


class ScriptedLoopAdapter:
    """Deterministic loop adapter for AgentExecution contract tests."""

    def __init__(
        self,
        outcomes: list[
            LoopResult
            | BaseException
            | Callable[[ExecutionSnapshot, list[PendingSignal]], LoopResult]
        ],
    ) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[tuple[ExecutionSnapshot, list[PendingSignal]]] = []

    async def run(
        self,
        snapshot: ExecutionSnapshot,
        signals: list[PendingSignal],
    ) -> LoopResult:
        self.calls.append((snapshot, signals))
        if not self._outcomes:
            return LoopResult(status="succeeded")
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        if callable(outcome):
            return outcome(snapshot, signals)
        return outcome


class ScriptedLoopDriver:
    """Compatibility alias for older tests; production code uses ExecutionDriver."""

    def __init__(
        self,
        store: SQLiteExecutionStore,
        adapter: LoopAdapter,
        *,
        lease_ttl_seconds: float = 30.0,
        heartbeat_interval_seconds: float | None = None,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self._driver = ExecutionDriver(
            store,
            adapter,
            lease_ttl_seconds=lease_ttl_seconds,
            heartbeat_interval_seconds=heartbeat_interval_seconds,
            retry_policy=retry_policy,
        )

    async def run_once(self, *, owner_id: str) -> ExecutionSnapshot | None:
        return await self._driver.run_once(owner_id=owner_id)


class ExecutionDriver:
    """Claim one durable execution, run a LoopAdapter, and commit through fencing."""

    def __init__(
        self,
        store: SQLiteExecutionStore,
        adapter: LoopAdapter,
        *,
        lease_ttl_seconds: float = 30.0,
        heartbeat_interval_seconds: float | None = None,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self._store = store
        self._adapter = adapter
        _validate_positive("lease_ttl_seconds", lease_ttl_seconds)
        self._lease_ttl_seconds = lease_ttl_seconds
        if heartbeat_interval_seconds is None:
            heartbeat_interval_seconds = max(0.05, lease_ttl_seconds / 3.0)
        _validate_positive("heartbeat_interval_seconds", heartbeat_interval_seconds)
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._retry_policy = retry_policy or RetryPolicy()

    async def run_once(self, *, owner_id: str) -> ExecutionSnapshot | None:
        lease = self._store.claim_next(
            owner_id=owner_id,
            lease_ttl_seconds=self._lease_ttl_seconds,
        )
        if lease is None:
            return None
        heartbeat_stop = asyncio.Event()
        heartbeat_lost = asyncio.Event()
        heartbeat_task = asyncio.create_task(
            self._heartbeat(
                execution_id=lease.execution_id,
                owner_id=owner_id,
                lease_token=lease.lease_token,
                stop=heartbeat_stop,
                lost=heartbeat_lost,
            )
        )
        adapter_task: asyncio.Task[LoopResult] | None = None
        try:
            snapshot = self._store.get(lease.execution_id)
            signals = self._store.fetch_pending_signals(lease.execution_id)
            adapter_task = asyncio.create_task(self._adapter.run(snapshot, signals))
            done, _pending = await asyncio.wait(
                {adapter_task, heartbeat_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if heartbeat_task in done and heartbeat_lost.is_set():
                adapter_task.cancel()
                try:
                    await adapter_task
                except asyncio.CancelledError:
                    pass
                try:
                    return self._store.requeue_claimed(
                        lease.execution_id,
                        owner_id=owner_id,
                        lease_token=lease.lease_token,
                        reason="heartbeat_lost",
                    )
                except FencingError:
                    return None
            result = await adapter_task
            if _result_requests_retry(result):
                return self._schedule_retry(
                    lease.execution_id,
                    owner_id=owner_id,
                    lease_token=lease.lease_token,
                    attempt=lease.attempt,
                    reason="loop_result_retryable",
                    error_code=result.last_error_code or "loop_retryable_failure",
                    message=result.error_message or "Loop requested retry.",
                    retry_after_seconds=result.retry_after_seconds,
                )
            return self._store.commit_loop_result(
                lease.execution_id,
                owner_id=owner_id,
                lease_token=lease.lease_token,
                result=result,
                signal_ids=result.applied_signal_ids,
            )
        except asyncio.CancelledError:
            if adapter_task is not None:
                adapter_task.cancel()
                try:
                    await adapter_task
                except asyncio.CancelledError:
                    pass
            try:
                self._store.requeue_claimed(
                    lease.execution_id,
                    owner_id=owner_id,
                    lease_token=lease.lease_token,
                    reason="runtime_shutdown",
                )
            except FencingError:
                pass
            raise
        except FencingError:
            return None
        except RetryableLoopError as exc:
            try:
                return self._schedule_retry(
                    lease.execution_id,
                    owner_id=owner_id,
                    lease_token=lease.lease_token,
                    attempt=lease.attempt,
                    reason="loop_exception_retryable",
                    error_code=exc.error_code,
                    message=str(exc),
                    retry_after_seconds=exc.retry_after_seconds,
                )
            except FencingError:
                return None
            except Exception as retry_exc:  # noqa: BLE001 - invalid retry metadata fails durably
                try:
                    return self._store.fail_execution(
                        lease.execution_id,
                        owner_id=owner_id,
                        lease_token=lease.lease_token,
                        error_code=exc.error_code,
                        message=f"{exc}; retry scheduling failed: {retry_exc}",
                    )
                except FencingError:
                    return None
        except Exception as exc:  # noqa: BLE001 - loop failures become durable state
            try:
                return self._store.fail_execution(
                    lease.execution_id,
                    owner_id=owner_id,
                    lease_token=lease.lease_token,
                    error_code="loop_error",
                    message=str(exc),
                )
            except FencingError:
                return None
        finally:
            heartbeat_stop.set()
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass

    async def _heartbeat(
        self,
        *,
        execution_id: str,
        owner_id: str,
        lease_token: int,
        stop: asyncio.Event,
        lost: asyncio.Event,
    ) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(
                    stop.wait(),
                    timeout=self._heartbeat_interval_seconds,
                )
                return
            except TimeoutError:
                try:
                    ok = self._store.heartbeat(
                        execution_id,
                        owner_id=owner_id,
                        lease_token=lease_token,
                        lease_ttl_seconds=self._lease_ttl_seconds,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - heartbeat failures lose the fence
                    lost.set()
                    return
                if not ok:
                    lost.set()
                    return

    def _schedule_retry(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        attempt: int,
        reason: str,
        error_code: str,
        message: str,
        retry_after_seconds: float | None,
    ) -> ExecutionSnapshot:
        delay = self._retry_policy.delay_for_attempt(
            execution_id,
            attempt,
            retry_after_seconds=retry_after_seconds,
        )
        not_before = self._store.clock.now() + delay
        return self._store.schedule_retry_claimed(
            execution_id,
            owner_id=owner_id,
            lease_token=lease_token,
            reason=reason,
            error_code=error_code,
            message=message,
            not_before=not_before,
            max_attempts=self._retry_policy.max_attempts,
        )


def _validate_positive(name: str, value: float) -> None:
    if (
        not isinstance(value, int | float)
        or not math.isfinite(float(value))
        or float(value) <= 0.0
    ):
        raise ValueError(f"{name} must be finite and > 0")


def _result_requests_retry(result: LoopResult) -> bool:
    return (
        result.status == "failed"
        and bool(result.retryable)
        and bool(result.safe_to_retry)
    )


def _stable_jitter(execution_key: str, attempt: int, delay: float) -> float:
    jitter_cap = min(1.0, max(0.0, delay) * 0.2)
    if jitter_cap == 0.0:
        return 0.0
    digest = hashlib.sha256(f"{execution_key}:{attempt}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:8], "big") / float(2**64 - 1)
    return bucket * jitter_cap
