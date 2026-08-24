from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.hiker.app.orchestrator import HikerOrchestrator
from services.runtime.app.config import RuntimeSettings
from tests.hiker.hiker_fakes import FakeGateway


HEADERS = {"X-Anna-Workspace-ID": "ws_demo", "X-Anna-User-ID": "admin"}


def _client():
    app = create_app(hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()))
    return TestClient(app)


def test_dashboard_run_returns_snapshot():
    response = _client().post(
        "/api/cowork/hiker/dashboard/runs",
        headers=HEADERS,
        json={"workspace_id": "ws_demo", "actor_user_id": "admin"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["snapshot"]["source"] == "Hiker MCP"
    assert any(kpi["id"] == "contract_amount" for kpi in body["snapshot"]["kpis"])


def test_dashboard_run_rejects_identity_mismatch():
    response = _client().post(
        "/api/cowork/hiker/dashboard/runs",
        headers={"X-Anna-Workspace-ID": "ws_demo", "X-Anna-User-ID": "intruder"},
        json={"workspace_id": "ws_demo", "actor_user_id": "admin"},
    )
    assert response.status_code == 403
