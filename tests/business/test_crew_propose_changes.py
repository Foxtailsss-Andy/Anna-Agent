"""``crew.propose_changes`` Host tool + owner confirm (ticket P · AC5).

Seams: ``POST /_business/crew/tools/call`` (the Host → Business envelope) and
``POST /api/crew/projects/{id}/channel/command/confirm`` on the product-mode
app built by ``create_app``. The Node Host itself is not involved.
"""
from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.business.harness_client import HarnessHostClient
from services.business.mode import BusinessModeConfig
from services.hiker.app.orchestrator import HikerOrchestrator
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore
from services.runtime.app.config import RuntimeSettings
from tests.hiker.hiker_fakes import FakeGateway

_SERVICE = {"x-anna-service-token": "business-token"}


def _no_host(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not be hit
    raise AssertionError(f"unexpected Host call {request.method} {request.url}")


def _app(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    config = BusinessModeConfig(
        enabled=True, host_origin="http://host.test", service_token="business-token"
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config, transport=httpx.MockTransport(_no_host)),
        identity_service=identity,
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )
    client = TestClient(app)
    boss = {"Authorization": f"Bearer {identity.login('boss@anna.demo', 'crew-demo').token}"}
    andy = {"Authorization": f"Bearer {identity.login('andy@anna.demo', 'crew-demo').token}"}
    return client, boss, andy


def _project(client, auth):
    return client.post(
        "/api/crew/projects",
        headers=auth,
        json={"goal_text": "秋季营销物料", "sop_template_id": "marketing_collateral"},
    ).json()


def _task_id(project, title):
    return next(t["id"] for t in project["tasks"] if t["title"] == title)


def _task(client, auth, pid, title):
    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    return next(t for t in project["tasks"] if t["title"] == title)


def _propose(client, arguments, *, tool_call_id="call-1", run_id="wb-run-1", actor="acc_boss"):
    envelope = {
        "workspace_id": "ws_crew_demo",
        "actor_user_id": actor,
        "run_id": run_id,
        "name": "crew.propose_changes",
        "arguments": arguments,
    }
    if tool_call_id is not None:
        envelope["tool_call_id"] = tool_call_id
    return client.post("/_business/crew/tools/call", headers=_SERVICE, json=envelope)


def _channel(client, auth, pid):
    return client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]


def _full_proposal(project):
    return {
        "project_id": project["id"],
        "summary": "先做竞品调研再写文案，并让 Scribe 负责文案。",
        "new_tasks": [
            {
                "title": "竞品调研",
                "role": "设计",
                "acceptance": "三家竞品对比表",
                "depends_on": ["营销 Brief"],
                "insert_before": ["文案撰写"],
                "assignee_id": "acc_andy",
            }
        ],
        "assignments": [
            {
                "task_id": _task_id(project, "文案撰写"),
                "member_id": "acc_agent_scribe",
                "reason": "Scribe 负责文案",
            }
        ],
    }


def test_proposal_writes_one_anna_card_and_changes_no_facts(tmp_path, monkeypatch):
    client, boss, _andy = _app(tmp_path, monkeypatch)
    project = _project(client, boss)
    pid = project["id"]
    channel_before = _channel(client, boss, pid)

    response = _propose(client, _full_proposal(project))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "crew.propose_changes"
    assert body["effect"] == "proposal"
    result = body["result"]
    assert result["new_task_count"] == 1
    assert result["assignment_count"] == 1
    assert result["status"] == "awaiting_confirmation"

    channel = _channel(client, boss, pid)
    assert len(channel) == len(channel_before) + 1
    card = channel[-1]
    assert card["id"] == result["message_id"]
    assert card["kind"] == "command" and card["author_kind"] == "anna"
    assert card["body"] == "Anna 提议：先做竞品调研再写文案，并让 Scribe 负责文案。"
    assert card["payload"] == {
        "drafts": [
            {
                "title": "竞品调研",
                "role": "设计",
                "depends_on": ["营销 Brief"],
                "insert_before": ["文案撰写"],
                "acceptance": "三家竞品对比表",
                "assignee_id": "acc_andy",
            }
        ],
        "assignments": [
            {
                "task_id": _task_id(project, "文案撰写"),
                "member_id": "acc_agent_scribe",
                "reason": "Scribe 负责文案",
            }
        ],
        "origin": "anna_coordination",
        "source": {"type": "workbench_run", "run_id": "wb-run-1", "tool_call_id": "call-1"},
        "text": "先做竞品调研再写文案，并让 Scribe 负责文案。",
        "suggested_assignee": None,
    }
    # A Coordination Proposal is not a fact: graph and assignments unchanged.
    after = client.get(f"/api/crew/projects/{pid}", headers=boss).json()
    assert [
        (t["id"], t["status"], t["depends_on"], t["assignee_member_id"]) for t in after["tasks"]
    ] == [
        (t["id"], t["status"], t["depends_on"], t["assignee_member_id"]) for t in project["tasks"]
    ]


def test_repeated_tool_call_returns_the_same_card(tmp_path, monkeypatch):
    client, boss, _andy = _app(tmp_path, monkeypatch)
    project = _project(client, boss)

    first = _propose(client, _full_proposal(project)).json()["result"]["message_id"]
    channel_len = len(_channel(client, boss, project["id"]))
    second = _propose(client, _full_proposal(project)).json()["result"]["message_id"]
    other = _propose(client, _full_proposal(project), tool_call_id="call-2").json()

    assert second == first
    assert other["result"]["message_id"] != first
    assert len(_channel(client, boss, project["id"])) == channel_len + 1


def test_invalid_proposals_are_rejected_with_codes_and_write_nothing(tmp_path, monkeypatch):
    client, boss, _andy = _app(tmp_path, monkeypatch)
    project = _project(client, boss)
    pid = project["id"]
    brief_id = _task_id(project, "营销 Brief")
    client.post(f"/api/crew/projects/{pid}/tasks/{brief_id}/assign",
                headers=boss, json={"member_id": "acc_boss"})
    client.post(f"/api/crew/projects/{pid}/tasks/{brief_id}/start", headers=boss)
    channel_len = len(_channel(client, boss, pid))

    def new_task(**fields):
        return {"title": "竞品调研", "role": "设计", **fields}

    cases = [
        ({"project_id": "proj_missing", "summary": "s", "new_tasks": [new_task()]},
         "project_not_found"),
        ({"project_id": pid, "summary": "s", "new_tasks": [], "assignments": []},
         "empty_proposal"),
        ({"project_id": pid, "summary": "s", "new_tasks": [new_task(depends_on=["不存在"])]},
         "unknown_task_title:不存在"),
        ({"project_id": pid, "summary": "s", "new_tasks": [new_task(insert_before=["营销 Brief"])]},
         "insert_before_not_allowed:营销 Brief"),
        ({"project_id": pid, "summary": "s", "new_tasks": [new_task(assignee_id="acc_ghost")]},
         "assignee_not_member:acc_ghost"),
        ({"project_id": pid, "summary": "s", "new_tasks": [new_task(assignee_id="anna")]},
         "assignee_not_member:anna"),
        ({"project_id": pid, "summary": "s", "new_tasks": [new_task(), new_task()]},
         "duplicate_title:竞品调研"),
        ({"project_id": pid, "summary": "s", "new_tasks": [new_task(title="文案撰写")]},
         "duplicate_title:文案撰写"),
        ({"project_id": pid, "summary": "s",
          "assignments": [{"task_id": "task_nope", "member_id": "acc_andy"}]},
         "unknown_task:task_nope"),
        ({"project_id": pid, "summary": "s",
          "assignments": [{"task_id": brief_id, "member_id": "acc_ghost"}]},
         "assignee_not_member:acc_ghost"),
    ]
    for index, (arguments, code) in enumerate(cases):
        response = _propose(client, arguments, tool_call_id=f"bad-{index}")
        assert response.status_code == 422, (code, response.text)
        assert response.json() == {"detail": code}

    assert len(_channel(client, boss, pid)) == channel_len


def test_owner_confirm_applies_ordering_and_assignments(tmp_path, monkeypatch):
    client, boss, andy = _app(tmp_path, monkeypatch)
    project = _project(client, boss)
    pid = project["id"]
    message_id = _propose(client, _full_proposal(project)).json()["result"]["message_id"]
    confirm_url = f"/api/crew/projects/{pid}/channel/command/confirm"

    assert client.post(confirm_url, headers=andy, json={"message_id": message_id}).status_code == 403

    confirmed = client.post(confirm_url, headers=boss, json={"message_id": message_id})

    assert confirmed.status_code == 200, confirmed.text
    research = _task(client, boss, pid, "竞品调研")
    copy = _task(client, boss, pid, "文案撰写")
    assert research["depends_on"] == [_task_id(project, "营销 Brief")]
    assert research["status"] == "blocked"
    assert research["assignee_member_id"] == "acc_andy"
    assert research["created_from_message_id"] == message_id
    assert research["id"] in copy["depends_on"]
    assert copy["status"] == "blocked"
    assert copy["assignee_member_id"] == "acc_agent_scribe"
    bodies = [m["body"] for m in _channel(client, boss, pid)]
    assert "“竞品调研”已派给 @Andy。" in bodies
    assert "“文案撰写”已派给 @Agent·Scribe。" in bodies

    # Re-confirming the same card is a no-op.
    channel_len = len(_channel(client, boss, pid))
    again = client.post(confirm_url, headers=boss, json={"message_id": message_id})
    assert again.status_code == 200
    assert len(_channel(client, boss, pid)) == channel_len


def test_confirm_selected_assignment_only_and_report_stale_one(tmp_path, monkeypatch):
    client, boss, _andy = _app(tmp_path, monkeypatch)
    project = _project(client, boss)
    pid = project["id"]
    brief_id = _task_id(project, "营销 Brief")
    copy_id = _task_id(project, "文案撰写")
    proposal = {
        "project_id": pid,
        "summary": "调整负责人",
        "new_tasks": [{"title": "竞品调研", "role": "设计"}],
        "assignments": [
            {"task_id": brief_id, "member_id": "acc_andy", "reason": "Andy 熟悉"},
            {"task_id": copy_id, "member_id": "acc_agent_scribe"},
        ],
    }
    message_id = _propose(client, proposal).json()["result"]["message_id"]
    # Between proposal and confirm, the owner starts 营销 Brief himself.
    client.post(f"/api/crew/projects/{pid}/tasks/{brief_id}/assign",
                headers=boss, json={"member_id": "acc_boss"})
    client.post(f"/api/crew/projects/{pid}/tasks/{brief_id}/start", headers=boss)

    confirmed = client.post(
        f"/api/crew/projects/{pid}/channel/command/confirm",
        headers=boss,
        json={"message_id": message_id, "draft_indexes": [], "assignment_indexes": [0, 1]},
    )

    assert confirmed.status_code == 200, confirmed.text
    titles = [t["title"] for t in confirmed.json()["tasks"]]
    assert "竞品调研" not in titles  # draft not selected
    assert _task(client, boss, pid, "营销 Brief")["assignee_member_id"] == "acc_boss"
    assert _task(client, boss, pid, "文案撰写")["assignee_member_id"] == "acc_agent_scribe"
    rows = _channel(client, boss, pid)
    bodies = [m["body"] for m in rows]
    assert any("“营销 Brief”→@Andy（执行中）" in body for body in bodies)
    # The confirmation row points at the card it settled, even though no task was created.
    assert any((m.get("payload") or {}).get("confirms_message_id") == message_id for m in rows if m["kind"] == "event")

    bad = client.post(
        f"/api/crew/projects/{pid}/channel/command/confirm",
        headers=boss,
        json={"message_id": message_id, "assignment_indexes": [5]},
    )
    assert bad.status_code == 400


def test_project_read_gives_the_roster_needed_to_name_assignees(tmp_path, monkeypatch):
    """A Workbench Run must be able to map "Andy" to a member id without the member
    having appeared in the channel first (review R-spec finding 1). E-mail stays out."""
    client, boss, _andy = _app(tmp_path, monkeypatch)
    project = _project(client, boss)
    response = client.post(
        "/_business/crew/tools/call",
        headers=_SERVICE,
        json={
            "workspace_id": "ws_crew_demo",
            "actor_user_id": "acc_boss",
            "run_id": "wb-run-roster",
            "name": "crew.project.read",
            "arguments": {"project_id": project["id"]},
        },
    )
    assert response.status_code == 200
    members = response.json()["result"]["members"]
    andy = next(member for member in members if member["display_name"] == "Andy")
    assert andy == {"id": "acc_andy", "display_name": "Andy", "kind": "human", "role": andy["role"]}
    assert all("email" not in member for member in members)
