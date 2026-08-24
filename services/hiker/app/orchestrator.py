from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from services.hiker.app.capability import HikerCapabilityHandler
from services.hiker.app.schemas import (
    HikerAgingBucket,
    HikerAnomaly,
    HikerAssistantRun,
    HikerCollectionProgress,
    HikerCustomerRow,
    HikerDashboardRun,
    HikerDashboardSnapshot,
    HikerKpi,
)
from services.mcp_gateway.app.hiker_adapter import HikerMcpError, HikerMcpGateway
from services.reimbursement.app.audit import AuditService
from services.runtime.app.base_orchestrator import BaseOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import Outcome
from services.runtime.app.engine.capability import LoopOutcome
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_engine import (
    SWALLOWED_ENGINE_TERMINALS,
    QueryEngine,
)
from services.runtime.app.event_stream import AuditFrameWatermark
from services.runtime.app.hiker_tool_registry import HikerToolRegistry
from services.runtime.app.mcp_dispatcher import (
    McpToolDispatcher,
    connector_preflight_when_model_configured,
)
from services.runtime.app.model_provider import OpenAICompatibleModelProvider
from services.runtime.app.skill_loader import SkillLoader


MAX_HIKER_MODEL_TOOL_ROUNDS = 6


def _money(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


class HikerOrchestrator(BaseOrchestrator):
    _fail_event_type = "hiker.dashboard.failed"
    _run_id_prefix = "hiker_run_"

    def __init__(
        self,
        adapter: HikerMcpGateway | None = None,
        model_provider: OpenAICompatibleModelProvider | None = None,
        skill_loader: SkillLoader | None = None,
        tool_registry: HikerToolRegistry | None = None,
        audit: AuditService | None = None,
        settings: RuntimeSettings | None = None,
        engine: QueryEngine | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self.adapter = adapter or HikerMcpGateway(self.settings)
        self.model_provider = model_provider or OpenAICompatibleModelProvider(self.settings)
        self.skill_loader = skill_loader or SkillLoader()
        self.tool_registry = tool_registry or HikerToolRegistry()
        self.audit = audit or AuditService()
        # The assistant ReAct loop now runs on the shared platform engine.
        # Default wires the real governed streaming model (production_deps);
        # tests inject a fake stream_model via QueryEngine(deps=...).
        self.engine = engine or QueryEngine(self.settings)
        self.mcp_dispatcher = McpToolDispatcher(
            adapter=self.adapter,
            audit=self.audit,
            hash_payload=self._hash_payload,
            error_type=HikerMcpError,
            error_contract=HikerMcpError.as_contract,
        )
        self._run_counter = 0
        self._assistant_counter = 0
        self._dashboard_runs: dict[str, HikerDashboardRun] = {}
        self._assistant_runs: dict[str, HikerAssistantRun] = {}

    # ---- shared MCP args -------------------------------------------------
    def _base_args(self, run_id: str, actor_user_id: str) -> dict[str, Any]:
        # Hiker validates `actor_user_id` against ITS OWN users (admin/sales/finance)
        # and rejects unknown ones with `permission_denied`. Anna's local session
        # user (e.g. "local-<name>") is not a Hiker user, so every Hiker MCP call
        # uses the configured Hiker default actor. The Anna `actor_user_id` is kept
        # for Anna-side run ownership/audit only, never forwarded to Hiker.
        return {
            "request_id": run_id,
            "actor_user_id": self.settings.hiker_default_actor,
        }

    # ---- dashboard (deterministic, no model) -----------------------------
    def start_dashboard_run(self, workspace_id: str, actor_user_id: str) -> HikerDashboardRun:
        run = HikerDashboardRun(
            id=self._next_run_id(),
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            status="validating",
        )
        self._dashboard_runs[run.id] = run
        self.audit.append(run.audit_events, "hiker.dashboard.run.created", run.id, {})

        status = self.adapter.status()
        if status.get("status") != "connected":
            return self._fail_run(
                run,
                str(status.get("error_code") or "mcp_connector_not_ready"),
                str(status.get("message") or "Hiker MCP connector is not connected"),
            )
        try:
            snapshot = self._collect_snapshot(run)
        except HikerMcpError as exc:
            return self._fail_run(run, exc.error_code, exc.message)

        run.snapshot = snapshot
        run.status = "ready"
        self.audit.append(
            run.audit_events,
            "hiker.dashboard.generated",
            run.id,
            {"kpi_count": len(snapshot.kpis), "anomaly_count": len(snapshot.anomalies)},
        )
        return run

    def _collect_snapshot(self, run: HikerDashboardRun) -> HikerDashboardSnapshot:
        args = self._base_args(run.id, run.actor_user_id)
        dashboard = self.mcp_dispatcher.call_tool_audited(
            run.audit_events, run.id, "hiker.report.get_dashboard_summary", {}, dict(args)
        ).get("data", {})
        collection = self.mcp_dispatcher.call_tool_audited(
            run.audit_events, run.id, "hiker.report.get_collection_summary", {}, dict(args)
        ).get("data", {})
        country = self.mcp_dispatcher.call_tool_audited(
            run.audit_events, run.id, "hiker.master_data.search", {"types": ["country"]},
            {**args, "types": ["country"], "limit": 50},
        ).get("data", {})

        customers_rows = ((collection.get("customers") or {}).get("rows")) or []
        country_count = len((country.get("items") or []))

        kpis = [
            HikerKpi(id="contract_count", label="合同数", value=_money(dashboard.get("contract_count")), unit="个"),
            HikerKpi(id="contract_amount", label="合同总额", value=_money(dashboard.get("contract_amount")), unit="¥"),
            HikerKpi(id="planned_receipt", label="计划收款", value=_money(dashboard.get("planned_receipt_amount")), unit="¥"),
            HikerKpi(id="actual_receipt", label="实际收款", value=_money(dashboard.get("actual_receipt_amount")), unit="¥"),
            HikerKpi(id="unreceived", label="未收款", value=_money(dashboard.get("unreceived_amount")), unit="¥"),
            HikerKpi(id="customer_count", label="客户数", value=float(len(customers_rows)), unit="个"),
            HikerKpi(id="country_count", label="覆盖国家", value=float(country_count), unit="个"),
        ]

        progress = HikerCollectionProgress(
            planned_amount=_money(dashboard.get("planned_receipt_amount")),
            actual_amount=_money(dashboard.get("actual_receipt_amount")),
            unreceived_amount=_money(dashboard.get("unreceived_amount")),
        )

        aging_summary = (collection.get("aging") or {}).get("summary") or {}
        aging_buckets = [
            HikerAgingBucket(id="not_due", label="未到期",
                             count=int(aging_summary.get("not_due_count") or 0), amount=_money(aging_summary.get("not_due_amount"))),
            HikerAgingBucket(id="overdue_1_30", label="逾期 1-30",
                             count=int(aging_summary.get("overdue_1_30_count") or 0), amount=_money(aging_summary.get("overdue_1_30_amount"))),
            HikerAgingBucket(id="overdue_31_60", label="逾期 31-60",
                             count=int(aging_summary.get("overdue_31_60_count") or 0), amount=_money(aging_summary.get("overdue_31_60_amount"))),
            HikerAgingBucket(id="overdue_61_90", label="逾期 61-90",
                             count=int(aging_summary.get("overdue_61_90_count") or 0), amount=_money(aging_summary.get("overdue_61_90_amount"))),
            HikerAgingBucket(id="overdue_90_plus", label="逾期 90+",
                             count=int(aging_summary.get("overdue_90_plus_count") or 0), amount=_money(aging_summary.get("overdue_90_plus_amount"))),
        ]

        risk_summary = (collection.get("risk") or {}).get("summary") or {}
        top_customers = sorted(
            (
                HikerCustomerRow(
                    customer_name=str(row.get("customer_name") or ""),
                    contract_count=int(row.get("contract_count") or 0),
                    contract_amount=_money(row.get("contract_amount")),
                    planned_receipt_amount=_money(row.get("planned_receipt_amount")),
                    actual_receipt_amount=_money(row.get("actual_receipt_amount")),
                    unreceived_amount=_money(row.get("unreceived_amount")),
                )
                for row in customers_rows
            ),
            key=lambda c: c.contract_amount,
            reverse=True,
        )[:5]

        snapshot = HikerDashboardSnapshot(
            kpis=kpis,
            collection=progress,
            aging_buckets=aging_buckets,
            risk_due_soon_count=int(risk_summary.get("due_soon_count") or 0),
            risk_overdue_count=int(risk_summary.get("overdue_count") or 0),
            top_customers=top_customers,
            anomalies=_detect_anomalies(dashboard, collection, top_customers),
        )
        return snapshot

    # ---- assistant (model ReAct, streamable) -----------------------------
    def begin_assistant_run(self, workspace_id: str, actor_user_id: str, question: str) -> HikerAssistantRun:
        run = HikerAssistantRun(
            id=self._next_assistant_run_id(),
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            question=question,
            status="validating",
        )
        self._assistant_runs[run.id] = run
        return run

    def record_assistant_created_and_advance(self, run: HikerAssistantRun, question: str) -> HikerAssistantRun:
        self._record_assistant_created(run, question)
        return self._advance_assistant_run(run)

    def _record_assistant_created(self, run: HikerAssistantRun, question: str) -> None:
        """Record step shared by the streaming / non-streaming entries."""
        self.audit.append(
            run.audit_events,
            "hiker.assistant.run.created",
            run.id,
            {"question_hash": self._hash_payload({"question": question})},
        )

    def start_assistant_run(self, workspace_id: str, actor_user_id: str, question: str) -> HikerAssistantRun:
        run = self.begin_assistant_run(workspace_id, actor_user_id, question)
        return self.record_assistant_created_and_advance(run, question)

    def _advance_assistant_run(self, run: HikerAssistantRun) -> HikerAssistantRun:
        handler, config, failed_run = self._prepare_assistant_advance(run)
        if failed_run is not None:
            return failed_run
        outcome = self.engine.run_to_outcome(config, handler, run.id, run.audit_events)
        return self._resolve_assistant_outcome(run, outcome)

    def _prepare_assistant_advance(
        self, run: HikerAssistantRun
    ) -> tuple[
        HikerCapabilityHandler | None,
        QueryConfig | None,
        HikerAssistantRun | None,
    ]:
        """Load the skill, preflight, and build the engine inputs for one run.

        Returns ``(handler, config, None)`` when the run may advance, or
        ``(None, None, failed_run)`` when skill load / connector preflight
        already failed it. Preflight and the ``skill.loaded`` audit stay here,
        BEFORE the engine runs — the engine loop has no preflight step.
        """
        skill, failed = self._load_skill_and_record(
            run, self.settings.hiker_assistant_skill_id, fail_run=self._fail_assistant_run
        )
        if skill is None:
            return None, None, failed

        preflight_error, _mcp_status = connector_preflight_when_model_configured(
            self.model_provider.settings,
            self.adapter,
            not_connected_message="Hiker MCP connector is not connected",
        )
        if preflight_error is not None:
            return None, None, self._fail_assistant_run(
                run, preflight_error[0], preflight_error[1]
            )

        handler = HikerCapabilityHandler(
            skill=skill,
            run=run,
            tool_registry=self.tool_registry,
            mcp_dispatcher=self.mcp_dispatcher,
            audit=self.audit,
            base_args=self._base_args(run.id, run.actor_user_id),
            boss_directive=self.settings.agent_directive("hiker"),
        )
        # The engine reads tools off the handler's (memoized) initial request;
        # QueryConfig.tools mirrors them for completeness (the loop itself does
        # not read config.tools).
        config = QueryConfig(
            run_id=run.id,
            skill_id=skill.id,
            tools=handler.build_initial_request().tools,
            max_turns=MAX_HIKER_MODEL_TOOL_ROUNDS,
            config_error_message=(
                "model endpoint and API key are required before running Anna Hiker assistant"
            ),
        )
        return handler, config, None

    def _resolve_assistant_outcome(
        self, run: HikerAssistantRun, outcome: LoopOutcome
    ) -> HikerAssistantRun:
        """Map the engine's terminal ``LoopOutcome`` onto the assistant run."""
        if outcome.status == "completed":
            # The handler already set run.status/answer/agent_message and
            # emitted the terminal audit (hiker.assistant.answered).
            return run
        if outcome.status == "exhausted":
            return self._fail_assistant_run(
                run,
                "tool_loop_exhausted",
                "Hiker assistant tool loop exceeded max rounds",
            )
        if outcome.status == "suspended":
            # Hiker handlers never suspend (HikerCapabilityHandler raises no
            # CapabilitySuspend); falling through would mislabel a healthy
            # paused run as failed and drop the suspend reason. Fail loudly
            # at the mapping site.
            raise RuntimeError(
                "hiker assistant outcome mapping does not support 'suspended'"
                " — add explicit handling before introducing CapabilitySuspend"
                " to a hiker handler"
            )
        return self._fail_assistant_run(
            run,
            outcome.error_code or "model_call_failed",
            outcome.message or "",
        )

    async def stream_assistant_advance(
        self,
        run: HikerAssistantRun,
        question: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """Drive the assistant ReAct loop on the platform engine, yielding SSE frames.

        The streaming twin of ``record_assistant_created_and_advance`` — same
        semantics (run.created audit → skill load + preflight → engine →
        outcome mapping) but driven with ``async for`` in THIS task (no
        ``asyncio.run``, no worker thread), so engine process events reach the
        client live.

        Yields frame dicts for the SSE route to serialize:

        * ``{"type": "event", "event": <AuditEvent>}`` — every audit event
          appended to ``run.audit_events`` during the advance, in append order
          (watermark flush: before each engine frame, then once after the
          engine finishes). The frontend renders these as the trace timeline.
        * engine process frames forwarded as-is — ``text_delta`` (real token
          streaming), ``tool_start`` / ``tool_done``.
        * exactly one terminal ``{"type": "done", "run": <run>}``. The engine's
          own run-less terminals (``SWALLOWED_ENGINE_TERMINALS``) are
          swallowed; their outcome is mapped onto the run via
          ``_resolve_assistant_outcome`` — the same mapping the non-streaming
          advance uses.
        * on an unexpected raise: pending audit frames, then a terminal
          ``{"type": "error", "message": ...}`` (the retired
          ``stream_run_action`` contract).

        Client-disconnect ruling — FINANCE-STYLE (finalize): a
        ``HikerAssistantRun`` is only ever ``validating`` / ``ready`` /
        ``failed`` — hiker has no parked, resumable state (contrast
        reimbursement's ``collecting`` / ``waiting_confirmation``) and no
        public entry re-advances an existing assistant run. A close mid-model
        call would therefore strand the run non-terminal forever, so
        ``GeneratorExit`` finalizes an in-flight run as ``failed`` /
        ``client_disconnected``; a close after the done frame must not
        overwrite a terminal run.
        """
        # Shared watermark cursor (see AuditFrameWatermark for the in-place
        # append contract run.audit_events must honor during the advance).
        watermark = AuditFrameWatermark(run.audit_events)

        try:
            self._record_assistant_created(run, question)
            handler, config, failed_run = self._prepare_assistant_advance(run)
            if failed_run is not None:
                for frame in watermark.new_frames():
                    yield frame
                yield {"type": "done", "run": failed_run}
                return
            # Flush run.created + skill.loaded before the first (slow) model call.
            for frame in watermark.new_frames():
                yield frame

            outcome = Outcome()
            async for event in self.engine.run(
                config, handler, run.id, run.audit_events, outcome
            ):
                for frame in watermark.new_frames():
                    yield frame
                if event.get("type") in SWALLOWED_ENGINE_TERMINALS:
                    continue
                yield event
            assert outcome.value is not None  # a fully-drained stream always sets it
            final_run = self._resolve_assistant_outcome(run, outcome.value)
            for frame in watermark.new_frames():
                yield frame
            yield {"type": "done", "run": final_run}
        except GeneratorExit:
            # Client disconnect / stop button: the SSE route closes this
            # generator mid-stream. Finalize an in-flight run so it never
            # lingers non-terminal (see the disconnect ruling above); a close
            # after the done frame must not overwrite a terminal run. Mutate
            # only — never yield after GeneratorExit.
            if run.status not in ("ready", "failed"):
                self._fail_assistant_run(
                    run,
                    "client_disconnected",
                    "client disconnected before the assistant run finished",
                )
            raise
        except Exception as exc:  # noqa: BLE001 — surface as a stream error frame
            for frame in watermark.new_frames():
                yield frame
            yield {"type": "error", "message": str(exc)}

    def _fail_assistant_run(self, run: HikerAssistantRun, error_code: str, message: str) -> HikerAssistantRun:
        return self._fail_run_event(run, "hiker.assistant.failed", error_code, message)

    def _next_assistant_run_id(self) -> str:
        self._assistant_counter += 1
        return f"hiker_assistant_run_{self._assistant_counter:03d}"


def _detect_anomalies(dashboard: dict, collection: dict, top_customers: list[HikerCustomerRow]) -> list[HikerAnomaly]:
    anomalies: list[HikerAnomaly] = []
    total = _money(dashboard.get("contract_amount"))
    if top_customers and total > 0:
        top = top_customers[0]
        ratio = top.contract_amount / total
        if ratio >= 0.5:
            anomalies.append(
                HikerAnomaly(
                    id="concentration",
                    title=f"客户集中度高：{top.customer_name} 占合同总额 {ratio * 100:.0f}%",
                    severity="high" if ratio >= 0.7 else "medium",
                    explanation=f"单一客户合同额 ¥{top.contract_amount:,.0f}，占全部合同 ¥{total:,.0f} 的 {ratio * 100:.0f}%，回款风险集中。",
                )
            )
    risk = (collection.get("risk") or {}).get("summary") or {}
    overdue = int(risk.get("overdue_count") or 0)
    if overdue > 0:
        anomalies.append(
            HikerAnomaly(id="overdue", title=f"{overdue} 笔回款已逾期", severity="high",
                         explanation=f"逾期金额 ¥{_money(risk.get('overdue_amount')):,.0f}，需优先催收。")
        )
    due_soon = int(risk.get("due_soon_count") or 0)
    if due_soon > 0:
        anomalies.append(
            HikerAnomaly(id="due_soon", title=f"{due_soon} 笔回款即将到期", severity="medium",
                         explanation=f"即将到期金额 ¥{_money(risk.get('due_soon_amount')):,.0f}，建议提前提醒客户。")
        )
    return anomalies
