"""Per-run frame journal — the resilience seam for background runs (L3a, P3).

A chat run driven in the background (``asyncio.create_task``) is decoupled from
any SSE connection: instead of yielding frames straight to one request, it
appends them here. Each frame gets a monotonically increasing ``seq`` (from 1),
is buffered in an in-memory ring for live followers, and is written through to
SQLite so a run survives a dropped connection — a later subscriber replays from
any ``from_seq`` and follows to the terminal, or replays purely from disk once
the run has finished.

Design (deliberately tiny — no pub/sub framework, no threads):

* ``append`` stamps the next ``seq`` plus a millisecond-precision UTC ``ts``,
  buffers into a bounded ring, flips the terminal flag on a ``done`` / ``error``
  frame, wakes waiters via an ``asyncio.Condition``, then writes through the
  optional ``writer``. A journal write failure is retained for ordered retry;
  the run itself must never die because journaling hiccuped.
* ``subscribe`` yields frames ``> from_seq`` from the ring, transparently
  backfilling from persistent storage (via the injected ``backfill``) whenever
  ``from_seq`` is older than the ring floor (the ring dropped the oldest), then
  follows live appends until the terminal frame is delivered.

The ``seq`` and ``ts`` fields are ADDITIVE to the R2 frame contract; existing
frame types and fields are untouched (unknown fields are ignored by existing
consumers). ``ts`` gives the trace assembler (``_row_ts``) millisecond ordering
where the persisted row's ``created_at`` is only second-granular — without it,
tool spans that open and close inside one second collapse to zero duration.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# A frame of one of these types is the run's terminal — the journal flips closed
# when it is appended so followers drain and stop. Mirrors the chat orchestrator's
# terminal frames (``done`` on success, ``error`` on failure / stop).
_TERMINAL_FRAME_TYPES = frozenset({"done", "error"})

# Generous per-run ring: enough to hold a full run's frames for live followers.
# Older frames drop out of memory and fall back to the SQLite read-through — the
# ring is a fast path, not the source of truth.
_DEFAULT_RING_CAP = 4096


class FrameJournal:
    """In-memory ring + terminal flag + condition for one live run's frames.

    Persistence is injected per call (``writer`` on ``append``, ``backfill`` on
    ``subscribe``) so the journal itself stays a pure, unit-testable object with
    no store coupling.
    """

    def __init__(self, ring_cap: int = _DEFAULT_RING_CAP, *, start_seq: int = 1) -> None:
        # ``start_seq`` lets a RESUMED run (L4a continue) keep numbering where the
        # suspended segment left off: the manager passes (max persisted seq)+1 so
        # ``seq`` stays strictly contiguous across suspend/resume. A fresh run
        # starts at 1 (the default).
        self._ring: deque[dict[str, Any]] = deque(maxlen=ring_cap)
        self._next_seq = start_seq
        self._terminal = False
        self._condition = asyncio.Condition()
        self._subscription_count = 0
        self._resume_subscription_count = 0
        self._frames_emitted = 0
        self._gap_recovery_count = 0
        self._pending_writes: deque[dict[str, Any]] = deque()
        self._persistence_failure_count = 0
        self._durable_seq: int | None = None
        self._durability_degraded = False

    @property
    def terminal(self) -> bool:
        return self._terminal

    def ring_floor(self) -> int | None:
        """The oldest ``seq`` still buffered in memory (``None`` if empty)."""
        return self._ring[0]["seq"] if self._ring else None

    def read_from(self, seq: int) -> list[dict[str, Any]]:
        """Buffered frames with ``seq`` ≥ the argument (a ring snapshot)."""
        return [frame for frame in self._ring if frame["seq"] >= seq]

    async def append(
        self,
        frame: dict[str, Any],
        writer: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any] | None:
        """Stamp the next ``seq`` + ``ts``, buffer + notify, then write through.

        Returns the stamped frame (a shallow copy of ``frame`` plus ``seq`` and
        ``ts``), or ``None`` if the journal is already terminal — a post-terminal
        append (e.g. a racing background frame after an explicit stop) is dropped
        so followers see exactly one terminal.
        """
        async with self._condition:
            if self._terminal:
                return None
            seq = self._next_seq
            self._next_seq += 1
            stamped = {
                **frame,
                "seq": seq,
                "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            }
            self._ring.append(stamped)
            if stamped.get("type") in _TERMINAL_FRAME_TYPES:
                self._terminal = True
            self._condition.notify_all()
        if writer is not None:
            self._pending_writes.append(stamped)
            self._flush_pending(writer)
        return stamped

    async def flush(self, writer: Callable[[dict[str, Any]], None] | None = None) -> bool:
        """Retry pending frames in sequence order and report whether all persisted."""
        if writer is not None:
            self._flush_pending(writer)
        return not self._pending_writes

    def _flush_pending(self, writer: Callable[[dict[str, Any]], None]) -> None:
        while self._pending_writes:
            stamped = self._pending_writes[0]
            try:
                writer(stamped)
            except Exception:  # noqa: BLE001 — journaling must never kill a live run
                self._persistence_failure_count += 1
                self._durability_degraded = True
                logger.warning(
                    "frame journal write-through failed at seq %s",
                    stamped["seq"],
                    exc_info=True,
                )
                return
            self._pending_writes.popleft()
            self._durable_seq = stamped["seq"]
        self._durability_degraded = False

    def telemetry_snapshot(self) -> dict[str, int | bool | list[int] | None]:
        """Return local, non-content SSE attach/replay counters for this run."""
        return {
            "subscription_count": self._subscription_count,
            "resume_subscription_count": self._resume_subscription_count,
            "frames_emitted": self._frames_emitted,
            "gap_recovery_count": self._gap_recovery_count,
            "persistence_failure_count": self._persistence_failure_count,
            "durable_seq": self._durable_seq,
            "pending_persistence_seqs": [
                frame["seq"] for frame in self._pending_writes
            ],
            "durability_degraded": self._durability_degraded,
            "last_seq": self._next_seq - 1,
            "terminal": self._terminal,
        }

    async def close(
        self,
        writer: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        """Flip the journal terminal and wake every follower (idempotent).

        The background driver calls this in its ``finally`` so followers unblock
        even if the stream ended without a terminal frame (a defensive belt — a
        healthy chat stream always ends on ``done`` / ``error``)."""
        await self.flush(writer)
        async with self._condition:
            self._terminal = True
            self._condition.notify_all()

    async def subscribe(
        self,
        from_seq: int = 0,
        backfill: Callable[[int], list[dict[str, Any]]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield frames ``> from_seq`` from the ring (+ backfill), then follow.

        Replays buffered frames strictly after ``from_seq``; when the next needed
        seq is older than the ring floor (the ring dropped it), pulls the gap from
        ``backfill`` (persistent storage) — a transparent ring→DB merge. Then
        follows live appends via the condition until the terminal frame is
        delivered, at which point the generator returns. Multiple subscribers may
        follow the same journal concurrently; each tracks its own cursor.
        """
        self._subscription_count += 1
        if from_seq > 0:
            self._resume_subscription_count += 1
        next_seq = from_seq + 1
        while True:
            # Cursor before this pass's backfill — used below to detect a gap that
            # backfill could not close (frames on neither ring nor disk). Without
            # it, an unrecoverable gap would spin the gap→backfill cycle forever
            # with no await point, hanging the event loop.
            seq_before_backfill = next_seq
            # 1. Backfill persisted frames below the ring floor (or when the ring
            #    is empty). Covers a from_seq older than the trimmed ring.
            floor = self.ring_floor()
            if backfill is not None and (floor is None or next_seq < floor):
                for frame in backfill(next_seq):
                    seq = frame.get("seq")
                    if not isinstance(seq, int) or seq < next_seq:
                        continue
                    if floor is not None and seq >= floor:
                        break  # the ring covers the rest — never duplicate
                    self._frames_emitted += 1
                    yield frame
                    next_seq = seq + 1

            # 2. Serve buffered ring frames, then either loop, wait, or finish.
            gap = False
            async with self._condition:
                while True:
                    # INVARIANT: no await between the ring-floor snapshot above and this batch capture — a future await there could let ring eviction outrun the floor and open a replay gap.
                    batch = [frame for frame in self._ring if frame["seq"] >= next_seq]
                    if batch:
                        # Live-backfill gap: each backfill ``yield`` above suspends,
                        # so the live producer can evict below the pre-backfill floor
                        # while we replay disk. If the ring now starts ABOVE next_seq
                        # the in-between frames were evicted — they're on disk (a
                        # single-producer journal write-through's them before the
                        # evicting append), so loop back to backfill rather than serve
                        # the ring (which would silently skip them).
                        #
                        # ``next_seq > seq_before_backfill`` is the stall guard: only
                        # loop back if this pass's backfill made forward progress. If a
                        # gap persists with no progress the frames are on NEITHER ring
                        # nor disk (a swallowed write-through then evicted) — retrying
                        # is a non-yielding infinite loop, so serve the ring instead:
                        # an honest skip of genuinely unrecoverable frames.
                        if (
                            backfill is not None
                            and batch[0]["seq"] > next_seq
                            and next_seq > seq_before_backfill
                        ):
                            gap = True
                        break
                    if self._terminal:
                        return
                    await self._condition.wait()
            if gap:
                self._gap_recovery_count += 1
                continue
            for frame in batch:
                if frame["seq"] < next_seq:
                    continue  # a concurrent advance already covered this seq
                self._frames_emitted += 1
                yield frame
                next_seq = frame["seq"] + 1
