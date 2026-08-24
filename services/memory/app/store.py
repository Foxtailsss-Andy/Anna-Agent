from __future__ import annotations

import sqlite3
from uuid import uuid4
from pathlib import Path

from services.memory.app.schemas import BusinessMemoryItem, utc_now_iso


class BusinessMemoryStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def add(
        self,
        workspace_id: str,
        memory_type: str,
        title: str,
        content: str,
        source: str,
        confidence: float = 1.0,
        scope: str = "workspace",
        project_id: str | None = None,
    ) -> BusinessMemoryItem:
        if scope not in ("workspace", "project"):
            raise ValueError(f"unknown memory scope {scope!r}")
        if scope == "project" and not project_id:
            raise ValueError("project-scoped memory requires a project_id")
        if scope == "workspace" and project_id:
            raise ValueError("workspace-scoped memory must not carry a project_id")
        now = utc_now_iso()
        with self._connect() as connection:
            next_id = f"business_memory_{uuid4().hex}"
            connection.execute(
                """
                INSERT INTO business_memory (
                    id, workspace_id, memory_type, title, content, source,
                    confidence, scope, project_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    next_id,
                    workspace_id,
                    memory_type,
                    title,
                    content,
                    source,
                    float(confidence),
                    scope,
                    project_id,
                    now,
                    now,
                ),
            )
        return BusinessMemoryItem(
            id=next_id,
            workspace_id=workspace_id,
            memory_type=memory_type,
            title=title,
            content=content,
            source=source,
            confidence=float(confidence),
            scope=scope,
            project_id=project_id,
            created_at=now,
            updated_at=now,
        )

    def list_items(
        self,
        workspace_id: str,
        scope: str | None = None,
        project_id: str | None = None,
        limit: int = 50,
    ) -> list[BusinessMemoryItem]:
        """Workspace listing, optionally filtered by ``scope`` / ``project_id``.

        ``scope=None`` keeps the historical behavior (every row of the
        workspace); ``scope="project"`` + ``project_id`` is a Crew project's
        共识 listing."""
        clauses = ["workspace_id = ?"]
        params: list[object] = [workspace_id]
        if scope is not None:
            clauses.append("scope = ?")
            params.append(scope)
        if project_id is not None:
            clauses.append("project_id = ?")
            params.append(project_id)
        params.append(limit)
        # Newest first; rowid breaks created_at ties in true insertion order
        # (timestamps can collide within the clock's resolution — a random
        # uuid tiebreak would make listings, and the 共识 numbering derived
        # from them, non-deterministic).
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM business_memory
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        return [self._item_from_row(row) for row in rows]

    def get(self, item_id: str) -> BusinessMemoryItem | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM business_memory WHERE id = ?", (item_id,)
            ).fetchone()
        return self._item_from_row(row) if row is not None else None

    def update(
        self,
        item_id: str,
        *,
        memory_type: str | None = None,
        title: str | None = None,
        content: str | None = None,
    ) -> BusinessMemoryItem | None:
        """Edit an item's classification/text in place (scope/owner immutable).

        Returns the updated item, or ``None`` when the id is unknown."""
        existing = self.get(item_id)
        if existing is None:
            return None
        now = utc_now_iso()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE business_memory
                SET memory_type = ?, title = ?, content = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    existing.memory_type if memory_type is None else memory_type,
                    existing.title if title is None else title,
                    existing.content if content is None else content,
                    now,
                    item_id,
                ),
            )
        return self.get(item_id)

    def delete(self, item_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM business_memory WHERE id = ?", (item_id,)
            )
            return cursor.rowcount > 0

    def search(
        self,
        workspace_id: str,
        query: str,
        limit: int = 5,
        include_project: bool = False,
    ) -> list[BusinessMemoryItem]:
        """Workspace knowledge retrieval.

        B3 裁定: defaults to ``scope="workspace"`` rows only — a Crew project's
        共识 entries (``scope="project"``) are namespaced to that project and
        must NOT leak into a generic workspace recall (chat/finance/hiker). Pass
        ``include_project=True`` to opt a caller into the project rows too.
        """
        normalized = query.strip()
        if not normalized:
            return self.list_items(
                workspace_id,
                scope=None if include_project else "workspace",
                limit=limit,
            )
        pattern = f"%{normalized}%"
        clauses = ["workspace_id = ?", "(title LIKE ? OR content LIKE ? OR memory_type LIKE ?)"]
        params: list[object] = [workspace_id, pattern, pattern, pattern]
        if not include_project:
            clauses.append("scope = 'workspace'")
        params.append(limit)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM business_memory
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        items = [self._item_from_row(row) for row in rows]
        if items:
            return items
        return self._fuzzy_search(workspace_id, normalized, limit, include_project)

    def count(self, workspace_id: str | None = None) -> int:
        with self._connect() as connection:
            if workspace_id is None:
                return int(
                    connection.execute("SELECT COUNT(*) FROM business_memory").fetchone()[0]
                )
            return int(
                connection.execute(
                    "SELECT COUNT(*) FROM business_memory WHERE workspace_id = ?",
                    (workspace_id,),
                ).fetchone()[0]
            )

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS business_memory (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    memory_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    scope TEXT NOT NULL DEFAULT 'workspace',
                    project_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            # B1b in-place migration for pre-scope databases: ADD COLUMN is
            # idempotent-by-catch — on a fresh table the columns already exist
            # and SQLite raises "duplicate column name", which we swallow.
            for ddl in (
                "ALTER TABLE business_memory "
                "ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'",
                "ALTER TABLE business_memory ADD COLUMN project_id TEXT",
            ):
                try:
                    connection.execute(ddl)
                except sqlite3.OperationalError as exc:
                    if "duplicate column name" not in str(exc).lower():
                        raise
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_business_memory_workspace
                ON business_memory(workspace_id, created_at)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_business_memory_project
                ON business_memory(workspace_id, scope, project_id)
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _item_from_row(self, row: sqlite3.Row) -> BusinessMemoryItem:
        return BusinessMemoryItem(
            id=str(row["id"]),
            workspace_id=str(row["workspace_id"]),
            memory_type=str(row["memory_type"]),
            title=str(row["title"]),
            content=str(row["content"]),
            source=str(row["source"]),
            confidence=float(row["confidence"]),
            scope=str(row["scope"]),
            project_id=(
                str(row["project_id"]) if row["project_id"] is not None else None
            ),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
        )

    def _fuzzy_search(
        self,
        workspace_id: str,
        query: str,
        limit: int,
        include_project: bool = False,
    ) -> list[BusinessMemoryItem]:
        needles = _query_needles(query)
        if not needles:
            return []
        scored: list[tuple[int, BusinessMemoryItem]] = []
        for item in self.list_items(
            workspace_id,
            scope=None if include_project else "workspace",
            limit=100,
        ):
            haystack = f"{item.memory_type} {item.title} {item.content}"
            score = sum(1 for needle in needles if needle in haystack)
            if score:
                scored.append((score, item))
        scored.sort(key=lambda pair: (-pair[0], pair[1].created_at, pair[1].id))
        return [item for _score, item in scored[:limit]]


def _query_needles(query: str) -> list[str]:
    normalized = "".join(
        character
        for character in query
        if character.isalnum() or "\u4e00" <= character <= "\u9fff"
    )
    if len(normalized) < 2:
        return [normalized] if normalized else []
    needles = {normalized[index : index + 4] for index in range(max(len(normalized) - 3, 1))}
    needles |= {normalized[index : index + 2] for index in range(max(len(normalized) - 1, 1))}
    return sorted(needle for needle in needles if needle)
