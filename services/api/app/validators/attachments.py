from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from services.reimbursement.app.attachments import (
    attachment_path_from_uri,
    import_attachment_content,
)
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator


def _import_attachment(
    reimbursement: ReimbursementOrchestrator,
    workspace_id: str,
    user_id: str,
    filename: str,
    content: bytes,
) -> dict[str, Any]:
    return import_attachment_content(
        reimbursement.settings,
        workspace_id,
        user_id,
        filename,
        content,
    )


def _assert_imported_attachment_list(
    attachments: Any,
    reimbursement: ReimbursementOrchestrator,
    workspace_id: str,
    user_id: str,
) -> None:
    """Validate a standalone list of Anna-imported attachment references."""
    if attachments is None:
        return
    if not isinstance(attachments, list):
        raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
    for attachment in attachments:
        if not isinstance(attachment, dict):
            raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
        uri = attachment.get("uri")
        if not isinstance(uri, str):
            raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
        attachment_path = attachment_path_from_uri(
            reimbursement.settings,
            workspace_id,
            user_id,
            uri,
        )
        if attachment_path is None or not attachment_path.exists():
            raise HTTPException(status_code=400, detail="attachments must be imported through Anna")


def _assert_imported_attachment_answers(
    answers: dict[str, Any],
    reimbursement: ReimbursementOrchestrator,
    workspace_id: str,
    user_id: str,
) -> None:
    attachments = answers.get("attachments")
    if attachments is None:
        return
    if not isinstance(attachments, list):
        raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
    for attachment in attachments:
        if not isinstance(attachment, dict):
            raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
        uri = attachment.get("uri")
        if not isinstance(uri, str):
            raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
        attachment_path = attachment_path_from_uri(
            reimbursement.settings,
            workspace_id,
            user_id,
            uri,
        )
        if attachment_path is None or not attachment_path.exists():
            raise HTTPException(status_code=400, detail="attachments must be imported through Anna")
