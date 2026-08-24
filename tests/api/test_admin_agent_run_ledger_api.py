import json

from fastapi.testclient import TestClient

from services.api.app.main import create_app


HEADERS = {
    "X-Anna-Workspace-ID": "demo",
    "X-Anna-User-ID": "u_demo",
}

RUNTIME_ENV_KEYS = (
    "ANNA_MODEL_API_KEY",
    "ANNA_MODEL_ENDPOINT",
    "ANNA_MODEL_PROVIDER",
    "ANNA_MODEL_NAME",
    "ANNA_RUNTIME_CONFIG_PATH",
    "ANNA_REIMBURSEMENT_MCP_SERVER",
    "ANNA_REIMBURSEMENT_MCP_API_KEY",
    "ANNA_ERP_MCP_SERVER",
    "ANNA_ERP_MCP_API_KEY",
)


def test_admin_agent_run_ledger_lists_cross_runtime_runs_without_raw_inputs(tmp_path, monkeypatch):
    for env_key in RUNTIME_ENV_KEYS:
        monkeypatch.delenv(env_key, raising=False)
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "anna-state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "anna-memory.sqlite3"))
    client = TestClient(create_app())
    raw_secret = "raw-secret-should-not-appear"

    client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "message": f"请总结 {raw_secret}",
            "template_id": "summarize",
        },
    )
    client.post(
        "/api/cowork/associate/receivables-recovery/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "period": "2026-06",
            "goal_text": f"催收客户 {raw_secret}",
        },
    )
    client.post(
        "/api/create/drafts",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": f"生成提示词 {raw_secret}",
        },
    )
    client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": f"报销餐饮 100 元 {raw_secret}",
        },
    )

    response = client.get("/api/admin/agent-runs/ledger", headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["summary"] == {
        "run_count": 4,
        "event_count": 11,
        "domains": {
            "associate": 1,
            "chat": 1,
            "create": 1,
            "reimbursement": 1,
        },
        "statuses": {"failed": 4},
    }
    assert [run["domain"] for run in body["runs"]] == [
        "reimbursement",
        "create",
        "associate",
        "chat",
    ]
    create_entry = next(run for run in body["runs"] if run["domain"] == "create")
    assert create_entry["kind"] == "prompt"
    assert create_entry["event_types"] == [
        "create.prompt.run.created",
        "create.failed",
    ]
    reimbursement_entry = next(
        run for run in body["runs"] if run["domain"] == "reimbursement"
    )
    assert reimbursement_entry["writes_external_data"] is False
    assert reimbursement_entry["approval_required"] is False
    assert reimbursement_entry["error_code"] == "model_not_configured"
    assert raw_secret not in json.dumps(body, ensure_ascii=False)


def test_admin_agent_run_ledger_rejects_cross_workspace_access():
    client = TestClient(create_app())

    response = client.get(
        "/api/admin/agent-runs/ledger",
        headers=HEADERS,
        params={"workspace_id": "other-workspace"},
    )

    assert response.status_code == 403
