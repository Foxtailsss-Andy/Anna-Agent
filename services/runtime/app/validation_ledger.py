from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


class SQLiteRuntimeValidationLedgerStore:
    def __init__(self, db_path: str | Path, limit: int = 20) -> None:
        self.db_path = Path(db_path)
        self.limit = limit
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def save_item(self, item: dict[str, Any]) -> None:
        payload = json.dumps(item, ensure_ascii=False, sort_keys=True)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO runtime_validation_ledger (
                    validation_id,
                    created_at,
                    status,
                    payload
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(validation_id) DO UPDATE SET
                    created_at = excluded.created_at,
                    status = excluded.status,
                    payload = excluded.payload
                """,
                (
                    item["validation_id"],
                    item["created_at"],
                    item["status"],
                    payload,
                ),
            )
            connection.execute(
                """
                DELETE FROM runtime_validation_ledger
                WHERE rowid NOT IN (
                    SELECT rowid FROM runtime_validation_ledger
                    ORDER BY rowid DESC
                    LIMIT ?
                )
                """,
                (self.limit,),
            )

    def list_items(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload FROM runtime_validation_ledger
                ORDER BY rowid DESC
                LIMIT ?
                """,
                (self.limit,),
            ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS runtime_validation_ledger (
                    validation_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection
