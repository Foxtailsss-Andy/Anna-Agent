from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from services.runtime.app.skill_loader import SkillLoader


HEADERS = {
    "X-Anna-Workspace-ID": "demo",
    "X-Anna-User-ID": "u_demo",
}


class AssociateExecutionModelProvider:
    def __init__(self):
        self.settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="model-key",
            erp_mcp_server="https://erp.example/mcp",
        )
        self.requests = []

    async def create_response(self, request):
        self.requests.append(request)
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_aging",
                        name="erp.finance.get_receivables_aging",
                        arguments={"period": "2026-06", "overdue_days": 30},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_plan",
                    name="associate.emit_goal_plan",
                    arguments={
                        "goal": "逾期 30 天以上应收金额降低 20%",
                        "summary": "优先处理华东客户 A。",
                        "nodes": [
                            {
                                "id": "n1",
                                "title": "生成客户跟进任务草案",
                                "status": "blocked",
                                "owner": "finance_user",
                                "depends_on": [],
                                "blocker": "需要审批后执行",
                                "write_intent": {
                                    "action_type": "erp.collection_task.create_draft",
                                    "risk_level": "medium",
                                    "summary": "为华东客户 A 创建催收跟进任务草案。",
                                },
                            }
                        ],
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class ExecutableAssociateGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")
        self.calls = []

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.get_receivables_aging"],
            "tools": [{"name": "erp.finance.get_receivables_aging"}],
        }

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "erp.finance.get_receivables_aging":
            return {
                "period": arguments["period"],
                "items": [{"customer": "华东客户 A", "amount": 180000}],
                "sources": ["ERP_AR_AGING"],
            }
        if tool_name == "erp.collection_task.create_draft":
            return {
                "external_task_id": "collection-task-api-001",
                "external_status": "draft_created",
            }
        raise AssertionError(f"unexpected Associate MCP tool: {tool_name}")


def test_default_associate_receivables_run_fails_setup_instead_of_fake_plan(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_ERP_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.post(
        "/api/cowork/associate/receivables-recovery/runs",
        headers={
            "X-Anna-Workspace-ID": "demo",
            "X-Anna-User-ID": "u_demo",
        },
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "period": "2026-06",
            "goal_text": "把逾期 30 天以上应收金额降低 20%",
        },
    )

    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "failed"
    assert body["error_code"] == "model_not_configured"
    assert body["plan"] is None
    assert "nodes" not in body


def test_api_recovers_associate_run_after_app_restart_when_state_db_is_configured(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "anna-state.sqlite3"))
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_ERP_MCP_SERVER", raising=False)

    first_client = TestClient(create_app())
    create_response = first_client.post(
        "/api/cowork/associate/receivables-recovery/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "period": "2026-06",
            "goal_text": "把逾期 30 天以上应收金额降低 20%",
        },
    )
    assert create_response.status_code == 200
    created = create_response.json()
    assert created["status"] == "failed"
    assert created["error_code"] == "model_not_configured"

    restarted_client = TestClient(create_app())
    get_response = restarted_client.get(
        f"/api/cowork/associate/receivables-recovery/runs/{created['id']}",
        headers=HEADERS,
    )

    assert get_response.status_code == 200
    restored = get_response.json()
    assert restored["id"] == created["id"]
    assert restored["error_code"] == "model_not_configured"
    assert [event["type"] for event in restored["audit_events"]][-1] == "associate.failed"


def test_associate_node_execution_api_requires_approval_before_mcp_write():
    gateway = ExecutableAssociateGateway()
    client = TestClient(
        create_app(
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=gateway,
                model_provider=AssociateExecutionModelProvider(),
                skill_loader=SkillLoader(),
            )
        )
    )
    create_response = client.post(
        "/api/cowork/associate/receivables-recovery/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "period": "2026-06",
            "goal_text": "把逾期 30 天以上应收金额降低 20%",
        },
    )
    created = create_response.json()

    approval_response = client.post(
        f"/api/cowork/associate/receivables-recovery/runs/{created['id']}/nodes/n1/approval",
        headers=HEADERS,
        json={"requested_by": "u_demo"},
    )
    pending = approval_response.json()

    assert create_response.status_code == 200
    assert approval_response.status_code == 200
    assert pending["plan"]["nodes"][0]["approval"]["status"] == "pending"
    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]

    approve_response = client.post(
        f"/api/cowork/associate/receivables-recovery/approvals/{pending['plan']['nodes'][0]['approval']['id']}/approve",
        headers=HEADERS,
        json={"approved_by": "u_demo"},
    )
    approved = approve_response.json()

    assert approve_response.status_code == 200
    node = approved["plan"]["nodes"][0]
    assert node["status"] == "verify_pending"
    assert node["approval"]["status"] == "approved"
    assert node["write_action"]["verify_status"] == "verify_pending"
    assert node["write_action"]["external_task_id"] == "collection-task-api-001"
    assert [call[0] for call in gateway.calls] == [
        "erp.finance.get_receivables_aging",
        "erp.collection_task.create_draft",
    ]


def test_associate_node_execution_api_rejects_identity_mismatch():
    client = TestClient(create_app())

    response = client.post(
        "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n1/approval",
        headers=HEADERS,
        json={"requested_by": "other-user"},
    )

    assert response.status_code == 403


def test_associate_node_execution_api_returns_404_for_missing_node():
    gateway = ExecutableAssociateGateway()
    client = TestClient(
        create_app(
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=gateway,
                model_provider=AssociateExecutionModelProvider(),
                skill_loader=SkillLoader(),
            )
        )
    )
    created = client.post(
        "/api/cowork/associate/receivables-recovery/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "period": "2026-06",
            "goal_text": "把逾期 30 天以上应收金额降低 20%",
        },
    ).json()

    response = client.post(
        f"/api/cowork/associate/receivables-recovery/runs/{created['id']}/nodes/missing-node/approval",
        headers=HEADERS,
        json={"requested_by": "u_demo"},
    )

    assert response.status_code == 404
    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]


def test_associate_node_execution_api_rejects_approve_identity_mismatch():
    gateway = ExecutableAssociateGateway()
    client = TestClient(
        create_app(
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=gateway,
                model_provider=AssociateExecutionModelProvider(),
                skill_loader=SkillLoader(),
            )
        )
    )
    created = client.post(
        "/api/cowork/associate/receivables-recovery/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "period": "2026-06",
            "goal_text": "把逾期 30 天以上应收金额降低 20%",
        },
    ).json()
    pending = client.post(
        f"/api/cowork/associate/receivables-recovery/runs/{created['id']}/nodes/n1/approval",
        headers=HEADERS,
        json={"requested_by": "u_demo"},
    ).json()

    response = client.post(
        f"/api/cowork/associate/receivables-recovery/approvals/{pending['plan']['nodes'][0]['approval']['id']}/approve",
        headers=HEADERS,
        json={"approved_by": "other-user"},
    )

    assert response.status_code == 403
    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]
