"""Unit tests for ``ReimbursementCapabilityHandler`` (engine-facing seams).

The integration behavior (full runs through the engine) lives in
``test_reimbursement_agent_flow.py``; these tests pin the handler-level
contracts the engine relies on:

* the mixed-batch guard (``on_tool_batch``) rejects ``submit_intent`` batched
  with other calls BEFORE any dispatch;
* the ``submit_intent`` gate emits the tamper-evident approval audit pair in
  order (``approval.intent.requested`` strictly before ``approval.requested``)
  and pauses the run via ``CapabilitySuspend`` — not an error;
* the submit-guidance nudge fires from ``on_assistant_final`` at most
  ``MAX_SUBMIT_GUIDANCE_ROUNDS`` times per handler (i.e. per advance);
* connector-reported missing fields pause the run via ``CapabilitySuspend``
  with the ``missing_fields`` reason after the audited tool call.
"""
import pytest

from services.reimbursement.app.capability import (
    MAX_SUBMIT_GUIDANCE_ROUNDS,
    SUBMIT_GUIDANCE_MESSAGE,
    SUSPEND_REASON_MISSING_FIELDS,
    ReimbursementCapabilityHandler,
)
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import (
    SUSPEND_REASON_AWAITING_APPROVAL,
    CapabilityError,
    CapabilitySuspend,
)
from services.runtime.app.model_provider import ModelToolCall


CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.test/v1/chat/completions",
    model_api_key="test-key",
)


class ConnectedGateway:
    def __init__(self, validate_result=None):
        self.calls = []
        self._validate_result = validate_result or {
            "valid": True,
            "missing_fields": [],
            "policy_summary": "交通费在标准内",
            "risk_level": "low",
        }

    def status(self):
        return {"status": "connected", "server": "unit-test"}

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "reimbursement.validate_draft":
            return self._validate_result
        raise AssertionError(f"unexpected tool call: {tool_name}")


def _handler(adapter=None):
    orchestrator = ReimbursementOrchestrator(
        adapter=adapter or ConnectedGateway(),
        settings=CONFIGURED_SETTINGS,
    )
    run = orchestrator.begin_run("demo", "u_demo", "请帮我报销 ACME 项目交通费。")
    skill = orchestrator.skill_loader.load(
        orchestrator.settings.reimbursement_skill_id
    )
    handler = ReimbursementCapabilityHandler(
        orchestrator=orchestrator,
        skill=skill,
        mcp_status=adapter.status() if adapter else None,
        run=run,
    )
    return orchestrator, run, handler


def _submit_intent_call(**overrides):
    arguments = {
        "external_reimbursement_id": "EXT-DRAFT-001",
        "amount": 128,
        "currency": "CNY",
        "reason": "ACME 项目差旅交通",
        "policy_summary": "交通费在标准内",
        "risk_level": "low",
    }
    arguments.update(overrides)
    return ModelToolCall(
        id="call_submit_intent",
        name="reimbursement.submit_intent",
        arguments=arguments,
    )


def _prime_validated_draft(orchestrator, run):
    """Give the run an external draft + a matching draft.validated audit event."""
    run.draft.amount = 128
    run.draft.currency = "CNY"
    run.draft.reason = "ACME 项目差旅交通"
    run.draft.external_reimbursement_id = "EXT-DRAFT-001"
    run.draft.external_status = "draft"
    orchestrator.audit.append(
        run.audit_events,
        "reimbursement.draft.validated",
        run.id,
        {
            "draft_hash": "unit-test-hash",
            "policy_summary": "交通费在标准内",
            "risk_level": "low",
        },
    )


# --- mixed-batch guard --------------------------------------------------------


def test_on_tool_batch_rejects_submit_intent_mixed_with_other_calls():
    _orchestrator, run, handler = _handler()
    mixed = [
        ModelToolCall(id="c1", name="reimbursement.create_draft", arguments={}),
        _submit_intent_call(),
    ]

    with pytest.raises(CapabilityError) as exc_info:
        handler.on_tool_batch(mixed)

    assert exc_info.value.error_code == "submit_intent_requires_prior_observation"
    assert exc_info.value.message == (
        "submit_intent must be requested after prior tool observations"
    )
    # The guard rejects before any state change.
    assert run.approval is None
    assert run.audit_events == []


def test_on_tool_batch_allows_lone_submit_intent_and_plain_batches():
    _orchestrator, _run, handler = _handler()

    handler.on_tool_batch([_submit_intent_call()])
    handler.on_tool_batch(
        [
            ModelToolCall(id="c1", name="reimbursement.validate_draft", arguments={}),
            ModelToolCall(id="c2", name="reimbursement.create_draft", arguments={}),
        ]
    )


# --- submit_intent gate (THE suspend) ------------------------------------------


def test_submit_intent_suspends_with_ordered_approval_audit_chain():
    orchestrator, run, handler = _handler()
    _prime_validated_draft(orchestrator, run)

    with pytest.raises(CapabilitySuspend) as exc_info:
        handler.dispatch_tool(
            # Model-authored policy_summary is overridden by the authoritative
            # validate_draft output injected from the audit trail.
            _submit_intent_call(policy_summary="模型自编政策结论")
        )

    assert exc_info.value.reason == SUSPEND_REASON_AWAITING_APPROVAL
    assert run.approval is not None
    assert exc_info.value.detail == {"approval_id": run.approval.id}
    assert run.status == "waiting_confirmation"
    assert run.approval.payload["policy_summary"] == "交通费在标准内"
    # Resume must find the run by approval id (registered before the suspend).
    assert orchestrator.get_run_by_approval_id(run.approval.id) is run
    # The tamper-evident order: intent requested STRICTLY before requested.
    event_types = [event.type for event in run.audit_events]
    assert event_types == [
        "reimbursement.draft.validated",
        "approval.intent.requested",
        "approval.requested",
    ]
    intent_event = run.audit_events[1]
    assert intent_event.payload == {
        "external_reimbursement_id": "EXT-DRAFT-001",
        "risk_level": "low",
    }
    requested_event = run.audit_events[2]
    assert requested_event.payload["approval_id"] == run.approval.id
    assert requested_event.payload["approval_payload_hash"] == run.approval.payload_hash
    assert (
        requested_event.payload["draft_snapshot_hash"]
        == run.approval.draft_snapshot_hash
    )


def test_submit_intent_gate_error_is_capability_error_without_approval():
    _orchestrator, run, handler = _handler()

    with pytest.raises(CapabilityError) as exc_info:
        handler.dispatch_tool(_submit_intent_call())

    assert exc_info.value.error_code == "external_reimbursement_id_required"
    assert run.approval is None
    assert run.status != "waiting_confirmation"
    assert not any(event.type.startswith("approval.") for event in run.audit_events)


# --- submit-guidance nudge ------------------------------------------------------


def test_on_assistant_final_nudges_at_most_max_rounds_when_draft_created():
    orchestrator, run, handler = _handler()
    run.draft.external_reimbursement_id = "EXT-DRAFT-001"

    first = handler.on_assistant_final("草稿已创建。")
    second = handler.on_assistant_final("请确认。")
    third = handler.on_assistant_final("仍在等待。")

    assert MAX_SUBMIT_GUIDANCE_ROUNDS == 2
    assert first == SUBMIT_GUIDANCE_MESSAGE
    assert second == SUBMIT_GUIDANCE_MESSAGE
    assert third is None
    # Every final (nudged or not) records the agent message state + audit.
    assert run.status == "collecting"
    assert run.agent_message == "仍在等待。"
    agent_events = [
        event
        for event in run.audit_events
        if event.type == "reimbursement.agent.message"
    ]
    assert len(agent_events) == 3
    assert agent_events[0].payload["message_hash"] == orchestrator._hash_payload(
        {"message": "草稿已创建。"}
    )


def test_on_assistant_final_never_nudges_without_external_draft():
    _orchestrator, run, handler = _handler()

    assert handler.on_assistant_final("请补充报销信息。") is None
    assert run.status == "collecting"
    assert run.agent_message == "请补充报销信息。"


# --- connector missing fields pause ---------------------------------------------


def test_validate_draft_connector_missing_fields_suspends_after_audited_call():
    gateway = ConnectedGateway(
        validate_result={
            "valid": False,
            "missing_fields": ["project_id", "attachments"],
            "policy_summary": "缺少项目和附件",
            "risk_level": "medium",
        }
    )
    _orchestrator, run, handler = _handler(adapter=gateway)

    with pytest.raises(CapabilitySuspend) as exc_info:
        handler.dispatch_tool(
            ModelToolCall(
                id="call_validate",
                name="reimbursement.validate_draft",
                arguments={
                    "draft": {
                        "category": "transport",
                        "amount": 128,
                        "currency": "CNY",
                        "expense_date": "2026-05-29",
                        "merchant": "上海交通服务",
                        "reason": "ACME 项目差旅交通",
                        "department_id": "sales",
                        "cost_center_id": "cc_acme",
                    }
                },
            )
        )

    assert exc_info.value.reason == SUSPEND_REASON_MISSING_FIELDS
    assert run.status == "collecting"
    assert run.missing_fields == ["project_id", "attachments"]
    assert [event.type for event in run.audit_events] == [
        "mcp.tool.called",
        "reimbursement.policy.checked",
        "reimbursement.missing_fields.requested",
    ]
    assert len(gateway.calls) == 1
