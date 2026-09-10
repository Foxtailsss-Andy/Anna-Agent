from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException

from services.identity.app.schemas import SessionIdentity
from services.identity.app.service import IdentityService


def _assert_identity(
    body_workspace_id: str,
    body_user_id: str,
    header_workspace_id: str,
    header_user_id: str,
) -> None:
    if body_workspace_id != header_workspace_id or body_user_id != header_user_id:
        raise HTTPException(status_code=403, detail="request identity mismatch")


def _assert_run_access(
    run_workspace_id: str,
    run_user_id: str,
    header_workspace_id: str,
    header_user_id: str,
) -> None:
    if run_workspace_id != header_workspace_id or run_user_id != header_user_id:
        raise HTTPException(status_code=403, detail="run access denied")


def _assert_workspace_access(
    workspace_id: str,
    header_workspace_id: str,
    header_user_id: str,
) -> None:
    if workspace_id != header_workspace_id or not header_user_id:
        raise HTTPException(status_code=403, detail="workspace access denied")


def _resolve_product_identity(
    authorization: str | None,
    header_workspace_id: str,
    header_user_id: str,
    *,
    identity: IdentityService | None,
    local_session: Callable[[], SessionIdentity] | None,
) -> tuple[SessionIdentity, bool]:
    """Resolve the one server-owned identity used by product routes.

    A bearer token is authoritative when present. Token-less product calls use
    the configured local desktop identity, but still have to match both public
    identity headers. The boolean marks that trusted local fallback so legacy
    ownerless workdir records can remain readable only by that identity.
    """
    if authorization is not None:
        if not authorization.startswith("Bearer ") or identity is None:
            raise HTTPException(status_code=401, detail="authentication required")
        resolved = identity.resolve(authorization.removeprefix("Bearer ").strip())
        if resolved is None:
            raise HTTPException(status_code=401, detail="authentication required")
        if (
            resolved.workspace_id != header_workspace_id
            or resolved.user_id != header_user_id
        ):
            raise HTTPException(status_code=403, detail="request identity mismatch")
        return resolved, False
    if local_session is None:
        raise HTTPException(status_code=401, detail="authentication required")
    local = local_session()
    if local.workspace_id != header_workspace_id or local.user_id != header_user_id:
        raise HTTPException(status_code=403, detail="request identity mismatch")
    return local, True
