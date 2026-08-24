from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def test_create_app_exposes_login_and_authenticated_session(tmp_path):
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(store)
    app = create_app(identity_service=IdentityService(store))
    client = TestClient(app)

    login = client.post("/api/auth/login",
                        json={"email": "boss@anna.demo", "password": "crew-demo"})
    assert login.status_code == 200
    token = login.json()["token"]

    session = client.get("/api/session/current",
                         headers={"Authorization": f"Bearer {token}"})
    assert session.status_code == 200
    assert session.json()["user_id"] == "acc_boss"

    # Without a token, session/current still works (local fallback) — zero regression.
    assert client.get("/api/session/current").status_code == 200
