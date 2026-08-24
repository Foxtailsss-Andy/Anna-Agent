from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Header, HTTPException

from services.identity.app.schemas import LoginRequest, SessionIdentity
from services.identity.app.service import IdentityError, IdentityService


def build_router(
    identity: IdentityService,
    local_session: Callable[[], SessionIdentity] | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/auth/login")
    def login(request: LoginRequest) -> dict:
        try:
            result = identity.login(request.email, request.password)
        except IdentityError as exc:
            raise HTTPException(status_code=401, detail="invalid credentials") from exc
        return result.model_dump(mode="json")

    @router.post("/api/auth/logout")
    def logout(authorization: str | None = Header(default=None)) -> dict:
        token = _bearer_token(authorization)
        if token:
            identity.logout(token)
        return {"ok": True}

    @router.get("/api/auth/team")
    def team(authorization: str | None = Header(default=None)) -> dict:
        session = _require_session(identity, authorization, local_session)
        members = identity.list_members(session.workspace_id)
        return {"members": [member.model_dump(mode="json") for member in members]}

    return router


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization.removeprefix("Bearer ").strip() or None


def _require_session(
    identity: IdentityService,
    authorization: str | None,
    local_session: Callable[[], SessionIdentity] | None = None,
):
    token = _bearer_token(authorization)
    session = identity.resolve(token) if token else None
    # No token → local-runtime identity fallback (surface-consistency), when wired.
    if session is None and local_session is not None:
        session = local_session()
    if session is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return session
