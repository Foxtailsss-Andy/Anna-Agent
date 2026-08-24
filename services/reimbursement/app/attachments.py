from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from services.reimbursement.app.schemas import AttachmentRef
from services.runtime.app.config import RuntimeSettings


class AttachmentContentUnavailable(Exception):
    pass


def import_attachment_content(
    settings: RuntimeSettings,
    workspace_id: str,
    user_id: str,
    filename: str,
    content: bytes,
) -> dict[str, Any]:
    safe_name = safe_attachment_name(filename)
    sha256 = hashlib.sha256(content).hexdigest()
    attachment_dir = attachment_storage_root(settings) / workspace_id / user_id / sha256
    attachment_dir.mkdir(parents=True, exist_ok=True)
    attachment_path = attachment_dir / safe_name
    attachment_path.write_bytes(content)
    return {
        "name": safe_name,
        "uri": f"anna://attachment/{sha256}/{quote(safe_name)}",
        "size_bytes": len(content),
        "sha256": sha256,
    }


def materialize_attachments_for_mcp(
    settings: RuntimeSettings,
    workspace_id: str,
    user_id: str,
    attachments: list[AttachmentRef],
) -> list[dict[str, Any]]:
    materialized: list[dict[str, Any]] = []
    for attachment in attachments:
        payload = attachment.model_dump()
        attachment_path = attachment_path_from_uri(
            settings,
            workspace_id,
            user_id,
            attachment.uri,
        )
        if attachment_path is None or not attachment_path.exists():
            raise AttachmentContentUnavailable("attachment content is unavailable")
        content = attachment_path.read_bytes()
        payload.update(
            {
                "size_bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "content_base64": base64.b64encode(content).decode("ascii"),
            }
        )
        materialized.append(payload)
    return materialized


def attachment_path_from_uri(
    settings: RuntimeSettings,
    workspace_id: str,
    user_id: str,
    uri: str,
) -> Path | None:
    prefix = "anna://attachment/"
    if not uri.startswith(prefix):
        return None
    remainder = uri[len(prefix) :]
    if "/" not in remainder:
        return None
    sha256, encoded_name = remainder.split("/", 1)
    if not re.fullmatch(r"[a-f0-9]{64}", sha256):
        return None
    safe_name = safe_attachment_name(unquote(encoded_name))
    return attachment_storage_root(settings) / workspace_id / user_id / sha256 / safe_name


def attachment_storage_root(settings: RuntimeSettings) -> Path:
    state_db_path = settings.state_db_path
    if state_db_path:
        return Path(state_db_path).parent / "attachments"
    return Path.cwd() / ".anna" / "attachments"


def safe_attachment_name(filename: str) -> str:
    name = Path(filename).name.strip()
    if not name or name in {".", ".."}:
        return "attachment"
    return name.replace("/", "_").replace("\\", "_")
