from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, replace


"""Context-window management for the Anna Harness.

Ported from the Forge harness reference (``forge-harness/03-context-compaction.md``).
The thresholds, buffer constants, the ``[1m]`` window opt-in, the warning-state
structure and the circuit-breaker scaffold are kept faithful to that design. Two
things are adapted to fit current Anna:

* Messages are OpenAI-style ``dict`` objects (Anna's wire format), not the
  reference's ``Message`` class.
* The reference resolves the context window from a per-vendor model table
  ("Falcon" family). Anna is model-agnostic, so the window is resolved from
  runtime config (with a ``[1m]`` marker opt-in) instead of any vendor table.

This module ships the *cheap, lossless-first* layers that need no model call:
token accounting, the threshold machinery, and a structure-preserving truncation
of old tool results (``compact_messages``). It ALSO ships the pure orchestration
of the lossy LLM-summary layer (``autocompact_messages``): threshold gate ->
summarize the middle segment (protecting the system head + recent tail) ->
rebuild as a single ``<conversation_summary>`` message, with the reference's
circuit breaker over ``AutoCompactTrackingState``. The model call itself (the
``summarize`` callable) and the per-run tracking state live at the wiring site
(``services/runtime/app/autocompact.py``), keeping this module free of any I/O.
"""


# --- Constants (kept faithful to the reference; values are model-agnostic) ---

# Default context window when the model/window is unknown (tokens).
MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

# Tokens reserved for the model's output during a summary compaction.
# (p99.99 of compact-summary output is ~17k in the reference.)
MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

# Buffers reserved below the window so we act before hitting the hard edge.
AUTOCOMPACT_BUFFER_TOKENS = 13_000
WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
MANUAL_COMPACT_BUFFER_TOKENS = 3_000

# Circuit breaker: stop retrying the LLM-summary layer after this many consecutive
# failures. Reserved for the summary layer added in a later slice; the reference
# saw sessions hammer the API thousands of times without this breaker.
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

# Keep this many of the most recent messages untouched during cheap compaction so
# the live tail of the conversation is never degraded.
PROTECTED_TAIL_MESSAGES = 6

# Rough per-message structural overhead (role/envelope) added to the char estimate.
PER_MESSAGE_OVERHEAD_TOKENS = 4

TRUNCATED_TOOL_RESULT_PLACEHOLDER = "[earlier tool result omitted to fit the context window]"

# --- LLM-summary layer (autocompact) ---------------------------------------

# The single summary message the middle segment collapses into is wrapped in
# these tags. The tag doubles as the recompaction marker: on the next pass the
# prior summary sits in the middle and is re-summarized into ONE summary (never
# stacked). Detected by content prefix, so nothing extra is sent on the wire.
CONVERSATION_SUMMARY_OPEN = "<conversation_summary>"
CONVERSATION_SUMMARY_CLOSE = "</conversation_summary>"

# The summary instruction (ported from the forge reference's key instruction).
# Five fixed sections; MUST end with the anti-redo line so a resumed model never
# re-executes completed work. ADR-002: the produced summary is inserted verbatim
# as DATA by ``autocompact_messages`` — never parsed for instructions.
CONVERSATION_SUMMARY_PROMPT = (
    "你是上下文压缩器。请把下面这段较早的对话历史压缩成结构化摘要，"
    "严格按以下五个小节组织，只保留对继续完成任务有用的信息：\n"
    "1. 原始意图：用户最初要达成的目标。\n"
    "2. 已完成（关键结论与数据）：已经得到的结论、数值、事实。\n"
    "3. 未完成与下一步：还没做完的部分与接下来要做的事。\n"
    "4. 关键实体（单号、id、文件）：出现过的单号、ID、文件名等标识。\n"
    "5. 注意事项：约束、坑、需要保持的口径。\n"
    "只输出摘要本身，不要复述本提示。"
    "以上任务中已完成的部分不要重新执行。"
)

_ONE_MILLION_CONTEXT_PATTERN = re.compile(r"\[1m\]", re.IGNORECASE)


@dataclass(frozen=True)
class TokenWarningState:
    percent_left: int
    is_above_warning_threshold: bool
    is_above_error_threshold: bool
    is_above_auto_compact_threshold: bool
    is_at_blocking_limit: bool


@dataclass(frozen=True)
class AutoCompactTrackingState:
    """Carries cross-turn compaction state for the LLM-summary layer.

    Threaded across a run's model calls by the wiring site (one per run). The
    ``consecutive_failures`` count lets a circuit breaker stop retrying
    summarization once the context is irrecoverably over the limit; ``compacted``
    records that a summary is already in the history (recompaction).
    """

    compacted: bool
    turn_counter: int
    turn_id: str
    consecutive_failures: int | None = None


# A fresh tracker for a run that has never compacted.
FRESH_AUTOCOMPACT_TRACKING = AutoCompactTrackingState(
    compacted=False, turn_counter=0, turn_id="", consecutive_failures=0
)


@dataclass(frozen=True)
class AutoCompactInfo:
    """What the LLM-summary layer did on ONE successful compaction.

    ``model`` is stamped by the wiring site (this pure module is model-agnostic);
    the token counts drive the ``context.autocompact.applied`` audit payload.
    """

    before_tokens: int
    after_tokens: int


@dataclass(frozen=True)
class CompactionResult:
    messages: list[dict]
    compacted: bool
    pre_compact_token_count: int
    post_compact_token_count: int
    tokens_freed: int


def is_context_compaction_enabled(setting_enabled: bool = True) -> bool:
    """Whether cheap compaction runs.

    Mirrors the reference's ``DISABLE_COMPACT`` escape hatch (model-agnostic):
    the runtime setting wins unless the env off-switch is set.
    """
    if _env_truthy("ANNA_DISABLE_CONTEXT_COMPACTION"):
        return False
    return setting_enabled


def get_context_window_for_model(model: str, override: int | None = None) -> int:
    """Resolve the context window in a model-agnostic way.

    Resolution order (config-driven, no per-vendor model table):
      1. an explicit ``override`` (Anna runtime config), if positive;
      2. a ``[1m]`` marker in the model name -> 1,000,000 (the reference's opt-in);
      3. the default window.
    """
    if override and override > 0:
        return override
    if _ONE_MILLION_CONTEXT_PATTERN.search(model or ""):
        return 1_000_000
    return MODEL_CONTEXT_WINDOW_DEFAULT


def get_effective_context_window_size(window: int) -> int:
    """The window minus the output budget reserved for a summary."""
    return window - MAX_OUTPUT_TOKENS_FOR_SUMMARY


def get_auto_compact_threshold(window: int) -> int:
    """Token count at which compaction should fire."""
    return get_effective_context_window_size(window) - AUTOCOMPACT_BUFFER_TOKENS


def calculate_token_warning_state(token_usage: int, window: int) -> TokenWarningState:
    """The reference's warning-state calculation, model-agnostic.

    Drives the auto-compact decision today; the warning/error/blocking flags are
    kept for surfacing a "context N% full" signal to the UI later.
    """
    threshold = get_auto_compact_threshold(window)
    percent_left = (
        max(0, round(((threshold - token_usage) / threshold) * 100)) if threshold > 0 else 0
    )
    effective = get_effective_context_window_size(window)
    return TokenWarningState(
        percent_left=percent_left,
        is_above_warning_threshold=token_usage >= threshold - WARNING_THRESHOLD_BUFFER_TOKENS,
        is_above_error_threshold=token_usage >= threshold - ERROR_THRESHOLD_BUFFER_TOKENS,
        is_above_auto_compact_threshold=token_usage >= threshold,
        is_at_blocking_limit=token_usage >= effective - MANUAL_COMPACT_BUFFER_TOKENS,
    )


def context_usage(
    messages: list[dict],
    *,
    model: str,
    context_window: int | None = None,
    precomputed_token_count: int | None = None,
) -> dict:
    """A small, model-agnostic snapshot of how full the context is.

    Surfaces a "context N% used" signal to the UI. Reuses the same estimator and
    thresholds as compaction, so the number the user sees matches the number that
    triggers compaction.
    """
    window = get_context_window_for_model(model, context_window)
    token_count = (
        precomputed_token_count
        if precomputed_token_count is not None
        else estimate_tokens(messages)
    )
    state = calculate_token_warning_state(token_count, window)
    return {
        "token_count": token_count,
        "context_window": window,
        "percent_left": state.percent_left,
        "is_above_warning_threshold": state.is_above_warning_threshold,
        "is_above_auto_compact_threshold": state.is_above_auto_compact_threshold,
    }


def estimate_tokens(messages: list[dict]) -> int:
    return sum(_estimate_message_tokens(message) for message in messages)


def _estimate_message_tokens(message: dict) -> int:
    # Char-based, model-agnostic estimation: mimo/DeepSeek and other
    # OpenAI-compatible endpoints ship no shared tokenizer, so we approximate.
    # ASCII text is ~4 chars/token; CJK and other non-ASCII runs ~1 token/char
    # (denser), which matters because Anna is bilingual. The threshold buffers
    # absorb the error -- this drives a threshold decision, not billing.
    text = json.dumps(message, ensure_ascii=False, default=str)
    ascii_chars = sum(1 for char in text if ord(char) < 128)
    other_chars = len(text) - ascii_chars
    return ascii_chars // 4 + other_chars + PER_MESSAGE_OVERHEAD_TOKENS


def compact_messages(
    messages: list[dict],
    *,
    model: str,
    context_window: int | None = None,
    enabled: bool = True,
) -> CompactionResult:
    """Run the cheap, structure-preserving compaction layers.

    No-op (``compacted=False``) when disabled or under threshold. When over
    threshold, truncates the *content* of old tool-result messages -- the
    bulkiest, least-essential-to-keep-verbatim content -- oldest first, never
    touching the protected recent tail. The original message ``dict`` objects are
    never mutated (new copies are produced) so the objects handed to the API /
    prompt cache stay stable, per the reference's cache-safety rule.
    """
    pre_tokens = estimate_tokens(messages)
    if not is_context_compaction_enabled(enabled):
        return CompactionResult(list(messages), False, pre_tokens, pre_tokens, 0)

    window = get_context_window_for_model(model, context_window)
    threshold = get_auto_compact_threshold(window)
    if pre_tokens < threshold:
        return CompactionResult(list(messages), False, pre_tokens, pre_tokens, 0)

    work = list(messages)
    protected_start = max(0, len(work) - PROTECTED_TAIL_MESSAGES)
    for index in range(protected_start):
        message = work[index]
        if message.get("role") != "tool":
            continue
        content = message.get("content")
        if not isinstance(content, str) or content == TRUNCATED_TOOL_RESULT_PLACEHOLDER:
            continue
        if len(content) <= len(TRUNCATED_TOOL_RESULT_PLACEHOLDER):
            continue
        work[index] = {**message, "content": TRUNCATED_TOOL_RESULT_PLACEHOLDER}
        if estimate_tokens(work) < threshold:
            break

    post_tokens = estimate_tokens(work)
    return CompactionResult(
        messages=work,
        compacted=post_tokens < pre_tokens,
        pre_compact_token_count=pre_tokens,
        post_compact_token_count=post_tokens,
        tokens_freed=max(0, pre_tokens - post_tokens),
    )


def autocompact_messages(
    messages: list[dict],
    *,
    summarize: Callable[[str], str | None],
    state: AutoCompactTrackingState,
    window: int,
    threshold_tokens: int | None = None,
) -> tuple[list[dict], AutoCompactInfo | None, AutoCompactTrackingState]:
    """Pure orchestration of the LLM-summary layer (mirrors the forge reference).

    Below threshold -> messages unchanged, no info. Above threshold, and the
    circuit breaker is not tripped, the *middle* segment (everything between the
    leading ``system`` head and the protected recent tail) is handed to
    ``summarize`` and — on a non-empty summary — rebuilt as a single
    ``<conversation_summary>`` user message. On a ``None``/empty return OR a raise
    from ``summarize`` the failure is recorded (breaker++), the messages are left
    as-is (the caller's cheap layer already truncated them), and no info is
    returned. After ``MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`` consecutive failures
    the layer permanently no-ops (the reference's doomed-retry breaker). On
    success the tracker resets (``compacted=True``, failures 0).

    Recompaction: a prior summary lives in the middle on the next pass and is
    re-summarized into ONE summary — never stacked (the single-summary invariant).

    The message ``dict`` objects are never mutated (new list, protected messages
    reused by reference), matching the cache-safety rule of ``compact_messages``.
    """
    before_tokens = estimate_tokens(messages)
    threshold = (
        threshold_tokens
        if threshold_tokens is not None
        else get_auto_compact_threshold(window)
    )
    if before_tokens < threshold:
        return list(messages), None, state

    # Circuit breaker: once the context is irrecoverably over the limit, stop
    # spending model calls on doomed summaries (reference: sessions hammered the
    # API thousands of times without this).
    failures = state.consecutive_failures or 0
    if failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES:
        return list(messages), None, state

    head, middle, tail = _split_head_middle_tail(messages)
    if not middle:
        # Nothing summarizable (too few messages between head and tail).
        return list(messages), None, state

    try:
        summary = summarize(_render_segment(middle))
    except Exception:  # noqa: BLE001 — a summarizer failure must never crash a run
        summary = None
    if not summary or not summary.strip():
        return list(messages), None, replace(state, consecutive_failures=failures + 1)

    rebuilt = build_post_compact_messages(head, summary.strip(), tail)
    after_tokens = estimate_tokens(rebuilt)
    reset = AutoCompactTrackingState(
        compacted=True, turn_counter=0, turn_id="", consecutive_failures=0
    )
    return rebuilt, AutoCompactInfo(before_tokens, after_tokens), reset


def build_post_compact_messages(
    head: list[dict], summary: str, tail: list[dict]
) -> list[dict]:
    """Rebuild the message list as ``head + <conversation_summary> + tail``."""
    summary_message = {
        "role": "user",
        "content": f"{CONVERSATION_SUMMARY_OPEN}\n{summary}\n{CONVERSATION_SUMMARY_CLOSE}",
    }
    return [*head, summary_message, *tail]


def is_conversation_summary_message(message: dict) -> bool:
    """Whether ``message`` is a rebuilt ``<conversation_summary>`` user message."""
    content = message.get("content")
    return isinstance(content, str) and content.lstrip().startswith(
        CONVERSATION_SUMMARY_OPEN
    )


def _split_head_middle_tail(
    messages: list[dict],
) -> tuple[list[dict], list[dict], list[dict]]:
    """Protect the leading ``system`` head + the last ``PROTECTED_TAIL_MESSAGES``.

    The middle (everything else, including a prior summary) is what gets
    summarized. When the list is too short the middle is empty and the caller
    no-ops.
    """
    count = len(messages)
    head_end = 0
    while head_end < count and messages[head_end].get("role") == "system":
        head_end += 1
    tail_start = max(head_end, count - PROTECTED_TAIL_MESSAGES)
    return messages[:head_end], messages[head_end:tail_start], messages[tail_start:]


def _render_segment(messages: list[dict]) -> str:
    """Render the middle segment as plain text for the summary model call.

    Assistant tool-call turns (``content is None``) render as a compact tool-name
    note so the summarizer still sees that a tool ran.
    """
    lines: list[str] = []
    for message in messages:
        role = str(message.get("role") or "")
        content = message.get("content")
        if content is None:
            tool_calls = message.get("tool_calls")
            if isinstance(tool_calls, list) and tool_calls:
                names = ", ".join(
                    str((call.get("function") or {}).get("name") or "?")
                    for call in tool_calls
                    if isinstance(call, dict)
                )
                content = f"[调用工具：{names}]"
            else:
                content = ""
        lines.append(f"{role}: {content}")
    return "\n".join(lines)


def _env_truthy(name: str) -> bool:
    value = os.getenv(name)
    return bool(value) and value.strip().lower() in {"1", "true", "yes", "on"}
