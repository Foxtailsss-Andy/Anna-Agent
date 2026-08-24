"""Shared SSE serialization for Anna's cowork streaming routes.

The one canonical copy of the frame serializer + response headers that the
finance / reimbursement / hiker streaming routes previously each carried
verbatim (R1-T1a skeleton extraction). The wire shape is byte-identical to
the historical per-route copies: ``data: <json>\\n\\n`` with
``ensure_ascii=False``, and any pydantic ``event`` / ``run`` values dumped
via ``model_dump(mode="json")``.

The chat route serializes its own (differently shaped) frames inline and is
intentionally NOT migrated here.
"""
from __future__ import annotations

import json
from typing import Any

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def sse_frame(event: dict[str, Any]) -> str:
    payload = dict(event)
    inner = payload.get("event")
    if inner is not None and hasattr(inner, "model_dump"):
        payload["event"] = inner.model_dump(mode="json")
    run = payload.get("run")
    if run is not None and hasattr(run, "model_dump"):
        payload["run"] = run.model_dump(mode="json")
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
