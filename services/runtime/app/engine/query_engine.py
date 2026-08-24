"""Thin platform-engine entry point for the Anna engine (T6).

``QueryEngine`` is the top-level assembly that snapshots ``RuntimeSettings`` and
injectable ``QueryDeps`` once at construction, then forwards ``AgentLoop``'s live
event stream to the caller — an SSE route, a test, or any programmatic driver.

The event stream carries:

* ``{"type": "text_delta", "text": ...}`` — one streamed assistant token
* ``{"type": "tool_start", "name": ...}`` — tool dispatch beginning
* ``{"type": "tool_done",  "name": ...}`` — tool dispatch complete
* ``{"type": "done",       "turns": N}`` — normal completion
* ``{"type": "exhausted",  "turns": N}`` — ``max_turns`` hit without final answer
* ``{"type": "error",      "error_code": ..., "message": ...}`` — failure
* ``{"type": "awaiting_approval", "reason": ..., "detail": ...}`` — a handler
  raised ``CapabilitySuspend``; the run is paused, resumable out-of-band

Caller ownership of ``Outcome``
--------------------------------
The optional ``outcome`` holder lets a programmatic caller read the structured
terminal ``LoopOutcome`` after draining the event stream, without parsing events.
An SSE route can ignore it entirely.  When ``outcome`` is not passed, an internal
holder is created per ``run`` call — there is no shared mutable default argument.

Default dependencies
---------------------
``production_deps()`` is the default: the real ``stream_model`` with full
governance (compaction + audit).  Tests inject a ``QueryDeps`` with a fake
stream model directly.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import AgentLoop, Outcome
from services.runtime.app.engine.capability import CapabilityHandler, LoopOutcome
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps, production_deps
from services.runtime.app.harness_runtime import run_async
from services.runtime.app.model_provider import ModelRequest, ModelToolCall

# The engine's RUN-LESS terminal event types. ``AgentLoop.run`` ends its
# stream with exactly one terminal event; these three deliver their result
# through the caller-owned ``Outcome`` holder rather than on the event
# payload itself. Domain SSE surfaces that emit their own terminal
# ``{"type": "done", "run": <run>}`` frame therefore swallow exactly this set
# and re-emit the outcome mapped onto the run (see the finance /
# reimbursement / hiker ``stream_*_advance`` generators).
#
# ``awaiting_approval`` is deliberately EXCLUDED: it is the one engine
# terminal a domain surface may need to forward to the client verbatim (the
# reimbursement approval suspend, wiring spec §5). It lives here — next to
# the event vocabulary documented on this module — so the set can never
# drift from the terminals ``AgentLoop.run`` actually emits.
SWALLOWED_ENGINE_TERMINALS = frozenset({"done", "exhausted", "error"})

# Default config-error message for the single-call primitive, matching
# ``stream_model``'s own default. Structured-output domains pass their own
# domain-specific message (Create passes its "before running Anna Create" text);
# this default only applies when a caller omits it.
_SINGLE_CALL_CONFIG_ERROR_MESSAGE = (
    "model endpoint and API key are required before running Anna agent"
)


@dataclass(frozen=True)
class SingleCallResult:
    """Result of ONE governed model call for a structured-output domain.

    The terminal value of ``QueryEngine.run_single_call``. Shaped to mirror the
    OLD ``harness_runtime.HarnessModelCallResult`` so structured-output
    orchestrators (Create) migrate with a minimal edit: the old code branched on
    ``result.response is None`` → fail; the new code branches on
    ``result.error_code is not None`` → fail, then reads ``result.tool_calls``
    exactly where it read ``response.tool_calls``.

    ``error_code is None`` marks success. On success ``assistant_text`` holds any
    streamed assistant text (``None`` when the model streamed no text — e.g. a
    pure tool-call turn) and ``tool_calls`` holds the assembled calls (empty when
    the model called no tools). On failure ``error_code`` / ``message`` are
    populated (from the terminal ``error`` chunk) and ``tool_calls`` is empty.
    """

    assistant_text: str | None = None
    tool_calls: list[ModelToolCall] = field(default_factory=list)
    error_code: str | None = None
    message: str | None = None


class QueryEngine:
    """Thin platform-engine entry point.

    Snapshots ``settings`` and injectable ``deps`` once at construction time,
    then forwards ``AgentLoop``'s live event stream on each ``run`` call.

    Parameters
    ----------
    settings:
        Frozen ``RuntimeSettings`` snapshot (model endpoint, API key, flags).
        Threaded explicitly into each ``AgentLoop.run`` call rather than read
        off ``QueryConfig`` so the engine remains model-agnostic and testable
        without a live endpoint.
    deps:
        Injectable I/O dependencies (primarily ``stream_model``).  Defaults to
        ``production_deps()`` which wires the real governed streaming model.
        Tests pass a ``QueryDeps`` with a ``FakeStreamModel`` instead.
    """

    def __init__(
        self,
        settings: RuntimeSettings,
        deps: QueryDeps | None = None,
    ) -> None:
        self.settings = settings
        self.deps = deps or production_deps()

    async def run(
        self,
        config: QueryConfig,
        handler: CapabilityHandler,
        run_id: str,
        audit_events: list,
        outcome: Outcome | None = None,
    ) -> AsyncIterator[dict]:
        """Forward the ``AgentLoop`` event stream to the caller.

        Each call creates a fresh ``AgentLoop`` instance and drains its async
        generator, re-yielding every event dict without modification.  The
        ``outcome`` holder is populated before each terminal event so a
        programmatic caller can read the structured ``LoopOutcome`` after the
        stream drains.

        Parameters
        ----------
        config:
            Per-run configuration snapshot (run_id, skill_id, tools, max_turns).
        handler:
            Domain-level ``CapabilityHandler`` — system prompt, tools, MCP routing.
        run_id:
            Unique run identifier (used for logging and audit).
        audit_events:
            Mutable list for governance audit records appended in-place.
        outcome:
            Optional caller-owned ``Outcome`` holder.  When provided, its
            ``value`` field is set to the terminal ``LoopOutcome`` before the
            stream ends.  Omit when the caller only needs the event stream (e.g.
            an SSE route).  A fresh ``Outcome`` is created per call — there is
            no mutable default argument.
        """
        outcome = outcome if outcome is not None else Outcome()  # NOT a mutable default
        async for event in AgentLoop().run(
            config,
            handler,
            self.deps,
            run_id,
            audit_events,
            self.settings,
            outcome,
        ):
            yield event

    def run_to_outcome(
        self,
        config: QueryConfig,
        handler: CapabilityHandler,
        run_id: str,
        audit_events: list,
    ) -> LoopOutcome:
        """Drive the engine to completion from a NO-RUNNING-LOOP context.

        The shared non-streaming drain hoisted out of the finance / reimbursement
        / hiker orchestrators' (byte-identical) ``_run_engine`` helpers. ``run``
        is an async generator; the non-streaming domain entry points run in
        no-running-loop contexts (the same ones the old sync ``call_model``
        used), so this bridges via ``run_async`` (``asyncio.run``). Live events
        are discarded — the streaming SSE routes drive ``run`` directly with
        ``async for`` to surface them. Audit events still flow into
        ``audit_events`` in place, exactly as before.

        Refuses to run inside a running event loop (``run_async`` raises): an
        async caller must drive ``run`` with ``async for`` instead of bridging.
        """
        outcome = Outcome()

        async def _drain() -> Outcome:
            async for _event in self.run(config, handler, run_id, audit_events, outcome):
                pass
            return outcome

        coro = _drain()
        try:
            run_async(coro)
        except BaseException:
            # ``run_async`` raises RuntimeError BEFORE awaiting when called inside
            # a running loop; close the never-started coroutine so it does not
            # surface a ``coroutine '_drain' was never awaited`` RuntimeWarning.
            coro.close()
            raise
        assert outcome.value is not None  # a fully-drained stream always sets it
        return outcome.value

    def run_single_call(
        self,
        request: ModelRequest,
        run_id: str,
        audit_events: list,
        config_error_message: str = _SINGLE_CALL_CONFIG_ERROR_MESSAGE,
    ) -> SingleCallResult:
        """Drive ONE governed model call — the SINGLE-CALL engine primitive.

        For STRUCTURED-OUTPUT / non-ReAct domains (Anna Create): the model makes
        exactly one call and emits exactly one terminal structured-output tool
        (``create.emit_*_draft``) that IS the terminal; the orchestrator then
        does deterministic post-processing. There is no loop, no tool
        observation fed back, no second round.

        Contrast with ``run_to_outcome``, which drives the ReAct ``AgentLoop``
        (model → tools → observations → model, until the model stops calling
        tools). A single-emit domain must NOT go through the loop: with
        ``max_turns=1`` the loop dispatches the emit tool, then evaluates
        ``next_turn(2) > max_turns(1)`` and yields ``exhausted`` — which would
        wrongly FAIL a successful draft. This primitive drains ``stream_model``
        ONCE and hands the raw terminal (text + tool_calls, or error) back to the
        orchestrator, which owns all downstream semantics.

        Drains ``self.deps.stream_model`` once via the same ``run_async``
        sync-drain bridge ``run_to_outcome`` uses: accumulate ``text_delta``
        text, capture ``final`` tool calls, capture an ``error`` chunk's
        ``error_code`` / ``message``. Audit events flow into ``audit_events`` in
        place (``model.call.started`` / ``model.call.completed`` on success,
        ``model.call.failed`` on error), exactly as the streaming path does.

        Refuses to run inside a running event loop (``run_async`` raises): an
        async caller must drive ``stream_model`` with ``async for`` instead of
        bridging. The never-started coroutine is closed on refusal so no
        ``coroutine '_drain' was never awaited`` RuntimeWarning surfaces (mirrors
        the ``run_to_outcome`` T4c fix).
        """
        result: dict = {
            "assistant_text": None,
            "tool_calls": [],
            "error_code": None,
            "message": None,
        }

        async def _drain() -> None:
            assistant_text = ""
            async for chunk in self.deps.stream_model(
                run_id,
                audit_events,
                request,
                settings=self.settings,
                config_error_message=config_error_message,
            ):
                if chunk.kind == "text_delta":
                    assistant_text += chunk.text
                elif chunk.kind == "final":
                    result["tool_calls"] = list(chunk.tool_calls)
                elif chunk.kind == "error":
                    result["error_code"] = chunk.error_code
                    result["message"] = chunk.message
            result["assistant_text"] = assistant_text or None

        coro = _drain()
        try:
            run_async(coro)
        except BaseException:
            # Mirror ``run_to_outcome``: ``run_async`` raises BEFORE awaiting when
            # called inside a running loop; close the never-started coroutine so
            # it does not surface a ``never awaited`` RuntimeWarning.
            coro.close()
            raise
        # A failed call leaves any partial tool_calls empty (stream_model yields
        # the error chunk as its terminal, never a final), mirroring the OLD
        # HarnessModelCallResult(error_code=...) which carried no response.
        if result["error_code"] is not None:
            # Defensive: the ModelChunk contract emits exactly one terminal (final
            # XOR error), so on an error chunk tool_calls is already empty here.
            result["tool_calls"] = []
        return SingleCallResult(
            assistant_text=result["assistant_text"],
            tool_calls=result["tool_calls"],
            error_code=result["error_code"],
            message=result["message"],
        )
