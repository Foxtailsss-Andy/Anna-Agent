"""Domain-agnostic live SSE streaming of a run's audit trail — two generations.

Two mechanisms coexist in this module:

* ``AuditFrameWatermark`` — the CURRENT, engine-driven path. The async
  streaming advances (finance / reimbursement / hiker ``stream_*_advance``)
  drive the ``QueryEngine`` on the request's own event loop and use this
  cursor to flush newly appended audit events between live engine frames —
  no worker thread, no list swap.
* ``stream_run_action`` — the LEGACY observer path described by the rest of
  this docstring. Still live on the reimbursement approve/stream route (a
  model-free resume with no engine frames to stream); the chat / create /
  associate domains likewise remain on pre-engine paths until they migrate
  to the engine (R1-T4..T6).

Legacy mechanism: Anna's pre-engine domain orchestrators are synchronous and
emit one audit event per ReAct step (skill load, model call, MCP tool call,
…). To make the agent's work visible live — without touching the proven
MCP/governance/audit logic — we *observe* appends to a run's ``audit_events``
list and forward each new event over Server-Sent Events.

- ``NotifyingList`` is a drop-in ``list`` that fires a callback on ``append``.
  Every audit write goes through ``list.append`` (see ``AuditService.append``),
  so swapping ``run.audit_events`` for a ``NotifyingList`` captures every step
  with no orchestrator changes.
- The synchronous action runs in a worker thread; new events are pushed onto an
  ``asyncio.Queue`` thread-safely and yielded by the async generator the SSE
  endpoint consumes.
- After the action finishes the list is restored to a plain ``list`` so later
  (non-streamed) operations on the same run never touch a stale event loop.

This module is intentionally free of any domain types: ``run`` only needs an
``audit_events`` list attribute and ``action`` returns the final run object.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any, TypeVar

T = TypeVar("T")


class AuditFrameWatermark:
    """Flush audit events appended to a run's list as ``{"type": "event"}`` frames.

    The engine-driven streaming advances (finance / reimbursement / hiker
    ``stream_*_advance``) interleave audit-event frames with live engine
    frames: before each engine frame — and once more after the engine
    finishes — they emit every audit event appended since the previous flush,
    in append order, each event exactly once. This class is that watermark
    cursor, extracted from the character-identical closures the first two
    callers carried.

    IMPORTANT — in-place append contract: the watermark assumes audit events
    are appended to ``audit_events`` IN PLACE; ``run.audit_events`` must NOT
    be reassigned during the advance (contrast: the ``NotifyingList`` swap in
    ``stream_run_action`` below — still used by not-yet-migrated routes —
    DOES reassign the attribute; the two must never observe the same advance).

    ``skip_history=True`` starts the cursor past any events already on the
    list, so an advance that RESUMES a run (e.g. the reimbursement answers
    stream) never re-emits the prior advance's trail — mirroring how the old
    ``stream_run_action`` seeded its ``NotifyingList`` with history. The
    default starts at the list head (fresh-run streams flush everything).
    """

    def __init__(self, audit_events: list[Any], *, skip_history: bool = False) -> None:
        self._audit_events = audit_events
        self._watermark = len(audit_events) if skip_history else 0

    def new_frames(self) -> list[dict[str, Any]]:
        """Return one ``{"type": "event", "event": <AuditEvent>}`` frame per
        event appended since the last flush, advancing the cursor."""
        frames = [
            {"type": "event", "event": event}
            for event in self._audit_events[self._watermark :]
        ]
        self._watermark = len(self._audit_events)
        return frames


class NotifyingList(list):
    """A list that invokes ``on_append`` for each item added via ``append``.

    Seed items passed to the constructor do NOT fire the callback — only
    appends made after construction do, so historical events are not re-emitted.
    """

    def __init__(self, seed: list[Any] | None = None, on_append: Callable[[Any], None] | None = None):
        super().__init__(seed or [])
        self._on_append = on_append

    def append(self, item: Any) -> None:  # type: ignore[override]
        super().append(item)
        if self._on_append is not None:
            self._on_append(item)


async def stream_run_action(
    run: T,
    action: Callable[[], T],
) -> AsyncIterator[dict[str, Any]]:
    """Run a synchronous ``action`` while streaming its audit events.

    ``run`` must expose a mutable ``audit_events`` list. Yields
    ``{"type": "event", "event": <AuditEvent>}`` for each new step, then a final
    ``{"type": "done", "run": <run>}`` (or ``{"type": "error", "message": ...}``).
    """

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    original_events = list(run.audit_events)  # type: ignore[attr-defined]

    def on_append(event: Any) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ("event", event))

    run.audit_events = NotifyingList(original_events, on_append)  # type: ignore[attr-defined]

    result: dict[str, Any] = {}

    def worker() -> None:
        try:
            result["run"] = action()
        except Exception as exc:  # noqa: BLE001 — surface as a stream error frame
            result["error"] = exc
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, ("end", None))

    worker_future = loop.run_in_executor(None, worker)

    try:
        while True:
            kind, payload = await queue.get()
            if kind == "end":
                break
            yield {"type": "event", "event": payload}
        await worker_future
    finally:
        # Drop the observer so later operations on this run don't touch this
        # request's (finished) event loop.
        final_run = result.get("run")
        target = final_run if final_run is not None else run
        target.audit_events = list(target.audit_events)  # type: ignore[attr-defined]

    if "error" in result:
        yield {"type": "error", "message": str(result["error"])}
    else:
        yield {"type": "done", "run": result["run"]}
