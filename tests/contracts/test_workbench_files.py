from __future__ import annotations

import json

import httpx
from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.business.harness_client import HarnessHostClient
from services.business.mode import BusinessModeConfig
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


SERVICE_TOKEN = "workbench-files-service-token"
LOCAL_HEADERS = {
    "X-Anna-Workspace-ID": "legacy-workspace",
    "X-Anna-User-ID": "legacy-local-user",
}


def _configure(tmp_path, monkeypatch) -> IdentityService:
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
    monkeypatch.setenv("ANNA_WORKSPACE_ID", LOCAL_HEADERS["X-Anna-Workspace-ID"])
    monkeypatch.setenv("ANNA_USER_ID", LOCAL_HEADERS["X-Anna-User-ID"])

    identity_store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(identity_store)
    return IdentityService(identity_store)


def _product_client(identity: IdentityService) -> TestClient:
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token=SERVICE_TOKEN,
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config),
        identity_service=identity,
    )
    return TestClient(app)


def _bearer_headers(token: str, user_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-Anna-Workspace-ID": "ws_crew_demo",
        "X-Anna-User-ID": user_id,
    }


def test_legacy_workdir_is_visible_to_local_public_and_internal_scope(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    folder = tmp_path / "legacy-project"
    folder.mkdir()

    with TestClient(create_app(product_mode=False, identity_service=identity)) as legacy:
        registered = legacy.post(
            "/api/workdirs",
            json={"path": str(folder), "name": "Legacy project"},
            headers=LOCAL_HEADERS,
        )
        assert registered.status_code == 200
        workdir = registered.json()
        assert "owner_workspace_id" not in workdir
        assert "owner_actor_user_id" not in workdir

    with _product_client(identity) as product:
        listed = product.get("/api/workdirs", headers=LOCAL_HEADERS)
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["workdirs"]] == [workdir["id"]]

        scoped = product.post(
            "/_business/workbench/scope",
            headers={"X-Anna-Service-Token": SERVICE_TOKEN},
            json={
                "workspace_id": LOCAL_HEADERS["X-Anna-Workspace-ID"],
                "actor_user_id": LOCAL_HEADERS["X-Anna-User-ID"],
                "workdir_id": workdir["id"],
            },
        )
        assert scoped.status_code == 200
        assert scoped.json()["workdir_id"] == workdir["id"]
        assert scoped.json()["workdir_path"] == str(folder.resolve())


def test_same_path_workdirs_are_isolated_by_bearer_owner(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    folder = tmp_path / "shared-path"
    folder.mkdir()

    with _product_client(identity) as product:
        boss_login = product.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        andy_login = product.post(
            "/api/auth/login",
            json={"email": "andy@anna.demo", "password": "crew-demo"},
        )
        assert boss_login.status_code == andy_login.status_code == 200
        boss = _bearer_headers(boss_login.json()["token"], "acc_boss")
        andy = _bearer_headers(andy_login.json()["token"], "acc_andy")

        boss_registration = product.post(
            "/api/workdirs", json={"path": str(folder), "name": "Boss view"}, headers=boss
        )
        andy_registration = product.post(
            "/api/workdirs", json={"path": str(folder), "name": "Andy view"}, headers=andy
        )
        assert boss_registration.status_code == andy_registration.status_code == 200
        boss_workdir = boss_registration.json()
        andy_workdir = andy_registration.json()
        assert boss_workdir["id"] == andy_workdir["id"]
        assert boss_workdir["owner_actor_user_id"] == "acc_boss"
        assert andy_workdir["owner_actor_user_id"] == "acc_andy"

        boss_list = product.get("/api/workdirs", headers=boss)
        andy_list = product.get("/api/workdirs", headers=andy)
        assert [item["name"] for item in boss_list.json()["workdirs"]] == ["Boss view"]
        assert [item["name"] for item in andy_list.json()["workdirs"]] == ["Andy view"]

        for headers, expected_name in ((boss, "Boss view"), (andy, "Andy view")):
            scoped = product.post(
                "/_business/workbench/scope",
                headers={"X-Anna-Service-Token": SERVICE_TOKEN},
                json={
                    "workspace_id": "ws_crew_demo",
                    "actor_user_id": headers["X-Anna-User-ID"],
                    "workdir_id": boss_workdir["id"],
                },
            )
            assert scoped.status_code == 200
            assert scoped.json()["workdir_path"] == str(folder.resolve())

            touched = product.post(
                f"/api/workdirs/{boss_workdir['id']}/touch", headers=headers
            )
            assert touched.status_code == 200
            assert touched.json()["name"] == expected_name

        deleted = product.delete(
            f"/api/workdirs/{boss_workdir['id']}", headers=andy
        )
        assert deleted.status_code == 200
        revoked = product.post(
            "/_business/workbench/scope",
            headers={"X-Anna-Service-Token": SERVICE_TOKEN},
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "workdir_id": boss_workdir["id"],
            },
        )
        assert revoked.status_code == 404
        assert [item["name"] for item in product.get("/api/workdirs", headers=boss).json()["workdirs"]] == [
            "Boss view"
        ]
        assert product.get("/api/workdirs", headers=andy).json()["workdirs"] == []


def test_nonproduct_workdir_api_keeps_legacy_header_semantics_with_bearer(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    folder = tmp_path / "legacy-header-api"
    folder.mkdir()

    with TestClient(create_app(product_mode=False, identity_service=identity)) as client:
        registered = client.post(
            "/api/workdirs", json={"path": str(folder)}, headers=LOCAL_HEADERS
        )
        assert registered.status_code == 200
        token_response = client.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        assert token_response.status_code == 200
        headers = {
            **LOCAL_HEADERS,
            "Authorization": f"Bearer {token_response.json()['token']}",
        }

        listed = client.get("/api/workdirs", headers=headers)
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["workdirs"]] == [registered.json()["id"]]


def test_product_workdir_identity_ignores_service_headers_and_client_owner_fields(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    folder = tmp_path / "identity-bound"
    folder.mkdir()

    with _product_client(identity) as product:
        login = product.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        assert login.status_code == 200
        token = login.json()["token"]
        headers = _bearer_headers(token, "acc_boss")

        registered = product.post(
            "/api/workdirs",
            json={
                "path": str(folder),
                "name": "Server-owned",
                "owner_workspace_id": "attacker-workspace",
                "owner_actor_user_id": "attacker-user",
            },
            headers=headers,
        )
        assert registered.status_code == 200
        item = registered.json()
        assert item["owner_workspace_id"] == "ws_crew_demo"
        assert item["owner_actor_user_id"] == "acc_boss"

        spoofed_headers = {
            "X-Anna-Workspace-ID": "attacker-workspace",
            "X-Anna-User-ID": "attacker-user",
            "X-Anna-Service-Token": SERVICE_TOKEN,
        }
        assert product.get("/api/workdirs", headers=spoofed_headers).status_code == 403

        conflicting_headers = {
            **headers,
            "X-Anna-User-ID": "acc_andy",
        }
        assert product.get("/api/workdirs", headers=conflicting_headers).status_code == 403

        wrong_token = product.post(
            "/_business/workbench/scope",
            headers={"X-Anna-Service-Token": "wrong-service-token"},
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_boss",
                "workdir_id": item["id"],
            },
        )
        assert wrong_token.status_code == 401

        cross_owner = product.post(
            "/_business/workbench/scope",
            headers={"X-Anna-Service-Token": SERVICE_TOKEN},
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "workdir_id": item["id"],
            },
        )
        assert cross_owner.status_code == 404

        unknown = product.post(
            "/_business/workbench/scope",
            headers={"X-Anna-Service-Token": SERVICE_TOKEN},
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_boss",
                "workdir_id": "missing-workdir",
            },
        )
        assert unknown.status_code == 404


def test_product_chat_rejects_header_identity_forgery_before_host_submission(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token=SERVICE_TOKEN,
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    submitted: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        submitted.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "run_id": "host-chat-forged",
                "status": "completed",
                "result": {"assistant_message": "should not run"},
            },
        )

    host = HarnessHostClient(config, transport=httpx.MockTransport(handler))
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=host,
        identity_service=identity,
    )
    with TestClient(app) as product:
        login = product.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        assert login.status_code == 200
        forged = {
            "Authorization": f"Bearer {login.json()['token']}",
            "X-Anna-Workspace-ID": "ws_crew_demo",
            "X-Anna-User-ID": "acc_andy",
        }
        response = product.post(
            "/api/chat/runs",
            headers=forged,
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "message": "伪造身份不应进入 Host",
            },
        )

    assert response.status_code == 403
    assert submitted == []


def test_product_create_rejects_header_identity_forgery_before_host_submission(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token=SERVICE_TOKEN,
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    submitted: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        submitted.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "run_id": "host-create-forged",
                "status": "completed",
                "result": {"artifact": {"kind": "skill"}},
            },
        )

    host = HarnessHostClient(config, transport=httpx.MockTransport(handler))
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=host,
        identity_service=identity,
    )
    with TestClient(app) as product:
        login = product.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        assert login.status_code == 200
        forged = {
            "Authorization": f"Bearer {login.json()['token']}",
            "X-Anna-Workspace-ID": "ws_crew_demo",
            "X-Anna-User-ID": "acc_andy",
        }
        response = product.post(
            "/api/create/drafts",
            headers=forged,
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "prompt": "伪造身份不应进入 Host",
            },
        )

    assert response.status_code == 403
    assert submitted == []


def test_product_chat_host_context_uses_bearer_owner_for_same_path_workdirs(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    folder = tmp_path / "same-path-chat"
    folder.mkdir()
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token=SERVICE_TOKEN,
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    submitted: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        submitted.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "run_id": "host-chat-owner",
                "status": "completed",
                "result": {"assistant_message": "完成"},
            },
        )

    host = HarnessHostClient(config, transport=httpx.MockTransport(handler))
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=host,
        identity_service=identity,
    )
    with TestClient(app) as product:
        boss_login = product.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        andy_login = product.post(
            "/api/auth/login",
            json={"email": "andy@anna.demo", "password": "crew-demo"},
        )
        assert boss_login.status_code == andy_login.status_code == 200
        boss = _bearer_headers(boss_login.json()["token"], "acc_boss")
        andy = _bearer_headers(andy_login.json()["token"], "acc_andy")
        boss_workdir = product.post(
            "/api/workdirs",
            json={"path": str(folder), "name": "Boss tree"},
            headers=boss,
        )
        andy_workdir = product.post(
            "/api/workdirs",
            json={"path": str(folder), "name": "Andy tree"},
            headers=andy,
        )
        assert boss_workdir.status_code == andy_workdir.status_code == 200
        assert boss_workdir.json()["id"] == andy_workdir.json()["id"]

        response = product.post(
            "/api/chat/runs",
            headers=andy,
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "message": "读取我的目录",
                "workdir_id": andy_workdir.json()["id"],
            },
        )

    assert response.status_code == 200
    assert len(submitted) == 1
    assert "名称：Andy tree" in submitted[0]["system_prompt"]
    assert "名称：Boss tree" not in submitted[0]["system_prompt"]


def test_product_chat_business_callback_rechecks_workdir_owner_before_file_io(
    tmp_path, monkeypatch
):
    identity = _configure(tmp_path, monkeypatch)
    folder = tmp_path / "callback-owner"
    folder.mkdir()
    (folder / "note.txt").write_text("private", encoding="utf-8")
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token=SERVICE_TOKEN,
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "run_id": "host-chat-callback-owner",
                "status": "completed",
                "result": {"assistant_message": "完成"},
            },
        )

    host = HarnessHostClient(config, transport=httpx.MockTransport(handler))
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=host,
        identity_service=identity,
    )
    with TestClient(app) as product:
        boss_login = product.post(
            "/api/auth/login",
            json={"email": "boss@anna.demo", "password": "crew-demo"},
        )
        andy_login = product.post(
            "/api/auth/login",
            json={"email": "andy@anna.demo", "password": "crew-demo"},
        )
        assert boss_login.status_code == andy_login.status_code == 200
        boss = _bearer_headers(boss_login.json()["token"], "acc_boss")
        andy = _bearer_headers(andy_login.json()["token"], "acc_andy")
        registration = product.post(
            "/api/workdirs",
            json={"path": str(folder), "name": "Boss only"},
            headers=boss,
        )
        assert registration.status_code == 200
        run = product.post(
            "/api/chat/runs",
            headers=andy,
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "message": "不要读取别人的目录",
                "workdir_id": registration.json()["id"],
            },
        )
        assert run.status_code == 200
        callback = product.post(
            "/_business/chat/tools/call",
            headers={"X-Anna-Service-Token": SERVICE_TOKEN},
            json={
                "workspace_id": "ws_crew_demo",
                "actor_user_id": "acc_andy",
                "run_id": run.json()["id"],
                "name": "workdir.read_file",
                "arguments": {"path": "note.txt"},
            },
        )

    assert callback.status_code == 422
