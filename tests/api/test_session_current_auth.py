from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes import session as session_routes
from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


class _FakeReimbursement:
    # Minimal stand-in: session route only needs it for the local fallback.
    class _Provider:
        class settings:
            runtime_config_path = None
    model_provider = _Provider()

    class _Adapter:
        class settings:
            runtime_config_path = None
    adapter = _Adapter()


def _identity(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    store.create_workspace("ws1", "Acme")
    store.create_team("t1", "ws1", "Core")
    store.create_account(
        Account(id="acc1", workspace_id="ws1", email="boss@acme.test",
                display_name="Boss", role="boss"),
        hash_password("secret"),
    )
    return IdentityService(store)


def _client(tmp_path):
    app = FastAPI()
    app.include_router(
        session_routes.build_router(_FakeReimbursement(), _identity(tmp_path))
    )
    return TestClient(app)


def test_session_current_falls_back_to_local_without_token(tmp_path):
    client = _client(tmp_path)
    response = client.get("/api/session/current")
    assert response.status_code == 200
    body = response.json()
    # local fallback identity (default workspace), unauthenticated
    assert body["workspace_id"] == "local-workspace"
    assert body["source"] == "local-runtime"
    assert body["role"] == "boss"


def test_session_current_returns_authenticated_identity_with_token(tmp_path):
    from services.api.app.routes import auth as auth_routes
    identity = _identity(tmp_path)
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(session_routes.build_router(_FakeReimbursement(), identity))
    client = TestClient(app)
    token = client.post("/api/auth/login",
                        json={"email": "boss@acme.test", "password": "secret"}).json()["token"]
    response = client.get("/api/session/current", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    body = response.json()
    assert body["workspace_id"] == "ws1"
    assert body["user_id"] == "acc1"
    assert body["role"] == "boss"
    assert body["source"] == "token"
