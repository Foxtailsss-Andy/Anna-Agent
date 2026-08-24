"""Streaming model call (engine layer, T3).

The single streaming chokepoint for the platform ReAct engine. It merges the two
split halves Anna had before:

* ``engine/streaming.py::stream_chat_text`` — a real SSE reader (``stream:True``)
  that yields assistant text deltas, but tool-free and ungoverned.
* ``harness_runtime.py::AnnaHarnessRuntime.call_model`` — the governed
  (compaction + context_usage + audit) chokepoint, but non-streaming and
  tool-aware.

``stream_model`` streams text deltas token-by-token DURING the loop, accumulates
incremental tool-call fragments (OpenAI streams tool-call arguments as string
fragments across chunks), and reuses the exact same governance as ``call_model``
(byte-identical audit payloads, the shared ``_hash_payload``). It is the producer
half of the ``ModelChunk`` contract defined in ``engine/capability.py``; the agent
loop (T5) consumes it.

Governance mirrors ``call_model``; transport/SSE mirrors ``stream_chat_text``.
Tool-call assembly applies the same validation/mapping rules as
``model_provider._normalize_openai_response``.

Retry (R1-T2): transient transport failures (429/5xx/timeout/transport errors)
retry with the same attempts/backoff as
``OpenAICompatibleModelProvider.create_response`` — but ONLY while no SSE data
has left this producer. Once a ``text_delta`` has been yielded to the consumer
(or a tool-call fragment received), a retry would duplicate already-delivered
output, so from that point failures terminate exactly like the single-shot path.
Retried attempts are audit-silent (one ``model.call.started`` per logical call,
one terminal audit for the final outcome), matching ``create_response``.

Sampling (R1-T3): optional ``settings.model_temperature`` /
``settings.model_max_tokens`` are injected into the request payload and the
``model.call.started`` audit ONLY when set — None means the key is absent and
both payloads stay byte-identical to the pre-T3 wire format. Out-of-range
values fail loudly via ``_validate_sampling_settings`` (ADR-002 code gate);
``RuntimeSettings.from_env`` already coerces bad env/file values to None, so
the gate only fires for directly-constructed settings.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from services.reimbursement.app.audit import AuditEvent, AuditService
from services.runtime.app.config import (
    MODEL_TEMPERATURE_MAX,
    MODEL_TEMPERATURE_MIN,
    RuntimeSettings,
)
from services.runtime.app.autocompact import apply_autocompact_async
from services.runtime.app.concurrency import shared_model_call_bucket
from services.runtime.app.context_compaction import compact_messages, context_usage
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.harness_runtime import _hash_payload
from services.runtime.app.model_provider import (
    OPENAI_FUNCTION_NAME_PATTERN,
    ModelProviderError,
    ModelRequest,
    ModelToolCall,
    _classify_status_error,
    _model_tool_name,
    _normalize_arguments,
    _normalize_usage,
    _openai_message,
    provider_tool_contract,
)

# Module-level audit instance. AuditService.append is stateless (it only appends
# to the caller's list), so a shared instance is safe and mirrors call_model's
# usage; the monotonic-timestamp behaviour lives in AuditEvent's default factory.
_audit = AuditService()

# SSE is long-lived: bound connect/write/pool, but `read` is the max gap
# between streamed chunks (not a total cap), so a healthy long stream is never
# cut off mid-flight. A single total timeout would wrongly kill long streams.
_STREAM_CONNECT_TIMEOUT_SECONDS = 10.0
_STREAM_READ_TIMEOUT_SECONDS = 120.0
_STREAM_TIMEOUT = httpx.Timeout(
    connect=_STREAM_CONNECT_TIMEOUT_SECONDS,
    read=_STREAM_READ_TIMEOUT_SECONDS,
    write=_STREAM_CONNECT_TIMEOUT_SECONDS,
    pool=_STREAM_CONNECT_TIMEOUT_SECONDS,
)

# Retry (provider parity): mirrors OpenAICompatibleModelProvider's defaults —
# max_attempts=3, backoff_base_seconds=0.5, exponential schedule
# base * 2**(attempt-1) (i.e. 0.5s then 1.0s between attempts). Streaming adds
# ONE hard constraint the non-streaming provider doesn't have: a retry is safe
# only BEFORE the first chunk of SSE data reaches the consumer. After any
# text_delta has been yielded (or any tool-call fragment received), retrying
# would replay/duplicate output that already left this producer, so failures
# past that point fail immediately with the exact single-shot behaviour.
_STREAM_MAX_ATTEMPTS = 3
_STREAM_RETRY_BACKOFF_SECONDS = 0.5


async def stream_model(
    run_id: str,
    audit_events: list[AuditEvent],
    request: ModelRequest,
    *,
    settings: RuntimeSettings,
    config_error_message: str = "model endpoint and API key are required before running Anna agent",
    transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncIterator[ModelChunk]:
    """Stream one governed model call, yielding ``ModelChunk`` units.

    Yields zero or more ``text_delta`` chunks as assistant text arrives, then
    exactly one terminal chunk: ``final`` (with any accumulated tool calls) on
    success, or ``error`` on any unrecoverable failure. Audit events are appended
    to ``audit_events`` in place, mirroring ``call_model``.
    """
    # 0. Sampling-config gate (ADR-002: model-adjacent config passes a code
    #    gate). Raises loudly before any audit or transport work; from_env
    #    coerces bad env/file values to None, so this only fires for
    #    directly-constructed nonsense.
    _validate_sampling_settings(settings)

    # 1. Config check FIRST, before any audit (matches call_model: no audit on a
    #    missing-config rejection).
    if not settings.model_api_key or not settings.model_endpoint:
        yield ModelChunk(
            kind="error",
            error_code="model_not_configured",
            message=config_error_message,
        )
        return

    # 2. Compaction — mirror call_model exactly (no-op under threshold).
    compaction = compact_messages(
        request.messages,
        model=settings.model_name,
        context_window=settings.model_context_window,
        enabled=settings.context_compaction_enabled,
    )
    if compaction.compacted:
        request = ModelRequest(messages=compaction.messages, tools=request.tools)
        _audit.append(
            audit_events,
            "context.compaction.applied",
            run_id,
            {
                "pre_compact_token_count": compaction.pre_compact_token_count,
                "post_compact_token_count": compaction.post_compact_token_count,
                "tokens_freed": compaction.tokens_freed,
            },
        )

    # 2b. Autocompact — the lossy LLM-summary layer, AFTER the cheap layer (L4a,
    #     P1 上下文治理). No-op (returns the SAME request) when disabled or under
    #     threshold, so the common path stays byte-identical; audited
    #     (``context.autocompact.applied``) only when it actually summarizes. The
    #     blocking summary model call is offloaded to a thread so the shared loop
    #     never stalls. ``transport`` is threaded through so a test's MockTransport
    #     serves the summary single-shot too.
    autocompacted_request = await apply_autocompact_async(
        run_id, audit_events, request, settings=settings, transport=transport
    )
    autocompacted = autocompacted_request is not request
    request = autocompacted_request

    # 3. context_usage + model.call.started audit — mirror call_model exactly.
    #    Reuse the cheap layer's token count on the common (no-autocompact) path;
    #    re-estimate only when autocompact rewrote the messages.
    usage = context_usage(
        request.messages,
        model=settings.model_name,
        context_window=settings.model_context_window,
        precomputed_token_count=(
            None if autocompacted else compaction.post_compact_token_count
        ),
    )
    started_payload: dict[str, Any] = {
        "model_name": settings.model_name,
        "tool_names": [str(tool["name"]) for tool in request.tools],
        "tool_contract_hash": _hash_payload(
            {"tools": provider_tool_contract(request.tools)}
        ),
        "context_token_count": usage["token_count"],
        "context_window": usage["context_window"],
        "context_percent_left": usage["percent_left"],
    }
    # Sampling params surface in the audit ONLY when set (R1-T3): with both
    # None the payload stays byte-identical to the pre-T3 pins.
    if settings.model_temperature is not None:
        started_payload["temperature"] = settings.model_temperature
    if settings.model_max_tokens is not None:
        started_payload["max_tokens"] = settings.model_max_tokens
    _audit.append(audit_events, "model.call.started", run_id, started_payload)

    # 4. Build the streaming request payload (like create_response, stream:True).
    tool_name_map = {
        _model_tool_name(tool["name"]): tool["name"]
        for tool in request.tools
        if isinstance(tool.get("name"), str)
    }
    payload: dict[str, Any] = {
        "model": settings.model_name,
        "messages": [_openai_message(message) for message in request.messages],
        "stream": True,
        # Ask the provider to emit a terminal usage frame (W1.T5). OpenAI-compatible
        # streams (DeepSeek included) only report token usage when include_usage is
        # set; without it the streamed call has no usage to audit. The extra frame
        # carries empty choices + a top-level `usage`, handled in _parse_sse_line.
        "stream_options": {"include_usage": True},
    }
    if request.tools:
        payload["tools"] = provider_tool_contract(request.tools)
    if settings.model_reasoning_effort:
        payload["reasoning_effort"] = settings.model_reasoning_effort
        payload["thinking"] = {"type": "enabled"}
    # Optional sampling params (R1-T3), injected once here — the payload is
    # built once and reused byte-identically across retry attempts. None →
    # key absent → wire payload unchanged from the pre-T3 format.
    if settings.model_temperature is not None:
        payload["temperature"] = settings.model_temperature
    if settings.model_max_tokens is not None:
        payload["max_tokens"] = settings.model_max_tokens
    headers = {"Authorization": f"Bearer {settings.model_api_key}"}

    # 4b. Model-call rate gate (L5, P4 并行隔离): the process-wide bucket, taken
    #     ONCE per logical call — after the compaction layers and the started
    #     audit, immediately before the provider call. Retry attempts share the
    #     admission (same logical call; the provider-parity backoff already
    #     spaces them). The contended path blocks in a worker thread (L4a's
    #     sync/async split) so the shared event loop never stalls; the gate only
    #     delays, it never rejects.
    await shared_model_call_bucket(settings).acquire_async()

    # 5/6. Stream + read SSE, accumulating tool-call fragments and the latest
    #      finish_reason. Transport/HTTP errors classify exactly as call_model.
    #      Retryable failures (per ModelProviderError.retryable) retry with the
    #      provider-parity backoff — but only while `streamed_output` is False,
    #      i.e. before any SSE data has left this producer. Retried attempts are
    #      audit-silent: model.call.started fired once above, and _fail runs
    #      only for the final outcome.
    for attempt in range(1, _STREAM_MAX_ATTEMPTS + 1):
        # Per-attempt state: a retried attempt starts from a clean slate.
        accumulator = _ToolCallAccumulator()
        finish_reason: str | None = None
        usage: dict[str, int] | None = None
        streamed_output = False
        try:
            async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT, transport=transport) as client:
                async with client.stream(
                    "POST", settings.model_endpoint, json=payload, headers=headers
                ) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        response.raise_for_status()
                    async for line in response.aiter_lines():
                        parsed = _parse_sse_line(line)
                        if parsed is _DONE:
                            break
                        if parsed is None:
                            continue
                        delta, line_finish_reason, line_usage = parsed
                        if line_usage is not None:
                            # The include_usage terminal frame (empty choices) —
                            # capture the provider's real token counts for audit.
                            usage = line_usage
                        content = delta.get("content")
                        if isinstance(content, str) and content:
                            # Stream the token immediately — this is the live
                            # streaming, and the retry point of no return: the
                            # consumer now holds output a retry would duplicate.
                            streamed_output = True
                            yield ModelChunk(kind="text_delta", text=content)
                        # Tool-call fragments are accumulated, not streamed live:
                        # the ModelChunk contract has no tool-call delta kind, so
                        # they surface only in the terminal `final` chunk once
                        # assembled. They still count as SSE data for the retry
                        # cutoff — the model has begun emitting a response.
                        for entry in delta.get("tool_calls") or []:
                            streamed_output = True
                            accumulator.add(entry)
                        if line_finish_reason is not None:
                            finish_reason = line_finish_reason
            break  # stream consumed to completion — fall through to assembly
        except httpx.HTTPStatusError as exc:
            error = _classify_status_error(exc)
        except httpx.TimeoutException:
            error = ModelProviderError(
                "model_call_timeout", "model provider call timed out", retryable=True
            )
        except httpx.HTTPError:
            error = ModelProviderError(
                "model_call_failed", "model provider call failed", retryable=True
            )
        if streamed_output or not error.retryable or attempt >= _STREAM_MAX_ATTEMPTS:
            yield _fail(audit_events, run_id, error)
            return
        await asyncio.sleep(_STREAM_RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)))

    # 7. Assemble tool calls from accumulated fragments, applying the same
    #    validation/mapping rules as _normalize_openai_response.
    try:
        tool_calls = accumulator.assemble(tool_name_map)
    except ModelProviderError as exc:
        yield _fail(audit_events, run_id, exc)
        return

    # 8. Success — model.call.completed audit mirrors call_model.
    completed_payload: dict[str, Any] = {
        "finish_reason": finish_reason,
        "tool_call_count": len(tool_calls),
        "requested_tool_names": [tool_call.name for tool_call in tool_calls],
    }
    # Per-run token usage (W1.T5): attach the provider-reported counts ONLY when a
    # usage frame arrived. No frame → no keys (honesty rule: never a fabricated 0).
    if usage is not None:
        completed_payload["input_tokens"] = usage["input_tokens"]
        completed_payload["output_tokens"] = usage["output_tokens"]
    _audit.append(audit_events, "model.call.completed", run_id, completed_payload)
    yield ModelChunk(
        kind="final",
        tool_calls=tuple(tool_calls),
        finish_reason=finish_reason,
    )


def _validate_sampling_settings(settings: RuntimeSettings) -> None:
    """ADR-002 code gate: reject nonsensical sampling config loudly.

    ``RuntimeSettings.from_env`` coerces unparseable/out-of-range env or file
    values to None (the config module's silent-drop precedent), so a bad value
    reaching this point means directly-constructed settings — a programming
    error, failed fast with a clear ValueError. NaN fails the range comparison
    and is rejected too.
    """
    temperature = settings.model_temperature
    if temperature is not None and not (
        MODEL_TEMPERATURE_MIN <= temperature <= MODEL_TEMPERATURE_MAX
    ):
        raise ValueError(
            "model_temperature must be within "
            f"[{MODEL_TEMPERATURE_MIN}, {MODEL_TEMPERATURE_MAX}], got {temperature!r}"
        )
    max_tokens = settings.model_max_tokens
    if max_tokens is not None and max_tokens < 1:
        raise ValueError(f"model_max_tokens must be >= 1, got {max_tokens!r}")


def _fail(
    audit_events: list[AuditEvent], run_id: str, error: ModelProviderError
) -> ModelChunk:
    """Append the model.call.failed audit (mirroring call_model) and build the
    terminal error chunk."""
    _audit.append(
        audit_events,
        "model.call.failed",
        run_id,
        {"error_code": error.error_code, "retryable": error.retryable},
    )
    return ModelChunk(
        kind="error", error_code=error.error_code, message=error.message
    )


# --- SSE parsing ------------------------------------------------------------

_DONE = object()


def _parse_sse_line(line: str) -> Any:
    """Parse one SSE line into ``(delta_dict, finish_reason, usage)``.

    ``usage`` is ``{input_tokens, output_tokens}`` when the line carries a
    provider usage object (W1.T5), else ``None``. Returns ``_DONE`` for the
    terminal ``[DONE]`` sentinel, ``None`` for any line that carries no usable
    signal at all (blank lines, non-``data:`` lines, malformed JSON, keepalives,
    or a chunk with neither choices nor usage). The include_usage terminal frame
    has EMPTY choices but a top-level ``usage``, so usage is extracted before the
    choices check — such a frame surfaces as ``({}, None, usage)``.
    """
    line = line.strip()
    if not line or not line.startswith("data:"):
        return None
    data = line[len("data:"):].strip()
    if data == "[DONE]":
        return _DONE
    try:
        obj = json.loads(data)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    usage = _normalize_usage(obj.get("usage"))
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        # A usage-only terminal frame (empty choices + top-level usage) still
        # carries a signal; anything else with no choices is skippable junk.
        if usage is not None:
            return {}, None, usage
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    delta = first.get("delta")
    if not isinstance(delta, dict):
        delta = {}
    finish_reason = first.get("finish_reason")
    return delta, finish_reason, usage


# --- tool-call accumulation -------------------------------------------------


@dataclass
class _AccumulatedToolCall:
    index: int
    id: str | None = None
    name: str | None = None
    arguments: str = ""


class _ToolCallAccumulator:
    """Accumulates streamed tool-call fragments keyed by their ``index``.

    OpenAI-compatible providers stream a tool call across several chunks: the
    first carries ``id`` and ``function.name``, subsequent chunks append
    ``function.arguments`` string fragments. We capture id/name when present and
    concatenate the argument fragments per index.
    """

    def __init__(self) -> None:
        self._calls: dict[int, _AccumulatedToolCall] = {}

    def add(self, entry: Any) -> None:
        if not isinstance(entry, dict):
            return
        index = entry.get("index")
        if not isinstance(index, int):
            # Fall back to positional order when a provider omits index.
            index = len(self._calls)
        call = self._calls.get(index)
        if call is None:
            call = _AccumulatedToolCall(index=index)
            self._calls[index] = call
        if isinstance(entry.get("id"), str):
            call.id = entry["id"]
        function = entry.get("function")
        if isinstance(function, dict):
            if isinstance(function.get("name"), str):
                call.name = function["name"]
            fragment = function.get("arguments")
            if isinstance(fragment, str):
                call.arguments += fragment

    def assemble(self, tool_name_map: dict[str, str]) -> list[ModelToolCall]:
        """Build ``ModelToolCall``s in index order, applying the same rules as
        ``_normalize_openai_response`` (name pattern, offered-tool mapping,
        argument JSON parsing)."""
        tool_calls: list[ModelToolCall] = []
        for position, index in enumerate(sorted(self._calls)):
            call = self._calls[index]
            function_name = call.name
            if (
                not isinstance(function_name, str)
                or not OPENAI_FUNCTION_NAME_PATTERN.fullmatch(function_name)
            ):
                raise ModelProviderError(
                    "model_response_invalid",
                    "model response tool call function name was invalid",
                    retryable=False,
                )
            if function_name not in tool_name_map:
                raise ModelProviderError(
                    "model_tool_not_offered",
                    "model requested a tool that was not offered in this request",
                    retryable=False,
                )
            tool_calls.append(
                ModelToolCall(
                    id=str(call.id or f"call_{position + 1}"),
                    name=tool_name_map[function_name],
                    arguments=_normalize_arguments(call.arguments or None),
                )
            )
        return tool_calls
