from fastapi.testclient import TestClient

from services.api.app.main import create_app


HEADERS = {
    "X-Anna-Workspace-ID": "demo",
    "X-Anna-User-ID": "u_demo",
}


def test_api_recovers_reimbursement_run_after_app_restart_when_state_db_is_configured(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "anna-state.sqlite3"))
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)

    first_client = TestClient(create_app())
    create_response = first_client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "请帮我报销 ACME 项目交通费。",
        },
    )
    assert create_response.status_code == 200
    created = create_response.json()
    assert created["status"] == "failed"
    assert created["error_code"] == "model_not_configured"

    restarted_client = TestClient(create_app())
    get_response = restarted_client.get(
        f"/api/cowork/reimbursements/runs/{created['id']}",
        headers=HEADERS,
    )

    assert get_response.status_code == 200
    restored = get_response.json()
    assert restored["id"] == created["id"]
    assert restored["error_code"] == "model_not_configured"
    assert [event["type"] for event in restored["audit_events"]][-1] == (
        "reimbursement.failed"
    )


def test_api_defaults_to_runtime_config_adjacent_state_db(monkeypatch, tmp_path):
    runtime_config_path = tmp_path / "config" / "runtime.json"
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(runtime_config_path))
    monkeypatch.delenv("ANNA_STATE_DB_PATH", raising=False)
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)

    first_client = TestClient(create_app())
    create_response = first_client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "请帮我报销 ACME 项目交通费。",
        },
    )
    assert create_response.status_code == 200
    created = create_response.json()

    restarted_client = TestClient(create_app())
    get_response = restarted_client.get(
        f"/api/cowork/reimbursements/runs/{created['id']}",
        headers=HEADERS,
    )
    status_response = restarted_client.get(
        "/api/admin/runtime/status",
        headers=HEADERS,
    )

    assert get_response.status_code == 200
    assert get_response.json()["id"] == created["id"]
    assert status_response.json()["config"]["state_db_path"] == str(
        tmp_path / "state" / "anna-state.sqlite3"
    )


def test_api_lists_only_current_user_reimbursement_runs(monkeypatch, tmp_path):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "anna-state.sqlite3"))
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    client = TestClient(create_app())

    first_response = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "第一笔报销。",
        },
    )
    other_response = client.post(
        "/api/cowork/reimbursements/runs",
        headers={
            "X-Anna-Workspace-ID": "demo",
            "X-Anna-User-ID": "other_user",
        },
        json={
            "workspace_id": "demo",
            "actor_user_id": "other_user",
            "input_text": "其他用户的报销。",
        },
    )
    second_response = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "第二笔报销。",
        },
    )

    list_response = client.get("/api/cowork/reimbursements/runs", headers=HEADERS)

    assert first_response.status_code == 200
    assert other_response.status_code == 200
    assert second_response.status_code == 200
    assert list_response.status_code == 200
    listed_ids = [run["id"] for run in list_response.json()["runs"]]
    assert listed_ids == [
        second_response.json()["id"],
        first_response.json()["id"],
    ]
    assert other_response.json()["id"] not in listed_ids
