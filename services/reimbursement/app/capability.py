"""Reimbursement ``CapabilityHandler`` for the platform streaming engine.

``ReimbursementCapabilityHandler`` plugs the reimbursement domain into
``services.runtime.app.engine`` (``QueryEngine.run`` + ``AgentLoop``),
reproducing the byte-for-byte behavior of the orchestrator's old hand-rolled
ReAct loop (``_build_model_request`` / ``_apply_model_response`` /
submit-guidance nudge), which is now deleted. Preflight (connector when the
model is configured) and the ``skill.loaded`` audit stay in the orchestrator,
BEFORE the engine runs — the engine loop has no preflight step.

The write+approval specifics live here:

* **mixed-batch guard** — the optional ``on_tool_batch`` engine hook rejects
  ``submit_intent`` batched with other tool calls in the same assistant
  message (``submit_intent_requires_prior_observation``) BEFORE any dispatch.
* **submit_intent gate (the suspend)** — authoritative context injection →
  validation → ``approval.intent.requested`` audit → approval creation +
  registration → ``run.status = "waiting_confirmation"`` →
  ``approval.requested`` audit → ``CapabilitySuspend("awaiting_approval")``.
  The tamper-evident audit ORDER (``approval.intent.requested`` strictly
  before ``approval.requested``) is preserved. Resume (``approve_submit``)
  stays on the orchestrator and never touches the engine.
* **missing-fields pause** — when required fields are missing (skill preflight
  or connector ``validate_draft`` verdict) the run parks in ``collecting`` and
  the loop stops via ``CapabilitySuspend("missing_fields")`` — a pause for
  user answers, not a failure. ``answer_missing_fields`` re-advances later.
* **submit-guidance nudge** — ``on_assistant_final`` returns
  ``SUBMIT_GUIDANCE_MESSAGE`` (at most ``MAX_SUBMIT_GUIDANCE_ROUNDS`` times
  per handler instance == per advance, matching the old per-``_advance_run``
  counter) when the model stops talking while an external draft exists.

The handler is constructed per advance with the ``orchestrator`` itself: the
approval-id counter, the approval→run registry, the audit/hash helpers and the
MCP plumbing are shared with the resume paths (``approve_submit`` /
``retry_verify``) that stay on the orchestrator, so threading the orchestrator
through is the honest dependency (contrast finance, whose handler needed only
three leaf deps).
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, NoReturn

from services.mcp_gateway.app.reimbursement_adapter import ReimbursementMcpError
from services.reimbursement.app.attachments import (
    AttachmentContentUnavailable,
    materialize_attachments_for_mcp,
)
from services.reimbursement.app.schemas import (
    ApprovalRequest,
    AttachmentRef,
    ReimbursementDraft,
    ReimbursementRun,
)
from services.runtime.app.engine.capability import (
    SUSPEND_REASON_AWAITING_APPROVAL,
    CapabilityError,
    CapabilitySuspend,
    default_humanize_step,
)
from services.runtime.app.mcp_dispatcher import tool_observation_message
from services.runtime.app.model_provider import ModelRequest, ModelToolCall
from services.runtime.app.skill_loader import LoadedSkill

if TYPE_CHECKING:  # pragma: no cover — import cycle: orchestrator imports us
    from services.reimbursement.app.orchestrator import ReimbursementOrchestrator

# When the model creates a draft but stops without requesting submit_intent,
# the Harness nudges it to finish the flow instead of giving up (collecting).
MAX_SUBMIT_GUIDANCE_ROUNDS = 2
SUBMIT_GUIDANCE_MESSAGE = (
    "外部报销草稿已创建并通过校验。请立即调用 reimbursement.submit_intent "
    "工具提交审批意图以完成报销，不要仅用文字回复。"
)

# Reimbursement-specific suspend reason: the run parks in ``collecting`` and
# waits for user answers (``answer_missing_fields``), not for an approval.
SUSPEND_REASON_MISSING_FIELDS = "missing_fields"

SUBMIT_INTENT_CONTEXT_FIELDS = (
    "amount",
    "currency",
    "reason",
    "policy_summary",
    "risk_level",
)
EXTERNAL_STATE_FIELDS = frozenset({"external_reimbursement_id", "external_status"})

# B0 观察性:reimbursement emit 各工具的「正在…」step 标签。代码生成中文(ADR-002,
# 非模型文本),覆盖 10 个真实 reimbursement.* 工具的单据/校验/提交语汇;analyze/deliver
# 用领域措辞。submit_intent 会挂起等审批(无 deliver 步),故提交标签由 tool 短语承载。
_REIMBURSEMENT_TOOL_STEP_LABELS = {
    "reimbursement.get_capabilities": "正在确认报销能力",
    "reimbursement.get_policy": "正在核对报销政策",
    "reimbursement.validate_draft": "正在校验报销单据",
    "reimbursement.create_draft": "正在创建报销单据",
    "reimbursement.submit_intent": "正在提交报销审批",
    "reimbursement.get_status": "正在查询报销状态",
    "reimbursement.list_approvals": "正在查询待审批单据",
    "reimbursement.get_approval": "正在查询审批详情",
    "reimbursement.approve_intent": "正在提交审批通过意见",
    "reimbursement.reject_intent": "正在提交审批驳回意见",
}
_REIMBURSEMENT_PHASE_STEP_LABELS = {
    "analyze": "正在理解报销诉求",
    "deliver": "正在整理回答",
}


class ReimbursementCapabilityHandler:
    """Per-run reimbursement capability handler bound to a single run object.

    Constructed by ``ReimbursementOrchestrator`` for each engine advance with
    the already-loaded ``skill``, the resolved ``mcp_status`` from preflight
    (``None`` when the model is not configured — the old
    ``_build_model_request`` then re-read ``adapter.status()``, preserved
    here), and the ``run`` it mutates.
    """

    def __init__(
        self,
        *,
        orchestrator: "ReimbursementOrchestrator",
        skill: LoadedSkill,
        mcp_status: dict[str, Any] | None,
        run: ReimbursementRun,
        boss_directive: str | None = None,
    ) -> None:
        self.orchestrator = orchestrator
        self.skill = skill
        self.mcp_status = mcp_status
        self.run = run
        self.boss_directive = boss_directive
        self._initial_request: ModelRequest | None = None
        # Per-advance counter (the handler is constructed per advance), same
        # scope as the old loop-local ``submit_guidance_rounds``.
        self._guidance_rounds = 0

    # --- CapabilityHandler protocol ----------------------------------------

    def build_initial_request(self) -> ModelRequest:
        """Return the initial reimbursement ``ModelRequest``.

        Memoized: the orchestrator calls this once to populate
        ``QueryConfig.tools`` and the engine calls it again at loop entry, so
        building once keeps both call sites on a single tool discovery +
        prompt assembly (and a single ``adapter.status()`` fallback when
        preflight supplied no ``mcp_status``).
        """
        if self._initial_request is None:
            self._initial_request = self._build_model_request()
        return self._initial_request

    def on_tool_batch(self, tool_calls: list[ModelToolCall]) -> None:
        """Reject ``submit_intent`` batched with other calls (pre-dispatch).

        The engine dispatches tool calls one at a time; this optional hook is
        the only place the whole per-round batch is visible. Mirrors the old
        ``_has_mixed_submit_intent`` check, which ran before any dispatch.
        """
        tool_names = [tool_call.name for tool_call in tool_calls]
        if "reimbursement.submit_intent" in tool_names and len(tool_names) > 1:
            raise CapabilityError(
                "submit_intent_requires_prior_observation",
                "submit_intent must be requested after prior tool observations",
            )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        """Run one reimbursement tool call — the old ``_apply_model_response``
        per-tool body.

        * ``submit_intent`` → the approval gate (see ``_dispatch_submit_intent``).
        * ``validate_draft`` / ``create_draft`` → guarded preflight
          (``external_state_not_allowed`` / ``required_fields_missing`` /
          ``draft_validation_required``) before the MCP call.
        * everything else → governed MCP dispatch with audited success/failure.

        Raises ``CapabilityError`` to fail the run (the orchestrator maps it
        back to ``reimbursement.failed`` + error code) and ``CapabilitySuspend``
        to pause it (approval wait / missing fields).
        """
        run = self.run
        if tool_call.name == "reimbursement.submit_intent":
            return self._dispatch_submit_intent(tool_call)

        preflight_error = self._model_tool_preflight_error(
            tool_call.name,
            tool_call.arguments,
        )
        if preflight_error is not None:
            if preflight_error[0] == "required_fields_missing":
                raise self._missing_fields_suspend()
            raise CapabilityError(preflight_error[0], preflight_error[1])
        try:
            tool_result = self._dispatch_model_tool(tool_call.name, tool_call.arguments)
        except ReimbursementMcpError as exc:
            self._record_tool_call(
                tool_call.name,
                tool_call.arguments,
                "failed",
                error=exc.as_contract(),
            )
            raise CapabilityError(exc.error_code, exc.message)
        except PermissionError as exc:
            raise CapabilityError("tool_not_allowed", str(exc))
        self._record_tool_call(tool_call.name, tool_call.arguments, "success")
        if tool_call.name == "reimbursement.get_policy":
            self._record_policy_check(tool_call.name, tool_result)
        if tool_call.name == "reimbursement.validate_draft":
            self._record_policy_check(tool_call.name, tool_result)
            connector_missing_fields = _tool_missing_fields(tool_result)
            if connector_missing_fields:
                draft = tool_result.get(
                    "normalized_draft",
                    tool_call.arguments.get("draft", tool_call.arguments),
                )
                if isinstance(draft, dict):
                    run.draft = ReimbursementDraft.model_validate(draft)
                run.missing_fields = connector_missing_fields
                raise self._missing_fields_suspend()
            self._record_validated_draft(tool_call.arguments, tool_result)
        if tool_call.name == "reimbursement.create_draft":
            run.draft.external_reimbursement_id = tool_result.get(
                "external_reimbursement_id"
            )
            run.draft.external_status = tool_result.get("external_status")
        run.status = (
            "draft_created" if run.draft.external_reimbursement_id else "collecting"
        )
        return tool_observation_message(tool_call, tool_result)

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        """Record the agent message, then nudge or end.

        Always parks the run in ``collecting`` with the message + the
        ``reimbursement.agent.message`` audit (the old no-tool-calls branch).
        Returns ``SUBMIT_GUIDANCE_MESSAGE`` — a continuation nudge — while an
        external draft exists and fewer than ``MAX_SUBMIT_GUIDANCE_ROUNDS``
        nudges were spent this advance; otherwise ``None`` ends the run.
        """
        run = self.run
        run.status = "collecting"
        run.agent_message = assistant_message
        self.orchestrator.audit.append(
            run.audit_events,
            "reimbursement.agent.message",
            run.id,
            {
                "message_hash": self.orchestrator._hash_payload(
                    {"message": assistant_message or ""}
                )
            },
        )
        if (
            run.draft.external_reimbursement_id
            and self._guidance_rounds < MAX_SUBMIT_GUIDANCE_ROUNDS
        ):
            self._guidance_rounds += 1
            return SUBMIT_GUIDANCE_MESSAGE
        return None

    def humanize_step(self, phase: str, tool_call: ModelToolCall | None = None) -> str:
        """Authoritative Chinese ``StepEvent`` label for reimbursement (B0 opt-in).

        Defining this method OPTS reimbursement in to the engine's ``step``
        frames. The tool phase maps the 10 real ``reimbursement.*`` tools to
        now-doing 单据/校验/提交 labels; ``analyze`` / ``deliver`` carry domain
        phrasing. ALWAYS code-generated (ADR-002). TOTAL — never raises: an
        unmapped tool or phase falls through to ``default_humanize_step``.
        """
        if phase == "tool" and tool_call is not None:
            label = _REIMBURSEMENT_TOOL_STEP_LABELS.get(tool_call.name)
            if label is not None:
                return label
        phase_label = _REIMBURSEMENT_PHASE_STEP_LABELS.get(phase)
        if phase_label is not None:
            return phase_label
        return default_humanize_step(phase, tool_call)

    # --- submit_intent gate --------------------------------------------------

    def _dispatch_submit_intent(self, tool_call: ModelToolCall) -> NoReturn:
        """The approval gate: validate, audit, create + register the approval,
        park the run in ``waiting_confirmation``, then SUSPEND the engine run.

        Never returns — raises ``CapabilityError`` on a gate violation (the
        run fails with that code, exactly as the old loop's ``_fail_run``) or
        ``CapabilitySuspend`` once the approval is requested.
        """
        run = self.run
        # policy_summary / risk_level are authoritative validate_draft
        # outputs, not model-chosen values. Inject them from the validation
        # audit so the model cannot alter the assessed risk and so it need
        # not echo system-generated strings verbatim.
        self._inject_authoritative_context(tool_call.arguments)
        validation_error = self._submit_intent_error(tool_call.arguments)
        if validation_error is not None:
            raise CapabilityError(validation_error[0], validation_error[1])
        self.orchestrator.audit.append(
            run.audit_events,
            "approval.intent.requested",
            run.id,
            {
                "external_reimbursement_id": run.draft.external_reimbursement_id,
                "risk_level": str(tool_call.arguments["risk_level"]),
            },
        )
        run.approval = self._create_approval(tool_call.arguments)
        self.orchestrator._runs_by_approval_id[run.approval.id] = run
        run.status = "waiting_confirmation"
        self.orchestrator.audit.append(
            run.audit_events,
            "approval.requested",
            run.id,
            {
                "approval_id": run.approval.id,
                "approval_payload_hash": run.approval.payload_hash,
                "draft_snapshot_hash": run.approval.draft_snapshot_hash,
            },
        )
        raise CapabilitySuspend(
            SUSPEND_REASON_AWAITING_APPROVAL,
            detail={"approval_id": run.approval.id},
        )

    def _submit_intent_error(
        self,
        arguments: dict[str, Any],
    ) -> tuple[str, str] | None:
        run = self.run
        if not run.draft.external_reimbursement_id:
            return (
                "external_reimbursement_id_required",
                "external draft id is required before submit intent",
            )
        requested_external_id = str(arguments.get("external_reimbursement_id", ""))
        if requested_external_id != run.draft.external_reimbursement_id:
            return (
                "external_reimbursement_id_mismatch",
                "submit intent external id must match the current draft",
            )
        missing_context = [
            field for field in SUBMIT_INTENT_CONTEXT_FIELDS if not arguments.get(field)
        ]
        if missing_context:
            return (
                "submit_intent_context_required",
                "submit intent must include approval review context",
            )
        if float(arguments.get("amount")) != run.draft.amount:
            return (
                "submit_intent_context_mismatch",
                "submit intent amount must match the current draft",
            )
        if str(arguments.get("currency")) != run.draft.currency:
            return (
                "submit_intent_context_mismatch",
                "submit intent currency must match the current draft",
            )
        if str(arguments.get("reason")) != run.draft.reason:
            return (
                "submit_intent_context_mismatch",
                "submit intent reason must match the current draft",
            )
        if not self._has_verified_approval_context(
            str(arguments.get("policy_summary")),
            str(arguments.get("risk_level")),
        ):
            return (
                "submit_intent_context_unverified",
                "submit intent approval context must match validation results",
            )
        return None

    def _inject_authoritative_context(self, arguments: dict[str, Any]) -> None:
        for event in reversed(self.run.audit_events):
            if event.type == "reimbursement.draft.validated":
                policy_summary = event.payload.get("policy_summary")
                risk_level = event.payload.get("risk_level")
                if policy_summary is not None:
                    arguments["policy_summary"] = policy_summary
                if risk_level is not None:
                    arguments["risk_level"] = risk_level
                return

    def _has_verified_approval_context(
        self,
        policy_summary: str,
        risk_level: str,
    ) -> bool:
        return any(
            event.type == "reimbursement.draft.validated"
            and event.payload.get("policy_summary") == policy_summary
            and event.payload.get("risk_level") == risk_level
            for event in self.run.audit_events
        )

    def _create_approval(self, arguments: dict[str, Any]) -> ApprovalRequest:
        run = self.run
        draft_snapshot = json.loads(
            json.dumps(run.draft.as_mcp_payload(), ensure_ascii=False, sort_keys=True)
        )
        payload = {
            "external_reimbursement_id": run.draft.external_reimbursement_id,
            "amount": arguments["amount"],
            "currency": arguments["currency"],
            "reason": arguments["reason"],
            "policy_summary": arguments["policy_summary"],
        }
        return ApprovalRequest(
            id=self.orchestrator._next_approval_id(),
            run_id=run.id,
            action_type="reimbursement.submit",
            risk_level=str(arguments["risk_level"]),
            payload=payload,
            payload_hash=self.orchestrator._approval_payload_hash(payload),
            draft_snapshot=draft_snapshot,
            draft_snapshot_hash=self.orchestrator._draft_hash(draft_snapshot),
        )

    # --- guarded preflight + MCP dispatch -------------------------------------

    def _model_tool_preflight_error(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> tuple[str, str] | None:
        run = self.run
        if tool_name not in {
            "reimbursement.validate_draft",
            "reimbursement.create_draft",
        }:
            return None
        draft = arguments.get("draft", arguments)
        if not isinstance(draft, dict):
            return (
                "tool_arguments_invalid",
                f"{tool_name} requires a draft object",
            )
        if EXTERNAL_STATE_FIELDS & set(draft):
            return (
                "external_state_not_allowed",
                "model draft arguments must not include external reimbursement state",
            )
        merged_draft = self._merge_current_draft(draft)
        if "draft" in arguments:
            arguments["draft"] = merged_draft
        else:
            arguments.clear()
            arguments.update(merged_draft)
        if _has_unimported_attachments(run, merged_draft):
            run.draft = ReimbursementDraft.model_validate(
                {key: value for key, value in merged_draft.items() if key != "attachments"}
            )
            run.missing_fields = ["attachments"]
            return (
                "required_fields_missing",
                "attachments must be imported through Anna",
            )
        if tool_name == "reimbursement.validate_draft":
            return None
        required_fields = _skill_required_fields(self.skill)
        missing_fields = self.orchestrator.policy.required_missing_fields(
            ReimbursementDraft.model_validate(merged_draft),
            required_fields,
        )
        if missing_fields:
            run.draft = ReimbursementDraft.model_validate(merged_draft)
            run.missing_fields = missing_fields
            return (
                "required_fields_missing",
                "required reimbursement draft fields are missing",
            )
        if not self._has_successful_validation(merged_draft):
            return (
                "draft_validation_required",
                "create_draft requires a prior successful validate_draft call",
            )
        return None

    def _merge_current_draft(self, model_draft: dict[str, Any]) -> dict[str, Any]:
        current = {
            key: value
            for key, value in self.run.draft.as_mcp_payload().items()
            if key not in EXTERNAL_STATE_FIELDS
        }
        merged = dict(current)
        for key, value in model_draft.items():
            if key in EXTERNAL_STATE_FIELDS:
                continue
            if value not in (None, "", []):
                merged[key] = value
            elif key not in merged:
                merged[key] = value
        return merged

    def _has_successful_validation(self, draft: dict[str, Any]) -> bool:
        draft_hash = self.orchestrator._draft_hash(draft)
        return any(
            event.type == "reimbursement.draft.validated"
            and event.payload.get("draft_hash") == draft_hash
            for event in self.run.audit_events
        )

    def _dispatch_model_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        if self.orchestrator.tool_registry.dispatch_kind(tool_name) == "approval_intent":
            return {"requires_approval": True}
        return self.orchestrator.adapter.call_tool(
            tool_name,
            self._mcp_tool_arguments(tool_name, arguments),
        )

    def _mcp_tool_arguments(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        run = self.run
        context = {
            "workspace_id": run.workspace_id,
            "actor_user_id": run.actor_user_id,
        }
        if tool_name == "reimbursement.validate_draft":
            draft = arguments.get("draft", arguments)
            if not isinstance(draft, dict):
                raise ReimbursementMcpError(
                    "tool_arguments_invalid",
                    "validate_draft requires a draft object",
                    retryable=False,
                )
            return {**context, "draft": draft}
        if tool_name == "reimbursement.create_draft":
            draft = arguments.get("draft", arguments)
            if not isinstance(draft, dict):
                raise ReimbursementMcpError(
                    "tool_arguments_invalid",
                    "create_draft requires a draft object",
                    retryable=False,
                )
            run.draft = ReimbursementDraft.model_validate(draft)
            return {
                **context,
                "source": "Anna",
                "source_run_id": run.id,
                "idempotency_key": self.orchestrator.policy.create_idempotency_key(
                    run.id
                ),
                "draft": self._draft_mcp_payload(),
            }
        if tool_name == "reimbursement.get_status":
            external_id = str(arguments.get("external_reimbursement_id", ""))
            self._assert_current_external_id(external_id)
        return {**context, **arguments}

    def _draft_mcp_payload(self) -> dict[str, Any]:
        run = self.run
        payload = run.draft.as_mcp_payload()
        if not run.draft.attachments:
            return payload
        try:
            payload["attachments"] = materialize_attachments_for_mcp(
                self.orchestrator.settings,
                run.workspace_id,
                run.actor_user_id,
                run.draft.attachments,
            )
        except AttachmentContentUnavailable as exc:
            raise ReimbursementMcpError(
                "attachment_content_unavailable",
                "attachment content is unavailable",
                retryable=False,
            ) from exc
        return payload

    def _assert_current_external_id(self, external_id: str) -> None:
        run = self.run
        if not run.draft.external_reimbursement_id:
            raise ReimbursementMcpError(
                "external_reimbursement_id_required",
                "external draft id is required before status readback",
                retryable=False,
            )
        if external_id != run.draft.external_reimbursement_id:
            raise ReimbursementMcpError(
                "external_reimbursement_id_mismatch",
                "external id must match the current reimbursement draft",
                retryable=False,
            )

    # --- audit + pause helpers -------------------------------------------------

    def _missing_fields_suspend(self) -> CapabilitySuspend:
        """Park the run in ``collecting`` (old ``_request_missing_fields``) and
        build the pause signal that stops the engine loop without failing it."""
        run = self.run
        run.status = "collecting"
        run.error_code = None
        run.error_message = None
        self.orchestrator.audit.append(
            run.audit_events,
            "reimbursement.missing_fields.requested",
            run.id,
            {"missing_fields": run.missing_fields},
        )
        return CapabilitySuspend(
            SUSPEND_REASON_MISSING_FIELDS,
            detail={"missing_fields": list(run.missing_fields)},
        )

    def _record_tool_call(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
        status: str,
        error: dict[str, Any] | None = None,
    ) -> None:
        self.orchestrator.mcp_dispatcher.record_tool_called(
            self.run.audit_events,
            self.run.id,
            tool_name,
            tool_input,
            status,
            error=error,
        )

    def _record_validated_draft(
        self,
        arguments: dict[str, Any],
        tool_result: dict[str, Any],
    ) -> None:
        draft = arguments.get("draft", arguments)
        if not isinstance(draft, dict):
            return
        if not _validation_succeeded(tool_result):
            return
        self.orchestrator.audit.append(
            self.run.audit_events,
            "reimbursement.draft.validated",
            self.run.id,
            {
                "draft_hash": self.orchestrator._draft_hash(draft),
                "policy_summary": tool_result.get("policy_summary"),
                "risk_level": tool_result.get("risk_level"),
            },
        )

    def _record_policy_check(
        self,
        tool_name: str,
        tool_result: dict[str, Any],
    ) -> None:
        allowed_fields = (
            "policy_summary",
            "risk_level",
            "missing_fields",
            "valid",
            "blocked",
            "requires_confirmation",
        )
        payload = {"tool_name": tool_name}
        for field in allowed_fields:
            if field in tool_result:
                payload[field] = tool_result.get(field)
        self.orchestrator.audit.append(
            self.run.audit_events,
            "reimbursement.policy.checked",
            self.run.id,
            payload,
        )

    # --- request assembly (moved verbatim from the orchestrator) --------------

    def _build_model_request(self) -> ModelRequest:
        run = self.run
        mcp_status = self.mcp_status or self.orchestrator.adapter.status()
        discovered_tools = (
            mcp_status.get("tools", [])
            if isinstance(mcp_status.get("tools"), list)
            else []
        )
        tools = self.orchestrator.tool_registry.model_visible_tools(
            self.skill,
            discovered_tools=discovered_tools,
        )
        user_content = (
            f"Skill:\n{self.skill.content}\n\nUser reimbursement request:\n{run.input_text}"
        )
        current_draft = _current_draft_context(run)
        if current_draft:
            user_content += (
                "\n\nCurrent reimbursement draft:\n"
                f"{json.dumps(current_draft, ensure_ascii=False, sort_keys=True)}"
            )
        return ModelRequest(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Anna's enterprise reimbursement agent runtime. "
                        "Follow the loaded Skill and use only the provided tools."
                    
                        + directive_suffix(self.boss_directive)
                    ),
                },
                {
                    "role": "user",
                    "content": user_content,
                },
            ],
            tools=tools,
        )


def _skill_required_fields(skill: LoadedSkill) -> list[str]:
    raw_fields = skill.frontmatter.get("required_fields", [])
    if isinstance(raw_fields, list):
        return [str(field) for field in raw_fields]
    if isinstance(raw_fields, str):
        return [raw_fields]
    return []


def _validation_succeeded(tool_result: dict[str, Any]) -> bool:
    if tool_result.get("valid") is not True:
        return False
    if tool_result.get("blocked") is True:
        return False
    missing_fields = tool_result.get("missing_fields")
    return not missing_fields


def _tool_missing_fields(tool_result: dict[str, Any]) -> list[str]:
    missing_fields = tool_result.get("missing_fields")
    if not isinstance(missing_fields, list):
        return []
    return [str(field) for field in missing_fields if str(field)]


def _current_draft_context(run: ReimbursementRun) -> dict[str, Any]:
    payload = {
        key: value
        for key, value in run.draft.as_mcp_payload().items()
        if key not in EXTERNAL_STATE_FIELDS
    }
    if set(payload) == {"currency"}:
        return {}
    return payload


def _has_unimported_attachments(
    run: ReimbursementRun,
    draft: dict[str, Any],
) -> bool:
    if "attachments" not in draft:
        return False
    incoming = _attachment_ref_set(draft.get("attachments"))
    if incoming is None:
        return True
    if not incoming:
        return False
    imported = {
        (attachment.name, attachment.uri)
        for attachment in run.draft.attachments
        if attachment.uri.startswith("anna://attachment/")
    }
    return not incoming <= imported


def _attachment_ref_set(value: Any) -> set[tuple[str, str]] | None:
    if value in (None, ""):
        return set()
    if not isinstance(value, list):
        return None
    refs: set[tuple[str, str]] = set()
    for item in value:
        try:
            attachment = AttachmentRef.model_validate(item)
        except ValueError:
            return None
        refs.add((attachment.name, attachment.uri))
    return refs


def directive_suffix(directive: str | None) -> str:
    """P3 refinement — Boss 附加指令 (Agent 中心) appended to system prompts."""
    return "\n\n[Boss 附加指令]\n" + directive if directive else ""
