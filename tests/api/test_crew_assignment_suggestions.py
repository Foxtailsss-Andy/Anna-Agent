from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes import auth as auth_routes
from services.api.app.routes import crew as crew_routes
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def _client(tmp_path):
    identity_store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(identity_store)
    identity = IdentityService(identity_store)
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(crew, identity))
    return TestClient(app)


def test_assignment_suggestion_requires_authentication(tmp_path):
    client = _client(tmp_path)
    response = client.post(
        "/api/crew/projects/project_1/tasks/task_1/assignment-suggestions",
        json={"request_id": "550e8400-e29b-41d4-a716-446655440000"},
    )

    assert response.status_code == 401


def test_assignment_suggestion_rejects_extra_body_keys(tmp_path):
    client = _client(tmp_path)
    response = client.post(
        "/api/crew/projects/project_1/tasks/task_1/assignment-suggestions",
        json={
            "request_id": "550e8400-e29b-41d4-a716-446655440000",
            "project_id": "project_1",
        },
        headers={"Authorization": "Bearer invalid"},
    )

    assert response.status_code == 422


def test_assignment_suggestion_reads_task_and_roster_after_auth_guard(tmp_path):
    client = _client(tmp_path)
    token = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    ).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    project = client.post(
        "/api/crew/projects",
        json={"goal_text": "预览", "sop_template_id": "feature_iteration"},
        headers=headers,
    ).json()
    task = next(item for item in project["tasks"] if item["key"] == "brief")

    response = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assignment-suggestions",
        json={"request_id": "550e8400-e29b-41d4-a716-446655440000"},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["source"] == "role_rule"
    assert response.json()["member_id"] == "acc_boss"
    assert response.json()["meta"] is None


def test_cancel_before_post_is_a_tombstone_and_does_not_call_host(tmp_path):
    client = _client(tmp_path)
    token = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    ).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    project = client.post(
        "/api/crew/projects",
        json={"goal_text": "预览", "sop_template_id": "feature_iteration"},
        headers=headers,
    ).json()
    task = next(item for item in project["tasks"] if item["key"] == "brief")
    decision_id = "550e8400-e29b-41d4-a716-446655440000"

    canceled = client.delete(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assignment-suggestions/{decision_id}",
        headers=headers,
    )
    suggested = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assignment-suggestions",
        json={"request_id": decision_id},
        headers=headers,
    )

    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"
    assert suggested.status_code == 200
    assert suggested.json()["reason_code"] == "canceled"
    assert suggested.json()["member_id"] is None


def test_assignment_suggestion_rejects_gate_and_assigned_task(tmp_path):
    client = _client(tmp_path)
    token = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    ).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    project = client.post(
        "/api/crew/projects",
        json={"goal_text": "预览", "sop_template_id": "feature_iteration"},
        headers=headers,
    ).json()
    brief = next(item for item in project["tasks"] if item["key"] == "brief")
    gate = next(item for item in project["tasks"] if item["key"] == "prd_review")
    client.post(
        f"/api/crew/projects/{project['id']}/tasks/{brief['id']}/assign",
        json={"member_id": "acc_boss"},
        headers=headers,
    )

    assigned = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{brief['id']}/assignment-suggestions",
        json={"request_id": "550e8400-e29b-41d4-a716-446655440000"},
        headers=headers,
    )
    gate_response = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{gate['id']}/assignment-suggestions",
        json={"request_id": "650e8400-e29b-41d4-a716-446655440000"},
        headers=headers,
    )

    assert assigned.status_code == 409
    assert gate_response.status_code == 409


def test_assign_with_decision_id_adopts_suggestion_and_replays_receipt(tmp_path):
    client = _client(tmp_path)
    token = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    ).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    project = client.post(
        "/api/crew/projects",
        json={"goal_text": "预览", "sop_template_id": "feature_iteration"},
        headers=headers,
    ).json()
    task = next(item for item in project["tasks"] if item["key"] == "brief")
    decision_id = "550e8400-e29b-41d4-a716-446655440000"
    suggestion = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assignment-suggestions",
        json={"request_id": decision_id},
        headers=headers,
    )
    assert suggestion.status_code == 200, suggestion.text

    first = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assign",
        json={"member_id": "acc_boss", "decision_id": decision_id},
        headers=headers,
    )
    second = client.post(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assign",
        json={"member_id": "acc_boss", "decision_id": decision_id},
        headers=headers,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    loaded = client.get(f"/api/crew/projects/{project['id']}", headers=headers).json()
    assigned = next(item for item in loaded["tasks"] if item["id"] == task["id"])
    receipts = [
        event for event in loaded["audit_events"]
        if event["type"] == "crew.task.assign"
        and event["payload"].get("decision_id") == decision_id
    ]
    assert assigned["assignee_member_id"] == "acc_boss"
    assert len(receipts) == 1
    canceled = client.delete(
        f"/api/crew/projects/{project['id']}/tasks/{task['id']}/assignment-suggestions/{decision_id}",
        headers=headers,
    )
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "already_applied"
