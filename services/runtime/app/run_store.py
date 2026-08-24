from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Protocol


# P2 状态外置 (slice L2): the set of run statuses that are TERMINAL across every
# wired surface — a run in any of these has finished and must survive a restart
# untouched. Everything else (chat ``generating``, create ``validating``, or an
# unrecognized in-flight status) is a run whose process died mid-flight and is
# healed to ``interrupted`` by the startup sweep. Union kept deliberately wide:
# marking an unknown status interrupted is the honest, conservative default —
# better a false ``interrupted`` than a zombie that lies about being live.
#
# * chat            → ready / saved / failed
# * create          → ready_for_review / saved / failed
# * both (post-L2)  → interrupted  (already-swept: idempotent, never re-swept)
TERMINAL_RUN_STATUSES = frozenset(
    {
        "ready",
        "ready_for_review",
        "saved",
        "failed",
        "interrupted",
    }
)

# L4a 续办 (P1 上下文治理): statuses that are NON-terminal (the run is not done)
# yet MUST survive a restart untouched — a paused, resumable rest, not a dead
# in-flight run. The startup sweep skips these instead of mislabeling them
# ``interrupted`` (which would strand a continuable run). ``awaiting_continue`` is
# a chat run parked at ``max_turns`` with its messages persisted in the payload —
# still continue-able after a cold restart.
RESUMABLE_RUN_STATUSES = frozenset({"awaiting_continue"})


class RunStore(Protocol):
    """The surface-agnostic persistence seam wired into chat + create (L2).

    One flat table keyed by ``(surface, run_id)`` holding the full run payload
    (``model_dump(mode="json")``). The orchestrators write-through on creation
    and on every terminal transition, and fall back to this store on a registry
    miss so runs survive a process restart (pillar P2 状态外置).
    """

    def save_run(
        self,
        surface: str,
        run_id: str,
        thread_id: str | None,
        workspace_id: str,
        actor_user_id: str,
        status: str,
        created_at: str,
        payload: dict[str, Any],
    ) -> None:
        ...

    def get_run(self, surface: str, run_id: str) -> dict[str, Any] | None:
        ...

    def list_runs(
        self,
        surface: str,
        workspace_id: str,
        actor_user_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        ...

    def list_thread_runs(
        self,
        surface: str,
        thread_id: str,
        workspace_id: str,
        actor_user_id: str,
    ) -> list[dict[str, Any]]:
        ...

    def mark_stale_interrupted(self, surface: str) -> int:
        ...

    def max_run_sequence(self, surface: str, prefix: str) -> int:
        ...

    def append_frame(
        self,
        surface: str,
        run_id: str,
        seq: int,
        frame: dict[str, Any],
    ) -> None:
        ...

    def list_frames(
        self,
        surface: str,
        run_id: str,
        from_seq: int = 0,
    ) -> list[dict[str, Any]]:
        ...

    def list_frames_with_meta(
        self,
        surface: str,
        run_id: str,
        from_seq: int = 0,
    ) -> list[dict[str, Any]]:
        ...

    def max_frame_seq(self, surface: str, run_id: str) -> int:
        ...


class SQLiteRunStore:
    """SQLite-backed run store — one table, per-call connections.

    Mirrors ``services/reimbursement/app/state_store.py`` conventions exactly:
    a per-call ``sqlite3.connect`` (thread-safe under Anna's worker-thread
    streaming — each streamed run executes in its own thread), ``sqlite3.Row``
    row factory, ``CREATE ... IF NOT EXISTS`` schema init, and UPSERT via
    ``ON CONFLICT ... DO UPDATE``. No ORM, stdlib ``sqlite3`` only.

    The full run JSON is stored verbatim in ``payload`` (artifacts included).
    A very large artifact is stored inline this slice — acceptable for L2; blob
    splitting is a later concern if it ever bites.
    """

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def save_run(
        self,
        surface: str,
        run_id: str,
        thread_id: str | None,
        workspace_id: str,
        actor_user_id: str,
        status: str,
        created_at: str,
        payload: dict[str, Any],
    ) -> None:
        payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO runs (
                    surface,
                    run_id,
                    thread_id,
                    workspace_id,
                    actor_user_id,
                    status,
                    created_at,
                    payload,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(surface, run_id) DO UPDATE SET
                    thread_id = excluded.thread_id,
                    workspace_id = excluded.workspace_id,
                    actor_user_id = excluded.actor_user_id,
                    status = excluded.status,
                    payload = excluded.payload,
                    updated_at = datetime('now')
                """,
                (
                    surface,
                    run_id,
                    thread_id,
                    workspace_id,
                    actor_user_id,
                    status,
                    created_at,
                    payload_json,
                ),
            )
        # NOTE: created_at is intentionally NOT in the DO UPDATE SET — the
        # UPSERT preserves the ORIGINAL creation timestamp across the terminal
        # write, so ordering stays stable no matter what a later save passes.

    def get_run(self, surface: str, run_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM runs WHERE surface = ? AND run_id = ?",
                (surface, run_id),
            ).fetchone()
        return _row_to_payload(row)

    def list_runs(
        self,
        surface: str,
        workspace_id: str,
        actor_user_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload FROM runs
                WHERE surface = ? AND workspace_id = ? AND actor_user_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                (surface, workspace_id, actor_user_id, limit),
            ).fetchall()
        return [payload for row in rows if (payload := _row_to_payload(row)) is not None]

    def list_thread_runs(
        self,
        surface: str,
        thread_id: str,
        workspace_id: str,
        actor_user_id: str,
    ) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload FROM runs
                WHERE surface = ?
                  AND thread_id = ?
                  AND workspace_id = ?
                  AND actor_user_id = ?
                ORDER BY created_at ASC, rowid ASC
                """,
                (surface, thread_id, workspace_id, actor_user_id),
            ).fetchall()
        return [payload for row in rows if (payload := _row_to_payload(row)) is not None]

    def mark_stale_interrupted(self, surface: str) -> int:
        """Heal every non-terminal run of ``surface`` to ``interrupted``.

        Called ONCE per wired surface at app startup — a run still recorded as
        in-flight after a restart is honestly relabeled ``interrupted`` (both the
        status column and ``payload["status"]``). Terminal runs are left alone.
        Returns the number of runs healed.
        """
        healed = 0
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT run_id, status, payload FROM runs WHERE surface = ?",
                (surface,),
            ).fetchall()
            for row in rows:
                if (
                    row["status"] in TERMINAL_RUN_STATUSES
                    or row["status"] in RESUMABLE_RUN_STATUSES
                ):
                    # Terminal runs are done; resumable runs (awaiting_continue)
                    # are a healthy paused rest — neither is a mid-flight zombie.
                    continue
                payload = _row_to_payload(row)
                if payload is None:
                    payload = {}
                payload["status"] = "interrupted"
                connection.execute(
                    """
                    UPDATE runs
                    SET status = 'interrupted',
                        payload = ?,
                        updated_at = datetime('now')
                    WHERE surface = ? AND run_id = ?
                    """,
                    (
                        json.dumps(payload, ensure_ascii=False, sort_keys=True),
                        surface,
                        row["run_id"],
                    ),
                )
                interrupted_run = dict(payload)
                interrupted_run["status"] = "interrupted"
                next_frame = connection.execute(
                    """
                    SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
                    FROM run_frames
                    WHERE surface = ? AND run_id = ?
                    """,
                    (surface, row["run_id"]),
                ).fetchone()["next_seq"]
                connection.execute(
                    """
                    INSERT OR IGNORE INTO run_frames (surface, run_id, seq, frame, created_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                    """,
                    (
                        surface,
                        row["run_id"],
                        next_frame,
                        json.dumps(
                            {
                                "type": "error",
                                "seq": next_frame,
                                "message": "Run interrupted after process restart.",
                                "run": interrupted_run,
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                    ),
                )
                healed += 1
        return healed

    def max_run_sequence(self, surface: str, prefix: str) -> int:
        """Highest ``{prefix}NNN`` sequence stored for ``surface`` (0 if none).

        Chat/create allocate run ids from a per-orchestrator in-memory counter,
        which resets to 0 on restart — so a fresh process would re-mint ids that
        COLLIDE with persisted runs (a new run would UPSERT over an old one, and
        same-thread continuation after a restart would break). The orchestrators
        seed their counter from this at construction so ids keep climbing across
        restarts. Ids whose suffix is not ``{prefix}<digits>`` contribute 0.
        """
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT run_id FROM runs WHERE surface = ?",
                (surface,),
            ).fetchall()
        return max(
            (_sequence_suffix(row["run_id"], prefix) for row in rows),
            default=0,
        )

    def append_frame(
        self,
        surface: str,
        run_id: str,
        seq: int,
        frame: dict[str, Any],
    ) -> None:
        """Write through one journaled frame (L3a). Idempotent on ``seq``.

        The frame is stored verbatim as JSON TEXT (it already carries its own
        ``seq``); ``INSERT OR IGNORE`` makes a re-journaled seq a no-op so a
        replayed/duplicate append never raises. Called from the background
        driver via ``FrameJournal.append``'s ``writer`` — which swallows any
        error this raises, so a journaling hiccup never kills the live run.
        """
        frame_json = json.dumps(frame, ensure_ascii=False, sort_keys=True)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO run_frames (surface, run_id, seq, frame, created_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                """,
                (surface, run_id, seq, frame_json),
            )

    def list_frames(
        self,
        surface: str,
        run_id: str,
        from_seq: int = 0,
    ) -> list[dict[str, Any]]:
        """Journaled frames with ``seq`` ≥ ``from_seq``, in seq order.

        The read-through behind a resumable subscription: a live follower uses it
        to backfill frames older than the in-memory ring floor, and a finished
        run replays purely from here. A row whose JSON fails to parse (or is not a
        frame object) is SKIPPED, not fatal — one corrupt row must not sink an
        otherwise-recoverable replay (L2 review follow-up, baked in here).
        """
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT frame FROM run_frames
                WHERE surface = ? AND run_id = ? AND seq >= ?
                ORDER BY seq ASC
                """,
                (surface, run_id, from_seq),
            ).fetchall()
        frames: list[dict[str, Any]] = []
        for row in rows:
            try:
                parsed = json.loads(row["frame"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict):
                frames.append(parsed)
        return frames

    def list_frames_with_meta(
        self,
        surface: str,
        run_id: str,
        from_seq: int = 0,
    ) -> list[dict[str, Any]]:
        """帧 + 行级 created_at(Trace 轮 T1 读取面;list_frames 只回帧 JSON)。

        坏行跳过纪律与 ``list_frames`` 一致;created_at 是 SQLite ``datetime('now')``
        的秒粒度 UTC 字符串,装配器只把它当兜底时间源(优先帧内 ts / 事件 created_at)。
        """
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT frame, created_at FROM run_frames
                WHERE surface = ? AND run_id = ? AND seq >= ?
                ORDER BY seq ASC
                """,
                (surface, run_id, from_seq),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            try:
                parsed = json.loads(row["frame"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict):
                out.append({"frame": parsed, "created_at": row["created_at"]})
        return out

    def max_frame_seq(self, surface: str, run_id: str) -> int:
        """Highest journaled ``seq`` for a run (0 when none) — the resume floor.

        A run resumed after a ``max_turns`` suspension (L4a) must NOT restart its
        frame ``seq`` at 1: the frame table's PK is ``(surface, run_id, seq)`` and
        ``append_frame`` is ``INSERT OR IGNORE``, so a restarted seq would be
        SILENTLY DROPPED as a duplicate. The continuation journal starts at this
        value + 1, keeping ``seq`` strictly contiguous across suspend/resume.
        """
        with self._connect() as connection:
            row = connection.execute(
                "SELECT MAX(seq) AS max_seq FROM run_frames WHERE surface = ? AND run_id = ?",
                (surface, run_id),
            ).fetchone()
        max_seq = row["max_seq"] if row is not None else None
        return int(max_seq) if max_seq is not None else 0

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        # WAL + NORMAL sync: the per-frame journal write-through (``append_frame``
        # — one connect + INSERT + commit per frame, on the asyncio event loop)
        # otherwise pays a full fsync per token delta. journal_mode=WAL persists in
        # the DB file header, so re-applying it on each per-call connection is
        # idempotent; synchronous=NORMAL is per-connection and must be set each time.
        # (L3a follow-up — the write-through / batching contract is L5's, untouched.)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        return connection

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    surface TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    thread_id TEXT,
                    workspace_id TEXT NOT NULL,
                    actor_user_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (surface, run_id)
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_runs_owner_created
                ON runs(surface, workspace_id, actor_user_id, created_at)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_runs_thread
                ON runs(surface, thread_id)
                """
            )
            # L3a frame journal: append-only per-run frame log. The composite
            # PRIMARY KEY (surface, run_id, seq) doubles as the range-scan index
            # for ``list_frames`` (seq order within a run) — no extra index.
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS run_frames (
                    surface TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    frame TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (surface, run_id, seq)
                )
                """
            )


def _row_to_payload(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return json.loads(row["payload"])


def _sequence_suffix(run_id: str, prefix: str) -> int:
    """Parse the numeric suffix of ``{prefix}NNN`` (0 when it does not match)."""
    if not run_id.startswith(prefix):
        return 0
    suffix = run_id[len(prefix):]
    return int(suffix) if suffix.isdigit() else 0
