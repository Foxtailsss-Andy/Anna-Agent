"""Shared contracts for the Anna engine layer.

Every engine piece that produces or consumes streamed model output imports from
here rather than from each other, preventing circular imports between the
streaming model call (T3, producer) and the agent loop (T5, consumer).

Five contracts are defined:

- ``ModelChunk`` — one streamed unit yielded by the model call.
- ``LoopOutcome`` — the structured terminal result of one engine run.
- ``CapabilityError`` — raised by a handler when a tool step fails.
- ``CapabilitySuspend`` — raised by a handler to pause the run for external
  input (e.g. human approval); a non-error signal, distinct from
  ``CapabilityError``.
- ``CapabilityHandler`` — the sole interface a business domain implements to
  plug into the engine.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from services.runtime.app.model_provider import ModelRequest, ModelToolCall

# Default (and canonical engine-level) suspend reason. Domains may raise
# ``CapabilitySuspend`` with their own reasons (e.g. reimbursement's
# ``missing_fields``); consumers should compare against constants, not
# re-typed string literals.
SUSPEND_REASON_AWAITING_APPROVAL = "awaiting_approval"
SUSPEND_REASON_AWAITING_INPUT = "awaiting_input"


@dataclass(frozen=True)
class ModelChunk:
    """One streamed unit produced by the model call (T3).

    The streaming model call yields a sequence of ``text_delta`` chunks as
    assistant text arrives, then exactly one terminal chunk — either ``final``
    (normal stop, possibly with tool calls) or ``error`` (unrecoverable
    failure).  Consumers must handle all three kinds.

    Kinds
    -----
    ``"text_delta"``
        Partial assistant text.  ``text`` is populated; all other fields hold
        their defaults.
    ``"final"``
        Model stopped.  ``tool_calls`` holds any requested tool calls (may be
        empty); ``finish_reason`` holds the provider finish reason.  A
        ``final`` chunk intentionally does NOT echo the full assistant text —
        the streamed ``text_delta`` chunks are the source of truth for the
        assistant's text (the loop accumulates them); ``final`` carries only
        ``tool_calls`` and ``finish_reason``.
    ``"error"``
        Unrecoverable failure.  ``error_code`` and ``message`` are populated.
    """

    kind: str
    text: str = ""
    tool_calls: tuple[ModelToolCall, ...] = ()
    finish_reason: str | None = None
    error_code: str | None = None
    message: str | None = None
    # Provider-reported token usage on the terminal ``final`` chunk (W1.T5).
    # Both None unless the provider reported usage — never estimated. Carried so
    # the governed fake can mirror the real producer's conditional
    # ``model.call.completed`` usage keys (anti-drift parity).
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class LoopOutcome:
    """Structured terminal result of one engine run.

    The agent loop (T5) is an async generator that yields live process-event
    dicts (``{"type": "text_delta", ...}``, etc.) for callers that want
    streaming progress.  Rather than mixing the terminal result into that
    stream, T5 writes it into a small mutable holder (Andy's pattern) so the
    caller can read a clean, typed terminal value after the generator drains —
    without parsing the event stream.

    Statuses
    --------
    ``"completed"``
        Model produced a final answer without tool calls.
    ``"exhausted"``
        Loop hit ``QueryConfig.max_turns`` without a final answer.
    ``"failed"``
        Unrecoverable error (model failure or ``CapabilityError``).
        ``error_code`` and ``message`` are populated.
    ``"suspended"``
        A handler raised ``CapabilitySuspend`` to pause for external input
        (e.g. human approval). ``message`` holds the suspend ``reason``; the
        run is healthy and resumable out-of-band, not failed.
    ``"exhausted_suspended"``
        The loop hit ``max_turns`` while ``QueryConfig.suspend_on_exhaust`` was
        set (L4a). Unlike ``exhausted`` (a failure), this is a healthy, RESUMABLE
        rest: ``messages`` carries the full conversation so the caller can persist
        it and resume with a fresh budget. Opt-in — default runs never see it.

    ``messages`` is populated for ``exhausted_suspended`` (the snapshot to resume
    from), and — when ``QueryConfig.carry_messages_on_complete`` is set (J2
    opt-in) — for ``completed`` too (so a finished conversation can be RESUMED for
    an Evaluator补办 round). Every other case leaves it ``None`` — and a
    ``completed`` outcome without the opt-in stays byte-identical.
    """

    status: str
    final_message: str | None = None
    turns: int = 0
    error_code: str | None = None
    message: str | None = None
    messages: list[dict] | None = None


@dataclass(frozen=True)
class StepEvent:
    """One AUTHORITATIVE process-step marker produced by the agent loop (W1.T2).

    The loop knows exactly what it is about to do next; a surface should not have
    to GUESS "what is the agent doing now" from other frame types (a ``text_delta``
    could be thinking OR the answer; a ``tool_start`` says which tool but not why).
    ``StepEvent`` makes the engine the authority: it is emitted BEFORE each model
    call (``phase="analyze"``), BEFORE each tool dispatch (``phase="tool"``, with
    the ``tool`` name), and BEFORE the final answer (``phase="deliver"``). A
    ``phase="compact"`` label exists for context-compaction surfaces, though the
    loop itself does not emit it today.

    ``intent`` is a human-facing label (Chinese, per Anna's product surface) that
    is ALWAYS code-generated — from a handler's ``humanize_step`` hook or the
    ``default_humanize_step`` fallback — never model prose (ADR-002: every string
    the user reads as a status has passed a code gate).

    It rides the SAME event channel as ``tool_start`` / ``tool_done`` — the loop
    yields ``StepEvent(...).as_frame()``, a plain ``{"type": "step", ...}`` dict —
    so every existing consumer (``event.get("type")``) keeps working unchanged.
    """

    phase: str
    intent: str
    tool: str | None
    turn: int

    def as_frame(self) -> dict:
        """Serialize to the wire frame dict yielded on the engine event stream."""
        return {
            "type": "step",
            "phase": self.phase,
            "intent": self.intent,
            "tool": self.tool,
            "turn": self.turn,
        }


# The protocol-level default step labels — the fallback a handler's
# ``humanize_step`` may delegate to (and what ``default_humanize_step`` returns).
# Phase labels are the "正在…" now-doing phrasing; the tool phase maps to a
# generic call label since the engine layer has no domain tool vocabulary.
_DEFAULT_STEP_PHASE_LABELS = {
    "analyze": "正在思考",
    "deliver": "正在组织回答",
    "compact": "正在压缩上下文",
    "tool": "正在调用工具",
}


def default_humanize_step(phase: str, tool_call: ModelToolCall | None = None) -> str:
    """Protocol-level fallback label for a ``StepEvent`` ``intent``.

    Returns a sensible Chinese label when a ``CapabilityHandler`` does not
    override ``humanize_step`` (or delegates the phases/tools it does not
    specialize). For ``phase="tool"`` it names the tool generically
    (``正在调用 <tool>``); for the other phases it returns a fixed label. Purely
    code-generated — no model prose ever reaches it (ADR-002).
    """
    if phase == "tool":
        if tool_call is not None:
            return f"正在调用 {tool_call.name}"
        return _DEFAULT_STEP_PHASE_LABELS["tool"]
    return _DEFAULT_STEP_PHASE_LABELS.get(phase, "正在处理")


class CapabilityError(Exception):
    """Raised by ``CapabilityHandler.dispatch_tool`` when a tool step fails.

    Mirrors the shape of ``ModelProviderError`` — both carry ``error_code``
    and ``message`` attributes — so the agent loop can handle both with the
    same error classification logic.

    Raised on: governance denial, MCP call failure, unexpected tool result
    shape, or any domain-level error that should terminate the current run.
    """

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message


class CapabilitySuspend(Exception):
    """Raised by ``CapabilityHandler.dispatch_tool`` to PAUSE a run — not fail it.

    A *non-error* control signal, deliberately NOT a subclass of
    ``CapabilityError``: a suspend means the run is healthy but cannot proceed
    without external input (e.g. human approval of a reimbursement submit),
    whereas a ``CapabilityError`` means the tool step failed. The agent loop
    catches it around ``dispatch_tool``, records a ``LoopOutcome`` with
    ``status="suspended"``, yields an ``awaiting_approval`` terminal event and
    stops — leaving the run resumable out-of-band.

    Carries a machine-readable ``reason`` (default
    ``SUSPEND_REASON_AWAITING_APPROVAL``) and an optional ``detail`` dict
    (e.g. ``{"approval_id": ...}``) forwarded on the terminal event.
    """

    def __init__(
        self,
        reason: str = SUSPEND_REASON_AWAITING_APPROVAL,
        detail: dict | None = None,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


@runtime_checkable
class CapabilityHandler(Protocol):
    """The sole interface a business domain implements to plug into the engine.

    The engine is model-agnostic and business-agnostic.  All domain knowledge
    lives in a concrete ``CapabilityHandler`` — system prompts, tool
    definitions, MCP routing, governance checks, result folding.  The engine
    loop calls these three methods and nothing else.

    ``CapabilityHandler`` is decorated with ``@runtime_checkable``, so
    ``isinstance(obj, CapabilityHandler)`` works for any class that implements
    the three methods, without subclassing.

    Optional hook (not a protocol member, so three-method handlers still pass
    ``isinstance`` checks):

    ``on_tool_batch(tool_calls: list[ModelToolCall]) -> None``
        When defined, the agent loop calls it once per tool round with the
        WHOLE batch of requested tool calls, BEFORE dispatching any of them —
        the only place a handler can enforce batch-level rules (e.g.
        reimbursement rejects ``submit_intent`` mixed with other calls in the
        same assistant message). A raise is treated exactly like a raise from
        ``dispatch_tool``: ``CapabilityError`` fails the run,
        ``CapabilitySuspend`` pauses it; no ``tool_start`` event is emitted and
        no tool of the batch is dispatched.

    ``humanize_step(phase: str, tool_call: ModelToolCall | None) -> str``
        When defined, it OPTS the handler in to authoritative ``StepEvent``
        frames (W1.T2): the agent loop emits a ``{"type": "step", ...}`` frame
        before each model call (``analyze``), each tool dispatch (``tool``), and
        the final answer (``deliver``), stamping the ``intent`` this hook
        returns. Handlers WITHOUT the hook produce NO step frames — so the
        engine's other surfaces (whose orchestrators forward every non-swallowed
        event) are entirely unaffected. Delegate to ``default_humanize_step`` for
        phases/tools you do not specialize.
    """

    def build_initial_request(self) -> ModelRequest:
        """Return the initial ``ModelRequest`` for this run.

        Called once at loop entry.  Must return a ``ModelRequest`` with at
        least one message (the user turn) and the full tool list for this
        capability.
        """
        ...

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        """Execute one tool call and return the OpenAI-dict observation message.

        Applies governance checks, routes to MCP or local tool, folds the
        domain result into an OpenAI-style ``{"role": "tool", ...}`` dict and
        returns it.  Raises ``CapabilityError`` on any unrecoverable failure
        (governance denial, MCP error, …).
        """
        ...

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        """Called when the model stops issuing tool calls.

        Receives the last assistant text (may be ``None``).  Domain wrap-up
        goes here: persisting state, emitting audit events, etc.

        Return value drives what the loop does next:

        - ``None`` — end the run (the prior, default behavior). The loop yields
          its ``done`` terminal and stops.
        - a non-``None`` string — a **continuation nudge**: the loop appends
          the assistant message plus a ``{"role": "user", "content": <nudge>}``
          message and runs another turn (bounded by ``QueryConfig.max_turns``;
          a nudge blocked by ``max_turns`` yields ``exhausted``).
        """
        ...
