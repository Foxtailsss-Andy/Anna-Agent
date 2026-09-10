from __future__ import annotations

import json

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.business.harness_client import HarnessHostClient
from services.business.mode import BusinessModeConfig
from services.identity.app.seed import DEMO_WORKSPACE_ID, seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def _client(tmp_path, monkeypatch) -> TestClient:
    runtime_config = tmp_path / "runtime.json"
    runtime_config.write_text(json.dumps({}), encoding="utf-8")
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(runtime_config))
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("ANNA_RUNS_DB_PATH", str(tmp_path / "runs.sqlite3"))
    monkeypatch.setenv("ANNA_CREATE_WORKSPACE_ROOT", str(tmp_path / "create-runs"))
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "workdirs.json"))
    monkeypatch.setenv("ANNA_MODEL_ENDPOINT", "")
    monkeypatch.setenv("ANNA_MODEL_API_KEY", "")
    monkeypatch.setenv("ANNA_MODEL_NAME", "fixture-model")

    identity_store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(identity_store)
    identity = IdentityService(identity_store)
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="workbench-service-token",
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config),
        identity_service=identity,
    )
    return TestClient(app)


def test_workbench_scope_preserves_real_local_identity_fallback_without_authorization(
    tmp_path, monkeypatch
):
    client = _client(tmp_path, monkeypatch)
    local_session = client.get("/api/session/current")
    assert local_session.status_code == 200
    local = local_session.json()

    response = client.post(
        "/_business/workbench/scope",
        headers={"X-Anna-Service-Token": "workbench-service-token"},
        json={},
    )

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": local["workspace_id"],
        "actor_user_id": local["user_id"],
        "channel_id": f"chat_channel:{local['workspace_id']}",
    }


def test_workbench_scope_revalidates_the_same_real_local_identity_for_host_body(
    tmp_path, monkeypatch
):
    client = _client(tmp_path, monkeypatch)
    local_session = client.get("/api/session/current")
    assert local_session.status_code == 200
    local = local_session.json()

    response = client.post(
        "/_business/workbench/scope",
        headers={"X-Anna-Service-Token": "workbench-service-token"},
        json={
            "workspace_id": local["workspace_id"],
            "actor_user_id": local["user_id"],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": local["workspace_id"],
        "actor_user_id": local["user_id"],
        "channel_id": f"chat_channel:{local['workspace_id']}",
    }

    spoofed = client.post(
        "/_business/workbench/scope",
        headers={"X-Anna-Service-Token": "workbench-service-token"},
        json={
            "workspace_id": local["workspace_id"],
            "actor_user_id": "acc_boss",
        },
    )
    assert spoofed.status_code == 404


def test_workbench_scope_resolves_real_bearer_identity_with_explicit_scope(
    tmp_path, monkeypatch
):
    client = _client(tmp_path, monkeypatch)
    login = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    )
    assert login.status_code == 200
    token = login.json()["token"]

    response = client.post(
        "/_business/workbench/scope",
        headers={
            "X-Anna-Service-Token": "workbench-service-token",
            "Authorization": f"Bearer {token}",
        },
        json={"workspace_id": DEMO_WORKSPACE_ID, "actor_user_id": "acc_boss"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": DEMO_WORKSPACE_ID,
        "actor_user_id": "acc_boss",
        "channel_id": f"chat_channel:{DEMO_WORKSPACE_ID}",
    }


def test_workbench_scope_rechecks_real_logged_in_actor_without_bearer_for_host(
    tmp_path, monkeypatch
):
    client = _client(tmp_path, monkeypatch)
    login = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    )
    assert login.status_code == 200

    response = client.post(
        "/_business/workbench/scope",
        headers={"X-Anna-Service-Token": "workbench-service-token"},
        json={"workspace_id": DEMO_WORKSPACE_ID, "actor_user_id": "acc_boss"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": DEMO_WORKSPACE_ID,
        "actor_user_id": "acc_boss",
        "channel_id": f"chat_channel:{DEMO_WORKSPACE_ID}",
    }


def test_workbench_scope_rejects_invalid_authorization_without_local_fallback(
    tmp_path, monkeypatch
):
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/_business/workbench/scope",
        headers={
            "X-Anna-Service-Token": "workbench-service-token",
            "Authorization": "Bearer invalid-token",
        },
        json={},
    )

    assert response.status_code == 401
