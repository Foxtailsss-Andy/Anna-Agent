"""Per-run configuration snapshot for the Anna engine.

Mirrors the ``QueryConfig`` from the forge-harness reference design. An instance
is constructed once at engine entry from the caller's request and never
reassigned for the lifetime of the run.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class QueryConfig:
    """Immutable configuration snapshot fixed at engine entry.

    Snapshotted once when a run begins and never reassigned. All engine
    functions that need per-run settings receive this as a plain value, making
    the data-flow explicit and the loop trivially testable without mocking
    any mutable state.

    Fields
    ------
    run_id:
        Unique identifier for this run (used for logging and audit).
    skill_id:
        Identifies which Capability/skill is driving the run.
    tools:
        OpenAI-style tool definitions passed to the model on every turn.
    max_turns:
        Safety valve — the loop hard-stops after this many turns even if the
        model keeps requesting tools. Normal completion is the model producing
        a final answer without a tool call. ``max_turns == 0`` means
        UNLIMITED turns: the loop guards with
        ``if config.max_turns and next_turn > config.max_turns``, so a falsy
        ``0`` disables the cap entirely.
    config_error_message:
        Human-readable error surfaced when model endpoint / API key are absent.
    suspend_on_exhaust:
        Opt-in (L4a, P1 上下文治理). When True, hitting ``max_turns`` yields a
        RESUMABLE suspension (``LoopOutcome.status == "exhausted_suspended"``,
        carrying the current messages) instead of the terminal ``exhausted``
        failure — the caller persists the messages and resumes later with a fresh
        budget. Default False keeps every other surface byte-identical (an
        ``exhausted`` run still fails).
    carry_messages_on_complete:
        Opt-in (J2, 判断力轮 Evaluator). When True, a NORMAL ``completed``
        ``LoopOutcome`` carries the final messages list (exactly like the
        ``exhausted_suspended`` path already does) so the caller can RESUME the
        finished conversation — the Evaluator continuation reuses the L4a resume
        machinery to fold in a补办 nudge without re-assembling the turn. Default
        False leaves ``completed.messages`` ``None`` — byte-identical for every
        surface that does not opt in (only Anna Chat sets it True).
    carry_messages_on_suspend:
        Opt-in for durable adapters that need to resume after a healthy
        ``CapabilitySuspend``. When True, a ``suspended`` outcome carries the
        current messages plus the assistant tool-call message and any completed
        tool observations from that batch. Default False preserves legacy
        reimbursement/chat behavior.
    """

    run_id: str
    skill_id: str
    tools: list[dict]
    max_turns: int = 8
    config_error_message: str = (
        "model endpoint and API key are required before running Anna agent"
    )
    suspend_on_exhaust: bool = False
    carry_messages_on_complete: bool = False
    carry_messages_on_suspend: bool = False
