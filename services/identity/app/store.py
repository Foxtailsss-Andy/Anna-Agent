from __future__ import annotations

import sqlite3
from pathlib import Path

from services.identity.app.schemas import Account, Membership, Workspace


class SQLiteIdentityStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def create_workspace(self, workspace_id: str, name: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO identity_workspaces (id, name) VALUES (?, ?)",
                (workspace_id, name),
            )

    def get_workspace(self, workspace_id: str) -> Workspace | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, name FROM identity_workspaces WHERE id = ?",
                (workspace_id,),
            ).fetchone()
        if row is None:
            return None
        return Workspace(id=row["id"], name=row["name"])

    def create_team(self, team_id: str, workspace_id: str, name: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO identity_teams (id, workspace_id, name) VALUES (?, ?, ?)",
                (team_id, workspace_id, name),
            )

    def create_account(self, account: Account, password_hash: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO identity_accounts
                    (id, workspace_id, email, display_name, role, kind, password_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    account.id, account.workspace_id, account.email,
                    account.display_name, account.role, account.kind, password_hash,
                ),
            )

    def get_account(self, account_id: str) -> Account | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM identity_accounts WHERE id = ?", (account_id,)
            ).fetchone()
        return _row_to_account(row)

    def get_account_credentials(self, email: str) -> tuple[Account, str] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM identity_accounts WHERE email = ?", (email,)
            ).fetchone()
        account = _row_to_account(row)
        if account is None or row is None:
            return None
        return account, row["password_hash"]

    def add_membership(self, membership: Membership) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO identity_memberships
                    (account_id, workspace_id, team_id, role)
                VALUES (?, ?, ?, ?)
                """,
                (membership.account_id, membership.workspace_id,
                 membership.team_id, membership.role),
            )

    def list_members(self, workspace_id: str) -> list[Account]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM identity_accounts WHERE workspace_id = ? ORDER BY rowid",
                (workspace_id,),
            ).fetchall()
        return [account for account in (_row_to_account(row) for row in rows) if account]

    def create_session(self, token: str, account_id: str, workspace_id: str) -> None:
        # `created_at` is recorded for future TTL/audit. Session expiry is
        # intentionally deferred to a later hardening plan — tokens stay valid
        # until logout for this demo-grade foundation.
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO identity_sessions
                    (token, account_id, workspace_id, created_at)
                VALUES (?, ?, ?, datetime('now'))
                """,
                (token, account_id, workspace_id),
            )

    def get_session(self, token: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT account_id, workspace_id FROM identity_sessions WHERE token = ?",
                (token,),
            ).fetchone()
        if row is None:
            return None
        return {"account_id": row["account_id"], "workspace_id": row["workspace_id"]}

    def delete_session(self, token: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM identity_sessions WHERE token = ?", (token,)
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS identity_workspaces "
                "(id TEXT PRIMARY KEY, name TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS identity_teams "
                "(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL)"
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS identity_accounts (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    role TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    password_hash TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_identity_accounts_workspace "
                "ON identity_accounts(workspace_id)"
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS identity_memberships (
                    account_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    team_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    PRIMARY KEY (account_id, team_id)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS identity_sessions (
                    token TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )


def _row_to_account(row: sqlite3.Row | None) -> Account | None:
    if row is None:
        return None
    return Account(
        id=row["id"], workspace_id=row["workspace_id"], email=row["email"],
        display_name=row["display_name"], role=row["role"], kind=row["kind"],
    )
