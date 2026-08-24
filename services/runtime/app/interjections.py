"""Mid-run interjection queues — the J3 steering seam.

A tiny per-run mailbox letting a user speak to a run that is ALREADY running:
the API layer pushes text in, the engine's per-turn hook drains it out and
splices it into the conversation as a genuine user turn.

Why a module-level registry rather than a field on the handler: the producer
(the HTTP route, via ``BackgroundRunManager``) and the consumer (the
``CapabilityHandler`` the orchestrator builds per run) never see each other —
the handler is constructed deep inside ``stream_existing_run`` and is not
reachable from the route. Keying by ``run_id`` in one bounded, lock-guarded
cache is exactly the shape ``autocompact._trackers`` already uses for the same
reason, so this adds no new pattern to the runtime.

The lock is a ``threading.Lock`` (not an asyncio one) for the same reason
autocompact's is: non-streaming surfaces drive the model from worker threads,
and ``push`` / ``drain`` are O(1) non-blocking critical sections that must be
safe from either world.

Drain semantics are exactly-once: a drained batch is removed from the queue, so
an interjection is injected into the conversation once and never replayed on a
later turn.
"""
from __future__ import annotations

import threading
from collections import OrderedDict

# Bounded per-run queue cache. Entries are short-lived (a run's lifetime) and
# tiny (a handful of strings); the cap is a leak backstop for runs that end
# without a clean drain (e.g. a parked ``awaiting_continue`` run never resumed).
_QUEUE_CAP = 4096
# Per-run bound: steering is a conversation, not a firehose. Beyond this the
# OLDEST pending interjections are dropped so one run's queue cannot grow without
# limit. Be honest about the cost: that drop is SILENT — the route already
# answered ``accepted: True`` for a message that will now never reach the model.
# Acceptable only because 32 unanswered interjections on a single run is a user
# hammering send at a run that is not consuming them, not normal steering.
_PER_RUN_CAP = 32

_queues: "OrderedDict[str, list[str]]" = OrderedDict()
_lock = threading.Lock()


def reset_interjections() -> None:
    """Clear every run's queue (test isolation hook)."""
    with _lock:
        _queues.clear()


def push_interjection(run_id: str, text: str) -> None:
    """Queue one interjection for ``run_id``'s next turn."""
    with _lock:
        queue = _queues.get(run_id)
        if queue is None:
            queue = []
            _queues[run_id] = queue
        queue.append(text)
        del queue[:-_PER_RUN_CAP]
        _queues.move_to_end(run_id)
        while len(_queues) > _QUEUE_CAP:
            _queues.popitem(last=False)


def drain_interjections(run_id: str) -> list[str]:
    """Remove and return everything queued for ``run_id`` (exactly-once).

    Returns ``[]`` — and touches nothing — for the overwhelmingly common case of
    a run nobody is steering, so the per-turn call costs one dict lookup.
    """
    with _lock:
        queue = _queues.pop(run_id, None)
        return list(queue) if queue else []


def pop_interjection(run_id: str) -> str | None:
    """Remove and return only the FIRST queued item for ``run_id`` (or ``None``).

    The single-item sibling of ``drain_interjections``, for the ONE caller that
    can carry exactly one message at a time: the late-arrival guard turns a
    pending interjection into an ``on_assistant_final`` nudge, and a nudge is a
    single string. Popping one — rather than draining and joining the batch —
    keeps the J3 contract 逐条独立: the rest stay queued and the next turn's
    loop-top drain delivers them as their own user messages, never merged into
    one turn with this one.
    """
    with _lock:
        queue = _queues.get(run_id)
        if not queue:
            return None
        text = queue.pop(0)
        if not queue:
            _queues.pop(run_id, None)
        return text


def peek_interjections(run_id: str) -> int:
    """How many interjections are waiting for ``run_id`` (no side effects)."""
    with _lock:
        queue = _queues.get(run_id)
        return len(queue) if queue else 0


def clear_interjections(run_id: str) -> None:
    """Drop one run's queue — called when the run reaches a terminal."""
    with _lock:
        _queues.pop(run_id, None)
