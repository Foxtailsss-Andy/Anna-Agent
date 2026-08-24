from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

# B1b: the scope axis. "workspace" items are org-wide knowledge (the historical
# default — every pre-B1b row reads back as workspace); "project" items are a
# Crew project's 共识 entries (约束/口径/决策), keyed by ``project_id``.
MemoryScope = Literal["workspace", "project"]


class BusinessMemoryItem(BaseModel):
    id: str
    workspace_id: str
    memory_type: str
    title: str
    content: str
    source: str
    confidence: float = Field(ge=0.0, le=1.0)
    scope: MemoryScope = "workspace"
    project_id: str | None = None
    created_at: str
    updated_at: str


class CreateBusinessMemoryRequest(BaseModel):
    workspace_id: str
    memory_type: str
    title: str
    content: str
    source: str = "admin"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
