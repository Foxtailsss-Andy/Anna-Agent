"""Concurrency governance — per-workspace run gate + model-call rate bucket (L5, P4).

The two OUTER guardrails for parallel runs, per the architecture line "区分从
架构层做,不靠 Rule、不在 Harness 内分支" and the forge-harness tool-concurrency
chapter's shape (governance sits AROUND the loop as policy, never as branching
inside it — Anna's loop stays serial and untouched by this module):

* ``WorkspaceRunGate`` — a per-workspace ``asyncio.Semaphore`` map bounding how
  many background runs a workspace drives at once. Lives at the run manager
  (``BackgroundRunManager``), NOT in the engine: a run that exceeds the limit
  QUEUES (honestly announced via a ``run.queued`` audit/event frame the caller
  journals when queueing starts) — it is never rejected and never fails.
* ``ModelCallBucket`` — a thread-safe token bucket metering model calls per
  minute across the WHOLE process. It sits at the three provider chokepoints
  (``harness_runtime.call_model`` sync, ``engine/streaming_model.stream_model``
  async, and autocompact's summary single-shot), so every surface — background
  chat runs, legacy sync routes, crew/associate workers — shares one gate with
  zero per-domain wiring. A rate gate, not a breaker: it only DELAYS, it never
  rejects.

Sync/async split mirrors L4a's autocompact wiring: sync callers block on
``acquire``; async callers use ``acquire_async``, which fast-paths the
token-available case with zero thread overhead and offloads a contended blocking
wait to ``asyncio.to_thread`` so the shared event loop never stalls.

Config: ``runtime.json → concurrency: {per_workspace_runs, model_calls_per_minute}``
(defaults 3 / 30, read by ``RuntimeSettings.from_env`` following the nested
``context`` block pattern). Defaults are generous enough that today's
single-user desktop never queues and never waits — the gates only bite under
real parallel pressure (or a test-injected tight config).
"""
from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Awaitable, Callable

from services.runtime.app.config import RuntimeSettings


class WorkspaceRunGate:
    """Per-workspace run admission — a lazy map of ``asyncio.Semaphore``.

    Event-loop only (the background run manager owns it); no thread locks are
    needed because every acquire/release happens on the manager's loop. Entries
    are tiny and workspaces are few (single-digit on the desktop), so the map is
    never pruned.
    """

    def __init__(self, per_workspace_runs: int) -> None:
        self._limit = max(1, int(per_workspace_runs))
        self._semaphores: dict[str, asyncio.Semaphore] = {}

    @property
    def limit(self) -> int:
        return self._limit

    def _semaphore(self, workspace_id: str) -> asyncio.Semaphore:
        semaphore = self._semaphores.get(workspace_id)
        if semaphore is None:
            semaphore = asyncio.Semaphore(self._limit)
            self._semaphores[workspace_id] = semaphore
        return semaphore

    async def acquire(
        self,
        workspace_id: str,
        *,
        on_queued: Callable[[], Awaitable[None]] | None = None,
    ) -> bool:
        """Take one run slot for ``workspace_id``; return whether it had to wait.

        When the workspace is at capacity, ``on_queued`` (if given) is awaited
        BEFORE waiting on the semaphore — that is the caller's chance to make the
        queueing honest and visible (audit + journal a ``run.queued`` frame)
        while the run is actually parked, not after the fact. The no-wait fast
        path never suspends: ``Semaphore.locked()`` → sync decrement happen in
        one task step, so the check cannot race another coroutine.

        The caller MUST pair a successful acquire with exactly one ``release``
        on EVERY exit path (try/finally); a cancelled wait (e.g. a queued run
        stopped by the user) consumes no slot and must NOT be released.
        """
        semaphore = self._semaphore(workspace_id)
        if not semaphore.locked():
            await semaphore.acquire()  # sync fast path — cannot suspend here
            return False
        if on_queued is not None:
            await on_queued()
        await semaphore.acquire()
        return True

    def release(self, workspace_id: str) -> None:
        """Return one previously acquired slot (wakes the next queued run)."""
        self._semaphores[workspace_id].release()


class ModelCallBucket:
    """Thread-safe token bucket for model calls per minute (burst = capacity).

    A RATE gate, not a breaker: with no ``timeout`` it never rejects — it only
    delays until a token refills (capacity/60 tokens per second). Usable from
    both worlds, mirroring the L4a autocompact split:

    * sync callers (``call_model``, the summary single-shot, crew/associate
      worker threads) block on ``acquire``;
    * async callers (``stream_model``) use ``acquire_async`` — the common
      token-available case is a lock-guarded sync fast path (no thread), and
      only a contended wait is offloaded to ``asyncio.to_thread`` so the shared
      event loop never blocks.

    ``clock`` / ``sleep`` are injectable for deterministic tests (a fake clock
    advanced by a fake sleep — refill math is asserted without real waiting).
    """

    def __init__(
        self,
        calls_per_minute: int,
        *,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self._capacity = float(max(1, int(calls_per_minute)))
        self._rate_per_second = self._capacity / 60.0
        self._tokens = self._capacity  # start full: burst == capacity
        self._clock = clock or time.monotonic
        self._sleep = sleep or time.sleep
        self._lock = threading.Lock()
        self._updated_at = self._clock()

    @property
    def capacity(self) -> float:
        return self._capacity

    def _refill_locked(self, now: float) -> None:
        elapsed = max(0.0, now - self._updated_at)
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate_per_second)
        self._updated_at = now

    def try_acquire(self) -> bool:
        """Take one token without blocking; ``False`` when none is available."""
        with self._lock:
            self._refill_locked(self._clock())
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False

    def acquire(self, timeout: float | None = None) -> bool:
        """Block until one token is available; never rejects when ``timeout`` is None.

        Returns ``True`` once admitted. A ``timeout`` (seconds) is a defensive
        escape hatch for ops/tests — production chokepoints pass none, so a
        burst of calls is DELAYED to the configured rate, never failed.
        """
        deadline = None if timeout is None else self._clock() + timeout
        while True:
            with self._lock:
                now = self._clock()
                self._refill_locked(now)
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return True
                # Exact wait until the next whole token refills (tokens < 1 here,
                # so this is strictly positive).
                wait_seconds = (1.0 - self._tokens) / self._rate_per_second
            if deadline is not None:
                remaining = deadline - self._clock()
                if remaining <= 0.0:
                    return False
                wait_seconds = min(wait_seconds, remaining)
            # Sleep OUTSIDE the lock; the loop re-checks, so a concurrent thread
            # winning the refilled token just puts this one back to sleep.
            self._sleep(wait_seconds)

    async def acquire_async(self) -> None:
        """Async admission: sync fast path, contended wait in a worker thread.

        Mirrors ``apply_autocompact_async``'s split — the common path spawns no
        thread and never suspends; only an actually-empty bucket offloads the
        blocking wait so the shared uvicorn loop keeps serving other runs.
        """
        if self.try_acquire():
            return
        await asyncio.to_thread(self.acquire)


# --- process-wide shared bucket -------------------------------------------------
#
# One bucket per configured rate, shared by every chokepoint in the process, so
# all surfaces meter against the SAME budget (the whole point of a rate gate).
# In production exactly one rate exists (runtime.json). Keyed by rate — not by
# settings identity — because settings objects are freely copied/``replace``d
# (model profiles, the autocompact summary variant) and every copy must land on
# the same gate. ``install_*`` / ``reset_*`` are the test seams (mirroring
# autocompact's module-cache + reset-hook precedent).

_shared_buckets: dict[int, ModelCallBucket] = {}
_shared_buckets_lock = threading.Lock()


def shared_model_call_bucket(settings: RuntimeSettings) -> ModelCallBucket:
    """The process-wide bucket for this settings' configured rate."""
    rate = int(getattr(settings, "concurrency_model_calls_per_minute", 30) or 30)
    with _shared_buckets_lock:
        bucket = _shared_buckets.get(rate)
        if bucket is None:
            bucket = ModelCallBucket(rate)
            _shared_buckets[rate] = bucket
        return bucket


def install_shared_model_call_bucket(calls_per_minute: int, bucket: ModelCallBucket) -> None:
    """Pre-seed the shared registry for one rate (test observability seam)."""
    with _shared_buckets_lock:
        _shared_buckets[int(calls_per_minute)] = bucket


def reset_shared_model_call_buckets() -> None:
    """Clear the shared bucket registry (test isolation hook)."""
    with _shared_buckets_lock:
        _shared_buckets.clear()
