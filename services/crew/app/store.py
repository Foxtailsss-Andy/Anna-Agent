from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from services.crew.app.schemas import ChannelMessage, CrewProject, Notification


class ProjectVersionConflictError(RuntimeError):
    """Raised when a stale CrewProject snapshot loses a compare-and-swap save."""

    def __init__(self, project_id: str, expected_version: int | None = None) -> None:
        self.project_id = project_id
        self.expected_version = expected_version
        detail = project_id
        if expected_version is not None:
            detail = f"{project_id}: expected version {expected_version}"
        super().__init__(detail)


class ProjectInvariantError(RuntimeError):
    """Raised when a project mutation tries to change immutable identity fields."""


@dataclass(frozen=True)
class VersionedCrewProject:
    project: CrewProject
    version: int


@dataclass(frozen=True)
class ProjectionEffects:
    changed: bool
    channel_messages: list[ChannelMessage] | None = None
    notifications: list[Notification] | None = None


class SQLiteCrewStore:
    """SQLite-backed store for CrewProject objects.

    Mirrors the pattern from SQLiteAssociateStateStore:
    - crew_projects table with JSON payload
    - crew_id_counters table for sequence generation
    - workspace-scoped list queries
    """

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def save_project(self, project: CrewProject) -> None:
        payload = json.dumps(
            project.model_dump(mode="json"),
            ensure_ascii=False,
            sort_keys=True,
        )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT project_version FROM crew_projects WHERE project_id = ?",
                    (project.id,),
                ).fetchone()
                expected = int(project.project_version or 0)
                if row is None:
                    if expected != 0:
                        raise ProjectVersionConflictError(project.id, expected)
                    next_version = 1
                    conn.execute(
                        """
                        INSERT INTO crew_projects (
                            project_id, workspace_id, owner_user_id, payload,
                            project_version, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, datetime('now'))
                        """,
                        (
                            project.id,
                            project.workspace_id,
                            project.owner_user_id,
                            payload,
                            next_version,
                        ),
                    )
                else:
                    if expected <= 0:
                        raise ProjectVersionConflictError(project.id, None)
                    next_version = expected + 1
                    cur = conn.execute(
                        """
                        UPDATE crew_projects
                        SET workspace_id = ?,
                            owner_user_id = ?,
                            payload = ?,
                            project_version = ?,
                            updated_at = datetime('now')
                        WHERE project_id = ? AND project_version = ?
                        """,
                        (
                            project.workspace_id,
                            project.owner_user_id,
                            payload,
                            next_version,
                            project.id,
                            expected,
                        ),
                    )
                    if cur.rowcount <= 0:
                        raise ProjectVersionConflictError(project.id, expected)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        project.project_version = next_version

    def save_project_cas(self, project: CrewProject, *, expected_version: int) -> int:
        project.project_version = expected_version
        self.save_project(project)
        return project.project_version

    def get_project(self, project_id: str) -> CrewProject | None:
        versioned = self.get_project_versioned(project_id)
        return None if versioned is None else versioned.project

    def get_project_versioned(self, project_id: str) -> VersionedCrewProject | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload, project_version FROM crew_projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
        project = _row_to_project(row)
        if project is None:
            return None
        return VersionedCrewProject(project=project, version=project.project_version)

    def update_project(
        self,
        project_id: str,
        mutate: Callable[[CrewProject], None | CrewProject],
    ) -> CrewProject:
        """Load, mutate and save a CrewProject under one BEGIN IMMEDIATE lock."""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT payload, project_version FROM crew_projects WHERE project_id = ?",
                    (project_id,),
                ).fetchone()
                project = _row_to_project(row)
                if project is None:
                    raise ValueError(f"Project {project_id!r} not found")
                identity = (project.id, project.workspace_id, project.owner_user_id)
                result = mutate(project)
                if result is not None:
                    project = result
                if (project.id, project.workspace_id, project.owner_user_id) != identity:
                    raise ProjectInvariantError(
                        "project mutation cannot change id, workspace_id, or owner_user_id"
                    )
                next_version = project.project_version + 1
                payload = json.dumps(
                    project.model_dump(mode="json"),
                    ensure_ascii=False,
                    sort_keys=True,
                )
                cur = conn.execute(
                    """
                    UPDATE crew_projects
                    SET workspace_id = ?,
                        owner_user_id = ?,
                        payload = ?,
                        project_version = ?,
                        updated_at = datetime('now')
                    WHERE project_id = ? AND project_version = ?
                    """,
                    (
                        project.workspace_id,
                        project.owner_user_id,
                        payload,
                        next_version,
                        project.id,
                        project.project_version,
                    ),
                )
                if cur.rowcount != 1:
                    raise ProjectVersionConflictError(project_id, project.project_version)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        project.project_version = next_version
        return project

    def apply_execution_projection(
        self,
        *,
        project_id: str,
        task_id: str,
        execution_id: str,
        seq: int,
        mutate: Callable[[CrewProject], bool | ProjectionEffects],
    ) -> bool:
        """Apply one execution event projection and record its receipt atomically."""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                existing = conn.execute(
                    """
                    SELECT 1
                    FROM crew_execution_projection_receipts
                    WHERE execution_id = ? AND seq = ?
                    """,
                    (execution_id, seq),
                ).fetchone()
                if existing is not None:
                    conn.commit()
                    return False

                row = conn.execute(
                    "SELECT payload, project_version FROM crew_projects WHERE project_id = ?",
                    (project_id,),
                ).fetchone()
                project = _row_to_project(row)
                if project is None:
                    raise ValueError(f"Project {project_id!r} not found")
                identity = (project.id, project.workspace_id, project.owner_user_id)
                mutation = mutate(project)
                if isinstance(mutation, ProjectionEffects):
                    changed = mutation.changed
                    channel_messages = list(mutation.channel_messages or [])
                    notifications = list(mutation.notifications or [])
                else:
                    changed = bool(mutation)
                    channel_messages = []
                    notifications = []
                if (project.id, project.workspace_id, project.owner_user_id) != identity:
                    raise ProjectInvariantError(
                        "project mutation cannot change id, workspace_id, or owner_user_id"
                    )

                if changed:
                    next_version = project.project_version + 1
                    payload = json.dumps(
                        project.model_dump(mode="json"),
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                    cur = conn.execute(
                        """
                        UPDATE crew_projects
                        SET workspace_id = ?,
                            owner_user_id = ?,
                            payload = ?,
                            project_version = ?,
                            updated_at = datetime('now')
                        WHERE project_id = ? AND project_version = ?
                        """,
                        (
                            project.workspace_id,
                            project.owner_user_id,
                            payload,
                            next_version,
                            project.id,
                            project.project_version,
                        ),
                    )
                    if cur.rowcount != 1:
                        raise ProjectVersionConflictError(project_id, project.project_version)
                for message in channel_messages:
                    self._append_channel_message_tx(conn, message)
                for note in notifications:
                    self._append_notification_tx(conn, note)
                conn.execute(
                    """
                    INSERT INTO crew_execution_projection_receipts (
                        execution_id, seq, project_id, task_id, projected_at
                    )
                    VALUES (?, ?, ?, ?, datetime('now'))
                    """,
                    (execution_id, seq, project_id, task_id),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return changed

    def list_projects(
        self, workspace_id: str, owner_user_id: str
    ) -> list[CrewProject]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT payload, project_version FROM crew_projects
                WHERE workspace_id = ? AND owner_user_id = ?
                ORDER BY rowid DESC
                """,
                (workspace_id, owner_user_id),
            ).fetchall()
        return [p for p in (_row_to_project(r) for r in rows) if p is not None]

    def list_all_projects(self, workspace_id: str) -> list[CrewProject]:
        """Every project in a workspace regardless of owner (B3 inbox).

        A member's inbox spans projects owned by anyone (a task can be assigned
        to them in the Boss's project), so the aggregation needs a workspace-wide
        listing — the owner-scoped ``list_projects`` would hide them."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT payload, project_version
                FROM crew_projects
                WHERE workspace_id = ?
                ORDER BY rowid DESC
                """,
                (workspace_id,),
            ).fetchall()
        return [p for p in (_row_to_project(r) for r in rows) if p is not None]

    def next_project_sequence(self) -> int:
        return self._next_sequence("project")

    def next_task_sequence(self) -> int:
        return self._next_sequence("task")

    # ------------------------------------------------------------------
    # Channel messages (per-project chronicle)
    # ------------------------------------------------------------------

    def next_channel_seq(self, project_id: str) -> int:
        """Per-project, 1-based, monotonic channel sequence."""
        return self._next_sequence(f"channel:{project_id}")

    def append_channel_message(self, message: ChannelMessage) -> None:
        with self._connect() as conn:
            self._append_channel_message_tx(conn, message)

    def replace_channel_messages(self, project_id: str, messages: list[ChannelMessage]) -> None:
        """Atomically replace all channel rows for one already-authorized project."""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "DELETE FROM crew_channel_messages WHERE project_id = ?",
                    (project_id,),
                )
                for message in messages:
                    self._append_channel_message_tx(conn, message)
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    def list_channel_messages(self, project_id: str) -> list[ChannelMessage]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM crew_channel_messages
                WHERE project_id = ?
                ORDER BY seq ASC
                """,
                (project_id,),
            ).fetchall()
        return [_row_to_message(r) for r in rows]

    def get_channel_message(self, message_id: str) -> ChannelMessage | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM crew_channel_messages WHERE id = ?",
                (message_id,),
            ).fetchone()
        return _row_to_message(row) if row is not None else None

    # ------------------------------------------------------------------
    # Notifications (per-member, idempotent by key)
    # ------------------------------------------------------------------

    def next_notification_seq(self) -> int:
        return self._next_sequence("notification")

    def append_notification(self, note: Notification) -> bool:
        """Insert a notification; a duplicate ``idempotency_key`` is a no-op.

        Returns True when a new row was inserted, False when deduplicated.
        """
        with self._connect() as conn:
            cur = self._append_notification_tx(conn, note)
            return cur.rowcount > 0

    def list_notifications(
        self, workspace_id: str, member_id: str, unread_only: bool = False
    ) -> list[Notification]:
        query = (
            "SELECT * FROM crew_notifications "
            "WHERE workspace_id = ? AND to_member_id = ?"
        )
        if unread_only:
            query += " AND read_at IS NULL"
        query += " ORDER BY rowid DESC"  # newest first
        with self._connect() as conn:
            rows = conn.execute(query, (workspace_id, member_id)).fetchall()
        return [_row_to_notification(r) for r in rows]

    def mark_read(self, notification_id: str, member_id: str) -> Notification | None:
        """Stamp read_at (idempotent) for a member's own notification.

        Member scoping is the isolation boundary: a member can only read their
        own notifications. Returns the current row, or None if not found/owned.
        """
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE crew_notifications
                SET read_at = datetime('now')
                WHERE id = ? AND to_member_id = ? AND read_at IS NULL
                """,
                (notification_id, member_id),
            )
            row = conn.execute(
                "SELECT * FROM crew_notifications WHERE id = ? AND to_member_id = ?",
                (notification_id, member_id),
            ).fetchone()
        return _row_to_notification(row) if row is not None else None

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _next_sequence(self, name: str) -> int:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO crew_id_counters (name, value)
                VALUES (?, 0)
                ON CONFLICT(name) DO NOTHING
                """,
                (name,),
            )
            conn.execute(
                """
                UPDATE crew_id_counters
                SET value = value + 1
                WHERE name = ?
                """,
                (name,),
            )
            row = conn.execute(
                "SELECT value FROM crew_id_counters WHERE name = ?",
                (name,),
            ).fetchone()
        return int(row["value"])

    def _next_sequence_tx(self, conn: sqlite3.Connection, name: str) -> int:
        conn.execute(
            """
            INSERT INTO crew_id_counters (name, value)
            VALUES (?, 0)
            ON CONFLICT(name) DO NOTHING
            """,
            (name,),
        )
        conn.execute(
            """
            UPDATE crew_id_counters
            SET value = value + 1
            WHERE name = ?
            """,
            (name,),
        )
        row = conn.execute(
            "SELECT value FROM crew_id_counters WHERE name = ?",
            (name,),
        ).fetchone()
        return int(row["value"])

    def _append_channel_message_tx(
        self, conn: sqlite3.Connection, message: ChannelMessage
    ) -> sqlite3.Cursor:
        if message.seq <= 0:
            message.seq = self._next_sequence_tx(conn, f"channel:{message.project_id}")
        return conn.execute(
            """
            INSERT INTO crew_channel_messages (
                id, project_id, workspace_id, seq, author_kind, author_member_id,
                worker_profile_ref, caused_by_execution_id, kind, body, task_id,
                run_ref, mentions, audit_ref, payload, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            (
                message.id, message.project_id, message.workspace_id, message.seq,
                message.author_kind, message.author_member_id,
                message.worker_profile_ref, message.caused_by_execution_id,
                message.kind, message.body, message.task_id, message.run_ref,
                json.dumps(message.mentions, ensure_ascii=False),
                message.audit_ref,
                json.dumps(message.payload, ensure_ascii=False)
                if message.payload is not None else None,
                message.created_at,
            ),
        )

    def _append_notification_tx(
        self, conn: sqlite3.Connection, note: Notification
    ) -> sqlite3.Cursor:
        return conn.execute(
            """
            INSERT INTO crew_notifications (
                id, workspace_id, to_member_id, kind, title, deep_link,
                project_id, task_id, read_at, idempotency_key, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO NOTHING
            """,
            (
                note.id, note.workspace_id, note.to_member_id, note.kind,
                note.title, note.deep_link, note.project_id, note.task_id,
                note.read_at, note.idempotency_key, note.created_at,
            ),
        )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS crew_projects (
                    project_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    owner_user_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    project_version INTEGER NOT NULL DEFAULT 1 CHECK (project_version >= 1),
                    updated_at TEXT NOT NULL
                )
                """
            )
            try:
                conn.execute(
                    """
                    ALTER TABLE crew_projects
                    ADD COLUMN project_version INTEGER NOT NULL DEFAULT 1
                        CHECK (project_version >= 1)
                    """
                )
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(crew_projects)").fetchall()
            }
            if "schema_version" in columns:
                conn.execute(
                    """
                    UPDATE crew_projects
                    SET project_version = schema_version
                    WHERE project_version = 1 AND schema_version > 1
                    """
                )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_crew_projects_workspace_owner
                ON crew_projects(workspace_id, owner_user_id)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS crew_execution_projection_receipts (
                    execution_id TEXT NOT NULL,
                    seq INTEGER NOT NULL CHECK (seq > 0),
                    project_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    projected_at TEXT NOT NULL,
                    PRIMARY KEY (execution_id, seq)
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_crew_projection_receipts_project
                ON crew_execution_projection_receipts(project_id, task_id)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS crew_id_counters (
                    name TEXT PRIMARY KEY,
                    value INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS crew_channel_messages (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    author_kind TEXT NOT NULL,
                    author_member_id TEXT,
                    kind TEXT NOT NULL,
                    body TEXT NOT NULL,
                    task_id TEXT,
                    run_ref TEXT,
                    mentions TEXT NOT NULL,
                    audit_ref TEXT NOT NULL,
                    payload TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            # B3 in-place migration for pre-B3 databases: the command draft row
            # (kind="command") needs a structured ``payload`` (drafts + source
            # message id). ADD COLUMN is idempotent-by-catch — a fresh table
            # already has it and SQLite raises "duplicate column name".
            try:
                conn.execute("ALTER TABLE crew_channel_messages ADD COLUMN payload TEXT")
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
            try:
                conn.execute(
                    "ALTER TABLE crew_channel_messages ADD COLUMN worker_profile_ref TEXT"
                )
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
            try:
                conn.execute(
                    "ALTER TABLE crew_channel_messages ADD COLUMN caused_by_execution_id TEXT"
                )
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_crew_channel_project
                ON crew_channel_messages(project_id, seq)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS crew_notifications (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    to_member_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    deep_link TEXT NOT NULL,
                    project_id TEXT,
                    task_id TEXT,
                    read_at TEXT,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_crew_notifications_member
                ON crew_notifications(workspace_id, to_member_id)
                """
            )


def _row_to_project(row: sqlite3.Row | None) -> CrewProject | None:
    if row is None:
        return None
    project = CrewProject.model_validate(json.loads(row["payload"]))
    project.project_version = int(row["project_version"])
    return project


def _row_to_message(row: sqlite3.Row) -> ChannelMessage:
    # ``payload`` may be absent on rows read from a pre-B3 DB before its ALTER;
    # sqlite3.Row raises IndexError on an unknown key, so probe defensively.
    raw_payload = row["payload"] if "payload" in row.keys() else None
    return ChannelMessage(
        id=row["id"],
        project_id=row["project_id"],
        workspace_id=row["workspace_id"],
        seq=row["seq"],
        author_kind=row["author_kind"],
        author_member_id=row["author_member_id"],
        worker_profile_ref=(
            row["worker_profile_ref"] if "worker_profile_ref" in row.keys() else None
        ),
        caused_by_execution_id=(
            row["caused_by_execution_id"]
            if "caused_by_execution_id" in row.keys()
            else None
        ),
        kind=row["kind"],
        body=row["body"],
        task_id=row["task_id"],
        run_ref=row["run_ref"],
        mentions=json.loads(row["mentions"]),
        audit_ref=row["audit_ref"],
        payload=json.loads(raw_payload) if raw_payload else None,
        created_at=row["created_at"],
    )


def _row_to_notification(row: sqlite3.Row) -> Notification:
    return Notification(
        id=row["id"],
        workspace_id=row["workspace_id"],
        to_member_id=row["to_member_id"],
        kind=row["kind"],
        title=row["title"],
        deep_link=row["deep_link"],
        project_id=row["project_id"],
        task_id=row["task_id"],
        read_at=row["read_at"],
        idempotency_key=row["idempotency_key"],
        created_at=row["created_at"],
    )
