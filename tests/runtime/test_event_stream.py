"""Unit tests for ``AuditFrameWatermark`` (R1-T1a skeleton extraction).

The watermark cursor is the shared helper behind the engine-driven streaming
advances (finance / reimbursement / hiker ``stream_*_advance``): it flushes
audit events appended to a run's ``audit_events`` list — IN PLACE — as
``{"type": "event", "event": <AuditEvent>}`` SSE frames, in append order,
each event exactly once.
"""
from __future__ import annotations

from services.reimbursement.app.audit import AuditEvent
from services.runtime.app.event_stream import AuditFrameWatermark


def _event(event_type: str) -> AuditEvent:
    return AuditEvent(type=event_type, run_id="run-1", payload={})


def test_new_frames_flushes_appends_in_order_exactly_once():
    events: list[AuditEvent] = []
    watermark = AuditFrameWatermark(events)

    first = _event("skill.loaded")
    second = _event("model.call.started")
    events.append(first)
    events.append(second)

    frames = watermark.new_frames()
    assert frames == [
        {"type": "event", "event": first},
        {"type": "event", "event": second},
    ]
    # Nothing new appended — the same events are never re-emitted.
    assert watermark.new_frames() == []

    third = _event("model.call.completed")
    events.append(third)
    assert watermark.new_frames() == [{"type": "event", "event": third}]


def test_default_cursor_starts_at_list_start_including_history():
    # Finance semantics: the stream begins with a fresh run, so the cursor
    # starts at index 0 and any event already on the list is emitted.
    seeded = _event("finance.assistant.run.created")
    events = [seeded]

    watermark = AuditFrameWatermark(events)

    assert watermark.new_frames() == [{"type": "event", "event": seeded}]


def test_skip_history_starts_past_existing_events():
    # Reimbursement semantics: the answers stream RESUMES a run that already
    # carries the first advance's trail — history must never re-emit.
    history = _event("reimbursement.run.created")
    events = [history]

    watermark = AuditFrameWatermark(events, skip_history=True)

    assert watermark.new_frames() == []
    fresh = _event("reimbursement.answers.received")
    events.append(fresh)
    assert watermark.new_frames() == [{"type": "event", "event": fresh}]
