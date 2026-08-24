from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Protocol

from services.reimbursement.app.schemas import (
    ReimbursementRun,
    ReimbursementWriteAction,
)


class ReimbursementStateStore(Protocol):
    def save_run(self, run: ReimbursementRun) -> None:
        ...

    def get_run(self, run_id: str) -> ReimbursementRun | None:
        ...

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[ReimbursementRun]:
        ...

    def get_run_by_approval_id(self, approval_id: str) -> ReimbursementRun | None:
        ...

    def get_write_action(self, write_action_id: str) -> ReimbursementWriteAction | None:
        ...

    def max_run_sequence(self) -> int:
        ...

    def max_approval_sequence(self) -> int:
        ...

    def max_write_sequence(self) -> int:
        ...

    def next_run_sequence(self) -> int:
        ...

    def next_approval_sequence(self) -> int:
        ...

    def next_write_sequence(self) -> int:
        ...


class SQLiteReimbursementStateStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()
        self._seed_counter("run", self.max_run_sequence())
        self._seed_counter("approval", self.max_approval_sequence())
        self._seed_counter("write", self.max_write_sequence())

    def save_run(self, run: ReimbursementRun) -> None:
        payload = json.dumps(
            run.model_dump(mode="json"),
            ensure_ascii=False,
            sort_keys=True,
        )
        approval_id = run.approval.id if run.approval else None
        write_action_id = run.write_action.id if run.write_action else None
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO reimbursement_runs (
                    run_id,
                    approval_id,
                    write_action_id,
                    payload,
                    updated_at
                )
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(run_id) DO UPDATE SET
                    approval_id = excluded.approval_id,
                    write_action_id = excluded.write_action_id,
                    payload = excluded.payload,
                    updated_at = datetime('now')
                """,
                (run.id, approval_id, write_action_id, payload),
            )

    def get_run(self, run_id: str) -> ReimbursementRun | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM reimbursement_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return _row_to_run(row)

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[ReimbursementRun]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload FROM reimbursement_runs ORDER BY rowid DESC",
            ).fetchall()
        runs = [_row_to_run(row) for row in rows]
        return [
            run
            for run in runs
            if run is not None
            and run.workspace_id == workspace_id
            and run.actor_user_id == actor_user_id
        ]

    def get_run_by_approval_id(self, approval_id: str) -> ReimbursementRun | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM reimbursement_runs WHERE approval_id = ?",
                (approval_id,),
            ).fetchone()
        return _row_to_run(row)

    def get_write_action(self, write_action_id: str) -> ReimbursementWriteAction | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM reimbursement_runs WHERE write_action_id = ?",
                (write_action_id,),
            ).fetchone()
        run = _row_to_run(row)
        if run is None:
            return None
        return run.write_action

    def max_run_sequence(self) -> int:
        return self._max_sequence("run", "run_id")

    def max_approval_sequence(self) -> int:
        return self._max_sequence("approval", "approval_id")

    def max_write_sequence(self) -> int:
        return self._max_sequence("write", "write_action_id")

    def next_run_sequence(self) -> int:
        return self._next_sequence("run")

    def next_approval_sequence(self) -> int:
        return self._next_sequence("approval")

    def next_write_sequence(self) -> int:
        return self._next_sequence("write")

    def _max_sequence(self, prefix: str, column: str) -> int:
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT {column} AS identifier FROM reimbursement_runs "
                f"WHERE {column} IS NOT NULL"
            ).fetchall()
        return max(
            (_sequence_value(prefix, row["identifier"]) for row in rows),
            default=0,
        )

    def _next_sequence(self, name: str) -> int:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO reimbursement_id_counters (name, value)
                VALUES (?, 0)
                ON CONFLICT(name) DO NOTHING
                """,
                (name,),
            )
            connection.execute(
                """
                UPDATE reimbursement_id_counters
                SET value = value + 1
                WHERE name = ?
                """,
                (name,),
            )
            row = connection.execute(
                "SELECT value FROM reimbursement_id_counters WHERE name = ?",
                (name,),
            ).fetchone()
        return int(row["value"])

    def _seed_counter(self, name: str, value: int) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO reimbursement_id_counters (name, value)
                VALUES (?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    value = max(value, excluded.value)
                """,
                (name, value),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS reimbursement_runs (
                    run_id TEXT PRIMARY KEY,
                    approval_id TEXT,
                    write_action_id TEXT,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_reimbursement_runs_approval_id
                ON reimbursement_runs(approval_id)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_reimbursement_runs_write_action_id
                ON reimbursement_runs(write_action_id)
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS reimbursement_id_counters (
                    name TEXT PRIMARY KEY,
                    value INTEGER NOT NULL
                )
                """
            )


def _row_to_run(row: sqlite3.Row | None) -> ReimbursementRun | None:
    if row is None:
        return None
    return ReimbursementRun.model_validate(json.loads(row["payload"]))


def _sequence_value(prefix: str, identifier: str | None) -> int:
    if identifier is None:
        return 0
    expected_prefix = f"{prefix}_"
    if not identifier.startswith(expected_prefix):
        return 0
    suffix = identifier.removeprefix(expected_prefix)
    if not suffix.isdigit():
        return 0
    return int(suffix)
