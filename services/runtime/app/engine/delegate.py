"""One-shot, isolated, read-only worker-loop runner (B2 · W7.T1 long-run adapter).

``run_subagent`` is the engine-layer delegate primitive: it drives a FRESH
``QueryEngine`` + ``CapabilityHandler`` to a single terminal outcome, completely
isolated from any parent conversation, then maps the engine's terminal
``LoopOutcome`` onto a small ``SubagentResult``. It is the compatibility
mechanism behind Crew Worker Profiles doing real work (``agent_worker.py``).

Isolation (WorkBuddy 模式1): the ONLY thing that crosses into the child is the
``prompt``. ``handler_factory(prompt)`` builds a fresh handler whose
``build_initial_request`` bakes the prompt in as the sole user turn; no parent
history, no shared mutable state. Each call constructs its own ``QueryEngine``,
so two worker-loop runs never share a loop.

Read-only (防审批嵌套): v1 FORCES ``permission_mode="readonly"`` — a non-readonly
mode raises before a handler is built or a model call spent. The child is meant
to query/produce, never to write or trigger an approval; the factory is
contractually responsible for building a handler whose toolset carries no write
tools (the Crew v1 factory offers an EMPTY toolset — readonly by construction).

Synchronous, non-nested: the engine's async loop is drained via the same
``run_async`` (``asyncio.run``) bridge the non-streaming domain entry points use,
so ``run_subagent`` MUST be called from a no-running-loop context (a worker
thread or a plain sync test). A worker loop never spawns another worker loop
(single layer).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import Outcome
from services.runtime.app.engine.capability import CapabilityHandler
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps, production_deps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.harness_runtime import run_async

# The code-gate cap on a worker-loop returned summary. A longer final answer is
# truncated and marked so a parent never folds an unbounded blob into its own
# context / a channel row.
SUBAGENT_SUMMARY_MAX_CHARS = 2000
_SUMMARY_TRUNCATION_MARKER = "……[截断]"

_READONLY = "readonly"

_CONFIG_ERROR_MESSAGE = (
    "model endpoint and API key are required before running an Anna Worker Profile"
)

# ``handler_factory(prompt) -> CapabilityHandler`` — the ONLY input the child
# receives is the prompt (isolation). Kept as a plain callable alias so callers
# read the contract at a glance.
HandlerFactory = Callable[[str], CapabilityHandler]


@dataclass(frozen=True)
class SubagentResult:
    """The terminal result of one isolated worker-loop run.

    ``status`` maps the engine's ``LoopOutcome``: ``completed`` (a final answer),
    ``exhausted`` (hit ``max_turns`` without finishing), or ``failed`` (a model
    error OR an unexpected handler/engine exception). ``summary`` is the child's
    final text (``≤ SUBAGENT_SUMMARY_MAX_CHARS`` — truncated + marked past that;
    on a failure it carries the error message). ``audit_events`` are the engine's
    live process frames (``text_delta`` / ``tool_start`` / ``step`` / terminal)
    captured for the PARENT's trace display — never folded into any model context.
    ``error_code`` is the classified failure code when ``status == "failed"``
    (``None`` otherwise) — additive to the W7 contract for honest failure reporting.
    """

    status: Literal["completed", "failed", "exhausted"]
    summary: str
    turns_used: int
    audit_events: list[dict] = field(default_factory=list)
    error_code: str | None = None


def _truncate_summary(text: str) -> str:
    if len(text) <= SUBAGENT_SUMMARY_MAX_CHARS:
        return text
    return text[:SUBAGENT_SUMMARY_MAX_CHARS] + _SUMMARY_TRUNCATION_MARKER


def run_subagent(
    *,
    handler_factory: HandlerFactory,
    prompt: str,
    settings: RuntimeSettings,
    max_turns: int = 8,
    permission_mode: str = "readonly",
    deps: QueryDeps | None = None,
    run_id: str = "subagent",
) -> SubagentResult:
    """Drive one isolated, read-only worker loop to a terminal ``SubagentResult``.

    Parameters
    ----------
    handler_factory:
        ``prompt -> CapabilityHandler`` — builds a FRESH handler with only the
        prompt baked in (isolation). The factory owns the child's read-only
        toolset (v1: empty).
    prompt:
        The sole task/context handed to the child — no parent conversation.
    settings:
        Frozen ``RuntimeSettings`` for the child's own ``QueryEngine``.
    max_turns:
        The child's ReAct budget (default 8, the engine default).
    permission_mode:
        v1 FORCES ``"readonly"``; anything else raises ``ValueError`` before a
        handler is built or a model call spent.
    deps:
        Injectable engine I/O (the fake ``stream_model`` in tests); defaults to
        the real governed streaming model.
    run_id:
        The child run id used for its governance audit (isolated from the parent).

    Raises
    ------
    ValueError:
        When ``permission_mode`` is not ``"readonly"`` (v1 guard). Any other
        failure — model error or an unexpected handler/engine exception — is
        mapped to ``SubagentResult(status="failed")``, never raised.
    """
    if permission_mode != _READONLY:
        raise ValueError(
            "run_subagent v1 only supports permission_mode='readonly' "
            f"(防审批嵌套); got {permission_mode!r}"
        )

    process_frames: list[dict] = []
    # The child's OWN governance audit list (model.call.*) — isolated from the
    # parent; not surfaced on the result (the trace uses process_frames).
    child_audit: list = []
    try:
        handler = handler_factory(prompt)
        engine = QueryEngine(settings, deps or production_deps())
        config = QueryConfig(
            run_id=run_id,
            skill_id="subagent",
            tools=handler.build_initial_request().tools,
            max_turns=max_turns,
            config_error_message=_CONFIG_ERROR_MESSAGE,
        )
        outcome_holder = Outcome()

        async def _drain() -> None:
            async for event in engine.run(
                config, handler, run_id, child_audit, outcome_holder
            ):
                process_frames.append(event)

        run_async(_drain())
        outcome = outcome_holder.value
    except Exception as exc:  # noqa: BLE001 — 异常 → failed (never leak out)
        return SubagentResult(
            status="failed",
            summary=_truncate_summary(str(exc)),
            turns_used=0,
            audit_events=process_frames,
            error_code="subagent_error",
        )

    assert outcome is not None  # a fully-drained engine stream always sets it

    if outcome.status == "completed":
        return SubagentResult(
            status="completed",
            summary=_truncate_summary((outcome.final_message or "").strip()),
            turns_used=outcome.turns,
            audit_events=process_frames,
        )
    if outcome.status == "exhausted":
        return SubagentResult(
            status="exhausted",
            summary="",
            turns_used=outcome.turns,
            audit_events=process_frames,
            error_code="subagent_exhausted",
        )
    # failed / suspended / any other non-terminal-success outcome → failed. A
    # read-only handler never suspends and never opts into resumable exhaustion,
    # so those map here defensively (loud, honest) rather than silently.
    return SubagentResult(
        status="failed",
        summary=_truncate_summary(outcome.message or outcome.error_code or "worker loop failed"),
        turns_used=outcome.turns,
        audit_events=process_frames,
        error_code=outcome.error_code or "subagent_failed",
    )
