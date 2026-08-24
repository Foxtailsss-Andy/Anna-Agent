"""Shared fake ``stream_model`` seam for engine-driven tests (R1-T1a).

The one canonical home for the fake streaming model that the engine-layer and
domain-agent tests previously each carried as a local copy (5 duplicates),
plus a PUBLIC ``QueryEngine`` builder replacing the private ``_engine``
helpers that were imported cross-test-module.

Two fakes, one seam:

* ``BareFakeStreamModel`` — scripts only, ZERO governance side effects. For
  the ENGINE-layer tests (``test_engine_agent_loop`` /
  ``test_engine_query_engine``), which drive the loop with deliberately
  unconfigured ``RuntimeSettings`` and assert pure loop mechanics (event
  order, message splicing) with no audit mirroring and no config gate.
* ``FakeStreamModel`` — the governed mirror used by the DOMAIN tests. It
  reproduces the REAL ``stream_model``'s observable side effects so domain
  audit-trail assertions test the true wire behavior (see the class
  docstring for the exact mirror contract).
"""
from __future__ import annotations

from services.reimbursement.app.audit import AuditEvent
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.context_compaction import context_usage
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.harness_runtime import _hash_payload
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelResponse,
    provider_tool_contract,
)


def build_engine(stream_model, *, settings: RuntimeSettings) -> QueryEngine:
    """Return a ``QueryEngine`` wired to a fake ``stream_model``.

    The public name for what the domain test modules used to define locally
    as ``_engine`` (and import cross-module under that private name).
    """
    return QueryEngine(settings=settings, deps=QueryDeps(stream_model=stream_model))


class BareFakeStreamModel:
    """Scripts-only fake with ZERO governance side effects.

    Constructed with one ``ModelChunk`` list per model turn; each call pops
    the next list and yields its chunks verbatim. No config check, no audit
    events — the engine-layer tests assert pure loop mechanics against
    unconfigured ``RuntimeSettings``.

    Captured requests are exposed as ``self.calls`` (the engine tests'
    historical attribute name, preserved so their assertions stay
    byte-identical).
    """

    def __init__(self, scripts: list[list[ModelChunk]]):
        self._scripts = list(scripts)
        self.calls: list[ModelRequest] = []

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        self.calls.append(request)
        chunks = self._scripts.pop(0)

        async def _gen():
            for chunk in chunks:
                yield chunk

        return _gen()


class FakeStreamModel:
    """Governed fake mirroring the real ``stream_model``'s side effects.

    Two scripting styles, matching the two historical fakes this replaces:

    * ``FakeStreamModel(scripts)`` — ``scripts`` is one ``ModelChunk`` list
      per model turn (text deltas then a terminal ``final`` carrying any tool
      calls); the finance style.
    * subclass overriding ``respond(request) -> ModelResponse`` — one
      ``ModelResponse`` per turn, typically staged on ``len(self.requests)``;
      the reimbursement style. The base adapts the response to the engine's
      ``ModelChunk`` stream (one ``text_delta`` for the assistant message,
      then the ``final``).

    Governance mirror — kept in lockstep with the REAL producer
    (``services/runtime/app/engine/streaming_model.py::stream_model``):

    * config check FIRST: on missing endpoint/API key, a single ``error``
      chunk with ``model_not_configured`` and NO audit event, NO request
      capture (matches ``call_model`` / ``stream_model``).
    * ``model.call.started`` per governed call with the REAL payload shape —
      ``model_name`` / ``tool_names`` / ``tool_contract_hash`` /
      ``context_token_count`` / ``context_window`` / ``context_percent_left``
      plus conditional ``temperature`` / ``max_tokens`` ONLY when the matching
      ``settings.model_temperature`` / ``settings.model_max_tokens`` is set
      (R1-T3; None → key absent, byte-identical to the pre-T3 payload) — and
      WITHOUT ``skill_id`` / ``tool_schema_sources`` / ``prompt_hash`` (the
      platform engine has no business context; ``skill_id`` lives on the
      ``skill.loaded`` event).
    * ``model.call.completed`` appended before the terminal ``final`` chunk
      is yielded, exactly like the real producer.
    * ``model.call.failed`` (NEVER ``completed``) when a scripted terminal
      chunk is ``error`` — payload mirrors the real ``_fail``:
      ``error_code`` plus the real producer's ``retryable`` classification
      for that code (``_RETRYABLE_MODEL_ERROR_CODES``).

    Anti-drift pin: ``tests/runtime/test_engine_fakes_parity.py`` drives this
    fake AND the real producer side by side and asserts audit payload-key
    parity — payload changes to the real producer go red there until this
    mirror follows.

    Every governed request is captured on ``self.requests`` so tests can
    assert prompt assembly across turns.
    """

    def __init__(self, scripts: list[list[ModelChunk]] | None = None):
        self._scripts = list(scripts) if scripts is not None else None
        self.requests: list[ModelRequest] = []

    def respond(self, request: ModelRequest) -> ModelResponse:
        raise NotImplementedError(
            "pass scripts to FakeStreamModel(...) or subclass and override respond()"
        )

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        if not settings.model_api_key or not settings.model_endpoint:

            async def _not_configured():
                yield ModelChunk(
                    kind="error",
                    error_code="model_not_configured",
                    message=config_error_message,
                )

            return _not_configured()

        self.requests.append(request)
        if self._scripts is not None:
            chunks = self._scripts.pop(0)
        else:
            chunks = _chunks_from_response(self.respond(request))
        final = next((c for c in chunks if c.kind == "final"), None)
        tool_calls = list(final.tool_calls) if final is not None else []
        finish_reason = final.finish_reason if final is not None else None
        # Mirror the real producer's conditional usage keys (W1.T5): a final chunk
        # carrying provider-reported usage surfaces input/output tokens on the
        # completed audit; None → keys absent (byte-identical to a no-usage call).
        usage_tokens = (
            (final.input_tokens, final.output_tokens)
            if final is not None
            and final.input_tokens is not None
            and final.output_tokens is not None
            else None
        )

        usage = context_usage(
            request.messages,
            model=settings.model_name,
            context_window=settings.model_context_window,
        )
        started_payload = {
            "model_name": settings.model_name,
            "tool_names": [str(tool["name"]) for tool in request.tools],
            "tool_contract_hash": _hash_payload(
                {"tools": provider_tool_contract(request.tools)}
            ),
            "context_token_count": usage["token_count"],
            "context_window": usage["context_window"],
            "context_percent_left": usage["percent_left"],
        }
        # Mirrors the real producer's conditional sampling keys (R1-T3): set
        # settings surface in the started payload; None means key absent.
        if settings.model_temperature is not None:
            started_payload["temperature"] = settings.model_temperature
        if settings.model_max_tokens is not None:
            started_payload["max_tokens"] = settings.model_max_tokens
        audit_events.append(
            AuditEvent(
                type="model.call.started",
                run_id=run_id,
                payload=started_payload,
            )
        )

        def _append_completed() -> None:
            completed_payload = {
                "finish_reason": finish_reason,
                "tool_call_count": len(tool_calls),
                "requested_tool_names": [tc.name for tc in tool_calls],
            }
            if usage_tokens is not None:
                completed_payload["input_tokens"] = usage_tokens[0]
                completed_payload["output_tokens"] = usage_tokens[1]
            audit_events.append(
                AuditEvent(
                    type="model.call.completed",
                    run_id=run_id,
                    payload=completed_payload,
                )
            )

        def _append_failed(chunk: ModelChunk) -> None:
            # Mirrors the real producer's ``_fail`` payload exactly:
            # {"error_code": ..., "retryable": ...}.
            audit_events.append(
                AuditEvent(
                    type="model.call.failed",
                    run_id=run_id,
                    payload={
                        "error_code": chunk.error_code,
                        "retryable": chunk.error_code in _RETRYABLE_MODEL_ERROR_CODES,
                    },
                )
            )

        async def _gen():
            terminal_audited = False
            for chunk in chunks:
                if chunk.kind == "final":
                    # Real stream_model audits completion BEFORE yielding final.
                    _append_completed()
                    terminal_audited = True
                elif chunk.kind == "error":
                    # Real stream_model audits model.call.failed (via ``_fail``)
                    # BEFORE yielding the terminal error chunk — a failed call
                    # NEVER audits completed.
                    _append_failed(chunk)
                    terminal_audited = True
                yield chunk
            if not terminal_audited:
                # Defensive parity with the old finance fake: a script without
                # a terminal chunk still audits its completion.
                _append_completed()

        return _gen()


# The real producer's retryable classification per error code, as pinned by
# ``model_provider._classify_status_error`` plus ``stream_model``'s own
# timeout/transport handlers. The fake's mirrored ``model.call.failed``
# payload derives ``retryable`` from the scripted ``error_code`` via this
# table (the ModelChunk contract carries no retryable flag).
_RETRYABLE_MODEL_ERROR_CODES = frozenset(
    {
        "model_rate_limited",  # HTTP 429
        "model_provider_unavailable",  # HTTP 5xx
        "model_call_timeout",  # httpx.TimeoutException
        "model_call_failed",  # other transport-level httpx errors
    }
)


def _chunks_from_response(response: ModelResponse) -> list[ModelChunk]:
    """Adapt one ``ModelResponse`` to the ``ModelChunk`` stream contract."""
    chunks: list[ModelChunk] = []
    if response.assistant_message:
        chunks.append(ModelChunk(kind="text_delta", text=response.assistant_message))
    chunks.append(
        ModelChunk(
            kind="final",
            tool_calls=tuple(response.tool_calls),
            finish_reason=response.finish_reason,
        )
    )
    return chunks
