from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel, Field

_clock_lock = threading.Lock()
_last_issued_at: datetime | None = None


def _monotonic_utc_now() -> str:
    """Strictly increasing UTC timestamps for audit ordering.

    Windows clock granularity (~15.6ms) can hand identical wall-clock values
    to consecutive audit events, which breaks newest-first ordering in the
    cross-domain Agent Run Ledger. Audit evidence must be totally ordered,
    so collide-and-bump by one microsecond under a process-wide lock.
    """
    global _last_issued_at
    with _clock_lock:
        now = datetime.now(timezone.utc)
        if _last_issued_at is not None and now <= _last_issued_at:
            now = _last_issued_at + timedelta(microseconds=1)
        _last_issued_at = now
        return now.isoformat()


class AuditEvent(BaseModel):
    type: str
    run_id: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=_monotonic_utc_now)


class AuditService:
    def append(
        self,
        events: list[AuditEvent],
        event_type: str,
        run_id: str,
        payload: dict[str, Any] | None = None,
    ) -> AuditEvent:
        event = AuditEvent(type=event_type, run_id=run_id, payload=payload or {})
        events.append(event)
        return event
