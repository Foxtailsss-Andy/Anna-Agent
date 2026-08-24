import json

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.mcp_gateway.app.reimbursement_adapter import ReimbursementMcpGateway
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from tests.mcp_gateway.local_reimbursement_mcp_server import (
    LocalReimbursementMcpContractServer,
)
from tests.support.engine_fakes import FakeStreamModel


HEADERS = {
    "X-Anna-Workspace-ID": "demo",
    "X-Anna-User-ID": "u_demo",
}


class ValidationProbeModelProvider:
    """Serves ONLY the ``/api/admin/runtime/validate`` model probe.

    The reimbursement agent rounds now run on the platform engine (a fake
    ``stream_model`` — ``ContractApiFlowStream``); the orchestrator's
    ``model_provider`` is still what the runtime validation probe calls.
    """

    def __init__(self) -> None:
        self.settings = RuntimeSettings(
            model_endpoint="https://model.test/v1/chat/completions",
            model_api_key="test-key",
            model_name="mimo-v2.5-pro",
        )
        self.validation_requests = []

    async def create_response(self, request):
        assert _is_runtime_validation_probe(request)
        self.validation_requests.append(request)
        return ModelResponse(assistant_message="ok", finish_reason="stop")


class ContractApiFlowStream(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={"draft": _contract_draft()},
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
                        arguments={"draft": _contract_draft()},
                    )
                ],
                finish_reason="tool_calls",
            )

        create_observation = next(
            message
            for message in request.messages
            if message.get("role") == "tool"
            and message.get("name") == "reimbursement.create_draft"
        )
        external_id = json.loads(create_observation["content"])[
            "external_reimbursement_id"
        ]
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": external_id,
                        "amount": 860,
                        "currency": "CNY",
                        "reason": "ACME 续约客户晚餐",
                        "policy_summary": "contract server validation passed",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class ConnectedErpAdapter:
    settings = RuntimeSettings(erp_mcp_server="https://erp.example/rpc")

    def status(self):
        return {
            "status": "connected",
            "tool_count": 4,
            "tool_names": [
                "erp.finance.get_receivables_aging",
                "erp.collection_task.create_draft",
                "erp.collection_task.get_status",
            ],
        }

    def call_tool(self, tool_name, arguments):
        raise AssertionError("runtime validation ERP readiness must use tools/list only")


def test_reimbursement_api_contract_flow_creates_approves_submits_and_reads_back():
    server = LocalReimbursementMcpContractServer()
    model_provider = ValidationProbeModelProvider()
    stream = ContractApiFlowStream()
    orchestrator = ReimbursementOrchestrator(
        adapter=ReimbursementMcpGateway(
            settings=RuntimeSettings(reimbursement_mcp_server=server.url),
            transport=server.transport(),
        ),
        model_provider=model_provider,
        engine=QueryEngine(
            settings=model_provider.settings, deps=QueryDeps(stream_model=stream)
        ),
    )
    client = TestClient(
        create_app(
            orchestrator=orchestrator,
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ConnectedErpAdapter()),
        )
    )

    validation_response = client.post("/api/admin/runtime/validate")
    create_response = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "我昨天在上海请 ACME 客户吃饭 860 元，项目是 ACME 续约，帮我提交报销。",
        },
    )
    created = create_response.json()
    approve_response = client.post(
        f"/api/cowork/reimbursements/approvals/{created['approval']['id']}/approve",
        headers=HEADERS,
        json={"approved_by": "u_demo"},
    )
    approved = approve_response.json()
    audit_response = client.get(
        f"/api/admin/audit/reimbursement/runs/{approved['id']}",
        headers=HEADERS,
    )
    readback_response = client.get(
        f"/api/cowork/reimbursements/runs/{approved['id']}",
        headers=HEADERS,
    )
    action_response = client.get(
        f"/api/admin/audit/reimbursement/actions/{approved['write_action']['id']}",
        headers=HEADERS,
    )
    duplicate_approve_response = client.post(
        f"/api/cowork/reimbursements/approvals/{created['approval']['id']}/approve",
        headers=HEADERS,
        json={"approved_by": "u_demo"},
    )
    duplicate_audit_response = client.get(
        f"/api/admin/audit/reimbursement/runs/{approved['id']}",
        headers=HEADERS,
    )

    assert validation_response.status_code == 200
    assert validation_response.json()["status"] == "ready"
    assert create_response.status_code == 200
    assert created["status"] == "waiting_confirmation"
    assert created["draft"]["external_reimbursement_id"] == "contract-draft-run_001"
    assert created["approval"]["payload_hash"]
    assert created["approval"]["draft_snapshot_hash"]
    assert created["approval"]["draft_snapshot"]["merchant"] == "上海客户餐厅"
    assert approve_response.status_code == 200
    assert approved["status"] == "completed"
    assert approved["draft"]["external_status"] == "submitted"
    assert approved["write_action"]["verify_status"] == "verified"
    assert approved["write_action"]["approval_payload_hash"] == created["approval"]["payload_hash"]
    assert approved["write_action"]["draft_snapshot_hash"] == created["approval"]["draft_snapshot_hash"]
    assert audit_response.status_code == 200
    assert readback_response.status_code == 200
    assert readback_response.json()["status"] == "completed"
    assert (
        readback_response.json()["draft"]["external_reimbursement_id"]
        == "contract-draft-run_001"
    )
    assert action_response.status_code == 200
    assert action_response.json()["external_reimbursement_id"] == "contract-draft-run_001"
    assert action_response.json()["approval_payload_hash"] == created["approval"]["payload_hash"]
    assert action_response.json()["draft_snapshot_hash"] == created["approval"]["draft_snapshot_hash"]
    assert duplicate_approve_response.status_code == 200
    assert duplicate_approve_response.json()["status"] == "completed"
    assert duplicate_approve_response.json()["write_action"]["id"] == (
        approved["write_action"]["id"]
    )
    assert duplicate_audit_response.status_code == 200
    duplicate_event_types = [
        event["type"] for event in duplicate_audit_response.json()["audit_events"]
    ]
    assert duplicate_event_types.count("approval.approved") == 1
    event_types = [event["type"] for event in audit_response.json()["audit_events"]]
    assert "skill.loaded" in event_types
    assert "model.call.started" in event_types
    assert "mcp.tool.called" in event_types
    assert "approval.approved" in event_types
    assert "reimbursement.submitted" in event_types
    assert "reimbursement.verified" in event_types
    submitted_event = next(
        event
        for event in audit_response.json()["audit_events"]
        if event["type"] == "reimbursement.submitted"
    )
    assert submitted_event["payload"]["approval_id"] == created["approval"]["id"]
    assert submitted_event["payload"]["write_action_id"] == approved["write_action"]["id"]
    assert submitted_event["payload"]["approval_payload_hash"] == created["approval"]["payload_hash"]
    assert submitted_event["payload"]["draft_snapshot_hash"] == created["approval"]["draft_snapshot_hash"]
    called_tools = [
        request["params"]["name"]
        for request in server.requests
        if request["method"] == "tools/call"
    ]
    assert called_tools == [
        "reimbursement.get_capabilities",
        "reimbursement.validate_draft",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit",
        "reimbursement.get_status",
    ]
    assert "reimbursement.submit_intent" not in called_tools
    assert len(model_provider.validation_requests) == 2
    assert len(stream.requests) == 3


def test_reimbursement_api_contract_flow_rejects_external_draft_drift_before_submit():
    server = LocalReimbursementMcpContractServer()
    model_provider = ValidationProbeModelProvider()
    orchestrator = ReimbursementOrchestrator(
        adapter=ReimbursementMcpGateway(
            settings=RuntimeSettings(reimbursement_mcp_server=server.url),
            transport=server.transport(),
        ),
        model_provider=model_provider,
        engine=QueryEngine(
            settings=model_provider.settings,
            deps=QueryDeps(stream_model=ContractApiFlowStream()),
        ),
    )
    client = TestClient(create_app(orchestrator=orchestrator))

    create_response = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "我昨天在上海请 ACME 客户吃饭 860 元，项目是 ACME 续约，帮我提交报销。",
        },
    )
    created = create_response.json()
    server.mutate_draft(
        created["draft"]["external_reimbursement_id"],
        {"merchant": "审批后外部改动的商户"},
    )

    approve_response = client.post(
        f"/api/cowork/reimbursements/approvals/{created['approval']['id']}/approve",
        headers=HEADERS,
        json={"approved_by": "u_demo"},
    )
    failed = approve_response.json()

    assert approve_response.status_code == 200
    assert failed["status"] == "failed"
    assert failed["error_code"] == "external_draft_snapshot_mismatch"
    assert failed["write_action"] is None


def _is_runtime_validation_probe(request) -> bool:
    return any(
        message.get("role") == "user"
        and "Validate that the configured model endpoint" in message.get("content", "")
        for message in request.messages
    )


def _contract_draft() -> dict:
    return {
        "category": "meal",
        "amount": 860,
        "currency": "CNY",
        "expense_date": "2026-05-28",
        "merchant": "上海客户餐厅",
        "reason": "ACME 续约客户晚餐",
        "department_id": "sales",
        "cost_center_id": "cc_acme",
    }
