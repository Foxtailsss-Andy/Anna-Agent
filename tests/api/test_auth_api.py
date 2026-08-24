from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes import auth as auth_routes
from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def _client(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    store.create_workspace("ws1", "Acme")
    store.create_team("t1", "ws1", "Core")
    store.create_account(
        Account(id="acc1", workspace_id="ws1", email="boss@acme.test",
                display_name="Boss", role="boss"),
        hash_password("secret"),
    )
    store.create_account(
        Account(id="acc2", workspace_id="ws1", email="mate@acme.test",
                display_name="Mate", role="member"),
        hash_password("secret"),
    )
    identity = IdentityService(store)
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    return TestClient(app)


def test_login_success(tmp_path):
    client = _client(tmp_path)
    response = client.post("/api/auth/login",
                           json={"email": "boss@acme.test", "password": "secret"})
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["session"]["role"] == "boss"


def test_login_wrong_password_is_401(tmp_path):
    client = _client(tmp_path)
    response = client.post("/api/auth/login",
                           json={"email": "boss@acme.test", "password": "nope"})
    assert response.status_code == 401


def test_team_requires_token_and_lists_members(tmp_path):
    client = _client(tmp_path)
    assert client.get("/api/auth/team").status_code == 401
    token = client.post("/api/auth/login",
                        json={"email": "boss@acme.test", "password": "secret"}).json()["token"]
    response = client.get("/api/auth/team", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["members"]}
    assert ids == {"acc1", "acc2"}


def test_logout_invalidates_token(tmp_path):
    client = _client(tmp_path)
    token = client.post("/api/auth/login",
                        json={"email": "boss@acme.test", "password": "secret"}).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/auth/team", headers=auth).status_code == 200
    assert client.post("/api/auth/logout", headers=auth).status_code == 200
    assert client.get("/api/auth/team", headers=auth).status_code == 401
