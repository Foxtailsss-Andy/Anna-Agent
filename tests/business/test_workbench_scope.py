from __future__ import annotations

import json
from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.business.harness_client import HarnessHostClient
from services.business.mode import BusinessModeConfig
from services.identity.app.seed import DEMO_WORKSPACE_ID, seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def test_workbench_scope_resolves_real_bearer_identity(tmp_path, monkeypatch):
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
    host = HarnessHostClient(config)
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=host,
        identity_service=identity,
    )
    client = TestClient(app)
    login = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    )
    assert login.status_code == 200
    token = login.json()["token"]

    response = client.post(
        "/_business/workbench/scope",
        headers={
            "x-anna-service-token": "workbench-service-token",
            "authorization": f"Bearer {token}",
        },
        json={"workspace_id": DEMO_WORKSPACE_ID, "actor_user_id": "acc_boss"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": DEMO_WORKSPACE_ID,
        "actor_user_id": "acc_boss",
        "channel_id": f"chat_channel:{DEMO_WORKSPACE_ID}",
    }
