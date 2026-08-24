from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Protocol

from services.associate.app.schemas import (
    AssociateReceivablesRun,
    AssociateWriteAction,
)


class AssociateStateStore(Protocol):
    def save_run(self, run: AssociateReceivablesRun) -> None:
        ...

    def get_run(self, run_id: str) -> AssociateReceivablesRun | None:
        ...

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[AssociateReceivablesRun]:
        ...

    def get_run_by_approval_id(self, approval_id: str) -> AssociateReceivablesRun | None:
        ...

    def get_write_action(self, write_action_id: str) -> AssociateWriteAction | None:
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


class SQLiteAssociateStateStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()
        self._seed_counter("run", self.max_run_sequence())
        self._seed_counter("approval", self.max_approval_sequence())
        self._seed_counter("write", self.max_write_sequence())

    def save_run(self, run: AssociateReceivablesRun) -> None:
        payload = json.dumps(
            run.model_dump(mode="json"),
            ensure_ascii=False,
            sort_keys=True,
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO associate_runs (
                    run_id,
                    workspace_id,
                    actor_user_id,
                    payload,
                    updated_at
                )
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(run_id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    actor_user_id = excluded.actor_user_id,
                    payload = excluded.payload,
                    updated_at = datetime('now')
                """,
                (run.id, run.workspace_id, run.actor_user_id, payload),
            )
            connection.execute(
                "DELETE FROM associate_approval_index WHERE run_id = ?",
                (run.id,),
            )
            connection.execute(
                "DELETE FROM associate_write_action_index WHERE run_id = ?",
                (run.id,),
            )
            for node in run.plan.nodes if run.plan else []:
                if node.approval is not None:
                    connection.execute(
                        """
                        INSERT INTO associate_approval_index (
                            approval_id,
                            run_id,
                            node_id
                        )
                        VALUES (?, ?, ?)
                        """,
                        (node.approval.id, run.id, node.id),
                    )
                if node.write_action is not None:
                    connection.execute(
                        """
                        INSERT INTO associate_write_action_index (
                            write_action_id,
                            run_id,
                            node_id
                        )
                        VALUES (?, ?, ?)
                        """,
                        (node.write_action.id, run.id, node.id),
                    )

    def get_run(self, run_id: str) -> AssociateReceivablesRun | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM associate_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return _row_to_run(row)

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[AssociateReceivablesRun]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload FROM associate_runs
                WHERE workspace_id = ? AND actor_user_id = ?
                ORDER BY rowid DESC
                """,
                (workspace_id, actor_user_id),
            ).fetchall()
        return [run for run in (_row_to_run(row) for row in rows) if run is not None]

    def get_run_by_approval_id(self, approval_id: str) -> AssociateReceivablesRun | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT associate_runs.payload
                FROM associate_runs
                JOIN associate_approval_index
                  ON associate_runs.run_id = associate_approval_index.run_id
                WHERE associate_approval_index.approval_id = ?
                """,
                (approval_id,),
            ).fetchone()
        return _row_to_run(row)

    def get_write_action(self, write_action_id: str) -> AssociateWriteAction | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT associate_runs.payload
                FROM associate_runs
                JOIN associate_write_action_index
                  ON associate_runs.run_id = associate_write_action_index.run_id
                WHERE associate_write_action_index.write_action_id = ?
                """,
                (write_action_id,),
            ).fetchone()
        run = _row_to_run(row)
        if run is None or run.plan is None:
            return None
        for node in run.plan.nodes:
            if node.write_action and node.write_action.id == write_action_id:
                return node.write_action
        return None

    def max_run_sequence(self) -> int:
        return self._max_sequence("associate_run", "run_id")

    def max_approval_sequence(self) -> int:
        return self._max_sequence("associate_approval", "approval_id")

    def max_write_sequence(self) -> int:
        return self._max_sequence("associate_write", "write_action_id")

    def next_run_sequence(self) -> int:
        return self._next_sequence("run")

    def next_approval_sequence(self) -> int:
        return self._next_sequence("approval")

    def next_write_sequence(self) -> int:
        return self._next_sequence("write")

    def _max_sequence(self, prefix: str, column: str) -> int:
        table = "associate_runs"
        if column == "approval_id":
            table = "associate_approval_index"
        elif column == "write_action_id":
            table = "associate_write_action_index"
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT {column} AS identifier FROM {table} "
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
                INSERT INTO associate_id_counters (name, value)
                VALUES (?, 0)
                ON CONFLICT(name) DO NOTHING
                """,
                (name,),
            )
            connection.execute(
                """
                UPDATE associate_id_counters
                SET value = value + 1
                WHERE name = ?
                """,
                (name,),
            )
            row = connection.execute(
                "SELECT value FROM associate_id_counters WHERE name = ?",
                (name,),
            ).fetchone()
        return int(row["value"])

    def _seed_counter(self, name: str, value: int) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO associate_id_counters (name, value)
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
                CREATE TABLE IF NOT EXISTS associate_runs (
                    run_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    actor_user_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_associate_runs_workspace_user
                ON associate_runs(workspace_id, actor_user_id)
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS associate_approval_index (
                    approval_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_associate_approval_index_run_id
                ON associate_approval_index(run_id)
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS associate_write_action_index (
                    write_action_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_associate_write_action_index_run_id
                ON associate_write_action_index(run_id)
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS associate_id_counters (
                    name TEXT PRIMARY KEY,
                    value INTEGER NOT NULL
                )
                """
            )


def _row_to_run(row: sqlite3.Row | None) -> AssociateReceivablesRun | None:
    if row is None:
        return None
    return AssociateReceivablesRun.model_validate(json.loads(row["payload"]))

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
