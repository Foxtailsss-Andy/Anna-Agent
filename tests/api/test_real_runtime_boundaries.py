from fastapi.testclient import TestClient

from services.api.app.main import create_app


def test_default_create_run_fails_setup_instead_of_fake_success(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.post(
        "/api/cowork/reimbursements/runs",
        headers={
            "X-Anna-Workspace-ID": "demo",
            "X-Anna-User-ID": "u_demo",
        },
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "报销上海出差交通费 128 元。",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["error_code"] == "model_not_configured"
    assert body["draft"]["external_reimbursement_id"] is None
    event_types = [event["type"] for event in body["audit_events"]]
    assert "skill.loaded" in event_types
    assert "model.call.started" not in event_types
    assert "model.call.failed" not in event_types


def test_admin_mcp_status_reflects_missing_connector(monkeypatch):
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.get("/api/admin/mcp/reimbursement/status")

    assert response.status_code == 200
    assert response.json()["status"] == "not_configured"
    assert response.json()["error_code"] == "connector_not_configured"
