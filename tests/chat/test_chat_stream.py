"""R1-T4b — chat SSE streaming drives the platform QueryEngine.

``ChatOrchestrator.stream_run`` is the async generator behind
``POST /api/chat/runs/stream``. It mirrors ``start_run`` (run.created audit →
skill load + preflight → ``QueryEngine.run``) but yields wire frames live. Its
frame contract is now IDENTICAL to hiker/reimbursement — the R2
``text_delta`` uniformity cleanup retired chat's R1 ``delta`` remap:

* ``{"type": "event", "event": <AuditEvent>}`` — every audit event appended
  during the advance, in append order (via ``AuditFrameWatermark``);
* ``{"type": "text_delta", "text": ...}`` — one streamed assistant token (the
  engine's native token frame, no longer remapped to ``delta``);
* ``{"type": "tool_start"/"tool_done", "name": ...}`` — engine tool frames
  forwarded as-is;
* exactly one terminal ``{"type": "done", "run": <run>}`` on success OR
  ``{"type": "error", "run": <run>}`` on failure (chat's error shape — the
  frontend reads ``run.error_code`` / ``run.error_message``). The engine's own
  run-less terminals (``done``/``exhausted``/``error``) are swallowed and
  mapped onto the run.

Client disconnect / stop closes the generator; an in-flight (non-terminal) run
is finalized ``failed`` / ``client_disconnected`` — a close AFTER the terminal
frame must not overwrite an already-terminal run.

Fakes come from the shared engine seam (``tests.support.engine_fakes``); Chat
does not own business-system connector tools.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from services.chat.app.orchestrator import (
    MAX_CHAT_MODEL_TOOL_ROUNDS,
    ChatOrchestrator,
)
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class ForbiddenBusinessGateway:
    """A guard double proving Chat never reaches a business-system connector."""

    def __init__(self):
        self.calls = []

    def status(self):
        raise AssertionError("Chat must not preflight a business connector")

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        raise AssertionError("Chat must not call a business connector")


def _engine(stream_model) -> QueryEngine:
    return QueryEngine(
        settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=stream_model)
    )


def _text_delta_stream() -> FakeStreamModel:
    """Model streams the answer token-by-token, no tool call."""
    return FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="收入"),
                ModelChunk("text_delta", text="上升"),
                ModelChunk("text_delta", text="。"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )


def _business_tool_attempt_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            # round 1: model attempts a former business-system tool.
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_q",
                            name="erp.finance.query",
                            arguments={"question": "本月营收多少？"},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
        ]
    )


def _orchestrator(*, stream, gateway=None, settings=None) -> ChatOrchestrator:
    settings = settings or _CONFIGURED_SETTINGS
    if gateway is not None:
        gateway.calls.clear()
    return ChatOrchestrator(
        engine=_engine(stream),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
    )


def _collect(orchestrator):
    async def _drive():
        return [
            frame
            async for frame in orchestrator.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="总结这段经营复盘。",
                template_id="summarize",
            )
        ]

    return asyncio.run(_drive())


def _event_types(frames) -> list[str]:
    return [frame["event"].type for frame in frames if frame["type"] == "event"]


# --- happy path: real token streaming --------------------------------------------


def test_chat_stream_yields_text_deltas_then_final_ready_run():
    orchestrator = _orchestrator(stream=_text_delta_stream())

    frames = _collect(orchestrator)
    types = [frame["type"] for frame in frames]

    # Real token streaming: the engine's native `text_delta` frames (uniform with
    # finance/hiker/reimbursement — chat's R1 `delta` remap is gone), all before done.
    deltas = [f["text"] for f in frames if f["type"] == "text_delta"]
    assert deltas == ["收入", "上升", "。"]
    done_index = types.index("done")
    assert all(i < done_index for i, t in enumerate(types) if t == "text_delta")

    # Exactly one terminal done frame, carrying the final ready run.
    assert types.count("done") == 1
    assert types.count("error") == 0
    assert frames[-1]["type"] == "done"
    run = frames[-1]["run"]
    assert run.status == "ready"
    assert run.assistant_message == "收入上升。"

    # The engine's own run-less terminals never leak to the client.
    assert "exhausted" not in types

    # Audit event frames preserved, in append order — same trail as start_run.
    assert _event_types(frames) == [
        "chat.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "chat.response.generated",
    ]
    assert [f["event"] for f in frames if f["type"] == "event"] == list(run.audit_events)


def test_chat_stream_reports_model_not_configured():
    # RuntimeSettings() has no model → preflight fails BEFORE the engine runs.
    orchestrator = _orchestrator(
        stream=_text_delta_stream(), settings=RuntimeSettings()
    )

    frames = _collect(orchestrator)
    types = [frame["type"] for frame in frames]

    # Exactly one terminal error frame carrying the failed run.
    assert types.count("error") == 1
    assert types.count("done") == 0
    assert types.count("text_delta") == 0
    assert frames[-1]["type"] == "error"
    run = frames[-1]["run"]
    assert run.status == "failed"
    assert run.error_code == "model_not_configured"
    # Preflight failed before the engine ran — no model call.
    assert _event_types(frames) == [
        "chat.run.created",
        "skill.loaded",
        "chat.run.failed",
    ]


# --- business-system tool boundary ---------------------------------------------


def test_chat_stream_rejects_business_tool_without_calling_connector():
    gateway = ForbiddenBusinessGateway()
    orchestrator = _orchestrator(stream=_business_tool_attempt_stream(), gateway=gateway)

    async def _drive():
        return [
            frame
            async for frame in orchestrator.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="本月营收多少？",
                template_id="analyze",
            )
        ]

    frames = asyncio.run(_drive())
    types = [frame["type"] for frame in frames]

    # The former business tool is rejected before any connector call.
    assert gateway.calls == []
    deltas = [f["text"] for f in frames if f["type"] == "text_delta"]
    assert deltas == []
    assert types.count("done") == 0
    assert types.count("error") == 1
    assert frames[-1]["type"] == "error"
    run = frames[-1]["run"]
    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"

    # Tool process frames still expose what the model attempted, but no
    # mcp.tool.called audit exists because no connector was dispatched.
    tool_start_index = types.index("tool_start")
    assert frames[tool_start_index] == {"type": "tool_start", "name": "erp.finance.query"}
    assert "tool_done" not in types

    assert _event_types(frames) == [
        "chat.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "chat.run.failed",
    ]


def test_chat_stream_repeated_business_tool_does_not_suspend_for_continue():
    # Business-tool attempts are permission failures, not resumable max-turn loops.
    tool_round = [
        ModelChunk(
            "final",
            tool_calls=(
                ModelToolCall(
                    id="call_q",
                    name="erp.finance.query",
                    arguments={"question": "本月营收多少？"},
                ),
            ),
            finish_reason="tool_calls",
        ),
    ]
    stream = FakeStreamModel(
        [list(tool_round) for _ in range(MAX_CHAT_MODEL_TOOL_ROUNDS + 1)]
    )
    orchestrator = _orchestrator(stream=stream)

    async def _drive():
        return [
            frame
            async for frame in orchestrator.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="本月营收多少？",
                template_id=None,
            )
        ]

    frames = asyncio.run(_drive())
    types = [frame["type"] for frame in frames]

    assert "exhausted" not in types
    assert "done" not in types
    assert types.count("error") == 1
    assert _event_types(frames)[-1] == "chat.run.failed"
    assert frames[-1]["run"].error_code == "tool_not_allowed"
    assert types.count("tool_start") == 1
    assert types.count("tool_done") == 0


# --- W1.T2: authoritative step frames -------------------------------------------


def test_chat_stream_forwards_authoritative_step_frames():
    # ChatCapabilityHandler defines humanize_step, so the engine emits step
    # frames and stream_run forwards them on the same channel as tool_start.
    gateway = ForbiddenBusinessGateway()
    orchestrator = _orchestrator(stream=_business_tool_attempt_stream(), gateway=gateway)

    async def _drive():
        return [
            frame
            async for frame in orchestrator.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="本月营收多少？",
                template_id="analyze",
            )
        ]

    frames = asyncio.run(_drive())

    # The serialized wire frames carry "type":"step" with the authoritative
    # phase/intent/tool/turn — one rejected tool round.
    steps = [f for f in frames if f["type"] == "step"]
    assert steps == [
        {"type": "step", "phase": "analyze", "intent": "正在思考", "tool": None, "turn": 1},
        {
            "type": "step",
            "phase": "tool",
            "intent": "正在调用 erp.finance.query",
            "tool": "erp.finance.query",
            "turn": 1,
        },
    ]

    # Step frames are purely additive — the terminal is still the failed run.
    assert frames[-1]["type"] == "error"
    assert frames[-1]["run"].status == "failed"
    assert gateway.calls == []


# --- client disconnect ----------------------------------------------------------


def test_chat_stream_client_disconnect_finalizes_in_flight_run_as_failed():
    # Client disconnect / stop button → the route closes the generator mid-stream.
    # Chat runs are read-only and not resumable, so an in-flight run must be
    # finalized (never left lingering non-terminal in the registry).
    orchestrator = _orchestrator(stream=_text_delta_stream())

    async def _disconnect_after_first_delta():
        agen = orchestrator.stream_run(
            workspace_id="demo",
            actor_user_id="u_demo",
            message="总结这段经营复盘。",
            template_id="summarize",
        )
        async for frame in agen:
            if frame["type"] == "text_delta":
                break
        await agen.aclose()

    asyncio.run(_disconnect_after_first_delta())

    # The single created run is finalized failed / client_disconnected.
    (run,) = list(orchestrator._runs.values())
    assert run.status == "failed"
    assert run.error_code == "client_disconnected"
    assert run.audit_events[-1].type == "chat.run.failed"
    assert run.audit_events[-1].payload["error_code"] == "client_disconnected"


def test_chat_stream_close_after_done_frame_never_overwrites_ready_run():
    # Close AT the done frame (consumer stops right after receiving it):
    # GeneratorExit fires with a terminal run — the guard must not re-finalize
    # it as client_disconnected.
    orchestrator = _orchestrator(stream=_text_delta_stream())

    async def _stop_at_done_frame():
        agen = orchestrator.stream_run(
            workspace_id="demo",
            actor_user_id="u_demo",
            message="总结这段经营复盘。",
            template_id="summarize",
        )
        async for frame in agen:
            if frame["type"] == "done":
                break
        await agen.aclose()

    asyncio.run(_stop_at_done_frame())

    (run,) = list(orchestrator._runs.values())
    assert run.status == "ready"
    assert run.error_code is None
    assert run.audit_events[-1].type == "chat.response.generated"
