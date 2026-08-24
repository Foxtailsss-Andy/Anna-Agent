"""Unit tests for the L3a per-run frame journal (pillar P3 恢复力).

Covers the journal in isolation (persistence injected as callables): seq is
monotonic from 1, the bounded ring drops the oldest, ``read_from`` snapshots the
ring, a post-terminal append is dropped, ``subscribe`` replays-then-follows to
the terminal, concurrent subscribers each receive every frame, and a ``from_seq``
older than the ring floor transparently backfills from persistent storage.
"""
from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime

from services.runtime.app.frame_journal import FrameJournal


class _MemStore:
    """A tiny in-memory stand-in for the SQLite read/write-through seam."""

    def __init__(self) -> None:
        self.frames: list[dict] = []

    def write(self, stamped: dict) -> None:
        self.frames.append(stamped)

    def read_from(self, from_seq: int) -> list[dict]:
        return [frame for frame in self.frames if frame["seq"] >= from_seq]


class _FlakyStore(_MemStore):
    def __init__(self) -> None:
        super().__init__()
        self.fail_writes = True

    def write(self, stamped: dict) -> None:
        if self.fail_writes:
            raise OSError("sqlite temporarily unavailable")
        super().write(stamped)


def test_append_assigns_monotonic_seq_from_one():
    async def _run():
        journal = FrameJournal()
        s1 = await journal.append({"type": "event"})
        s2 = await journal.append({"type": "text_delta", "text": "hi"})
        s3 = await journal.append({"type": "text_delta", "text": "!"})
        return s1, s2, s3, journal

    s1, s2, s3, journal = asyncio.run(_run())
    assert (s1["seq"], s2["seq"], s3["seq"]) == (1, 2, 3)
    # The stamped frame preserves the original fields plus the additive seq
    # (the equally additive wall-clock ts is pinned by its own test below).
    assert {k: v for k, v in s2.items() if k != "ts"} == {
        "type": "text_delta",
        "text": "hi",
        "seq": 2,
    }
    assert [f["seq"] for f in journal.read_from(1)] == [1, 2, 3]


def test_telemetry_counts_initial_and_from_seq_attachments_without_content():
    async def _run():
        journal = FrameJournal()
        await journal.append({"type": "text_delta", "text": "hidden"})
        await journal.append({"type": "done", "run": {}})
        first = [frame async for frame in journal.subscribe(from_seq=0)]
        second = [frame async for frame in journal.subscribe(from_seq=1)]
        return journal, first, second

    journal, first, second = asyncio.run(_run())
    assert [frame["seq"] for frame in first] == [1, 2]
    assert [frame["seq"] for frame in second] == [2]
    assert journal.telemetry_snapshot() == {
        "subscription_count": 2,
        "resume_subscription_count": 1,
        "frames_emitted": 3,
        "gap_recovery_count": 0,
        "persistence_failure_count": 0,
        "durable_seq": None,
        "pending_persistence_seqs": [],
        "durability_degraded": False,
        "last_seq": 2,
        "terminal": True,
    }


def test_persistence_failure_retries_in_order_and_exposes_terminal_gap():
    async def _run():
        store = _FlakyStore()
        journal = FrameJournal()
        await journal.append({"type": "text_delta", "text": "lost temporarily"}, store.write)
        await journal.append({"type": "done", "run": {}}, store.write)
        failed = journal.telemetry_snapshot()
        failed_store_frames = list(store.frames)

        store.fail_writes = False
        await journal.flush(store.write)
        recovered = journal.telemetry_snapshot()
        return store, failed_store_frames, failed, recovered

    store, failed_store_frames, failed, recovered = asyncio.run(_run())
    assert failed["persistence_failure_count"] == 2
    assert failed["durable_seq"] is None
    assert failed["pending_persistence_seqs"] == [1, 2]
    assert failed["durability_degraded"] is True
    assert [frame["seq"] for frame in failed_store_frames] == []

    # A terminal journal does not accept new frames, but the writer recovery
    # path must still flush the pending terminal segment before returning.
    assert recovered["durable_seq"] == 2
    assert recovered["pending_persistence_seqs"] == []
    assert recovered["durability_degraded"] is False
    assert [frame["seq"] for frame in store.frames] == [1, 2]


def test_append_stamps_millisecond_utc_ts():
    """Every stamped frame carries an ISO8601 UTC ``ts`` with ms precision (T1b).

    The trace assembler's ``_row_ts`` prefers the frame's own ``ts`` over the DB
    row's second-granular ``created_at``; without it, tool spans inside one
    second collapse to zero duration. ``ts`` is ADDITIVE like ``seq`` — unknown
    fields are ignored by existing frame consumers.
    """

    async def _run():
        journal = FrameJournal()
        before = datetime.now(UTC)
        stamped = await journal.append({"type": "tool_start", "name": "read_file"})
        after = datetime.now(UTC)
        return stamped, before, after, journal.read_from(1)

    stamped, before, after, buffered = asyncio.run(_run())
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00", stamped["ts"]), (
        f"ts is not ISO8601 ms UTC: {stamped.get('ts')!r}"
    )
    # Real wall clock, UTC-aware, and inside the window the append happened in
    # (truncated to ms, so the lower bound may round down by <1ms).
    parsed = datetime.fromisoformat(stamped["ts"])
    assert parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0
    assert before.replace(microsecond=0) <= parsed <= after
    # The additive seq (and the caller's own fields) survive alongside it.
    assert stamped["seq"] == 1
    assert stamped["type"] == "tool_start" and stamped["name"] == "read_file"
    # The buffered ring holds the same stamped frame — live followers see ts too.
    assert buffered == [stamped]


def test_read_from_returns_frames_at_or_after_seq():
    async def _run():
        journal = FrameJournal()
        for i in range(5):
            await journal.append({"type": "text_delta", "text": str(i)})
        return journal

    journal = asyncio.run(_run())
    assert [f["seq"] for f in journal.read_from(3)] == [3, 4, 5]
    assert journal.read_from(6) == []


def test_ring_cap_drops_oldest_and_floor_advances():
    async def _run():
        journal = FrameJournal(ring_cap=3)
        for i in range(5):
            await journal.append({"type": "text_delta", "text": str(i)})
        return journal

    journal = asyncio.run(_run())
    # Only the newest 3 stay in memory; seqs keep climbing (1,2 evicted).
    assert [f["seq"] for f in journal.read_from(1)] == [3, 4, 5]
    assert journal.ring_floor() == 3


def test_append_after_terminal_is_dropped():
    async def _run():
        journal = FrameJournal()
        await journal.append({"type": "text_delta", "text": "a"})
        await journal.append({"type": "done", "run": {}})  # terminal → journal closed
        dropped = await journal.append({"type": "text_delta", "text": "late"})
        return journal, dropped

    journal, dropped = asyncio.run(_run())
    assert journal.terminal is True
    assert dropped is None  # post-terminal append is a no-op
    assert [f["seq"] for f in journal.read_from(1)] == [1, 2]  # seq did not advance


def test_subscribe_replays_buffered_then_follows_to_terminal():
    async def _run():
        journal = FrameJournal()
        await journal.append({"type": "event"})       # seq 1 (buffered before subscribe)
        await journal.append({"type": "text_delta"})  # seq 2

        collected: list[dict] = []

        async def _consume():
            async for frame in journal.subscribe(from_seq=0):
                collected.append(frame)

        async def _produce():
            await asyncio.sleep(0)  # let the consumer drain the buffered head first
            await journal.append({"type": "text_delta"})     # seq 3
            await journal.append({"type": "done", "run": {}})  # seq 4 terminal

        await asyncio.gather(_consume(), _produce())
        return collected

    collected = asyncio.run(_run())
    assert [f["seq"] for f in collected] == [1, 2, 3, 4]
    assert collected[-1]["type"] == "done"  # terminal delivered before return


def test_subscribe_from_seq_skips_already_delivered():
    async def _run():
        journal = FrameJournal()
        for _ in range(4):
            await journal.append({"type": "text_delta"})
        await journal.append({"type": "done", "run": {}})  # seq 5 terminal
        collected = [frame async for frame in journal.subscribe(from_seq=3)]
        return collected

    collected = asyncio.run(_run())
    assert [f["seq"] for f in collected] == [4, 5]  # strictly after from_seq=3


def test_concurrent_subscribers_both_receive_every_frame():
    async def _run():
        journal = FrameJournal()
        a: list[dict] = []
        b: list[dict] = []

        async def _consume(sink):
            async for frame in journal.subscribe(from_seq=0):
                sink.append(frame)

        async def _produce():
            await asyncio.sleep(0)
            for _ in range(3):
                await journal.append({"type": "text_delta"})
            await journal.append({"type": "done", "run": {}})

        await asyncio.gather(_consume(a), _consume(b), _produce())
        return a, b

    a, b = asyncio.run(_run())
    assert [f["seq"] for f in a] == [1, 2, 3, 4]
    assert [f["seq"] for f in b] == [1, 2, 3, 4]


def test_subscribe_backfills_below_ring_floor_from_store():
    async def _run():
        store = _MemStore()
        journal = FrameJournal(ring_cap=2)
        # Write-through to the store on every append; ring keeps only the last 2.
        for i in range(4):
            await journal.append({"type": "text_delta", "text": str(i)}, store.write)
        await journal.append({"type": "done", "run": {}}, store.write)  # seq 5 terminal
        # Ring floor is now 4; a from_seq=0 subscriber must backfill 1..3 from the
        # store, then serve 4,5 from the ring — a transparent ring→DB merge.
        assert journal.ring_floor() == 4
        collected = [
            frame
            async for frame in journal.subscribe(from_seq=0, backfill=store.read_from)
        ]
        return collected

    collected = asyncio.run(_run())
    assert [f["seq"] for f in collected] == [1, 2, 3, 4, 5]  # no gap, no duplicate
    assert collected[-1]["type"] == "done"


def test_subscribe_recovers_frames_evicted_during_live_backfill():
    """A live producer evicting past the ring floor MID-backfill loses no frame.

    Every backfill ``yield`` suspends the subscriber, so a live producer can
    append — and, on a tiny ring, EVICT — frames below the floor snapshotted
    before backfilling began. Without gap-recovery the subsequent ring batch
    starts ABOVE the subscriber's cursor and the in-between frames are silently
    skipped in the live view (they survive on disk). This pins that the
    subscriber still receives EVERY seq contiguously — the evicted frames are
    re-served from disk before the ring (mirrors the reviewer's ring_cap=2 repro).
    """

    async def _run():
        store = _MemStore()
        journal = FrameJournal(ring_cap=2)
        # Seed 1..5 with write-through; ring keeps only [4,5] (floor 4), disk 1..5.
        for i in range(1, 6):
            await journal.append({"type": "text_delta", "text": str(i)}, store.write)
        assert journal.ring_floor() == 4

        collected: list[dict] = []

        async def _consume():
            async for frame in journal.subscribe(from_seq=0, backfill=store.read_from):
                collected.append(frame)
                if frame["seq"] == 3:
                    # Mid-backfill: the generator is suspended at this yield, about
                    # to snapshot the ring. Let the live producer append 6,7 + the
                    # terminal — on ring_cap=2 this EVICTS 4,5 (and 6) below the
                    # pre-backfill floor of 4, opening the live gap.
                    await journal.append({"type": "text_delta", "text": "6"}, store.write)
                    await journal.append({"type": "text_delta", "text": "7"}, store.write)
                    await journal.append({"type": "done", "run": {}}, store.write)

        await _consume()
        return collected

    collected = asyncio.run(_run())
    assert [f["seq"] for f in collected] == [1, 2, 3, 4, 5, 6, 7, 8]  # no seq skipped
    assert collected[-1]["type"] == "done"


def test_subscribe_honestly_skips_a_gap_unrecoverable_from_disk():
    """An unrecoverable live gap (frames on NEITHER ring nor disk) is skipped,
    not spun on forever.

    If a write-through was swallowed (a transient SQLite hiccup) AND the ring
    later evicts those seqs, a mid-backfill gap points at frames that exist
    nowhere. Gap-recovery must not loop the gap→backfill cycle forever — that
    spin has no await point and would hang the whole event loop. When a repeated
    gap makes no backfill progress, ``subscribe`` serves the ring batch: an
    honest skip of the unrecoverable frames. The fuel-limited backfill turns any
    regression into a fast failure instead of a hung test.
    """

    async def _run():
        store = _MemStore()
        journal = FrameJournal(ring_cap=2)

        calls = {"n": 0}

        def _fueled_read_from(from_seq: int) -> list[dict]:
            calls["n"] += 1
            if calls["n"] > 50:  # a healthy subscribe backfills only a handful of times
                raise RuntimeError("backfill stall — gap recovery is spinning")
            return store.read_from(from_seq)

        # 1..3 written through (disk + ring). Ring cap 2 keeps only [2,3] so far.
        for i in range(1, 4):
            await journal.append({"type": "text_delta", "text": str(i)}, store.write)

        collected: list[dict] = []

        async def _consume():
            async for frame in journal.subscribe(from_seq=0, backfill=_fueled_read_from):
                collected.append(frame)
                if frame["seq"] == 3:
                    # Suspended mid-backfill. Append 4,5,6 with their write-through
                    # SWALLOWED (no writer), then 7 + terminal WITH write-through.
                    # ring_cap=2 evicts everything below 7; 4,5,6 are now on neither
                    # ring nor disk — the unrecoverable gap.
                    await journal.append({"type": "text_delta", "text": "4"})
                    await journal.append({"type": "text_delta", "text": "5"})
                    await journal.append({"type": "text_delta", "text": "6"})
                    await journal.append({"type": "text_delta", "text": "7"}, store.write)
                    await journal.append({"type": "done", "run": {}}, store.write)

        await _consume()
        return collected

    collected = asyncio.run(_run())
    # 4,5,6 are honestly skipped (nowhere to recover them); the rest is contiguous.
    assert [f["seq"] for f in collected] == [1, 2, 3, 7, 8]
    assert collected[-1]["type"] == "done"


def test_close_unblocks_followers_without_a_terminal_frame():
    async def _run():
        journal = FrameJournal()
        await journal.append({"type": "text_delta"})  # seq 1, no terminal frame
        collected: list[dict] = []

        async def _consume():
            async for frame in journal.subscribe(from_seq=0):
                collected.append(frame)

        async def _closer():
            await asyncio.sleep(0)
            await journal.close()  # defensive close — followers must unblock

        await asyncio.gather(_consume(), _closer())
        return collected, journal

    collected, journal = asyncio.run(_run())
    assert [f["seq"] for f in collected] == [1]
    assert journal.terminal is True
