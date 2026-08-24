from __future__ import annotations

from typing import Any

from services.associate.app.schemas import (
    AssociateApprovalRequest,
    AssociateGoalNode,
    AssociateGoalPlan,
    AssociateReceivablesRun,
    AssociateWriteAction,
)
from services.associate.app.state_store import AssociateStateStore
from services.mcp_gateway.app.erp_adapter import ErpMcpError, ErpMcpGateway
from services.reimbursement.app.audit import AuditService
from services.runtime.app.associate_tool_registry import AssociateToolRegistry
from services.runtime.app.base_orchestrator import BaseOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.mcp_dispatcher import (
    McpToolDispatcher,
    assistant_tool_call_message,
    missing_required_tools,
    model_and_connector_preflight,
    tool_observation_message,
)
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelResponse,
    OpenAICompatibleModelProvider,
)
from services.runtime.app.skill_loader import LoadedSkill, SkillLoader


MAX_ASSOCIATE_MODEL_TOOL_ROUNDS = 5
REQUIRED_ASSOCIATE_MCP_TOOLS = frozenset({"erp.finance.get_receivables_aging"})
ASSOCIATE_BACKEND_WRITE_ACTIONS = frozenset({"erp.collection_task.create_draft"})
ASSOCIATE_BACKEND_READBACK_ACTIONS = frozenset({"erp.collection_task.get_status"})


class AssociateReceivablesOrchestrator(BaseOrchestrator):
    _fail_event_type = "associate.failed"
    _run_id_prefix = "associate_run_"
    _approval_id_prefix = "associate_approval_"
    _write_id_prefix = "associate_write_"

    def __init__(
        self,
        adapter: ErpMcpGateway | None = None,
        model_provider: OpenAICompatibleModelProvider | None = None,
        skill_loader: SkillLoader | None = None,
        tool_registry: AssociateToolRegistry | None = None,
        audit: AuditService | None = None,
        settings: RuntimeSettings | None = None,
        state_store: AssociateStateStore | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self.adapter = adapter or ErpMcpGateway(self.settings)
        self.model_provider = model_provider or OpenAICompatibleModelProvider(self.settings)
        self.skill_loader = skill_loader or SkillLoader()
        self.tool_registry = tool_registry or AssociateToolRegistry()
        self.audit = audit or AuditService()
        self.harness_runtime = AnnaHarnessRuntime(
            model_provider=self.model_provider,
            audit=self.audit,
        )
        self.mcp_dispatcher = McpToolDispatcher(
            adapter=self.adapter,
            audit=self.audit,
            hash_payload=self._hash_payload,
            error_type=ErpMcpError,
            error_contract=_safe_mcp_error_contract,
        )
        self.state_store = state_store
        self._run_counter = state_store.max_run_sequence() if state_store else 0
        self._approval_counter = (
            state_store.max_approval_sequence() if state_store else 0
        )
        self._write_counter = state_store.max_write_sequence() if state_store else 0
        self._runs: dict[str, AssociateReceivablesRun] = {}

    def start_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        period: str,
        goal_text: str,
    ) -> AssociateReceivablesRun:
        run = AssociateReceivablesRun(
            id=self._next_run_id(),
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            period=period,
            goal_text=goal_text,
            status="validating",
        )
        self.audit.append(
            run.audit_events,
            "associate.run.created",
            run.id,
            {"period": period, "goal_hash": self._hash_payload({"goal": goal_text})},
        )
        return self._save_and_return(self._advance_run(run))

    def get_run(self, run_id: str) -> AssociateReceivablesRun | None:
        run = self._runs.get(run_id)
        if run is not None:
            return run
        if self.state_store is None:
            return None
        run = self.state_store.get_run(run_id)
        if run is not None:
            self._remember_run(run)
        return run

    def list_runs(
        self,
        workspace_id: str,
        actor_user_id: str,
    ) -> list[AssociateReceivablesRun]:
        if self.state_store is not None:
            runs = self.state_store.list_runs(workspace_id, actor_user_id)
            for run in runs:
                self._remember_run(run)
            return runs
        return [
            run
            for run in reversed(list(self._runs.values()))
            if run.workspace_id == workspace_id and run.actor_user_id == actor_user_id
        ]

    def get_run_by_approval_id(self, approval_id: str) -> AssociateReceivablesRun | None:
        found = self._find_approval(approval_id)
        if found:
            return found[0]
        if self.state_store is None:
            return None
        run = self.state_store.get_run_by_approval_id(approval_id)
        if run is not None:
            self._remember_run(run)
        return run

    def get_write_action(self, write_action_id: str) -> AssociateWriteAction | None:
        for run in self._runs.values():
            if run.plan is None:
                continue
            for node in run.plan.nodes:
                if node.write_action and node.write_action.id == write_action_id:
                    return node.write_action
        if self.state_store is not None:
            return self.state_store.get_write_action(write_action_id)
        return None

    def request_node_execution(
        self,
        run_id: str,
        node_id: str,
        requested_by: str,
    ) -> AssociateReceivablesRun:
        run = self._require_run(run_id)
        if requested_by != run.actor_user_id:
            raise ValueError("requested_by must match run actor")
        node = self._require_node(run, node_id)
        if node.write_intent is None:
            raise ValueError("node does not have a write intent")
        if node.write_intent.action_type not in ASSOCIATE_BACKEND_WRITE_ACTIONS:
            raise ValueError("Associate write action is not allowed")
        if node.approval and node.approval.status == "pending":
            return run

        payload = self._approval_payload(run, node)
        node_snapshot = self._node_snapshot(node)
        node.approval = AssociateApprovalRequest(
            id=self._next_approval_id(),
            run_id=run.id,
            node_id=node.id,
            action_type=node.write_intent.action_type,
            risk_level=node.write_intent.risk_level,
            payload=payload,
            payload_hash=self._hash_payload(payload),
            node_snapshot=node_snapshot,
            node_snapshot_hash=self._hash_payload(node_snapshot),
        )
        self.audit.append(
            run.audit_events,
            "associate.node.approval.requested",
            run.id,
            {
                "approval_id": node.approval.id,
                "node_id": node.id,
                "action_type": node.approval.action_type,
                "risk_level": node.approval.risk_level,
                "approval_payload_hash": node.approval.payload_hash,
                "node_snapshot_hash": node.approval.node_snapshot_hash,
            },
        )
        return self._save_and_return(run)

    def approve_node_execution(
        self,
        approval_id: str,
        approved_by: str,
    ) -> AssociateReceivablesRun:
        run, node = self._require_approval(approval_id)
        approval = node.approval
        if approval is None:
            raise ValueError("approval request not found")
        if approved_by != run.actor_user_id:
            raise ValueError("approved_by must match run actor")
        if approval.status == "approved" and node.write_action is not None:
            return run
        if approval.status != "pending":
            raise ValueError("approval is not pending")
        self._assert_approval_still_matches_node(node, approval)

        approval.status = "approved"
        self.audit.append(
            run.audit_events,
            "associate.node.approval.approved",
            run.id,
            {
                "approval_id": approval.id,
                "node_id": node.id,
                "approved_by": approved_by,
                "approval_payload_hash": approval.payload_hash,
                "node_snapshot_hash": approval.node_snapshot_hash,
            },
        )
        node.status = "running"
        idempotency_key = f"associate:{approval.id}"
        try:
            result = self.mcp_dispatcher.call_tool_audited(
                run.audit_events,
                run.id,
                approval.action_type,
                approval.payload,
                self._mcp_write_arguments(
                    run,
                    node,
                    approval,
                    idempotency_key=idempotency_key,
                ),
            )
        except ErpMcpError:
            node.status = "blocked"
            node.write_action = AssociateWriteAction(
                id=self._next_write_id(),
                run_id=run.id,
                node_id=node.id,
                approval_id=approval.id,
                action_type=approval.action_type,
                status="failed",
                idempotency_key=idempotency_key,
                approval_payload_hash=approval.payload_hash,
                node_snapshot_hash=approval.node_snapshot_hash,
            )
            return self._save_and_return(run)

        node.write_action = AssociateWriteAction(
            id=self._next_write_id(),
            run_id=run.id,
            node_id=node.id,
            approval_id=approval.id,
            action_type=approval.action_type,
            status="success",
            external_task_id=_optional_str(result.get("external_task_id") or result.get("id")),
            external_status=_optional_str(result.get("external_status") or result.get("status")),
            idempotency_key=idempotency_key,
            approval_payload_hash=approval.payload_hash,
            node_snapshot_hash=approval.node_snapshot_hash,
        )
        return self._verify_node_execution(run, node, approval)

    def _verify_node_execution(
        self,
        run: AssociateReceivablesRun,
        node: AssociateGoalNode,
        approval: AssociateApprovalRequest,
    ) -> AssociateReceivablesRun:
        if node.write_action is None:
            raise ValueError("write action is required before verify")
        if not node.write_action.external_task_id:
            node.status = "verify_pending"
            return self._record_node_verify_pending(run, node, approval)
        if not self._readback_tool_available():
            node.status = "verify_pending"
            return self._record_node_verify_pending(run, node, approval)

        readback_input = self._mcp_readback_arguments(run, node)
        try:
            readback = self.mcp_dispatcher.call_tool_audited(
                run.audit_events,
                run.id,
                "erp.collection_task.get_status",
                readback_input,
                readback_input,
            )
        except ErpMcpError:
            node.status = "verify_pending"
            return self._record_node_verify_pending(run, node, approval)

        readback_task_id = _optional_str(readback.get("external_task_id") or readback.get("id"))
        readback_status = _optional_str(
            readback.get("external_status") or readback.get("status")
        )
        if (
            readback_task_id == node.write_action.external_task_id
            and node.write_action.external_status is not None
            and readback_status is not None
            and readback_status == node.write_action.external_status
        ):
            node.write_action.verify_status = "verified"
            node.status = "completed"
            self.audit.append(
                run.audit_events,
                "associate.node.verified",
                run.id,
                {
                    "node_id": node.id,
                    "approval_id": approval.id,
                    "write_action_id": node.write_action.id,
                    "external_task_id": node.write_action.external_task_id,
                    "external_status": node.write_action.external_status,
                    "readback_external_task_id": readback_task_id,
                    "readback_external_status": readback_status,
                    "verify_status": "verified",
                    "approval_payload_hash": approval.payload_hash,
                    "node_snapshot_hash": approval.node_snapshot_hash,
                },
            )
            return self._save_and_return(run)
        node.status = "verify_pending"
        return self._record_node_verify_pending(
            run,
            node,
            approval,
            readback_external_task_id=readback_task_id,
            readback_external_status=readback_status,
        )

    def _record_node_verify_pending(
        self,
        run: AssociateReceivablesRun,
        node: AssociateGoalNode,
        approval: AssociateApprovalRequest,
        readback_external_task_id: str | None = None,
        readback_external_status: str | None = None,
    ) -> AssociateReceivablesRun:
        assert node.write_action is not None
        node.write_action.verify_status = "verify_pending"
        self.audit.append(
            run.audit_events,
            "associate.node.verify_pending",
            run.id,
            {
                "node_id": node.id,
                "approval_id": approval.id,
                "write_action_id": node.write_action.id,
                "external_task_id": node.write_action.external_task_id,
                "external_status": node.write_action.external_status,
                "readback_external_task_id": readback_external_task_id,
                "readback_external_status": readback_external_status,
                "verify_status": node.write_action.verify_status,
                "approval_payload_hash": approval.payload_hash,
                "node_snapshot_hash": approval.node_snapshot_hash,
            },
        )
        return self._save_and_return(run)

    def reject_node_execution(
        self,
        approval_id: str,
        rejected_by: str,
    ) -> AssociateReceivablesRun:
        run, node = self._require_approval(approval_id)
        approval = node.approval
        if approval is None:
            raise ValueError("approval request not found")
        if rejected_by != run.actor_user_id:
            raise ValueError("rejected_by must match run actor")
        if approval.status != "pending":
            return run
        approval.status = "rejected"
        self.audit.append(
            run.audit_events,
            "associate.node.approval.rejected",
            run.id,
            {
                "approval_id": approval.id,
                "node_id": node.id,
                "rejected_by": rejected_by,
                "approval_payload_hash": approval.payload_hash,
            },
        )
        return self._save_and_return(run)

    def _advance_run(self, run: AssociateReceivablesRun) -> AssociateReceivablesRun:
        skill, failed_run = self._load_skill_and_record(
            run,
            self.settings.associate_receivables_skill_id,
        )
        if skill is None:
            return failed_run

        preflight_error, mcp_status = model_and_connector_preflight(
            self.model_provider.settings,
            self.adapter,
            not_configured_message=(
                "model endpoint and API key are required before running Anna Associate"
            ),
            not_connected_message="ERP MCP connector is not connected",
        )
        if preflight_error is not None:
            return self._fail_run(run, preflight_error[0], preflight_error[1])
        missing_tools = missing_required_tools(mcp_status, REQUIRED_ASSOCIATE_MCP_TOOLS)
        if missing_tools:
            return self._fail_run(
                run,
                "mcp_required_tools_missing",
                f"ERP MCP server is missing Associate tools: {', '.join(missing_tools)}",
            )

        model_request = self._build_model_request(run, skill, mcp_status)
        messages = list(model_request.messages)
        for _round in range(MAX_ASSOCIATE_MODEL_TOOL_ROUNDS):
            current_request = ModelRequest(messages=messages, tools=model_request.tools)
            result = self.harness_runtime.call_model(
                run_id=run.id,
                audit_events=run.audit_events,
                request=current_request,
                started_payload={"skill_id": skill.id},
                config_error_message=(
                    "model endpoint and API key are required before running Anna Associate"
                ),
            )
            if result.response is None:
                return self._fail_run(
                    run,
                    result.error_code or "model_call_failed",
                    result.message or "",
                )
            model_response = result.response
            observations = self._apply_model_response(run, model_response)
            if run.status in {"ready", "failed"}:
                return run
            if not model_response.tool_calls:
                run.status = "collecting"
                return run
            messages.append(assistant_tool_call_message(model_response))
            messages.extend(observations)

        return self._fail_run(
            run,
            "tool_loop_exhausted",
            "Associate model tool loop exceeded the maximum number of rounds",
        )

    def _apply_model_response(
        self,
        run: AssociateReceivablesRun,
        model_response: ModelResponse,
    ) -> list[dict[str, Any]]:
        observations: list[dict[str, Any]] = []
        for tool_call in model_response.tool_calls:
            try:
                dispatch_kind = self.tool_registry.dispatch_kind(tool_call.name)
            except PermissionError as exc:
                self._fail_run(run, "tool_not_allowed", str(exc))
                return []

            if dispatch_kind == "internal":
                run.plan = AssociateGoalPlan.model_validate(tool_call.arguments)
                run.status = "ready"
                self.audit.append(
                    run.audit_events,
                    "associate.plan.emitted",
                    run.id,
                    {
                        "node_count": len(run.plan.nodes),
                        "blocked_count": len(
                            [node for node in run.plan.nodes if node.status == "blocked"]
                        ),
                    },
                )
                return observations

            try:
                tool_result = self.mcp_dispatcher.call_tool_audited(
                    run.audit_events,
                    run.id,
                    tool_call.name,
                    tool_call.arguments,
                    self._mcp_tool_arguments(run, tool_call.arguments),
                )
            except ErpMcpError as exc:
                self._fail_run(run, exc.error_code, exc.message)
                return []
            observations.append(tool_observation_message(tool_call, tool_result))
        return observations

    def _mcp_tool_arguments(
        self,
        run: AssociateReceivablesRun,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "workspace_id": run.workspace_id,
            "actor_user_id": run.actor_user_id,
            "period": str(arguments.get("period") or run.period),
            "overdue_days": float(arguments.get("overdue_days") or 30),
        }

    def _build_model_request(
        self,
        run: AssociateReceivablesRun,
        skill: LoadedSkill,
        mcp_status: dict[str, Any],
    ) -> ModelRequest:
        discovered_tools = (
            mcp_status.get("tools", [])
            if isinstance(mcp_status.get("tools"), list)
            else []
        )
        return ModelRequest(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Anna Associate. Follow the loaded Skill, read ERP "
                        "data through tools, and emit a structured plan. Do not execute writes."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Skill:\n{skill.content}\n\n"
                        f"Period: {run.period}\nGoal: {run.goal_text}"
                    ),
                },
            ],
            tools=self.tool_registry.model_visible_tools(
                skill,
                discovered_tools=discovered_tools,
            ),
        )

    def _save_and_return(
        self,
        run: AssociateReceivablesRun,
    ) -> AssociateReceivablesRun:
        self._remember_run(run)
        if self.state_store is not None:
            self.state_store.save_run(run)
        return run

    def _remember_run(self, run: AssociateReceivablesRun) -> None:
        self._runs[run.id] = run

    def _require_run(self, run_id: str) -> AssociateReceivablesRun:
        run = self.get_run(run_id)
        if run is None:
            raise ValueError("Associate run not found")
        return run

    def _require_node(
        self,
        run: AssociateReceivablesRun,
        node_id: str,
    ) -> AssociateGoalNode:
        if run.plan is None:
            raise ValueError("Associate run has no plan")
        for node in run.plan.nodes:
            if node.id == node_id:
                return node
        raise ValueError("Associate node not found")

    def _find_approval(
        self,
        approval_id: str,
    ) -> tuple[AssociateReceivablesRun, AssociateGoalNode] | None:
        for run in self._runs.values():
            if run.plan is None:
                continue
            for node in run.plan.nodes:
                if node.approval and node.approval.id == approval_id:
                    return run, node
        return None

    def _require_approval(
        self,
        approval_id: str,
    ) -> tuple[AssociateReceivablesRun, AssociateGoalNode]:
        found = self._find_approval(approval_id)
        if found is None and self.state_store is not None:
            run = self.state_store.get_run_by_approval_id(approval_id)
            if run is not None:
                self._remember_run(run)
                found = self._find_approval(approval_id)
        if found is None:
            raise ValueError("approval request not found")
        return found

    def _approval_payload(
        self,
        run: AssociateReceivablesRun,
        node: AssociateGoalNode,
    ) -> dict[str, Any]:
        assert node.write_intent is not None
        return {
            "workspace_id": run.workspace_id,
            "actor_user_id": run.actor_user_id,
            "period": run.period,
            "goal": run.goal_text,
            "node_id": node.id,
            "node_title": node.title,
            "action_type": node.write_intent.action_type,
            "risk_level": node.write_intent.risk_level,
            "summary": node.write_intent.summary,
            "payload": node.write_intent.payload,
        }

    def _node_snapshot(self, node: AssociateGoalNode) -> dict[str, Any]:
        return node.model_dump(
            mode="json",
            exclude={"approval", "write_action"},
        )

    def _assert_approval_still_matches_node(
        self,
        node: AssociateGoalNode,
        approval: AssociateApprovalRequest,
    ) -> None:
        if approval.payload_hash != self._hash_payload(approval.payload):
            raise ValueError("approval payload hash mismatch")
        if node.write_intent is None:
            raise ValueError("node does not have a write intent")
        if approval.action_type != node.write_intent.action_type:
            raise ValueError("approval action mismatch")
        if approval.payload.get("action_type") != approval.action_type:
            raise ValueError("approval action mismatch")
        if approval.action_type not in ASSOCIATE_BACKEND_WRITE_ACTIONS:
            raise ValueError("Associate write action is not allowed")
        if approval.node_snapshot_hash != self._hash_payload(self._node_snapshot(node)):
            raise ValueError("approval node snapshot mismatch")

    def _mcp_write_arguments(
        self,
        run: AssociateReceivablesRun,
        node: AssociateGoalNode,
        approval: AssociateApprovalRequest,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return {
            "workspace_id": run.workspace_id,
            "actor_user_id": run.actor_user_id,
            "source": "Anna",
            "source_run_id": run.id,
            "source_node_id": node.id,
            "node_id": node.id,
            "confirmation_id": approval.id,
            "idempotency_key": idempotency_key,
            "period": run.period,
            "summary": approval.payload["summary"],
            "payload": approval.payload.get("payload", {}),
            "approval_payload_hash": approval.payload_hash,
            "node_snapshot_hash": approval.node_snapshot_hash,
        }

    def _mcp_readback_arguments(
        self,
        run: AssociateReceivablesRun,
        node: AssociateGoalNode,
    ) -> dict[str, Any]:
        assert node.write_action is not None
        return {
            "workspace_id": run.workspace_id,
            "actor_user_id": run.actor_user_id,
            "source": "Anna",
            "source_run_id": run.id,
            "source_node_id": node.id,
            "node_id": node.id,
            "write_action_id": node.write_action.id,
            "external_task_id": node.write_action.external_task_id,
        }

    def _readback_tool_available(self) -> bool:
        try:
            status = self.adapter.status()
        except Exception:
            return False
        tool_names = status.get("tool_names")
        return isinstance(tool_names, list) and any(
            tool_name in ASSOCIATE_BACKEND_READBACK_ACTIONS for tool_name in tool_names
        )


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _safe_mcp_error_contract(exc: ErpMcpError) -> dict[str, Any]:
    return {
        "error_code": exc.error_code,
        "message": "ERP MCP tool call failed",
        "retryable": exc.retryable,
    }
