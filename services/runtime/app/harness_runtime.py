from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from typing import Any

from services.reimbursement.app.audit import AuditService, AuditEvent
from services.runtime.app.autocompact import apply_autocompact_sync
from services.runtime.app.concurrency import shared_model_call_bucket
from services.runtime.app.context_compaction import compact_messages, context_usage
from services.runtime.app.model_provider import (
    ModelProviderError,
    ModelRequest,
    ModelResponse,
    OpenAICompatibleModelProvider,
    provider_tool_contract,
)


@dataclass(frozen=True)
class HarnessModelCallResult:
    response: ModelResponse | None = None
    error_code: str | None = None
    message: str | None = None
    retryable: bool = False


class AnnaHarnessRuntime:
    def __init__(
        self,
        model_provider: OpenAICompatibleModelProvider,
        audit: AuditService | None = None,
    ) -> None:
        self.model_provider = model_provider
        self.audit = audit or AuditService()

    def call_model(
        self,
        run_id: str,
        audit_events: list[AuditEvent],
        request: ModelRequest,
        started_payload: dict[str, Any] | None = None,
        config_error_message: str = "model endpoint and API key are required before running Anna agent",
    ) -> HarnessModelCallResult:
        settings = self.model_provider.settings
        if not settings.model_api_key or not settings.model_endpoint:
            return HarnessModelCallResult(
                error_code="model_not_configured",
                message=config_error_message,
            )

        # Keep the request under the context window before spending a model call.
        # Uniform across every domain (it lives on the shared chokepoint, not in
        # any orchestrator). No-op when under threshold, so the common path is
        # untouched; audited only when it actually frees tokens.
        compaction = compact_messages(
            request.messages,
            model=settings.model_name,
            context_window=settings.model_context_window,
            enabled=settings.context_compaction_enabled,
        )
        if compaction.compacted:
            request = ModelRequest(messages=compaction.messages, tools=request.tools)
            self.audit.append(
                audit_events,
                "context.compaction.applied",
                run_id,
                {
                    "pre_compact_token_count": compaction.pre_compact_token_count,
                    "post_compact_token_count": compaction.post_compact_token_count,
                    "tokens_freed": compaction.tokens_freed,
                },
            )

        # Autocompact — the lossy LLM-summary layer, AFTER the cheap layer (L4a).
        # No-op (returns the SAME request) when disabled or under threshold, so
        # every current single-shot caller (crew / associate) stays byte-identical;
        # audited only when it actually summarizes. The summary reuses this
        # provider's transport so an injected fake transport serves it too.
        autocompacted_request = apply_autocompact_sync(
            run_id,
            audit_events,
            request,
            settings=settings,
            transport=getattr(self.model_provider, "_transport", None),
        )
        autocompacted = autocompacted_request is not request
        request = autocompacted_request

        usage = context_usage(
            request.messages,
            model=settings.model_name,
            context_window=settings.model_context_window,
            precomputed_token_count=(
                None if autocompacted else compaction.post_compact_token_count
            ),
        )
        self.audit.append(
            audit_events,
            "model.call.started",
            run_id,
            {
                "model_name": settings.model_name,
                "tool_names": [str(tool["name"]) for tool in request.tools],
                "tool_contract_hash": _hash_payload(
                    {"tools": provider_tool_contract(request.tools)}
                ),
                "context_token_count": usage["token_count"],
                "context_window": usage["context_window"],
                "context_percent_left": usage["percent_left"],
                **(started_payload or {}),
            },
        )
        # Model-call rate gate (L5, P4 并行隔离): the process-wide bucket, taken
        # AFTER both compaction layers, immediately before the provider call.
        # Blocking is fine here — call_model only runs in no-running-loop
        # contexts (run_async asserts): worker threads and sync routes. The gate
        # only delays (never rejects), so behavior is unchanged until the
        # configured calls-per-minute is actually exceeded.
        shared_model_call_bucket(settings).acquire()
        try:
            response = run_async(self.model_provider.create_response(request))
        except ModelProviderError as exc:
            self.audit.append(
                audit_events,
                "model.call.failed",
                run_id,
                {"error_code": exc.error_code, "retryable": exc.retryable},
            )
            return HarnessModelCallResult(
                error_code=exc.error_code,
                message=exc.message,
                retryable=exc.retryable,
            )

        completed_payload: dict[str, Any] = {
            "finish_reason": response.finish_reason,
            "tool_call_count": len(response.tool_calls),
            "requested_tool_names": [tool_call.name for tool_call in response.tool_calls],
        }
        # Per-run token usage (W1.T5): surface the provider-reported counts ONLY
        # when the provider actually reported them — absent keys mean "unknown",
        # never a fabricated zero (honesty rule).
        if response.input_tokens is not None and response.output_tokens is not None:
            completed_payload["input_tokens"] = response.input_tokens
            completed_payload["output_tokens"] = response.output_tokens
        self.audit.append(audit_events, "model.call.completed", run_id, completed_payload)
        return HarnessModelCallResult(response=response)


def _hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def run_async(awaitable):
    """Drive ``awaitable`` to completion from a no-running-loop context.

    The shared sync→async bridge (``asyncio.run``) used by the non-streaming
    orchestrator advances and ``call_model``. Refuses to run when an event
    loop is already active in this thread — an async caller must ``await``
    the coroutine (or drive the engine's async generator directly) instead of
    bridging.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(awaitable)
    raise RuntimeError(
        "run_async cannot be used inside a running event loop; "
        "await the coroutine instead of bridging"
    )
