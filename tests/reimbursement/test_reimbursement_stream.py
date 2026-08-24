"""W6 — reimbursement SSE streaming drives the platform engine.

``ReimbursementOrchestrator._stream_advance`` (shared by
``stream_created_advance`` / ``stream_answers_advance``) is the async generator
behind ``POST /api/cowork/reimbursements/runs/stream`` and
``POST /api/cowork/reimbursements/runs/{run_id}/answers/stream``. It mirrors the
non-streaming twins (record audit event → skill load + preflight →
``QueryEngine.run`` → outcome mapping → persist) but yields SSE frame dicts live:

* ``{"type": "event", "event": <AuditEvent>}`` — every audit event appended
  during the advance, in append order (the frontend renders the trace timeline);
* ``{"type": "text_delta", "text": ...}`` and ``{"type": "tool_start"/"tool_done",
  "name": ...}`` — engine process events forwarded as-is (real token streaming);
* ``{"type": "awaiting_approval", "reason", "detail"}`` — forwarded verbatim
  ONLY for the approval suspend (``SUSPEND_REASON_AWAITING_APPROVAL``); the
  missing-fields suspend is swallowed (the ``reimbursement.missing_fields
  .requested`` audit frame + the ``collecting`` done run carry the semantics,
  exactly like the old SSE stream);
* exactly one terminal ``{"type": "done", "run": <run>}`` — the engine's own
  run-less terminals (``done``/``exhausted``/``error``) are swallowed and
  mapped onto the run via ``_resolve_outcome``;
* an unexpected raise keeps the old ``stream_run_action`` contract: streamed
  audit frames so far, then a terminal ``{"type": "error", "message": ...}``.

Client-disconnect policy DIVERGES from finance W4: reimbursement runs are NOT
finalized on ``GeneratorExit`` because the domain's parked states are resumable
(``collecting`` → answers flow, ``waiting_confirmation`` → ``approve_submit``).

The fake stream-model seam comes from ``tests.support.engine_fakes``
(``FakeStreamModel`` + ``build_engine``); the reimbursement domain fakes
(gateway + scripted model providers) are reused from
``test_reimbursement_agent_flow`` — no second copy.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes.reimbursement import build_router
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.reimbursement.app.state_store import SQLiteReimbursementStateStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import SUSPEND_REASON_AWAITING_APPROVAL
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from tests.reimbursement.test_reimbursement_agent_flow import (
    CONFIGURED_SETTINGS,
    FakeReimbursementMcpGateway,
    MissingFieldRecoveryModelProvider,
    StepwiseFakeModelProvider,
)
from tests.support.engine_fakes import FakeStreamModel, build_engine


def _engine(stream):
    return build_engine(stream, settings=CONFIGURED_SETTINGS)


INPUT_TEXT = "请帮我报销 ACME 项目交通费。"

FULL_DRAFT = {
    "category": "transport",
    "amount": 128,
    "currency": "CNY",
    "expense_date": "2026-05-29",
    "merchant": "上海交通服务",
    "reason": "ACME 项目差旅交通",
    "department_id": "sales",
    "cost_center_id": "cc_acme",
}


class NarratedCollectingModelProvider(FakeStreamModel):
    """Round 1: narrates then validates the draft; round 2: narrated wrap-up.

    Both rounds carry assistant text, so the stream surfaces MULTIPLE
    ``text_delta`` frames before the terminal done frame.
    """

    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                assistant_message="正在校验报销草稿。",
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={"draft": dict(FULL_DRAFT)},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="草稿校验通过，还需要发票附件。",
            finish_reason="stop",
        )


class ExplodingSkillLoader:
    """Raises OUTSIDE the domain contract (not SkillLoaderError)."""

    def load(self, skill_id):
        raise RuntimeError("boom: unexpected loader crash")


# --- drivers -------------------------------------------------------------------


def _orchestrator(gateway, stream) -> ReimbursementOrchestrator:
    return ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )


def _collect(agen):
    async def _drive():
        return [frame async for frame in agen]

    return asyncio.run(_drive())


def _event_types(frames) -> list[str]:
    return [frame["event"].type for frame in frames if frame["type"] == "event"]


# --- happy path: real token streaming --------------------------------------------


def test_stream_create_emits_token_deltas_tool_frames_and_done_run():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, NarratedCollectingModelProvider())
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    frames = _collect(orchestrator.stream_created_advance(run, INPUT_TEXT))
    types = [frame["type"] for frame in frames]

    # Real token streaming: MULTIPLE text_delta frames, all before done.
    deltas = [f["text"] for f in frames if f["type"] == "text_delta"]
    assert deltas == ["正在校验报销草稿。", "草稿校验通过，还需要发票附件。"]
    done_index = types.index("done")
    assert all(i < done_index for i, t in enumerate(types) if t == "text_delta")

    # Exactly one terminal done frame, and it carries the final run.
    assert types.count("done") == 1
    assert frames[-1]["type"] == "done"
    final_run = frames[-1]["run"]
    assert final_run is run
    assert final_run.status == "collecting"
    assert final_run.agent_message == "草稿校验通过，还需要发票附件。"

    # The engine's run-less terminals never leak; no suspend happened.
    assert "awaiting_approval" not in types
    assert "exhausted" not in types
    assert "error" not in types

    # Audit event frames preserved, in append order — same trail as non-streaming.
    assert _event_types(frames) == [
        "reimbursement.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "reimbursement.policy.checked",
        "reimbursement.draft.validated",
        "model.call.started",
        "model.call.completed",
        "reimbursement.agent.message",
    ]
    assert [f["event"] for f in frames if f["type"] == "event"] == list(run.audit_events)

    # tool_start/tool_done wrap the tool round; the audited mcp.tool.called
    # event frame is flushed between them.
    tool_start_index = types.index("tool_start")
    tool_done_index = types.index("tool_done")
    assert frames[tool_start_index] == {
        "type": "tool_start",
        "name": "reimbursement.validate_draft",
    }
    assert frames[tool_done_index] == {
        "type": "tool_done",
        "name": "reimbursement.validate_draft",
    }
    mcp_index = next(
        i
        for i, f in enumerate(frames)
        if f["type"] == "event" and f["event"].type == "mcp.tool.called"
    )
    assert tool_start_index < mcp_index < tool_done_index


# --- approval suspend (the W6 acceptance) ------------------------------------------


def test_stream_create_forwards_awaiting_approval_frame_then_resume_works():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, StepwiseFakeModelProvider())
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    frames = _collect(orchestrator.stream_created_advance(run, INPUT_TEXT))
    types = [frame["type"] for frame in frames]

    # The tamper-evident audit pair precedes the FORWARDED suspend frame,
    # which precedes the terminal done frame.
    intent_index = next(
        i
        for i, f in enumerate(frames)
        if f["type"] == "event" and f["event"].type == "approval.intent.requested"
    )
    requested_index = next(
        i
        for i, f in enumerate(frames)
        if f["type"] == "event" and f["event"].type == "approval.requested"
    )
    approval_frame_index = types.index("awaiting_approval")
    done_index = types.index("done")
    assert intent_index < requested_index < approval_frame_index < done_index

    assert run.approval is not None
    assert frames[approval_frame_index] == {
        "type": "awaiting_approval",
        "reason": SUSPEND_REASON_AWAITING_APPROVAL,
        "detail": {"approval_id": run.approval.id},
    }

    # tool_start for submit_intent was already live; the suspend means no
    # tool_done follows it.
    assert [f["name"] for f in frames if f["type"] == "tool_start"] == [
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit_intent",
    ]
    assert [f["name"] for f in frames if f["type"] == "tool_done"] == [
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
    ]

    assert frames[-1]["type"] == "done"
    final_run = frames[-1]["run"]
    assert final_run is run
    assert final_run.status == "waiting_confirmation"
    assert final_run.approval is not None
    assert final_run.error_code is None

    # Suspend → resume is intact end-to-end: approve still submits + verifies.
    submitted = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )
    assert submitted.status == "completed"
    assert submitted.write_action is not None
    assert submitted.write_action.verify_status == "verified"
    assert gateway.submit_call_count == 1


# --- missing-fields suspend (park, not an approval prompt) --------------------------


def test_stream_missing_fields_park_swallows_suspend_and_answers_stream_resumes():
    stream = MissingFieldRecoveryModelProvider()
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, stream)
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    frames = _collect(orchestrator.stream_created_advance(run, INPUT_TEXT))
    types = [frame["type"] for frame in frames]

    # NOT an approval prompt: no awaiting_approval frame reaches the client;
    # the missing_fields.requested audit frame + collecting run carry the park.
    assert "awaiting_approval" not in types
    assert any(
        f["type"] == "event"
        and f["event"].type == "reimbursement.missing_fields.requested"
        and f["event"].payload["missing_fields"] == ["merchant"]
        for f in frames
    )
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"].status == "collecting"
    assert run.missing_fields == ["merchant"]

    # The ANSWERS stream advances across the park — streaming continues, all
    # the way to the forwarded approval suspend.
    answers = {"merchant": "上海交通服务"}
    run = orchestrator.begin_answer(run.id, answers)
    answer_frames = _collect(orchestrator.stream_answers_advance(run, answers))
    answer_types = [frame["type"] for frame in answer_frames]

    assert _event_types(answer_frames)[:2] == [
        "reimbursement.answers.received",
        "skill.loaded",
    ]
    assert answer_types.index("awaiting_approval") < answer_types.index("done")
    assert answer_frames[-1]["type"] == "done"
    recovered = answer_frames[-1]["run"]
    assert recovered.status == "waiting_confirmation"
    assert recovered.draft.merchant == "上海交通服务"
    assert recovered.approval is not None


# --- client disconnect (policy DIVERGES from finance W4) ----------------------------


def test_stream_client_disconnect_does_not_finalize_run():
    # Finance W4 fails an in-flight run as client_disconnected because its
    # in-flight states are not resumable. Reimbursement's parked states ARE
    # resumable (collecting → answers flow, waiting_confirmation →
    # approve_submit), so a disconnect must never finalize the run.
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, NarratedCollectingModelProvider())
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    async def _disconnect_after_first_delta():
        agen = orchestrator.stream_created_advance(run, INPUT_TEXT)
        async for frame in agen:
            if frame["type"] == "text_delta":
                break
        await agen.aclose()

    asyncio.run(_disconnect_after_first_delta())

    # Status unchanged (still the pre-park in-flight status), never failed.
    assert run.status == "validating"
    assert run.error_code is None
    assert not any(event.type == "reimbursement.failed" for event in run.audit_events)


def test_stream_disconnect_after_awaiting_approval_keeps_run_resumable():
    # The dangerous case the no-finalize policy exists for: a close right
    # after the suspend frame (before the done frame) must not destroy the
    # registered approval — approve_submit must still resume the run.
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, StepwiseFakeModelProvider())
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    async def _disconnect_after_suspend_frame():
        agen = orchestrator.stream_created_advance(run, INPUT_TEXT)
        async for frame in agen:
            if frame["type"] == "awaiting_approval":
                break
        await agen.aclose()

    asyncio.run(_disconnect_after_suspend_frame())

    assert run.status == "waiting_confirmation"
    assert run.approval is not None
    assert run.error_code is None

    submitted = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )
    assert submitted.status == "completed"
    assert submitted.write_action is not None
    assert submitted.write_action.verify_status == "verified"


def test_stream_disconnect_persists_parked_run_to_state_store(tmp_path):
    # Makes the GeneratorExit persist load-bearing: the two tests above run
    # with state_store=None, where _save_and_return is only an in-memory
    # re-register — they would pass even without the persist. Here the parked
    # run AND its approval must be readable back from the REAL store (via a
    # fresh store instance, so the orchestrator's in-memory registry cannot
    # satisfy the read).
    store_path = tmp_path / "anna-state.sqlite3"
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=_engine(StepwiseFakeModelProvider()),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    async def _disconnect_after_suspend_frame():
        agen = orchestrator.stream_created_advance(run, INPUT_TEXT)
        async for frame in agen:
            if frame["type"] == "awaiting_approval":
                break
        await agen.aclose()

    asyncio.run(_disconnect_after_suspend_frame())

    assert run.approval is not None
    restored = SQLiteReimbursementStateStore(store_path).get_run(run.id)
    assert restored is not None
    assert restored.status == "waiting_confirmation"
    assert restored.approval is not None
    assert restored.approval.id == run.approval.id
    by_approval = SQLiteReimbursementStateStore(store_path).get_run_by_approval_id(
        run.approval.id
    )
    assert by_approval is not None
    assert by_approval.id == run.id


# --- failure paths ------------------------------------------------------------------


def test_stream_preflight_failure_yields_failed_run_done_frame():
    class MissingConnectorGateway:
        settings = RuntimeSettings()

        def status(self):
            return {
                "status": "not_configured",
                "error_code": "connector_not_configured",
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError(
                "MCP tools must not be called when connector is missing"
            )

    stream = NarratedCollectingModelProvider()
    orchestrator = _orchestrator(MissingConnectorGateway(), stream)
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    frames = _collect(orchestrator.stream_created_advance(run, INPUT_TEXT))

    assert [frame["type"] for frame in frames] == ["event", "event", "event", "done"]
    assert _event_types(frames) == [
        "reimbursement.run.created",
        "skill.loaded",
        "reimbursement.failed",
    ]
    failed = frames[-1]["run"]
    assert failed.status == "failed"
    assert failed.error_code == "connector_not_configured"
    assert stream.requests == []


def test_stream_unexpected_exception_yields_error_frame():
    # Parity with the retired stream_run_action contract: audit frames streamed
    # so far, then a terminal {"type": "error", "message": ...} frame, no done.
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=_engine(NarratedCollectingModelProvider()),
        skill_loader=ExplodingSkillLoader(),
        settings=CONFIGURED_SETTINGS,
    )
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    frames = _collect(orchestrator.stream_created_advance(run, INPUT_TEXT))

    assert _event_types(frames) == ["reimbursement.run.created"]
    assert frames[-1]["type"] == "error"
    assert "boom" in frames[-1]["message"]
    assert all(frame["type"] != "done" for frame in frames)


# --- route-level SSE e2e ------------------------------------------------------------


def test_stream_route_serializes_engine_frames_and_awaiting_approval_as_sse():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, StepwiseFakeModelProvider())
    app = FastAPI()
    app.include_router(build_router(orchestrator))
    client = TestClient(app)

    response = client.post(
        "/api/cowork/reimbursements/runs/stream",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": INPUT_TEXT,
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
    assert "tool_start" in types
    assert "tool_done" in types

    # The serialized awaiting_approval frame reaches the CLIENT before done.
    approval_frame = next(f for f in frames if f["type"] == "awaiting_approval")
    assert approval_frame["reason"] == SUSPEND_REASON_AWAITING_APPROVAL
    approval_id = approval_frame["detail"]["approval_id"]
    requested_index = next(
        i
        for i, f in enumerate(frames)
        if f["type"] == "event" and f["event"]["type"] == "approval.requested"
    )
    assert requested_index < types.index("awaiting_approval") < types.index("done")

    # Terminal frame carries the serialized suspended run.
    assert frames[-1]["type"] == "done"
    run_payload = frames[-1]["run"]
    assert run_payload["status"] == "waiting_confirmation"
    assert run_payload["approval"]["id"] == approval_id

    # Audit event frames still flow to the trace timeline.
    event_types = [f["event"]["type"] for f in frames if f["type"] == "event"]
    assert "reimbursement.run.created" in event_types
    assert "approval.intent.requested" in event_types


# --- attachments through the create stream (route-level e2e) ------------------------


class AttachmentCreateFlowModelProvider(FakeStreamModel):
    """Create-run flow with an imported attachment echoed on the model draft:
    validate → create_draft → submit_intent (approval suspend)."""

    def __init__(self, attachment: dict | None = None) -> None:
        super().__init__()
        self.attachment = attachment

    def _draft(self) -> dict:
        return {**FULL_DRAFT, "attachments": [self.attachment]}

    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={"draft": self._draft()},
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 2:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={"draft": self._draft()},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": "EXT-DRAFT-001",
                        "amount": 128,
                        "currency": "CNY",
                        "reason": "ACME 项目差旅交通",
                        "policy_summary": "交通费在标准内",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class CapturingCreateDraftGateway(FakeReimbursementMcpGateway):
    """Reused fake gateway, additionally capturing the create_draft call args."""

    def __init__(self) -> None:
        super().__init__()
        self.create_draft_arguments = None

    def create_draft(self, **kwargs):
        self.create_draft_arguments = kwargs
        return super().create_draft(**kwargs)


def test_stream_create_with_attachments_materializes_content_for_mcp(tmp_path):
    # Streaming twin of test_create_draft_materializes_imported_attachment_
    # content_for_mcp (tests/api/test_reimbursement_attachments_api.py):
    # attachments supplied on the create-run STREAM request flow into the
    # draft via begin_run and reach the MCP materialized on create_draft,
    # while the SSE frames never leak the attachment bytes.
    content = b"receipt-bytes"
    sha256 = hashlib.sha256(content).hexdigest()
    settings = RuntimeSettings(
        model_endpoint="https://model.test/v1/chat/completions",
        model_api_key="test-key",
        state_db_path=str(tmp_path / "state.sqlite3"),
    )
    stream = AttachmentCreateFlowModelProvider()
    gateway = CapturingCreateDraftGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=QueryEngine(settings=settings, deps=QueryDeps(stream_model=stream)),
        settings=settings,
    )
    app = FastAPI()
    app.include_router(build_router(orchestrator))
    client = TestClient(app)

    attachment = client.post(
        "/api/cowork/reimbursements/attachments",
        headers={
            "X-Anna-Workspace-ID": "demo",
            "X-Anna-User-ID": "u_demo",
            "X-Anna-Attachment-Name": "receipt.pdf",
            "Content-Type": "application/octet-stream",
        },
        content=content,
    ).json()
    stream.attachment = attachment

    response = client.post(
        "/api/cowork/reimbursements/runs/stream",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "请帮我提交带发票的 ACME 项目交通费报销。",
            "attachments": [attachment],
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

    # The full tool flow ran live and the stream completed: exactly one
    # terminal done frame, preceded by the forwarded approval suspend.
    assert [f["name"] for f in frames if f["type"] == "tool_start"] == [
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit_intent",
    ]
    assert types.count("done") == 1
    assert frames[-1]["type"] == "done"
    assert types.index("awaiting_approval") < types.index("done")
    run_payload = frames[-1]["run"]
    assert run_payload["status"] == "waiting_confirmation"

    # The client-facing draft keeps only the imported reference…
    assert run_payload["draft"]["attachments"] == [
        {"name": "receipt.pdf", "uri": attachment["uri"]}
    ]

    # …while create_draft reached the MCP with the MATERIALIZED content —
    # the non-streaming twin's strongest assertion.
    assert gateway.create_draft_arguments is not None
    assert gateway.create_draft_arguments["draft"]["attachments"][0] == {
        "name": "receipt.pdf",
        "uri": attachment["uri"],
        "size_bytes": len(content),
        "sha256": sha256,
        "content_base64": base64.b64encode(content).decode("ascii"),
    }
    # Attachment bytes never leak into any SSE frame.
    assert "content_base64" not in response.text

    # Audit trail records the imported reference flow (same events as the
    # non-streaming path), streamed live as event frames.
    event_types = [f["event"]["type"] for f in frames if f["type"] == "event"]
    assert "reimbursement.draft.validated" in event_types
    assert "approval.requested" in event_types
    assert [
        f["event"]["payload"]["tool_name"]
        for f in frames
        if f["type"] == "event" and f["event"]["type"] == "mcp.tool.called"
    ] == ["reimbursement.validate_draft", "reimbursement.create_draft"]


def test_stream_answers_route_rejects_non_collecting_run_before_stream_opens():
    # The begin_answer gate runs BEFORE the StreamingResponse is constructed,
    # so answers streamed at a non-collecting run must be a plain HTTP 400 —
    # not a 200 SSE stream carrying an error frame.
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, StepwiseFakeModelProvider())
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text=INPUT_TEXT,
    )
    assert run.status == "waiting_confirmation"  # parked on approval, NOT collecting

    app = FastAPI()
    app.include_router(build_router(orchestrator))
    client = TestClient(app)

    response = client.post(
        f"/api/cowork/reimbursements/runs/{run.id}/answers/stream",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={"answers": {"merchant": "上海交通服务"}},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "run is not waiting for missing fields"
    assert not response.headers["content-type"].startswith("text/event-stream")
