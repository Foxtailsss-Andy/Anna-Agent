"""R1-T1b — hiker assistant SSE streaming drives the platform engine.

``HikerOrchestrator.stream_assistant_advance`` is the async generator behind
``POST /api/cowork/hiker/assistant/runs/stream``. It mirrors
``record_assistant_created_and_advance`` (run.created audit → skill load +
preflight → ``QueryEngine.run``) but yields SSE frame dicts live:

* ``{"type": "event", "event": <AuditEvent>}`` — every audit event appended
  during the advance, in append order (the frontend renders the trace timeline);
* ``{"type": "text_delta", "text": ...}`` and ``{"type": "tool_start"/"tool_done",
  "name": ...}`` — engine process events forwarded as-is (real token streaming);
* exactly one terminal ``{"type": "done", "run": <run>}`` carrying the final
  run. The engine's own run-less terminals (``done``/``exhausted``/``error``)
  are swallowed and mapped onto the run with the same outcome mapping as the
  non-streaming advance — the frontend's done handler requires ``run``.
* an unexpected raise keeps the old ``stream_run_action`` contract: streamed
  audit frames so far, then a terminal ``{"type": "error", "message": ...}``.

Client-disconnect policy is FINANCE-STYLE (finalize as ``failed`` /
``client_disconnected``): ``HikerAssistantRun.status`` is only ever
``validating`` / ``ready`` / ``failed`` — there is no parked, resumable state
and no public entry re-advances an existing assistant run, so an in-flight
run closed mid-stream would otherwise linger non-terminal forever.

The fake stream-model seam comes from ``tests.support.engine_fakes``; the
shared hiker fakes (gateway / skill loader) from ``tests.hiker.hiker_fakes``.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes.hiker import build_router
from services.hiker.app.orchestrator import (
    MAX_HIKER_MODEL_TOOL_ROUNDS,
    HikerOrchestrator,
)
from services.mcp_gateway.app.hiker_adapter import HikerMcpError
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.model_provider import ModelToolCall
from tests.hiker.hiker_fakes import FakeGateway, FakeSkillLoader
from tests.support.engine_fakes import FakeStreamModel, build_engine


QUESTION = "整体经营怎么样?"

CONFIGURED_SETTINGS = RuntimeSettings(
    model_api_key="k",
    model_endpoint="http://m",
    hiker_assistant_skill_id="hiker/global-customer",
)


class ExplodingSkillLoader:
    """Raises OUTSIDE the domain contract (not SkillLoaderError)."""

    def load(self, skill_id):
        raise RuntimeError("boom: unexpected loader crash")


def _assistant_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            # round 1: request the dashboard-summary tool.
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_hiker_1",
                            name="hiker.report.get_dashboard_summary",
                            arguments={},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
            # round 2: stream the final assistant answer token-by-token.
            [
                ModelChunk("text_delta", text="整体经营稳健，"),
                ModelChunk("text_delta", text="数据来自 Hiker MCP。"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )


def _always_tool_calling_stream() -> FakeStreamModel:
    tool_round = [
        ModelChunk(
            "final",
            tool_calls=(
                ModelToolCall(
                    id="call_hiker_loop",
                    name="hiker.report.get_dashboard_summary",
                    arguments={},
                ),
            ),
            finish_reason="tool_calls",
        ),
    ]
    # One more than MAX_HIKER_MODEL_TOOL_ROUNDS so pop() never runs dry.
    return FakeStreamModel(
        [list(tool_round) for _ in range(MAX_HIKER_MODEL_TOOL_ROUNDS + 1)]
    )


class FailingGateway(FakeGateway):
    def call_tool(self, tool_name, arguments):
        raise HikerMcpError("hiker_upstream_unavailable", "Hiker upstream is down", True)


# --- drivers -------------------------------------------------------------------


def _orchestrator(gateway, stream, settings=CONFIGURED_SETTINGS) -> HikerOrchestrator:
    return HikerOrchestrator(
        adapter=gateway,
        skill_loader=FakeSkillLoader(),
        settings=settings,
        engine=build_engine(stream, settings=settings),
    )


def _collect_frames(orchestrator, run, question=QUESTION):
    async def _drive():
        return [
            frame
            async for frame in orchestrator.stream_assistant_advance(run, question)
        ]

    return asyncio.run(_drive())


def _event_types(frames) -> list[str]:
    return [frame["event"].type for frame in frames if frame["type"] == "event"]


# --- happy path: real token streaming --------------------------------------------


def test_stream_assistant_emits_token_deltas_tool_frames_and_done_run():
    gateway = FakeGateway()
    orchestrator = _orchestrator(gateway, _assistant_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)
    types = [frame["type"] for frame in frames]

    # Real token streaming: MULTIPLE text_delta frames, all before done.
    deltas = [f["text"] for f in frames if f["type"] == "text_delta"]
    assert deltas == ["整体经营稳健，", "数据来自 Hiker MCP。"]
    done_index = types.index("done")
    assert all(i < done_index for i, t in enumerate(types) if t == "text_delta")

    # Exactly one terminal done frame, and it carries the final ready run.
    assert types.count("done") == 1
    assert frames[-1]["type"] == "done"
    final_run = frames[-1]["run"]
    assert final_run is run
    assert final_run.status == "ready"
    assert final_run.answer == "整体经营稳健，数据来自 Hiker MCP。"
    assert final_run.agent_message == final_run.answer
    assert final_run.tools_used == ["hiker.report.get_dashboard_summary"]

    # The engine's own run-less terminals never leak to the client.
    assert all("run" in f for f in frames if f["type"] == "done")
    assert "exhausted" not in types
    assert "error" not in types

    # Audit event frames preserved, in append order — same trail as non-streaming.
    assert _event_types(frames) == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "model.call.started",
        "model.call.completed",
        "hiker.assistant.answered",
    ]
    assert [f["event"] for f in frames if f["type"] == "event"] == list(run.audit_events)

    # tool_start/tool_done wrap the tool round; the audited mcp.tool.called
    # event frame is flushed between them.
    tool_start_index = types.index("tool_start")
    tool_done_index = types.index("tool_done")
    assert frames[tool_start_index] == {
        "type": "tool_start",
        "name": "hiker.report.get_dashboard_summary",
    }
    assert frames[tool_done_index] == {
        "type": "tool_done",
        "name": "hiker.report.get_dashboard_summary",
    }
    mcp_index = next(
        i
        for i, f in enumerate(frames)
        if f["type"] == "event" and f["event"].type == "mcp.tool.called"
    )
    assert tool_start_index < mcp_index < tool_done_index

    # Round-2 model.call.started event frame lands BEFORE the first token delta.
    first_delta_index = types.index("text_delta")
    started_indexes = [
        i
        for i, f in enumerate(frames)
        if f["type"] == "event" and f["event"].type == "model.call.started"
    ]
    assert started_indexes[1] < first_delta_index
    assert tool_done_index < first_delta_index


# --- failure paths ----------------------------------------------------------------


def test_stream_assistant_tool_error_ends_with_done_frame_carrying_failed_run():
    orchestrator = _orchestrator(FailingGateway(), _assistant_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)
    types = [frame["type"] for frame in frames]

    # The engine's error terminal is mapped onto the run, not forwarded.
    assert "error" not in types
    assert frames[-1]["type"] == "done"
    failed = frames[-1]["run"]
    assert failed.status == "failed"
    assert failed.error_code == "hiker_upstream_unavailable"
    assert failed.error_message == "Hiker upstream is down"
    assert _event_types(frames) == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "hiker.assistant.failed",
    ]
    mcp_event = next(
        f["event"]
        for f in frames
        if f["type"] == "event" and f["event"].type == "mcp.tool.called"
    )
    assert mcp_event.payload["status"] == "failed"
    # tool_start was already live; the dispatch failed so no tool_done follows.
    assert "tool_start" in types
    assert "tool_done" not in types


def test_stream_assistant_exhaustion_ends_with_done_frame_carrying_failed_run():
    orchestrator = _orchestrator(FakeGateway(), _always_tool_calling_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)
    types = [frame["type"] for frame in frames]

    # The engine's exhausted terminal is mapped onto the run, not forwarded.
    assert "exhausted" not in types
    assert frames[-1]["type"] == "done"
    failed = frames[-1]["run"]
    assert failed.status == "failed"
    assert failed.error_code == "tool_loop_exhausted"
    assert failed.error_message == "Hiker assistant tool loop exceeded max rounds"
    assert _event_types(frames)[-1] == "hiker.assistant.failed"
    # Exactly MAX_HIKER_MODEL_TOOL_ROUNDS tool rounds ran before the valve.
    assert types.count("tool_start") == MAX_HIKER_MODEL_TOOL_ROUNDS
    assert types.count("tool_done") == MAX_HIKER_MODEL_TOOL_ROUNDS


def test_stream_assistant_without_model_config_yields_failed_run_done_frame():
    # Reimbursement-style preflight: no model config → connector NOT checked;
    # the engine's model seam surfaces model_not_configured, mapped onto the
    # run — the client still gets a proper done frame.
    stream = _assistant_stream()
    gateway = FakeGateway()
    orchestrator = _orchestrator(gateway, stream, settings=RuntimeSettings())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)

    assert _event_types(frames) == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "hiker.assistant.failed",
    ]
    assert frames[-1]["type"] == "done"
    failed = frames[-1]["run"]
    assert failed.status == "failed"
    assert failed.error_code == "model_not_configured"
    assert stream.requests == []


def test_stream_assistant_connector_down_yields_failed_run_done_frame():
    class DownGateway(FakeGateway):
        def status(self):
            return {"status": "not_configured", "error_code": "connector_not_configured"}

    stream = _assistant_stream()
    orchestrator = _orchestrator(DownGateway(), stream)
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)

    assert [frame["type"] for frame in frames] == ["event", "event", "event", "done"]
    assert _event_types(frames) == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "hiker.assistant.failed",
    ]
    failed = frames[-1]["run"]
    assert failed.status == "failed"
    assert failed.error_code == "connector_not_configured"
    assert stream.requests == []


def test_stream_assistant_unexpected_exception_yields_error_frame():
    # Parity with the retired stream_run_action contract: audit frames streamed
    # so far, then a terminal {"type": "error", "message": ...} frame.
    orchestrator = HikerOrchestrator(
        adapter=FakeGateway(),
        skill_loader=ExplodingSkillLoader(),
        settings=CONFIGURED_SETTINGS,
        engine=build_engine(_assistant_stream(), settings=CONFIGURED_SETTINGS),
    )
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)

    assert _event_types(frames) == ["hiker.assistant.run.created"]
    assert frames[-1]["type"] == "error"
    assert "boom" in frames[-1]["message"]
    assert all(frame["type"] != "done" for frame in frames)


# --- client disconnect --------------------------------------------------------------


def test_stream_assistant_client_disconnect_finalizes_in_flight_run_as_failed():
    # Finance-style ruling (see module docstring): hiker assistant runs have
    # no resumable parked state, so a mid-stream close must finalize the run.
    orchestrator = _orchestrator(FakeGateway(), _assistant_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    async def _disconnect_after_first_delta():
        agen = orchestrator.stream_assistant_advance(run, QUESTION)
        async for frame in agen:
            if frame["type"] == "text_delta":
                break
        await agen.aclose()

    asyncio.run(_disconnect_after_first_delta())

    assert run.status == "failed"
    assert run.error_code == "client_disconnected"
    assert run.audit_events[-1].type == "hiker.assistant.failed"
    assert run.audit_events[-1].payload["error_code"] == "client_disconnected"


def test_stream_assistant_close_after_full_drain_keeps_ready_run():
    orchestrator = _orchestrator(FakeGateway(), _assistant_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    async def _drain_then_close():
        agen = orchestrator.stream_assistant_advance(run, QUESTION)
        frames = [frame async for frame in agen]
        # Fully drained; a late close must leave the terminal run untouched.
        await agen.aclose()
        return frames

    frames = asyncio.run(_drain_then_close())

    assert frames[-1]["type"] == "done"
    assert run.status == "ready"
    assert run.error_code is None
    assert _event_types(frames)[-1] == "hiker.assistant.answered"


def test_stream_assistant_close_at_done_frame_never_overwrites_terminal_run():
    orchestrator = _orchestrator(FakeGateway(), _assistant_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    async def _stop_at_done_frame():
        agen = orchestrator.stream_assistant_advance(run, QUESTION)
        async for frame in agen:
            if frame["type"] == "done":
                break
        await agen.aclose()

    asyncio.run(_stop_at_done_frame())

    assert run.status == "ready"
    assert run.error_code is None
    assert run.audit_events[-1].type == "hiker.assistant.answered"


# --- route-level SSE e2e ------------------------------------------------------------


def test_stream_route_serializes_engine_frames_as_sse():
    orchestrator = _orchestrator(FakeGateway(), _assistant_stream())
    app = FastAPI()
    app.include_router(build_router(orchestrator))
    client = TestClient(app)

    response = client.post(
        "/api/cowork/hiker/assistant/runs/stream",
        headers={"X-Anna-Workspace-ID": "ws_demo", "X-Anna-User-ID": "admin"},
        json={
            "workspace_id": "ws_demo",
            "actor_user_id": "admin",
            "question": QUESTION,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    frames = [
        json.loads(chunk[len("data: ") :])
        for chunk in response.text.split("\n\n")
        if chunk.startswith("data: ")
    ]
    types = [frame["type"] for frame in frames]

    # Multiple token deltas reach the CLIENT before the done frame.
    deltas = [f["text"] for f in frames if f["type"] == "text_delta"]
    assert deltas == ["整体经营稳健，", "数据来自 Hiker MCP。"]
    done_index = types.index("done")
    assert all(i < done_index for i, t in enumerate(types) if t == "text_delta")
    assert "tool_start" in types
    assert "tool_done" in types

    # Terminal frame carries the serialized run object.
    assert frames[-1]["type"] == "done"
    run_payload = frames[-1]["run"]
    assert run_payload["status"] == "ready"
    assert run_payload["answer"] == "整体经营稳健，数据来自 Hiker MCP。"
    assert run_payload["tools_used"] == ["hiker.report.get_dashboard_summary"]

    # Audit event frames still flow to the trace timeline, in order.
    event_types = [f["event"]["type"] for f in frames if f["type"] == "event"]
    assert event_types == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "model.call.started",
        "model.call.completed",
        "hiker.assistant.answered",
    ]
