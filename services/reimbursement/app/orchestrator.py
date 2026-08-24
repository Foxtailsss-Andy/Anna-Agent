from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Any

from services.mcp_gateway.app.reimbursement_adapter import (
    ReimbursementMcpError,
    ReimbursementMcpGateway,
)
from services.reimbursement.app.audit import AuditService
from services.reimbursement.app.capability import ReimbursementCapabilityHandler
from services.reimbursement.app.policy import ReimbursementPolicy
from services.reimbursement.app.schemas import (
    AttachmentRef,
    ReimbursementDraft,
    ReimbursementRun,
    ReimbursementWriteAction,
)
from services.reimbursement.app.state_store import ReimbursementStateStore
from services.runtime.app.base_orchestrator import BaseOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import Outcome
from services.runtime.app.engine.capability import (
    SUSPEND_REASON_AWAITING_APPROVAL,
    LoopOutcome,
)
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_engine import (
    SWALLOWED_ENGINE_TERMINALS,
    QueryEngine,
)
from services.runtime.app.event_stream import AuditFrameWatermark
from services.runtime.app.mcp_dispatcher import (
    McpToolDispatcher,
    connector_preflight_when_model_configured,
)
from services.runtime.app.model_provider import OpenAICompatibleModelProvider
from services.runtime.app.reimbursement_tool_registry import ReimbursementToolRegistry
from services.runtime.app.skill_loader import SkillLoader

MAX_MODEL_TOOL_ROUNDS = 6

USER_EDITABLE_DRAFT_FIELDS = frozenset(
    {
        "category",
        "amount",
        "currency",
        "expense_date",
        "merchant",
        "reason",
        "department_id",
        "cost_center_id",
        "project_id",
        "attachments",
    }
)


class ReimbursementOrchestrator(BaseOrchestrator):
    _fail_event_type = "reimbursement.failed"

    def __init__(
        self,
        adapter: ReimbursementMcpGateway | None = None,
        model_provider: OpenAICompatibleModelProvider | None = None,
        skill_loader: SkillLoader | None = None,
        tool_registry: ReimbursementToolRegistry | None = None,
        policy: ReimbursementPolicy | None = None,
        audit: AuditService | None = None,
        state_store: ReimbursementStateStore | None = None,
        settings: RuntimeSettings | None = None,
        engine: QueryEngine | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self.adapter = adapter or ReimbursementMcpGateway(self.settings)
        self.model_provider = model_provider or OpenAICompatibleModelProvider(self.settings)
        self.skill_loader = skill_loader or SkillLoader()
        self.tool_registry = tool_registry or ReimbursementToolRegistry()
        self.policy = policy or ReimbursementPolicy()
        self.audit = audit or AuditService()
        # The ReAct loop now runs on the shared platform engine. Default wires the
        # real governed streaming model (production_deps); tests inject a fake
        # stream_model via QueryEngine(deps=...).
        self.engine = engine or QueryEngine(self.settings)
        self.mcp_dispatcher = McpToolDispatcher(
            adapter=self.adapter,
            audit=self.audit,
            hash_payload=self._hash_payload,
            error_type=ReimbursementMcpError,
            error_contract=ReimbursementMcpError.as_contract,
        )
        self.state_store = state_store
        self._run_counter = state_store.max_run_sequence() if state_store else 0
        self._approval_counter = (
            state_store.max_approval_sequence() if state_store else 0
        )
        self._write_counter = state_store.max_write_sequence() if state_store else 0
        self._runs_by_id: dict[str, ReimbursementRun] = {}
        self._runs_by_approval_id: dict[str, ReimbursementRun] = {}

    def start_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        input_text: str,
        attachments: list[dict[str, Any]] | None = None,
    ) -> ReimbursementRun:
        run = self.begin_run(workspace_id, actor_user_id, input_text, attachments)
        return self.record_created_and_advance(run, input_text)

    def begin_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        input_text: str,
        attachments: list[dict[str, Any]] | None = None,
    ) -> ReimbursementRun:
        """Create and register a run record WITHOUT advancing.

        Split out so streamed runs can attach an audit observer before any
        ReAct step runs; ``start_run`` keeps its original behavior. Invoice
        attachments supplied at start are set on the draft so they flow into the
        model-built draft and reach the MCP (materialized) on create_draft.
        """
        draft = ReimbursementDraft()
        if attachments:
            draft.attachments = [
                AttachmentRef.model_validate(attachment) for attachment in attachments
            ]
            if any(
                not attachment.uri.startswith("anna://attachment/")
                for attachment in draft.attachments
            ):
                raise ValueError("attachments must be imported through Anna")
        run = ReimbursementRun(
            id=self._next_run_id(),
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            input_text=input_text,
            status="validating",
            draft=draft,
        )
        self._runs_by_id[run.id] = run
        return run

    def record_created_and_advance(
        self,
        run: ReimbursementRun,
        input_text: str,
    ) -> ReimbursementRun:
        """Emit the run.created event then run the ReAct loop and persist."""
        self._record_created(run, input_text)
        return self._save_and_return(self._advance_run(run))

    def _record_created(self, run: ReimbursementRun, input_text: str) -> None:
        """Record step shared by the streaming / non-streaming create entries."""
        self.audit.append(
            run.audit_events,
            "reimbursement.run.created",
            run.id,
            {"input_hash": self._hash_payload({"input": input_text})},
        )

    def answer_missing_fields(
        self,
        run_id: str,
        answers: dict[str, Any],
    ) -> ReimbursementRun:
        run = self.begin_answer(run_id, answers)
        return self.apply_answers_and_advance(run, answers)

    def begin_answer(
        self,
        run_id: str,
        answers: dict[str, Any],
    ) -> ReimbursementRun:
        """Validate that a run can accept answers; returns it without advancing."""
        run = self.get_run(run_id)
        if run is None:
            raise ValueError("run not found")
        if run.status != "collecting":
            raise ValueError("run is not waiting for missing fields")
        return run

    def apply_answers_and_advance(
        self,
        run: ReimbursementRun,
        answers: dict[str, Any],
    ) -> ReimbursementRun:
        """Apply supplied fields, record the event, then run the ReAct loop."""
        self._record_answers(run, answers)
        return self._save_and_return(self._advance_run(run))

    def _record_answers(self, run: ReimbursementRun, answers: dict[str, Any]) -> None:
        """Record step shared by the streaming / non-streaming answers entries."""
        self._apply_answers(run.draft, answers)
        run.status = "validating"
        self.audit.append(
            run.audit_events,
            "reimbursement.answers.received",
            run.id,
            {"answered_fields": sorted(answers.keys())},
        )

    def stream_created_advance(
        self,
        run: ReimbursementRun,
        input_text: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming twin of ``record_created_and_advance``.

        Runs the SAME ``_record_created`` step as the non-streaming entry
        (single source of truth for the audit payload), then drives the engine
        advance live — see ``_stream_advance`` for the frame contract.
        """
        return self._stream_advance(run, lambda: self._record_created(run, input_text))

    def stream_answers_advance(
        self,
        run: ReimbursementRun,
        answers: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming twin of ``apply_answers_and_advance``.

        Runs the SAME ``_record_answers`` step as the non-streaming entry
        (single source of truth for the field apply + audit payload), then
        drives the engine advance live — see ``_stream_advance`` for the frame
        contract. The route must gate the run through ``begin_answer`` first,
        mirroring the non-streaming ``answer_missing_fields`` pairing.
        """
        return self._stream_advance(run, lambda: self._record_answers(run, answers))

    async def _stream_advance(
        self,
        run: ReimbursementRun,
        record: Callable[[], None],
    ) -> AsyncIterator[dict[str, Any]]:
        """Drive one ReAct advance on the platform engine, yielding SSE frames.

        Shared body of ``stream_created_advance`` / ``stream_answers_advance``
        — same semantics as their non-streaming twins (record step → skill
        load + preflight → engine → outcome mapping → persist) but driven with
        ``async for`` in THIS task (no ``asyncio.run``, no worker thread), so
        engine process events reach the client live.

        Yields frame dicts for the SSE route to serialize:

        * ``{"type": "event", "event": <AuditEvent>}`` — every audit event
          appended to ``run.audit_events`` during the advance, in append order
          (watermark flush: before each engine frame, then once after the
          engine finishes). The frontend renders these as the trace timeline.
        * engine process frames forwarded as-is — ``text_delta`` (real token
          streaming), ``tool_start`` / ``tool_done``.
        * ``{"type": "awaiting_approval", "reason", "detail"}`` — forwarded
          verbatim ONLY when ``reason`` is ``SUSPEND_REASON_AWAITING_APPROVAL``
          (additive frame, spec §5; ``detail`` carries the ``approval_id``).
          A ``SUSPEND_REASON_MISSING_FIELDS`` suspend is NOT forwarded — it is
          not an approval prompt; the ``reimbursement.missing_fields.requested``
          audit event frame plus the done run with status ``collecting`` carry
          the semantics, exactly like the old SSE stream. Either suspend is
          TERMINAL for this advance: the run was already parked by the handler
          (``waiting_confirmation`` / ``collecting``) and the done frame below
          carries it.
        * exactly one terminal ``{"type": "done", "run": <run>}``. The engine's
          own run-less terminals (``done``/``exhausted``/``error``) are
          swallowed; their outcome is mapped onto the run via
          ``_resolve_outcome`` and persisted via ``_save_and_return`` — the
          same mapping the non-streaming advance uses.
        * on an unexpected raise: pending audit frames, then a terminal
          ``{"type": "error", "message": ...}`` and no done frame / no persist
          (the legacy ``stream_run_action`` error contract — still live on
          approve/stream; the non-streaming twins likewise raise before
          reaching ``_save_and_return``).

        Client-disconnect policy — DIVERGES from finance W4: on
        ``GeneratorExit`` the run is NOT finalized. Finance's in-flight states
        are not resumable, so W4 fails them as ``client_disconnected``;
        reimbursement's parked states are resumable out-of-band
        (``collecting`` → the answers flow gates on ``collecting``;
        ``waiting_confirmation`` → ``approve_submit``) AND double as this
        generator's healthy end states — a close at the done frame is
        indistinguishable from a mid-flight close, so finalizing would destroy
        a resumable run (e.g. a registered approval awaiting
        ``approve_submit``). The pre-park transients (``validating``,
        ``draft_created``) may linger if the client disconnects mid-model-call;
        they are inert (list/get only, no write path) and a user simply starts
        a new run. The run is persisted as-is so a parked state survives
        (mutate only — never yield after GeneratorExit).
        """
        # Start past any prior-advance history (skip_history=True): only
        # events appended during THIS advance stream as frames (the answers
        # stream resumes a run that already carries the first advance's trail
        # — the old stream_run_action likewise seeded its NotifyingList so
        # history was never re-emitted). See AuditFrameWatermark for the
        # in-place append contract run.audit_events must honor.
        watermark = AuditFrameWatermark(run.audit_events, skip_history=True)

        try:
            record()
            handler, config, failed_run = self._prepare_advance(run)
            if failed_run is not None:
                self._save_and_return(failed_run)
                for frame in watermark.new_frames():
                    yield frame
                yield {"type": "done", "run": failed_run}
                return
            # Flush the record step's event + skill.loaded before the first
            # (slow) model call.
            for frame in watermark.new_frames():
                yield frame

            outcome = Outcome()
            async for event in self.engine.run(
                config, handler, run.id, run.audit_events, outcome
            ):
                for frame in watermark.new_frames():
                    yield frame
                event_type = event.get("type")
                if event_type == "awaiting_approval":
                    # The engine emits ONE suspend event type for every
                    # CapabilitySuspend reason; only a true approval prompt is
                    # a client-visible frame — any other reason (today:
                    # SUSPEND_REASON_MISSING_FIELDS) is swallowed (see
                    # docstring). Both reasons are terminal — fall through to
                    # the done frame below.
                    if event.get("reason") == SUSPEND_REASON_AWAITING_APPROVAL:
                        yield event
                    continue
                if event_type in SWALLOWED_ENGINE_TERMINALS:
                    continue
                yield event
            assert outcome.value is not None  # a fully-drained stream always sets it
            final_run = self._save_and_return(
                self._resolve_outcome(run, outcome.value)
            )
            for frame in watermark.new_frames():
                yield frame
            yield {"type": "done", "run": final_run}
        except GeneratorExit:
            # Client disconnect / stop button: do NOT finalize (see docstring);
            # persist the run as-is so a parked (resumable) state survives.
            self._save_and_return(run)
            raise
        except Exception as exc:  # noqa: BLE001 — surface as a stream error frame
            for frame in watermark.new_frames():
                yield frame
            yield {"type": "error", "message": str(exc)}

    def _advance_run(self, run: ReimbursementRun) -> ReimbursementRun:
        """Drive one ReAct advance on the platform engine.

        Each advance = one fresh ``QueryEngine.run`` whose initial request the
        handler rebuilds from the CURRENT run state (prior answers/draft
        context included), exactly as the old hand-rolled loop rebuilt its
        messages per ``_advance_run`` entry.
        """
        handler, config, failed_run = self._prepare_advance(run)
        if failed_run is not None:
            return failed_run
        outcome = self.engine.run_to_outcome(config, handler, run.id, run.audit_events)
        return self._resolve_outcome(run, outcome)

    def _prepare_advance(
        self, run: ReimbursementRun
    ) -> tuple[
        ReimbursementCapabilityHandler | None,
        QueryConfig | None,
        ReimbursementRun | None,
    ]:
        """Load the skill, preflight, and build the engine inputs for one advance.

        Returns ``(handler, config, None)`` when the run may advance, or
        ``(None, None, failed_run)`` when skill load / connector preflight
        already failed it. Preflight and the ``skill.loaded`` audit stay here,
        BEFORE the engine runs — the engine loop has no preflight step.
        """
        skill, failed_run = self._load_skill_and_record(
            run,
            self.settings.reimbursement_skill_id,
        )
        if skill is None:
            return None, None, failed_run

        connector_error, mcp_status = self._mcp_connector_preflight()
        if connector_error is not None:
            return None, None, self._fail_run(
                run, connector_error[0], connector_error[1]
            )

        handler = ReimbursementCapabilityHandler(
            orchestrator=self,
            boss_directive=self.settings.agent_directive("reimbursement"),
            skill=skill,
            mcp_status=mcp_status,
            run=run,
        )
        # The engine reads tools off the handler's (memoized) initial request;
        # QueryConfig.tools mirrors them for completeness (the loop itself does
        # not read config.tools).
        config = QueryConfig(
            run_id=run.id,
            skill_id=skill.id,
            tools=handler.build_initial_request().tools,
            max_turns=MAX_MODEL_TOOL_ROUNDS,
            config_error_message=(
                "model endpoint and API key are required before running Anna reimbursement agent"
            ),
        )
        return handler, config, None

    def _resolve_outcome(
        self, run: ReimbursementRun, outcome: LoopOutcome
    ) -> ReimbursementRun:
        """Map the engine's terminal ``LoopOutcome`` onto the reimbursement run."""
        if outcome.status in {"completed", "suspended"}:
            # completed: on_assistant_final already parked the run (collecting +
            # agent message audit). suspended: dispatch_tool already parked it —
            # waiting_confirmation + approval (awaiting_approval) or collecting +
            # missing fields (missing_fields). Neither is a failure.
            return run
        if outcome.status == "exhausted":
            return self._fail_run(
                run,
                "tool_loop_exhausted",
                "model tool loop exceeded the maximum number of rounds",
            )
        return self._fail_run(
            run,
            outcome.error_code or "model_call_failed",
            outcome.message or "",
        )

    def _mcp_connector_preflight(
        self,
    ) -> tuple[tuple[str, str] | None, dict[str, Any] | None]:
        return connector_preflight_when_model_configured(
            self.model_provider.settings,
            self.adapter,
            not_connected_message="reimbursement MCP connector is not connected",
        )

    def approve_submit(self, approval_id: str, approved_by: str) -> ReimbursementRun:
        run = self.get_run_by_approval_id(approval_id)
        if run is None or run.approval is None:
            raise ValueError("approval request not found")
        if run.write_action is not None:
            return run
        if run.approval.status not in {"pending", "approved"}:
            raise ValueError("approval request is not pending")
        if run.approval.status == "approved" and not self._last_submit_failure_retryable(run):
            raise ValueError("submit failure is not retryable")
        if not run.draft.external_reimbursement_id:
            raise ValueError("external draft is required before submit")
        if not self._approval_payload_matches_current_draft(run):
            raise ValueError("approval payload does not match current draft")

        first_approval = run.approval.status == "pending"
        run.approval.status = "approved"
        run.status = "submitting"
        if first_approval:
            self.audit.append(
                run.audit_events,
                "approval.approved",
                run.id,
                {
                    "approval_id": approval_id,
                    "approved_by": approved_by,
                    "approval_payload_hash": run.approval.payload_hash,
                    "draft_snapshot_hash": run.approval.draft_snapshot_hash,
                },
            )
        else:
            self.audit.append(
                run.audit_events,
                "approval.submit.retry_requested",
                run.id,
                {
                    "approval_id": approval_id,
                    "approved_by": approved_by,
                    "approval_payload_hash": run.approval.payload_hash,
                    "draft_snapshot_hash": run.approval.draft_snapshot_hash,
                },
            )
        try:
            submit_result = self.adapter.submit(
                workspace_id=run.workspace_id,
                actor_user_id=run.actor_user_id,
                source_run_id=run.id,
                confirmation_id=run.approval.id,
                idempotency_key=self.policy.submit_idempotency_key(run.id),
                external_reimbursement_id=run.draft.external_reimbursement_id,
                expected_draft_snapshot=run.approval.draft_snapshot,
                expected_draft_snapshot_hash=run.approval.draft_snapshot_hash,
            )
        except ReimbursementMcpError as exc:
            return self._save_and_return(
                self._fail_tool_call(
                    run,
                    "reimbursement.submit",
                    {
                        "approval_id": run.approval.id,
                        "external_reimbursement_id": run.draft.external_reimbursement_id,
                    },
                    exc,
                )
            )
        self._record_tool_call(
            run,
            "reimbursement.submit",
            {
                "approval_id": run.approval.id,
                "external_reimbursement_id": run.draft.external_reimbursement_id,
            },
            "success",
        )
        run.draft.external_reimbursement_id = submit_result[
            "external_reimbursement_id"
        ]
        run.draft.external_status = submit_result["external_status"]
        run.write_action = ReimbursementWriteAction(
            id=self._next_write_id(),
            run_id=run.id,
            approval_id=approval_id,
            external_reimbursement_id=run.draft.external_reimbursement_id,
            idempotency_key=self.policy.submit_idempotency_key(run.id),
            status="success",
            verify_status="verify_pending",
            approval_payload_hash=run.approval.payload_hash,
            draft_snapshot_hash=run.approval.draft_snapshot_hash,
        )
        self.audit.append(
            run.audit_events,
            "reimbursement.submitted",
            run.id,
            {
                "approval_id": run.approval.id,
                "write_action_id": run.write_action.id,
                "approval_payload_hash": run.approval.payload_hash,
                "draft_snapshot_hash": run.approval.draft_snapshot_hash,
                "external_reimbursement_id": run.draft.external_reimbursement_id,
                "external_status": run.draft.external_status,
            },
        )
        return self.retry_verify(run.id)

    def reject_submit(self, approval_id: str, rejected_by: str) -> ReimbursementRun:
        run = self.get_run_by_approval_id(approval_id)
        if run is None or run.approval is None:
            raise ValueError("approval request not found")
        if run.approval.status != "pending":
            raise ValueError("approval request is not pending")
        run.approval.status = "rejected"
        run.status = "draft_created"
        self.audit.append(
            run.audit_events,
            "approval.rejected",
            run.id,
            {"approval_id": approval_id, "rejected_by": rejected_by},
        )
        return self._save_and_return(run)

    def retry_verify(self, run_id: str) -> ReimbursementRun:
        run = self.get_run(run_id)
        if run is None:
            raise ValueError("run not found")
        if run.write_action is None:
            raise ValueError("write action is required before verify")
        if not run.draft.external_reimbursement_id:
            raise ValueError("external reimbursement id is required before verify")

        run.status = "verifying"
        tool_input = {"external_reimbursement_id": run.draft.external_reimbursement_id}
        try:
            status = self.adapter.get_status(
                run.workspace_id,
                run.actor_user_id,
                run.draft.external_reimbursement_id,
            )
        except ReimbursementMcpError as exc:
            return self._save_and_return(
                self._fail_tool_call(run, "reimbursement.get_status", tool_input, exc)
            )
        self._record_tool_call(run, "reimbursement.get_status", tool_input, "success")
        readback_external_id = status.get("external_reimbursement_id")
        readback_external_status = status.get("external_status")
        verify_status = (
            "verified"
            if readback_external_id == run.draft.external_reimbursement_id
            and readback_external_status == run.draft.external_status
            else "verify_pending"
        )
        run.write_action.verify_status = verify_status
        run.status = "completed" if verify_status == "verified" else "verify_pending"
        self.audit.append(
            run.audit_events,
            "reimbursement.verified",
            run.id,
            {
                "external_reimbursement_id": run.draft.external_reimbursement_id,
                "external_status": run.draft.external_status,
                "readback_external_reimbursement_id": readback_external_id,
                "readback_external_status": readback_external_status,
                "verify_status": verify_status,
            },
        )
        return self._save_and_return(run)

    def get_run(self, run_id: str) -> ReimbursementRun | None:
        run = self._runs_by_id.get(run_id)
        if run is not None:
            return run
        if self.state_store is None:
            return None
        run = self.state_store.get_run(run_id)
        if run is not None:
            self._remember_run(run)
        return run

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[ReimbursementRun]:
        if self.state_store is not None:
            runs = self.state_store.list_runs(workspace_id, actor_user_id)
            for run in runs:
                self._remember_run(run)
            return runs
        return [
            run
            for run in reversed(list(self._runs_by_id.values()))
            if run.workspace_id == workspace_id and run.actor_user_id == actor_user_id
        ]

    def get_run_by_approval_id(self, approval_id: str) -> ReimbursementRun | None:
        run = self._runs_by_approval_id.get(approval_id)
        if run is not None:
            return run
        if self.state_store is None:
            return None
        run = self.state_store.get_run_by_approval_id(approval_id)
        if run is not None:
            self._remember_run(run)
        return run

    def get_write_action(self, write_action_id: str) -> ReimbursementWriteAction | None:
        for run in self._runs_by_id.values():
            if run.write_action and run.write_action.id == write_action_id:
                return run.write_action
        if self.state_store is not None:
            return self.state_store.get_write_action(write_action_id)
        return None

    def _save_and_return(self, run: ReimbursementRun) -> ReimbursementRun:
        self._remember_run(run)
        if self.state_store is not None:
            self.state_store.save_run(run)
        return run

    def _remember_run(self, run: ReimbursementRun) -> None:
        self._runs_by_id[run.id] = run
        if run.approval is not None:
            self._runs_by_approval_id[run.approval.id] = run

    def _approval_payload_matches_current_draft(self, run: ReimbursementRun) -> bool:
        if run.approval is None:
            return False
        if run.approval.action_type != "reimbursement.submit":
            return False
        payload = run.approval.payload
        if (
            run.approval.payload_hash
            and run.approval.payload_hash != self._approval_payload_hash(payload)
        ):
            return False
        if (
            run.approval.draft_snapshot_hash
            and run.approval.draft_snapshot is not None
            and run.approval.draft_snapshot_hash
            != self._draft_hash(run.approval.draft_snapshot)
        ):
            return False
        if (
            run.approval.draft_snapshot_hash
            and run.approval.draft_snapshot_hash
            != self._draft_hash(run.draft.as_mcp_payload())
        ):
            return False
        if (
            run.approval.draft_snapshot is not None
            and run.approval.draft_snapshot != run.draft.as_mcp_payload()
        ):
            return False
        expected = {
            "external_reimbursement_id": run.draft.external_reimbursement_id,
            "amount": run.draft.amount,
            "currency": run.draft.currency,
            "reason": run.draft.reason,
        }
        return all(payload.get(key) == value for key, value in expected.items())

    def _apply_answers(self, draft: ReimbursementDraft, answers: dict[str, Any]) -> None:
        for field in answers:
            if field not in USER_EDITABLE_DRAFT_FIELDS:
                raise ValueError(f"field is not user-editable: {field}")
        for field, value in answers.items():
            if field == "attachments":
                attachments = [
                    AttachmentRef.model_validate(attachment) for attachment in value
                ]
                if any(
                    not attachment.uri.startswith("anna://attachment/")
                    for attachment in attachments
                ):
                    raise ValueError("attachments must be imported through Anna")
                draft.attachments = attachments
            else:
                setattr(draft, field, value)

    def _record_tool_call(
        self,
        run: ReimbursementRun,
        tool_name: str,
        tool_input: dict[str, Any],
        status: str,
    ) -> None:
        self.mcp_dispatcher.record_tool_called(
            run.audit_events,
            run.id,
            tool_name,
            tool_input,
            status,
        )

    def _last_submit_failure_retryable(self, run: ReimbursementRun) -> bool:
        for event in reversed(run.audit_events):
            if (
                event.type == "mcp.tool.called"
                and event.payload.get("tool_name") == "reimbursement.submit"
            ):
                error = event.payload.get("error")
                return (
                    event.payload.get("status") == "failed"
                    and isinstance(error, dict)
                    and error.get("retryable") is True
                )
        return False

    def _fail_tool_call(
        self,
        run: ReimbursementRun,
        tool_name: str,
        tool_input: dict[str, Any],
        error: ReimbursementMcpError,
    ) -> ReimbursementRun:
        self.mcp_dispatcher.record_tool_called(
            run.audit_events,
            run.id,
            tool_name,
            tool_input,
            "failed",
            error=error.as_contract(),
        )
        return self._fail_run(run, error.error_code, error.message)

    def _draft_hash(self, draft: dict[str, Any]) -> str:
        return self._hash_payload({"draft": draft})

    def _approval_payload_hash(self, payload: dict[str, Any]) -> str:
        return self._hash_payload({"approval_payload": payload})
