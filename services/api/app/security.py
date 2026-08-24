from __future__ import annotations

from fastapi import HTTPException


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
