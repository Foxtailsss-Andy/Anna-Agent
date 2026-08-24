from __future__ import annotations

import secrets

from services.identity.app.passwords import verify_password
from services.identity.app.schemas import (
    Account,
    LoginResponse,
    SessionIdentity,
)
from services.identity.app.store import SQLiteIdentityStore


class IdentityError(Exception):
    pass


class IdentityService:
    def __init__(self, store: SQLiteIdentityStore) -> None:
        self.store = store

    def login(self, email: str, password: str) -> LoginResponse:
        credentials = self.store.get_account_credentials(email)
        if credentials is None:
            raise IdentityError("invalid credentials")
        account, password_hash = credentials
        if not verify_password(password, password_hash):
            raise IdentityError("invalid credentials")
        token = secrets.token_urlsafe(32)
        self.store.create_session(token, account.id, account.workspace_id)
        return LoginResponse(token=token, session=self._identity(account))

    def logout(self, token: str) -> None:
        self.store.delete_session(token)

    def resolve(self, token: str) -> SessionIdentity | None:
        session = self.store.get_session(token)
        if session is None:
            return None
        account = self.store.get_account(session["account_id"])
        if account is None:
            return None
        # The session — not the account — is the authority on which workspace this
        # token is scoped to (an account may belong to multiple workspaces later).
        return self._identity(account, workspace_id=session["workspace_id"])

    def list_members(self, workspace_id: str) -> list[Account]:
        return self.store.list_members(workspace_id)

    def _identity(
        self, account: Account, workspace_id: str | None = None
    ) -> SessionIdentity:
        workspace_id = workspace_id or account.workspace_id
        workspace = self.store.get_workspace(workspace_id)
        return SessionIdentity(
            workspace_id=workspace_id,
            workspace_name=workspace.name if workspace else workspace_id,
            user_id=account.id,
            user_display_name=account.display_name,
            role=account.role,
        )
