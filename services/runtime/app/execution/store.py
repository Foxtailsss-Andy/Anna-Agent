from __future__ import annotations

import json
import math
import sqlite3
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from services.runtime.app.execution.clock import SystemClock
from services.runtime.app.execution.errors import (
    ActiveExecutionConflictError,
    ExecutionNotFoundError,
    FencingError,
    IdempotencyConflictError,
    QueueOverflowError,
    TerminalStateError,
    ToolEffectConflictError,
    ToolEffectTransitionError,
)
from services.runtime.app.execution.models import (
    ALLOWED_LOOP_STATUSES,
    ACTIVE_STATUSES,
    CancelExecution,
    ExecutionCommand,
    ExecutionEvent,
    ExecutionLease,
    ExecutionSnapshot,
    LoopResult,
    PendingSignal,
    RedriveExecution,
    SignalExecution,
    StartExecution,
    TERMINAL_STATUSES,
)

_TERMINAL_EVENT_TYPES = frozenset(
    {
        "execution.succeeded",
        "execution.failed",
        "execution.cancelled",
        "execution.dead_lettered",
    }
)
_EFFECT_RECOVERY_BLOCKERS = frozenset({"pending", "unknown"})
_SIGNAL_KINDS = frozenset({"steer", "answer", "approval"})
_TOOL_EFFECT_STATUSES = frozenset({"pending", "unknown", "succeeded", "failed"})
_TOOL_EFFECT_TRANSITIONS = {
    "pending": frozenset({"pending", "unknown", "succeeded", "failed"}),
    "unknown": frozenset({"unknown", "succeeded", "failed"}),
    "succeeded": frozenset({"succeeded"}),
    "failed": frozenset({"failed"}),
}


@dataclass(frozen=True)
class ExecutionOutboxEvent:
    id: int
    execution_id: str
    seq: int
    type: str
    payload: dict[str, Any]
    created_at: float
    claim_owner: str
    claim_token: str
    claim_expires_at: float


class SQLiteExecutionStore:
    """SQLite single-node production adapter for durable AgentExecution."""

    def __init__(
        self,
        db_path: str | Path,
        *,
        clock: Any | None = None,
        fault_hook: Callable[[str], None] | None = None,
    ) -> None:
        self.db_path = db_path
        self.clock = clock or SystemClock()
        self._fault_hook = fault_hook
        self._lock = threading.RLock()
        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(
            db_path,
            check_same_thread=False,
            isolation_level=None,
            timeout=30.0,
        )
        self._connection.row_factory = sqlite3.Row
        self._ensure_schema()

    def __enter__(self) -> SQLiteExecutionStore:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def close(self) -> None:
        self._connection.close()

    def dispatch(self, command: ExecutionCommand, *, max_queue_depth: int) -> ExecutionSnapshot:
        if isinstance(command, StartExecution):
            return self._dispatch_start(command, max_queue_depth=max_queue_depth)
        if isinstance(command, SignalExecution):
            return self._dispatch_signal(command)
        if isinstance(command, CancelExecution):
            return self._dispatch_cancel(command)
        if isinstance(command, RedriveExecution):
            return self._dispatch_redrive(command, max_queue_depth=max_queue_depth)
        raise TypeError(f"unknown execution command: {type(command)!r}")

    def get(self, execution_id: str) -> ExecutionSnapshot:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM executions WHERE execution_id = ?",
                (execution_id,),
            ).fetchone()
            if row is None:
                raise ExecutionNotFoundError(execution_id)
            return self._row_to_snapshot(row)

    def read_events(
        self, execution_id: str, *, after_seq: int = 0, limit: int = 200
    ) -> list[ExecutionEvent]:
        limit = min(1000, max(1, int(limit)))
        with self._lock:
            if not self._execution_exists(execution_id):
                raise ExecutionNotFoundError(execution_id)
            rows = self._connection.execute(
                """
                SELECT execution_id, seq, event_type, payload, created_at
                FROM execution_events
                WHERE execution_id = ? AND seq > ?
                ORDER BY seq ASC
                LIMIT ?
                """,
                (execution_id, int(after_seq), limit),
            ).fetchall()
        return [
            ExecutionEvent(
                execution_id=row["execution_id"],
                seq=int(row["seq"]),
                type=row["event_type"],
                payload=json.loads(row["payload"]),
                created_at=float(row["created_at"]),
            )
            for row in rows
        ]

    def claim_outbox_events(
        self,
        *,
        owner_id: str,
        limit: int = 100,
        lease_ttl_seconds: float = 30.0,
        subject_ref_prefix: str | None = None,
    ) -> list[ExecutionOutboxEvent]:
        _validate_lease_ttl(lease_ttl_seconds)
        limit = min(1000, max(1, int(limit)))
        claim_token = uuid.uuid4().hex
        now = self.clock.now()
        claim_expires_at = now + lease_ttl_seconds
        scope_clause = ""
        params: list[Any] = [now]
        if subject_ref_prefix is not None:
            scope_clause = (
                "AND EXISTS ("
                "SELECT 1 FROM executions AS e "
                "WHERE e.execution_id = o.execution_id AND e.subject_ref LIKE ?"
                ")"
            )
            params.append(f"{subject_ref_prefix}%")
        params.append(limit)
        with self._lock:
            with self._transaction():
                rows = self._connection.execute(
                    f"""
                    SELECT id
                    FROM execution_outbox AS o
                    WHERE o.delivered_at IS NULL
                      AND (o.claim_expires_at IS NULL OR o.claim_expires_at <= ?)
                      {scope_clause}
                      AND NOT EXISTS (
                          SELECT 1
                          FROM execution_outbox AS earlier
                          WHERE earlier.execution_id = o.execution_id
                            AND earlier.seq < o.seq
                            AND earlier.delivered_at IS NULL
                      )
                    ORDER BY id ASC
                    LIMIT ?
                    """,
                    tuple(params),
                ).fetchall()
                ids = [int(row["id"]) for row in rows]
                if not ids:
                    return []
                placeholders = ",".join("?" for _ in ids)
                self._connection.execute(
                    f"""
                    UPDATE execution_outbox
                    SET claim_owner = ?,
                        claim_token = ?,
                        claim_expires_at = ?
                    WHERE id IN ({placeholders})
                      AND delivered_at IS NULL
                    """,
                    (owner_id, claim_token, claim_expires_at, *ids),
                )
                claimed = self._connection.execute(
                    f"""
                    SELECT *
                    FROM execution_outbox
                    WHERE id IN ({placeholders})
                      AND claim_owner = ?
                      AND claim_token = ?
                    ORDER BY id ASC
                    """,
                    (*ids, owner_id, claim_token),
                ).fetchall()
        return [_row_to_outbox_event(row) for row in claimed]

    def ack_outbox_events(
        self,
        events: list[ExecutionOutboxEvent],
        *,
        owner_id: str,
        claim_token: str,
    ) -> int:
        if not events:
            return 0
        now = self.clock.now()
        ids = [int(event.id) for event in events]
        placeholders = ",".join("?" for _ in ids)
        with self._lock:
            with self._transaction():
                cur = self._connection.execute(
                    f"""
                    UPDATE execution_outbox
                    SET delivered_at = ?,
                        claim_owner = NULL,
                        claim_token = NULL,
                        claim_expires_at = NULL
                    WHERE id IN ({placeholders})
                      AND delivered_at IS NULL
                      AND claim_owner = ?
                      AND claim_token = ?
                      AND claim_expires_at > ?
                    """,
                    (now, *ids, owner_id, claim_token, now),
                )
                return int(cur.rowcount)

    def claim_next(
        self,
        *,
        owner_id: str,
        lease_ttl_seconds: float = 30.0,
    ) -> ExecutionLease | None:
        _validate_lease_ttl(lease_ttl_seconds)
        now = self.clock.now()
        lease_expires_at = now + lease_ttl_seconds
        with self._lock:
            with self._transaction():
                while True:
                    row = self._connection.execute(
                        """
                        SELECT * FROM executions
                        WHERE (
                              status = 'queued'
                              AND (not_before IS NULL OR not_before <= ?)
                           )
                           OR (
                              status = 'awaiting_signal'
                              AND EXISTS (
                                  SELECT 1 FROM execution_signals
                                  WHERE execution_signals.execution_id = executions.execution_id
                                    AND applied_at IS NULL
                              )
                           )
                           OR (status = 'running' AND lease_expires_at <= ?)
                        ORDER BY created_at ASC, execution_id ASC
                        LIMIT 1
                        """,
                        (now, now),
                    ).fetchone()
                    if row is None:
                        return None
                    if (
                        row["status"] == "running"
                        and self._has_recovery_blocking_effect(row["execution_id"])
                    ):
                        self._block_expired_running_for_recovery(row, now=now)
                        continue
                    break
                execution_id = row["execution_id"]
                previous_owner = row["lease_owner"]
                previous_token = int(row["lease_token"])
                previous_attempt = int(row["attempt"])
                if row["status"] == "running":
                    self._connection.execute(
                        """
                        UPDATE execution_attempts
                        SET status = 'expired'
                        WHERE execution_id = ? AND attempt = ?
                        """,
                        (execution_id, previous_attempt),
                    )
                    self._append_event(
                        execution_id,
                        "execution.lease_expired",
                        {
                            "owner_id": previous_owner,
                            "lease_token": previous_token,
                            "attempt": previous_attempt,
                        },
                    )

                attempt = previous_attempt + 1
                lease_token = previous_token + 1
                self._connection.execute(
                    """
                    UPDATE executions
                    SET status = 'running',
                        attempt = ?,
                        lease_owner = ?,
                        lease_token = ?,
                        lease_expires_at = ?,
                        not_before = NULL,
                        version = version + 1,
                        updated_at = ?
                    WHERE execution_id = ?
                      AND (
                        status = 'queued'
                        OR status = 'awaiting_signal'
                        OR (status = 'running' AND lease_expires_at <= ?)
                      )
                    """,
                    (
                        attempt,
                        owner_id,
                        lease_token,
                        lease_expires_at,
                        now,
                        execution_id,
                        now,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO execution_attempts (
                        execution_id, attempt, owner_id, lease_token,
                        started_at, heartbeat_at, lease_expires_at, status
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
                    """,
                    (
                        execution_id,
                        attempt,
                        owner_id,
                        lease_token,
                        now,
                        now,
                        lease_expires_at,
                    ),
                )
                self._append_event(
                    execution_id,
                    "execution.claimed",
                    {
                        "owner_id": owner_id,
                        "attempt": attempt,
                        "lease_token": lease_token,
                    },
                )
        return ExecutionLease(
            execution_id=execution_id,
            owner_id=owner_id,
            lease_token=lease_token,
            attempt=attempt,
            lease_expires_at=lease_expires_at,
        )

    def heartbeat(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        lease_ttl_seconds: float = 30.0,
    ) -> bool:
        _validate_lease_ttl(lease_ttl_seconds)
        now = self.clock.now()
        lease_expires_at = now + lease_ttl_seconds
        with self._lock:
            with self._transaction():
                cur = self._connection.execute(
                    """
                    UPDATE executions
                    SET lease_expires_at = ?, updated_at = ?, version = version + 1
                    WHERE execution_id = ?
                      AND status = 'running'
                      AND lease_owner = ?
                      AND lease_token = ?
                      AND lease_expires_at > ?
                    """,
                    (lease_expires_at, now, execution_id, owner_id, lease_token, now),
                )
                if cur.rowcount <= 0:
                    return False
                self._connection.execute(
                    """
                    UPDATE execution_attempts
                    SET heartbeat_at = ?, lease_expires_at = ?
                    WHERE execution_id = ? AND lease_token = ?
                    """,
                    (now, lease_expires_at, execution_id, lease_token),
                )
                return True

    def commit_loop_result(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        result: LoopResult,
        signal_ids: list[str] | None = None,
    ) -> ExecutionSnapshot:
        self._validate_loop_result(result)
        now = self.clock.now()
        signal_ids = list(result.applied_signal_ids if signal_ids is None else signal_ids)
        with self._lock:
            with self._transaction():
                row = self._execution_row(execution_id)
                self._assert_fence(row, owner_id=owner_id, lease_token=lease_token, now=now)
                self._check_fault("before_commit_loop_result")
                if result.status in TERMINAL_STATUSES:
                    late_signals = self._pending_signal_rows_excluding(
                        execution_id, signal_ids
                    )
                    if late_signals:
                        self._ack_signal_ids(execution_id, signal_ids, applied_at=now)
                        self._connection.execute(
                            """
                            UPDATE execution_attempts
                            SET status = 'queued'
                            WHERE execution_id = ? AND lease_token = ?
                            """,
                            (execution_id, lease_token),
                        )
                        self._connection.execute(
                            """
                            UPDATE executions
                            SET status = 'queued',
                                lease_owner = NULL,
                                lease_expires_at = NULL,
                                not_before = NULL,
                                version = version + 1,
                                updated_at = ?
                            WHERE execution_id = ?
                            """,
                            (now, execution_id),
                        )
                        self._append_event(
                            execution_id,
                            "execution.result_deferred",
                            {
                                "reason": "late_signal",
                                "deferred_status": result.status,
                                "owner_id": owner_id,
                                "lease_token": lease_token,
                                "applied_signal_ids": signal_ids,
                                "pending_signal_ids": [
                                    row["signal_id"] for row in late_signals
                                ],
                                "pending_signal_kinds": [
                                    row["kind"] for row in late_signals
                                ],
                            },
                        )
                        return self._row_to_snapshot(self._execution_row(execution_id))
                state = dict(json.loads(row["state_json"]))
                state.update(result.state)
                checkpoint = dict(json.loads(row["checkpoint_json"]))
                checkpoint.update(result.checkpoint)
                status = result.status
                last_error_code = result.last_error_code

                for event_type, payload in result.events:
                    if event_type in _TERMINAL_EVENT_TYPES:
                        raise ValueError("loop adapter may not emit terminal execution events")
                    self._append_event(execution_id, event_type, payload)

                if status in TERMINAL_STATUSES:
                    terminal_payload = {"status": status, "error_code": last_error_code}
                    if result.error_message is not None:
                        terminal_payload["message"] = result.error_message
                    self._append_event(
                        execution_id,
                        f"execution.{status}",
                        terminal_payload,
                    )
                    attempt_status = status
                    lease_owner = None
                    lease_expires_at = None
                elif status in {"queued", "awaiting_signal"}:
                    attempt_status = status
                    lease_owner = None
                    lease_expires_at = None
                else:
                    attempt_status = "running"
                    lease_owner = owner_id
                    lease_expires_at = row["lease_expires_at"]

                self._connection.execute(
                    """
                    UPDATE execution_attempts
                    SET status = ?
                    WHERE execution_id = ? AND lease_token = ?
                    """,
                    (attempt_status, execution_id, lease_token),
                )
                self._connection.execute(
                    """
                    UPDATE executions
                    SET status = ?,
                        state_json = ?,
                        checkpoint_json = ?,
                        last_error_code = ?,
                        lease_owner = ?,
                        lease_expires_at = ?,
                        not_before = NULL,
                        version = version + 1,
                        updated_at = ?
                    WHERE execution_id = ?
                    """,
                    (
                        status,
                        _json(state),
                        _json(checkpoint),
                        last_error_code,
                        lease_owner,
                        lease_expires_at,
                        now,
                        execution_id,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO execution_checkpoints (
                        execution_id, checkpoint, updated_at
                    )
                    VALUES (?, ?, ?)
                    ON CONFLICT(execution_id) DO UPDATE SET
                        checkpoint = excluded.checkpoint,
                        updated_at = excluded.updated_at
                    """,
                    (execution_id, _json(checkpoint), now),
                )
                self._ack_signal_ids(execution_id, signal_ids, applied_at=now)
        return self.get(execution_id)

    def fail_execution(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        error_code: str,
        message: str,
    ) -> ExecutionSnapshot:
        return self.commit_loop_result(
            execution_id,
            owner_id=owner_id,
            lease_token=lease_token,
            result=LoopResult(
                status="failed",
                last_error_code=error_code,
                events=[("execution.error", {"error_code": error_code, "message": message})],
                error_message=message,
            ),
        )

    def schedule_retry_claimed(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        reason: str,
        error_code: str,
        message: str,
        not_before: float,
        max_attempts: int,
    ) -> ExecutionSnapshot:
        """Persist a delayed retry or terminal DLQ under the current lease fence."""
        if max_attempts <= 0:
            raise ValueError("max_attempts must be > 0")
        if not math.isfinite(float(not_before)):
            raise ValueError("not_before must be finite")
        now = self.clock.now()
        with self._lock:
            with self._transaction():
                row = self._execution_row(execution_id)
                self._assert_fence(row, owner_id=owner_id, lease_token=lease_token, now=now)
                if self._has_recovery_blocking_effect(execution_id):
                    self._block_claimed_for_manual_recovery(
                        row,
                        owner_id=owner_id,
                        lease_token=lease_token,
                        now=now,
                    )
                    return self._row_to_snapshot(self._execution_row(execution_id))
                attempt = int(row["attempt"])
                if attempt >= int(max_attempts):
                    self._dead_letter_claimed_row(
                        row,
                        owner_id=owner_id,
                        lease_token=lease_token,
                        reason=reason,
                        error_code=error_code,
                        message=message,
                        max_attempts=max_attempts,
                        now=now,
                    )
                    self._check_fault("before_schedule_dead_letter_commit")
                    return self._row_to_snapshot(self._execution_row(execution_id))
                self._connection.execute(
                    """
                    UPDATE execution_attempts
                    SET status = 'queued'
                    WHERE execution_id = ? AND lease_token = ?
                    """,
                    (execution_id, lease_token),
                )
                self._connection.execute(
                    """
                    UPDATE executions
                    SET status = 'queued',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        not_before = ?,
                        last_error_code = ?,
                        version = version + 1,
                        updated_at = ?
                    WHERE execution_id = ?
                    """,
                    (float(not_before), error_code, now, execution_id),
                )
                self._append_event(
                    execution_id,
                    "execution.retry_scheduled",
                    {
                        "reason": reason,
                        "error_code": error_code,
                        "message": message,
                        "attempt": attempt,
                        "max_attempts": int(max_attempts),
                        "not_before": float(not_before),
                    },
                )
                self._check_fault("before_schedule_retry_commit")
        return self.get(execution_id)

    def dead_letter_claimed(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        reason: str,
        error_code: str,
        message: str,
        max_attempts: int,
    ) -> ExecutionSnapshot:
        now = self.clock.now()
        with self._lock:
            with self._transaction():
                row = self._execution_row(execution_id)
                self._assert_fence(row, owner_id=owner_id, lease_token=lease_token, now=now)
                self._dead_letter_claimed_row(
                    row,
                    owner_id=owner_id,
                    lease_token=lease_token,
                    reason=reason,
                    error_code=error_code,
                    message=message,
                    max_attempts=max_attempts,
                    now=now,
                )
                self._check_fault("before_dead_letter_commit")
        return self.get(execution_id)

    def fetch_pending_signals(
        self, execution_id: str, *, limit: int = 100
    ) -> list[PendingSignal]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT signal_id, execution_id, kind, payload_json, created_at
                FROM execution_signals
                WHERE execution_id = ? AND applied_at IS NULL
                ORDER BY created_at ASC, rowid ASC
                LIMIT ?
                """,
                (execution_id, min(1000, max(1, int(limit)))),
            ).fetchall()
        return [
            PendingSignal(
                signal_id=row["signal_id"],
                execution_id=row["execution_id"],
                kind=row["kind"],
                payload=json.loads(row["payload_json"]),
                created_at=float(row["created_at"]),
            )
            for row in rows
        ]

    def reconcile_startup(self) -> int:
        now = self.clock.now()
        healed = 0
        with self._lock:
            with self._transaction():
                rows = self._connection.execute(
                    """
                    SELECT * FROM executions
                    WHERE status = 'running' AND lease_expires_at <= ?
                    ORDER BY created_at ASC
                    """,
                    (now,),
                ).fetchall()
                for row in rows:
                    execution_id = row["execution_id"]
                    blocked = self._has_recovery_blocking_effect(execution_id)
                    if blocked:
                        self._block_expired_running_for_recovery(row, now=now)
                    else:
                        self._connection.execute(
                            """
                            UPDATE execution_attempts
                            SET status = 'expired'
                            WHERE execution_id = ? AND attempt = ?
                            """,
                            (execution_id, row["attempt"]),
                        )
                        self._connection.execute(
                            """
                            UPDATE executions
                            SET status = 'queued',
                                lease_owner = NULL,
                                lease_expires_at = NULL,
                                not_before = NULL,
                                version = version + 1,
                                updated_at = ?
                            WHERE execution_id = ?
                            """,
                            (now, execution_id),
                        )
                        self._append_event(
                            execution_id,
                            "execution.requeued",
                            {
                                "reason": "startup_reconcile",
                                "expired_owner": row["lease_owner"],
                                "expired_lease_token": row["lease_token"],
                            },
                        )
                    healed += 1
        return healed

    def requeue_claimed(
        self,
        execution_id: str,
        *,
        owner_id: str,
        lease_token: int,
        reason: str,
    ) -> ExecutionSnapshot:
        """Release a still-valid running lease back to queued under fencing."""
        now = self.clock.now()
        with self._lock:
            with self._transaction():
                row = self._execution_row(execution_id)
                self._assert_fence(row, owner_id=owner_id, lease_token=lease_token, now=now)
                self._connection.execute(
                    """
                    UPDATE execution_attempts
                    SET status = 'queued'
                    WHERE execution_id = ? AND lease_token = ?
                    """,
                    (execution_id, lease_token),
                )
                self._connection.execute(
                    """
                    UPDATE executions
                    SET status = 'queued',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        not_before = NULL,
                        version = version + 1,
                        updated_at = ?
                    WHERE execution_id = ?
                    """,
                    (now, execution_id),
                )
                self._append_event(
                    execution_id,
                    "execution.requeued",
                    {
                        "reason": reason,
                        "owner_id": owner_id,
                        "lease_token": lease_token,
                    },
                )
        return self.get(execution_id)

    def list_active(
        self,
        *,
        workspace_id: str,
        subject_ref_prefix: str | None = None,
    ) -> list[ExecutionSnapshot]:
        params: list[Any] = [workspace_id]
        scope = ""
        if subject_ref_prefix is not None:
            scope = "AND subject_ref LIKE ?"
            params.append(f"{subject_ref_prefix}%")
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT *
                FROM executions
                WHERE workspace_id = ?
                  AND status IN ('queued', 'running', 'awaiting_signal')
                  {scope}
                ORDER BY created_at ASC, execution_id ASC
                """,
                tuple(params),
            ).fetchall()
        return [self._row_to_snapshot(row) for row in rows]

    def record_tool_effect(
        self,
        execution_id: str,
        *,
        effect_key: str,
        tool_name: str,
        request_hash: str,
        status: str,
        result: dict[str, Any] | None = None,
    ) -> None:
        if status not in _TOOL_EFFECT_STATUSES:
            raise ValueError(f"invalid tool effect status: {status}")
        now = self.clock.now()
        with self._lock:
            with self._transaction():
                existing = self._connection.execute(
                    """
                    SELECT execution_id, tool_name, request_hash, status
                    FROM execution_tool_effects
                    WHERE effect_key = ?
                    """,
                    (effect_key,),
                ).fetchone()
                if existing is not None:
                    if (
                        existing["execution_id"] != execution_id
                        or existing["tool_name"] != tool_name
                        or existing["request_hash"] != request_hash
                    ):
                        raise ToolEffectConflictError(effect_key)
                    from_status = existing["status"]
                    if status not in _TOOL_EFFECT_TRANSITIONS[from_status]:
                        raise ToolEffectTransitionError(
                            effect_key,
                            from_status,
                            status,
                        )
                self._connection.execute(
                    """
                    INSERT INTO execution_tool_effects (
                        effect_key, execution_id, tool_name, request_hash, status,
                        result_json, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(effect_key) DO UPDATE SET
                        status = excluded.status,
                        result_json = excluded.result_json,
                        updated_at = excluded.updated_at
                    """,
                    (
                        effect_key,
                        execution_id,
                        tool_name,
                        request_hash,
                        status,
                        _json(result or {}) if result is not None else None,
                        now,
                        now,
                    ),
                )

    def _dispatch_start(
        self, command: StartExecution, *, max_queue_depth: int
    ) -> ExecutionSnapshot:
        payload = _command_payload(command)
        payload_hash = _hash_payload(payload)
        overflow = False
        execution_id: str | None = None
        with self._lock:
            with self._transaction():
                existing = self._command_row(command.workspace_id, command.request_id)
                if existing is not None:
                    self._assert_same_command(existing, payload_hash)
                    result = json.loads(existing["result_json"])
                    if result.get("error") == "queue_overflow":
                        overflow = True
                    else:
                        execution_id = result["execution_id"]
                    return_or_raise = True
                else:
                    return_or_raise = False
                    queued_count = self._queued_count(command.workspace_id)
                    if queued_count >= max_queue_depth:
                        overflow = True
                        self._insert_command(
                            command.workspace_id,
                            command.request_id,
                            "StartExecution",
                            None,
                            payload_hash,
                            payload,
                            {"error": "queue_overflow", "retryable": False},
                        )
                    else:
                        execution_id = f"exec_{uuid.uuid4().hex}"
                        now = self.clock.now()
                        try:
                            self._connection.execute(
                                """
                                INSERT INTO executions (
                                    execution_id, workspace_id, conversation_id, channel_id,
                                    subject_ref, trigger_ref, status, worker_profile_ref,
                                    run_profile_ref, input_json, state_json, checkpoint_json,
                                    version, created_at, updated_at, attempt, lease_owner,
                                    lease_token, lease_expires_at, not_before, last_error_code,
                                    linked_execution_id, redrive_metadata_json
                                )
                                VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, '{}', '{}',
                                        1, ?, ?, 0, NULL, 0, NULL, NULL, NULL, NULL, '{}')
                                """,
                                (
                                    execution_id,
                                    command.workspace_id,
                                    command.conversation_id,
                                    command.channel_id,
                                    command.subject_ref,
                                    command.trigger_ref,
                                    command.worker_profile_ref,
                                    command.run_profile_ref,
                                    _json(command.input),
                                    now,
                                    now,
                                ),
                            )
                        except sqlite3.IntegrityError as exc:
                            existing_id = self._active_execution_id(
                                command.workspace_id,
                                command.subject_ref,
                            )
                            if existing_id is None:
                                raise
                            raise ActiveExecutionConflictError(
                                command.subject_ref,
                                existing_id,
                            ) from exc
                        self._append_event(
                            execution_id,
                            "execution.started",
                            {
                                "workspace_id": command.workspace_id,
                                "conversation_id": command.conversation_id,
                                "channel_id": command.channel_id,
                                "subject_ref": command.subject_ref,
                                "trigger_ref": command.trigger_ref,
                                "worker_profile_ref": command.worker_profile_ref,
                                "run_profile_ref": command.run_profile_ref,
                            },
                        )
                        self._insert_command(
                            command.workspace_id,
                            command.request_id,
                            "StartExecution",
                            execution_id,
                            payload_hash,
                            payload,
                            {"execution_id": execution_id},
                        )
        if overflow:
            raise QueueOverflowError(command.request_id)
        if return_or_raise and execution_id is None:
            raise QueueOverflowError(command.request_id)
        assert execution_id is not None
        return self.get(execution_id)

    def _dispatch_signal(self, command: SignalExecution) -> ExecutionSnapshot:
        if command.kind not in _SIGNAL_KINDS:
            raise ValueError(f"invalid signal kind: {command.kind}")
        payload = _command_payload(command)
        payload_hash = _hash_payload(payload)
        with self._lock:
            with self._transaction():
                existing = self._command_row(command.workspace_id, command.request_id)
                if existing is not None:
                    self._assert_same_command(existing, payload_hash)
                    return self.get(json.loads(existing["result_json"])["execution_id"])
                row = self._execution_row(command.execution_id, workspace_id=command.workspace_id)
                if row["status"] in TERMINAL_STATUSES:
                    raise TerminalStateError(command.execution_id)
                now = self.clock.now()
                signal_id = f"sig_{uuid.uuid4().hex}"
                self._connection.execute(
                    """
                    INSERT INTO execution_signals (
                        signal_id, workspace_id, request_id, execution_id, kind,
                        payload_json, created_at, applied_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        signal_id,
                        command.workspace_id,
                        command.request_id,
                        command.execution_id,
                        command.kind,
                        _json(command.payload),
                        now,
                    ),
                )
                self._append_event(
                    command.execution_id,
                    "execution.signaled",
                    {"signal_id": signal_id, "kind": command.kind},
                )
                self._connection.execute(
                    """
                    UPDATE executions
                    SET version = version + 1, updated_at = ?
                    WHERE execution_id = ?
                    """,
                    (now, command.execution_id),
                )
                self._insert_command(
                    command.workspace_id,
                    command.request_id,
                    "SignalExecution",
                    command.execution_id,
                    payload_hash,
                    payload,
                    {"execution_id": command.execution_id, "signal_id": signal_id},
                )
        return self.get(command.execution_id)

    def _dispatch_cancel(self, command: CancelExecution) -> ExecutionSnapshot:
        payload = _command_payload(command)
        payload_hash = _hash_payload(payload)
        with self._lock:
            with self._transaction():
                existing = self._command_row(command.workspace_id, command.request_id)
                if existing is not None:
                    self._assert_same_command(existing, payload_hash)
                    return self.get(json.loads(existing["result_json"])["execution_id"])
                row = self._execution_row(command.execution_id, workspace_id=command.workspace_id)
                if row["status"] in TERMINAL_STATUSES:
                    raise TerminalStateError(command.execution_id)
                now = self.clock.now()
                self._append_event(
                    command.execution_id,
                    "execution.cancelled",
                    {"reason": command.reason},
                )
                if row["lease_token"]:
                    self._connection.execute(
                        """
                        UPDATE execution_attempts
                        SET status = 'cancelled'
                        WHERE execution_id = ? AND lease_token = ?
                        """,
                        (command.execution_id, row["lease_token"]),
                    )
                self._connection.execute(
                    """
                    UPDATE executions
                    SET status = 'cancelled',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        version = version + 1,
                        updated_at = ?
                    WHERE execution_id = ?
                    """,
                    (now, command.execution_id),
                )
                self._insert_command(
                    command.workspace_id,
                    command.request_id,
                    "CancelExecution",
                    command.execution_id,
                    payload_hash,
                    payload,
                    {"execution_id": command.execution_id},
                )
        return self.get(command.execution_id)

    def _dispatch_redrive(
        self, command: RedriveExecution, *, max_queue_depth: int
    ) -> ExecutionSnapshot:
        payload = _command_payload(command)
        payload_hash = _hash_payload(payload)
        overflow = False
        execution_id: str | None = None
        with self._lock:
            with self._transaction():
                existing = self._command_row(command.workspace_id, command.request_id)
                if existing is not None:
                    self._assert_same_command(existing, payload_hash)
                    result = json.loads(existing["result_json"])
                    if result.get("error") == "queue_overflow":
                        overflow = True
                    else:
                        execution_id = result["execution_id"]
                else:
                    original = self._row_to_snapshot(
                        self._execution_row(
                            command.execution_id,
                            workspace_id=command.workspace_id,
                        )
                    )
                    if original.status not in {"failed", "cancelled"}:
                        raise TerminalStateError(command.execution_id)
                    queued_count = self._queued_count(command.workspace_id)
                    if queued_count >= max_queue_depth:
                        overflow = True
                        self._insert_command(
                            command.workspace_id,
                            command.request_id,
                            "RedriveExecution",
                            None,
                            payload_hash,
                            payload,
                            {"error": "queue_overflow", "retryable": False},
                        )
                    else:
                        execution_id = f"exec_{uuid.uuid4().hex}"
                        now = self.clock.now()
                        redrive_metadata = {
                            "redrive_of": original.execution_id,
                            "reason": command.reason,
                        }
                        self._connection.execute(
                            """
                            INSERT INTO executions (
                                execution_id, workspace_id, conversation_id, channel_id,
                                subject_ref, trigger_ref, status, worker_profile_ref,
                                run_profile_ref, input_json, state_json, checkpoint_json,
                                version, created_at, updated_at, attempt, lease_owner,
                                lease_token, lease_expires_at, not_before, last_error_code,
                                linked_execution_id, redrive_metadata_json
                            )
                            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, '{}', '{}',
                                    1, ?, ?, 0, NULL, 0, NULL, NULL, NULL, ?, ?)
                            """,
                            (
                                execution_id,
                                original.workspace_id,
                                original.conversation_id,
                                original.channel_id,
                                original.subject_ref,
                                original.trigger_ref,
                                original.worker_profile_ref,
                                original.run_profile_ref,
                                _json(original.input),
                                now,
                                now,
                                original.execution_id,
                                _json(redrive_metadata),
                            ),
                        )
                        self._append_event(
                            execution_id,
                            "execution.started",
                            {
                                "workspace_id": original.workspace_id,
                                "conversation_id": original.conversation_id,
                                "channel_id": original.channel_id,
                                "subject_ref": original.subject_ref,
                                "trigger_ref": original.trigger_ref,
                                "worker_profile_ref": original.worker_profile_ref,
                                "run_profile_ref": original.run_profile_ref,
                                "redrive": redrive_metadata,
                            },
                        )
                        self._insert_command(
                            command.workspace_id,
                            command.request_id,
                            "RedriveExecution",
                            execution_id,
                            payload_hash,
                            payload,
                            {"execution_id": execution_id},
                        )
        if overflow:
            raise QueueOverflowError(command.request_id)
        assert execution_id is not None
        return self.get(execution_id)

    def _append_event(self, execution_id: str, event_type: str, payload: dict[str, Any]) -> None:
        row = self._connection.execute(
            "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM execution_events WHERE execution_id = ?",
            (execution_id,),
        ).fetchone()
        seq = int(row["max_seq"]) + 1
        now = self.clock.now()
        payload_json = _json(payload)
        self._connection.execute(
            """
            INSERT INTO execution_events (execution_id, seq, event_type, payload, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (execution_id, seq, event_type, payload_json, now),
        )
        self._connection.execute(
            """
            INSERT INTO execution_outbox (execution_id, seq, event_type, payload, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (execution_id, seq, event_type, payload_json, now),
        )

    def _execution_row(
        self, execution_id: str, *, workspace_id: str | None = None
    ) -> sqlite3.Row:
        if workspace_id is None:
            row = self._connection.execute(
                "SELECT * FROM executions WHERE execution_id = ?",
                (execution_id,),
            ).fetchone()
        else:
            row = self._connection.execute(
                "SELECT * FROM executions WHERE execution_id = ? AND workspace_id = ?",
                (execution_id, workspace_id),
            ).fetchone()
        if row is None:
            raise ExecutionNotFoundError(execution_id)
        return row

    def _execution_exists(self, execution_id: str) -> bool:
        row = self._connection.execute(
            "SELECT 1 FROM executions WHERE execution_id = ?",
            (execution_id,),
        ).fetchone()
        return row is not None

    def _command_row(self, workspace_id: str, request_id: str) -> sqlite3.Row | None:
        return self._connection.execute(
            """
            SELECT * FROM execution_commands
            WHERE workspace_id = ? AND request_id = ?
            """,
            (workspace_id, request_id),
        ).fetchone()

    def _insert_command(
        self,
        workspace_id: str,
        request_id: str,
        command_type: str,
        execution_id: str | None,
        payload_hash: str,
        payload: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        self._connection.execute(
            """
            INSERT INTO execution_commands (
                workspace_id, request_id, command_type, execution_id, payload_hash,
                payload_json, result_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                workspace_id,
                request_id,
                command_type,
                execution_id,
                payload_hash,
                _json(payload),
                _json(result),
                self.clock.now(),
            ),
        )

    def _assert_same_command(self, row: sqlite3.Row, payload_hash: str) -> None:
        if row["payload_hash"] != payload_hash:
            raise IdempotencyConflictError(row["request_id"])

    def _assert_fence(
        self,
        row: sqlite3.Row,
        *,
        owner_id: str,
        lease_token: int,
        now: float,
    ) -> None:
        if (
            row["status"] != "running"
            or row["lease_owner"] != owner_id
            or int(row["lease_token"]) != int(lease_token)
            or row["lease_expires_at"] is None
            or float(row["lease_expires_at"]) <= now
        ):
            raise FencingError(row["execution_id"])

    def _validate_loop_result(self, result: LoopResult) -> None:
        if result.status not in ALLOWED_LOOP_STATUSES:
            raise ValueError(f"invalid loop result status: {result.status}")
        if result.status == "cancelled":
            raise ValueError("loop adapter may not cancel executions")

    def _queued_count(self, workspace_id: str) -> int:
        row = self._connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM executions
            WHERE workspace_id = ? AND status = 'queued'
            """,
            (workspace_id,),
        ).fetchone()
        return int(row["count"])

    def _has_recovery_blocking_effect(self, execution_id: str) -> bool:
        row = self._connection.execute(
            """
            SELECT 1 FROM execution_tool_effects
            WHERE execution_id = ?
              AND status IN ('pending', 'unknown')
            LIMIT 1
            """,
            (execution_id,),
        ).fetchone()
        return row is not None

    def _pending_signal_rows_excluding(
        self, execution_id: str, signal_ids: list[str]
    ) -> list[sqlite3.Row]:
        if signal_ids:
            placeholders = ",".join("?" for _ in signal_ids)
            rows = self._connection.execute(
                f"""
                SELECT signal_id, kind
                FROM execution_signals
                WHERE execution_id = ?
                  AND applied_at IS NULL
                  AND signal_id NOT IN ({placeholders})
                ORDER BY created_at ASC, rowid ASC
                """,
                (execution_id, *signal_ids),
            ).fetchall()
        else:
            rows = self._connection.execute(
                """
                SELECT signal_id, kind
                FROM execution_signals
                WHERE execution_id = ? AND applied_at IS NULL
                ORDER BY created_at ASC, rowid ASC
                """,
                (execution_id,),
            ).fetchall()
        return list(rows)

    def _ack_signal_ids(
        self, execution_id: str, signal_ids: list[str], *, applied_at: float
    ) -> None:
        for signal_id in signal_ids:
            self._connection.execute(
                """
                UPDATE execution_signals
                SET applied_at = ?
                WHERE execution_id = ? AND signal_id = ? AND applied_at IS NULL
                """,
                (applied_at, execution_id, signal_id),
            )

    def _block_expired_running_for_recovery(self, row: sqlite3.Row, *, now: float) -> None:
        execution_id = row["execution_id"]
        self._connection.execute(
            """
            UPDATE execution_attempts
            SET status = 'interrupted'
            WHERE execution_id = ? AND attempt = ?
            """,
            (execution_id, row["attempt"]),
        )
        self._connection.execute(
            """
            UPDATE executions
            SET status = 'awaiting_signal',
                lease_owner = NULL,
                lease_expires_at = NULL,
                not_before = NULL,
                version = version + 1,
                updated_at = ?
            WHERE execution_id = ?
            """,
            (now, execution_id),
        )
        self._append_event(
            execution_id,
            "execution.recovery_blocked",
            {
                "reason": "external_effect_uncertain",
                "expired_owner": row["lease_owner"],
                "expired_lease_token": row["lease_token"],
            },
        )

    def _block_claimed_for_manual_recovery(
        self,
        row: sqlite3.Row,
        *,
        owner_id: str,
        lease_token: int,
        now: float,
    ) -> None:
        execution_id = row["execution_id"]
        attempt = int(row["attempt"])
        self._connection.execute(
            """
            UPDATE execution_attempts
            SET status = 'awaiting_signal'
            WHERE execution_id = ? AND lease_token = ?
            """,
            (execution_id, lease_token),
        )
        self._connection.execute(
            """
            UPDATE executions
            SET status = 'awaiting_signal',
                lease_owner = NULL,
                lease_expires_at = NULL,
                not_before = NULL,
                version = version + 1,
                updated_at = ?
            WHERE execution_id = ?
            """,
            (now, execution_id),
        )
        self._append_event(
            execution_id,
            "execution.recovery_blocked",
            {
                "reason": "effect_outcome_unknown",
                "manual_recovery_required": True,
                "owner_id": owner_id,
                "lease_token": lease_token,
                "attempt": attempt,
            },
        )

    def _dead_letter_claimed_row(
        self,
        row: sqlite3.Row,
        *,
        owner_id: str,
        lease_token: int,
        reason: str,
        error_code: str,
        message: str,
        max_attempts: int,
        now: float,
    ) -> None:
        execution_id = row["execution_id"]
        attempt = int(row["attempt"])
        self._connection.execute(
            """
            UPDATE execution_attempts
            SET status = 'failed'
            WHERE execution_id = ? AND lease_token = ?
            """,
            (execution_id, lease_token),
        )
        self._connection.execute(
            """
            UPDATE executions
            SET status = 'failed',
                lease_owner = NULL,
                lease_expires_at = NULL,
                not_before = NULL,
                last_error_code = ?,
                version = version + 1,
                updated_at = ?
            WHERE execution_id = ?
            """,
            (error_code, now, execution_id),
        )
        self._append_event(
            execution_id,
            "execution.dead_lettered",
            {
                "status": "failed",
                "reason": reason,
                "error_code": error_code,
                "message": message,
                "attempt": attempt,
                "max_attempts": int(max_attempts),
                "owner_id": owner_id,
                "lease_token": lease_token,
            },
        )

    def _active_execution_id(self, workspace_id: str, subject_ref: str) -> str | None:
        row = self._connection.execute(
            """
            SELECT execution_id
            FROM executions
            WHERE workspace_id = ?
              AND subject_ref = ?
              AND status IN ('queued', 'running', 'awaiting_signal')
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (workspace_id, subject_ref),
        ).fetchone()
        return None if row is None else row["execution_id"]

    def _row_to_snapshot(self, row: sqlite3.Row) -> ExecutionSnapshot:
        return ExecutionSnapshot(
            execution_id=row["execution_id"],
            workspace_id=row["workspace_id"],
            conversation_id=row["conversation_id"],
            channel_id=row["channel_id"],
            subject_ref=row["subject_ref"],
            trigger_ref=row["trigger_ref"],
            status=row["status"],
            worker_profile_ref=row["worker_profile_ref"],
            run_profile_ref=row["run_profile_ref"],
            input=json.loads(row["input_json"]),
            state=json.loads(row["state_json"]),
            checkpoint=json.loads(row["checkpoint_json"]),
            version=int(row["version"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            attempt=int(row["attempt"]),
            lease_owner=row["lease_owner"],
            lease_token=int(row["lease_token"]),
            lease_expires_at=(
                None if row["lease_expires_at"] is None else float(row["lease_expires_at"])
            ),
            not_before=None if row["not_before"] is None else float(row["not_before"]),
            last_error_code=row["last_error_code"],
            linked_execution_id=row["linked_execution_id"],
            redrive_metadata=json.loads(row["redrive_metadata_json"]),
        )

    def _check_fault(self, name: str) -> None:
        if self._fault_hook is not None:
            self._fault_hook(name)

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except Exception:
            self._connection.rollback()
            raise
        else:
            self._connection.commit()

    def _ensure_schema(self) -> None:
        with self._lock:
            self._connection.execute("PRAGMA foreign_keys=ON")
            if self.db_path != ":memory:":
                self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS executions (
                    execution_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    subject_ref TEXT NOT NULL,
                    trigger_ref TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN (
                            'queued', 'running', 'awaiting_signal',
                            'succeeded', 'failed', 'cancelled'
                        )
                    ),
                    worker_profile_ref TEXT NOT NULL,
                    run_profile_ref TEXT NOT NULL,
                    input_json TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    checkpoint_json TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK (version >= 1),
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    attempt INTEGER NOT NULL CHECK (attempt >= 0),
                    lease_owner TEXT,
                    lease_token INTEGER NOT NULL CHECK (lease_token >= 0),
                    lease_expires_at REAL,
                    not_before REAL,
                    last_error_code TEXT,
                    linked_execution_id TEXT REFERENCES executions(execution_id),
                    redrive_metadata_json TEXT NOT NULL
                )
                """
            )
            self._connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_one_active_subject
                ON executions(workspace_id, subject_ref)
                WHERE status IN ('queued', 'running', 'awaiting_signal')
                """
            )
            try:
                self._connection.execute("ALTER TABLE executions ADD COLUMN not_before REAL")
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
            self._connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_executions_status_created
                ON executions(workspace_id, status, created_at)
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_commands (
                    workspace_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    command_type TEXT NOT NULL,
                    execution_id TEXT REFERENCES executions(execution_id),
                    payload_hash TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (workspace_id, request_id)
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_events (
                    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                    seq INTEGER NOT NULL CHECK (seq > 0),
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (execution_id, seq)
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                    seq INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    delivered_at REAL,
                    claim_owner TEXT,
                    claim_token TEXT,
                    claim_expires_at REAL,
                    UNIQUE(execution_id, seq)
                )
                """
            )
            for statement in (
                "ALTER TABLE execution_outbox ADD COLUMN claim_owner TEXT",
                "ALTER TABLE execution_outbox ADD COLUMN claim_token TEXT",
                "ALTER TABLE execution_outbox ADD COLUMN claim_expires_at REAL",
            ):
                try:
                    self._connection.execute(statement)
                except sqlite3.OperationalError as exc:
                    if "duplicate column name" not in str(exc).lower():
                        raise
            self._connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_execution_outbox_claim
                ON execution_outbox(delivered_at, claim_expires_at, id)
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_attempts (
                    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                    attempt INTEGER NOT NULL,
                    owner_id TEXT NOT NULL,
                    lease_token INTEGER NOT NULL,
                    started_at REAL NOT NULL,
                    heartbeat_at REAL NOT NULL,
                    lease_expires_at REAL NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN (
                            'running', 'queued', 'awaiting_signal', 'succeeded',
                            'failed', 'cancelled', 'expired', 'interrupted'
                        )
                    ),
                    PRIMARY KEY (execution_id, attempt)
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_checkpoints (
                    execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
                    checkpoint TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_signals (
                    signal_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                    kind TEXT NOT NULL CHECK (kind IN ('steer', 'answer', 'approval')),
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    applied_at REAL,
                    UNIQUE(workspace_id, request_id)
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_tool_effects (
                    effect_key TEXT PRIMARY KEY,
                    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                    tool_name TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'unknown', 'succeeded', 'failed')
                    ),
                    result_json TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _row_to_outbox_event(row: sqlite3.Row) -> ExecutionOutboxEvent:
    return ExecutionOutboxEvent(
        id=int(row["id"]),
        execution_id=row["execution_id"],
        seq=int(row["seq"]),
        type=row["event_type"],
        payload=json.loads(row["payload"]),
        created_at=float(row["created_at"]),
        claim_owner=row["claim_owner"],
        claim_token=row["claim_token"],
        claim_expires_at=float(row["claim_expires_at"]),
    )


def _command_payload(command: ExecutionCommand) -> dict[str, Any]:
    payload = asdict(command)
    payload["command_type"] = type(command).__name__
    return payload


def _hash_payload(payload: dict[str, Any]) -> str:
    import hashlib

    return hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()


def _validate_lease_ttl(lease_ttl_seconds: float) -> None:
    if (
        not isinstance(lease_ttl_seconds, int | float)
        or not math.isfinite(float(lease_ttl_seconds))
        or float(lease_ttl_seconds) <= 0.0
    ):
        raise ValueError("lease_ttl_seconds must be finite and > 0")
