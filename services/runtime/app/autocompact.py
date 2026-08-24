"""LLM-summary autocompact wiring — the model call + per-run tracking state.

The lossy summary layer's I/O half, on top of the pure orchestration in
``context_compaction.autocompact_messages``. It owns the two things that pure
function deliberately does not:

* the ``summarize`` callable — a single no-tools completion on the CURRENT main
  model (no new model tier), bounded to a short output budget; and
* the per-run ``AutoCompactTrackingState`` that threads the circuit breaker /
  recompaction flag across a run's successive model calls.

Wiring sites: the shared model chokepoints ``engine/streaming_model.py``
(streaming, async) and ``harness_runtime.call_model`` (single-shot, sync), right
AFTER the cheap ``compact_messages`` layer — mirroring how the cheap layer is
already wired. The tracker lives in a small bounded, lock-guarded per-run cache
keyed by ``run_id`` so the shared ``stream_model`` signature (mirrored by many
test fakes) is untouched.

Recursion guard (reference: skip autocompact for ``session_memory`` / ``compact``
query sources): the summary call goes straight through the provider
(``OpenAICompatibleModelProvider.create_response``), NOT through ``stream_model``
/ ``call_model``, so it can never re-enter this layer — the guard is structural.
ADR-002: the returned summary is inserted verbatim as DATA, never parsed for
instructions.
"""
from __future__ import annotations

import asyncio
import threading
from collections import OrderedDict
from dataclasses import replace

import httpx

from services.reimbursement.app.audit import AuditEvent, AuditService
from services.runtime.app.concurrency import shared_model_call_bucket
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.context_compaction import (
    CONVERSATION_SUMMARY_PROMPT,
    FRESH_AUTOCOMPACT_TRACKING,
    AutoCompactTrackingState,
    autocompact_messages,
    estimate_tokens,
    get_auto_compact_threshold,
    get_context_window_for_model,
)
from services.runtime.app.model_provider import (
    ModelProviderError,
    ModelRequest,
    OpenAICompatibleModelProvider,
)

# Stateless shared audit appender (mirrors streaming_model's ``_audit``).
_audit = AuditService()

# Keep the aux summary call cheap and bounded (the reference reserves a large
# ceiling; Anna's summary is short by instruction, so a small budget is plenty).
_SUMMARY_MAX_TOKENS = 768
# Fewer retries than a main call — a doomed summary should fall back fast to the
# cheap layer rather than block a turn behind the full backoff schedule.
_SUMMARY_MAX_ATTEMPTS = 2

# Bounded, lock-guarded per-run tracker cache. Keyed by run_id; entries are tiny
# (three ints + a str). Non-streaming surfaces (crew / associate) drive the model
# from worker threads, so the lock is required. Only OVER-threshold calls ever
# populate it (see the fast-path guards below), so normal traffic never touches
# it.
_TRACKER_CAP = 4096
_trackers: "OrderedDict[str, AutoCompactTrackingState]" = OrderedDict()
_trackers_lock = threading.Lock()


def reset_autocompact_trackers() -> None:
    """Clear the whole tracker cache (test isolation hook)."""
    with _trackers_lock:
        _trackers.clear()


def clear_autocompact_tracker(run_id: str) -> None:
    """Drop one run's tracker — called when a run is resumed so a continuation
    starts with a fresh circuit breaker (a new budget, not the spent one)."""
    with _trackers_lock:
        _trackers.pop(run_id, None)


def _get_tracker(run_id: str) -> AutoCompactTrackingState:
    with _trackers_lock:
        return _trackers.get(run_id, FRESH_AUTOCOMPACT_TRACKING)


def _put_tracker(run_id: str, state: AutoCompactTrackingState) -> None:
    with _trackers_lock:
        _trackers[run_id] = state
        _trackers.move_to_end(run_id)
        while len(_trackers) > _TRACKER_CAP:
            _trackers.popitem(last=False)


def _enabled(settings: RuntimeSettings) -> bool:
    # The cheap master switch gates the whole family; autocompact has its own
    # (default ON) switch on top (config ``context.autocompact_enabled`` / env).
    return settings.context_compaction_enabled and settings.context_autocompact_enabled


def _build_summarize(settings: RuntimeSettings, transport: httpx.AsyncBaseTransport | None):
    """A sync summarize: ONE no-tools single-shot on the CURRENT main model."""
    summary_settings = replace(
        settings,
        model_reasoning_effort=None,  # a summary needs no deep-thinking budget
        model_max_tokens=_SUMMARY_MAX_TOKENS,
    )
    provider = OpenAICompatibleModelProvider(
        summary_settings, transport=transport, max_attempts=_SUMMARY_MAX_ATTEMPTS
    )

    def summarize(segment_text: str) -> str | None:
        request = ModelRequest(
            messages=[
                {"role": "system", "content": CONVERSATION_SUMMARY_PROMPT},
                {"role": "user", "content": segment_text},
            ],
            tools=[],
        )
        # Model-call rate gate (L5, P4): the summary single-shot is a REAL
        # provider call on a separate provider instance, so it must take the
        # same process-wide bucket as the main chokepoints — autocompact cannot
        # become a side door around the rate gate. Sync-blocking is safe: this
        # closure runs off the event loop (worker thread / sync caller).
        shared_model_call_bucket(settings).acquire()
        try:
            response = asyncio.run(provider.create_response(request))
        except ModelProviderError:
            return None
        return (response.assistant_message or "").strip() or None

    return summarize


def apply_autocompact_sync(
    run_id: str,
    audit_events: list[AuditEvent],
    request: ModelRequest,
    *,
    settings: RuntimeSettings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ModelRequest:
    """SYNC autocompact step (``call_model``, and the ``to_thread`` body).

    Returns the SAME ``request`` object on a no-op (so callers can detect "did it
    change?" by identity and keep their token-count fast paths byte-identical);
    a new ``ModelRequest`` with the rebuilt messages when a summary was applied,
    plus a ``context.autocompact.applied`` audit event.

    Safe to call off any event loop: the summary call uses ``asyncio.run``, so
    the async wiring routes through ``asyncio.to_thread`` (a worker thread has no
    running loop).
    """
    if not _enabled(settings):
        return request
    window = get_context_window_for_model(settings.model_name, settings.model_context_window)
    threshold = get_auto_compact_threshold(window)
    if estimate_tokens(request.messages) < threshold:
        return request  # under threshold — no cache touch, no model call

    state = _get_tracker(run_id)
    messages, info, new_state = autocompact_messages(
        request.messages,
        summarize=_build_summarize(settings, transport),
        state=state,
        window=window,
        threshold_tokens=threshold,
    )
    _put_tracker(run_id, new_state)
    if info is None:
        return request
    _audit.append(
        audit_events,
        "context.autocompact.applied",
        run_id,
        {
            "before_tokens": info.before_tokens,
            "after_tokens": info.after_tokens,
            "model": settings.model_name,
        },
    )
    return ModelRequest(messages=messages, tools=request.tools)


async def apply_autocompact_async(
    run_id: str,
    audit_events: list[AuditEvent],
    request: ModelRequest,
    *,
    settings: RuntimeSettings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ModelRequest:
    """ASYNC autocompact step (``engine/streaming_model.py``).

    Fast-paths the common under-threshold case with a cheap sync estimate (no
    thread), and only offloads the (blocking) summary model call to a worker
    thread when a summary is actually warranted — so the shared uvicorn event
    loop is never blocked on a model call, and normal traffic spawns no thread.
    """
    if not _enabled(settings):
        return request
    window = get_context_window_for_model(settings.model_name, settings.model_context_window)
    threshold = get_auto_compact_threshold(window)
    if estimate_tokens(request.messages) < threshold:
        return request
    return await asyncio.to_thread(
        apply_autocompact_sync,
        run_id,
        audit_events,
        request,
        settings=settings,
        transport=transport,
    )
