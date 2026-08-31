from __future__ import annotations

import json

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


def _host_client(requests: list[httpx.Request]) -> HarnessHostClient:
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            body = httpx.Response(202, json={"run_id": "host-chat-1", "status": "queued"})
        else:
            body = httpx.Response(
                200,
                json={
                    "run_id": "host-chat-1",
                    "status": "completed",
                    "result": {"assistant_message": "来自 OMP 的回答"},
                },
            )
        return body

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    return HarnessHostClient(config, transport=httpx.MockTransport(handler))


def test_business_app_has_no_python_execution_runtime_and_routes_chat_to_host(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("ANNA_WORKSPACE_ID", "ws_business")
    monkeypatch.setenv("ANNA_USER_ID", "u_business")
    monkeypatch.setenv("ANNA_USER_DISPLAY_NAME", "Business User")
    seen: list[httpx.Request] = []
    app = create_app(
        product_mode=True,
        business_mode_config=BusinessModeConfig(
            enabled=True,
            host_origin="http://host.test",
            service_token="business-token",
            poll_interval_seconds=0,
            wait_timeout_seconds=1,
        ),
        harness_client=_host_client(seen),
        hiker_orchestrator=HikerOrchestrator(
            adapter=FakeGateway(), settings=RuntimeSettings()
        ),
    )

    assert app.state.product_mode is True
    assert app.state.execution_runtime is None
    assert app.state.execution_kernel is None
    assert app.state.chat.settings.model_api_key is None
    assert app.state.chat.settings.model_endpoint is None

    response = TestClient(app).post(
        "/api/chat/runs",
        headers={"X-Anna-Workspace-ID": "ws_business", "X-Anna-User-ID": "u_business"},
        json={
            "workspace_id": "ws_business",
            "actor_user_id": "u_business",
            "message": "请回答一个问题",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["assistant_message"] == "来自 OMP 的回答"
    assert seen[0].url.path == "/_harness/runs"
    assert seen[0].headers["x-anna-service-token"] == "business-token"


def test_product_chat_task_resolves_skill_context_and_full_chat_tool_catalog(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("ANNA_WORKSPACE_ID", "ws_business")
    monkeypatch.setenv("ANNA_USER_ID", "u_business")
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            requests.append(json.loads(request.content))
            return httpx.Response(202, json={"run_id": "host-chat-context", "status": "queued"})
        return httpx.Response(
            200,
            json={
                "run_id": "host-chat-context",
                "status": "completed",
                "result": {"assistant_message": "已完成"},
            },
        )

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config, transport=httpx.MockTransport(handler)),
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )

    response = TestClient(app).post(
        "/api/chat/runs",
        headers={"X-Anna-Workspace-ID": "ws_business", "X-Anna-User-ID": "u_business"},
        json={
            "workspace_id": "ws_business",
            "actor_user_id": "u_business",
            "message": "请整理这份报告",
            "template_id": "summarize",
            "agent_id": "chat",
        },
    )

    assert response.status_code == 200
    assert len(requests) == 1
    task = requests[0]
    assert "Skill ID: chat/general-assistant" in task["system_prompt"]
    assert "请整理这份报告" in task["prompt"]
    assert task["context"]["skill_id"] == "chat/general-assistant"
    assert task["context"]["skill_provenance"]["source"] == "anna-python-skill-loader"
    assert task["context"]["agent_id"] == "chat"
    assert {tool["name"] for tool in task["context"]["tool_catalog"]} == {
        "chat.emit_page",
        "chat.emit_document",
    }
    assert "plan.update" not in {
        tool["name"] for tool in task["context"]["tool_catalog"]
    }


def test_product_chat_trace_projects_host_model_tool_and_usage_spans(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("ANNA_WORKSPACE_ID", "ws_business")
    monkeypatch.setenv("ANNA_USER_ID", "u_business")
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    timestamp = "2026-08-31T00:00:00.000Z"
    events = [
        {
            "id": "trace-started",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 0,
            "type": "run.started",
            "timestamp": timestamp,
            "schemaVersion": 1,
            "payload": {"threadId": "thread-trace"},
        },
        {
            "id": "trace-model-request",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 1,
            "type": "run.model.requested",
            "timestamp": "2026-08-31T00:00:01.000Z",
            "schemaVersion": 1,
            "payload": {"model": "deepseek-v4-pro", "requestIndex": 1},
        },
        {
            "id": "trace-model-response",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 2,
            "type": "omp.model.response",
            "timestamp": "2026-08-31T00:00:02.000Z",
            "schemaVersion": 1,
            "payload": {"requestIndex": 1, "message": {"role": "assistant", "content": []}},
        },
        {
            "id": "trace-usage",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 3,
            "type": "run.usage.updated",
            "timestamp": "2026-08-31T00:00:03.000Z",
            "schemaVersion": 1,
            "payload": {"requestIndex": 1, "cumulative": {"input": 2010, "output": 125}},
        },
        {
            "id": "trace-tool-dispatch",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 4,
            "type": "omp.tool.dispatch",
            "timestamp": "2026-08-31T00:00:04.000Z",
            "schemaVersion": 1,
            "payload": {"toolCallId": "call-trace", "tool": "chat.emit_document"},
        },
        {
            "id": "trace-tool-response",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 5,
            "type": "omp.tool.response",
            "timestamp": "2026-08-31T00:00:05.000Z",
            "schemaVersion": 1,
            "payload": {"toolCallId": "call-trace", "result": {"status": "succeeded"}},
        },
        {
            "id": "trace-completed",
            "workspaceId": "ws_business",
            "channelId": "chat_channel:ws_business",
            "streamId": "host-chat-trace",
            "seq": 6,
            "type": "run.completed",
            "timestamp": "2026-08-31T00:00:06.000Z",
            "schemaVersion": 1,
            "payload": {"outcome": "completed"},
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "host-chat-trace", "status": "queued"})
        if request.url.path.endswith("/events"):
            return httpx.Response(200, json={"events": events})
        return httpx.Response(
            200,
            json={
                "run_id": "host-chat-trace",
                "status": "completed",
                "result": {"assistant_message": "已完成"},
            },
        )

    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config, transport=httpx.MockTransport(handler)),
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )
    client = TestClient(app)
    headers = {"X-Anna-Workspace-ID": "ws_business", "X-Anna-User-ID": "u_business"}
    run = client.post(
        "/api/chat/runs",
        headers=headers,
        json={"workspace_id": "ws_business", "actor_user_id": "u_business", "message": "输出文档"},
    ).json()

    trace = client.get(f"/api/chat/runs/{run['id']}/trace", headers=headers)

    assert trace.status_code == 200
    document = trace.json()
    assert document["trace_id"] == run["id"]
    assert document["surface"] == "chat"
    assert {span["kind"] for span in document["spans"]} >= {"agent", "turn", "inference", "tool"}
    inference = next(span for span in document["spans"] if span["kind"] == "inference")
    assert inference["attributes"]["gen_ai.request.model"] == "deepseek-v4-pro"
    assert inference["attributes"]["gen_ai.usage.input_tokens"] == 2010
    assert inference["attributes"]["gen_ai.usage.output_tokens"] == 125
    tool = next(span for span in document["spans"] if span["kind"] == "tool")
    assert tool["name"] == "execute_tool chat.emit_document"
    assert tool["status"] == "ok"


def test_chat_business_handler_returns_scoped_artifact_for_host_projection(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("ANNA_WORKSPACE_ID", "ws_business")
    monkeypatch.setenv("ANNA_USER_ID", "u_business")
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "host-chat-artifact", "status": "queued"})
        return httpx.Response(
            200,
            json={
                "run_id": "host-chat-artifact",
                "status": "completed",
                "result": {"assistant_message": "文档已准备"},
            },
        )

    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config, transport=httpx.MockTransport(handler)),
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )
    client = TestClient(app)
    headers = {"X-Anna-Workspace-ID": "ws_business", "X-Anna-User-ID": "u_business"}
    run = client.post(
        "/api/chat/runs",
        headers=headers,
        json={
            "workspace_id": "ws_business",
            "actor_user_id": "u_business",
            "message": "输出文档",
        },
    ).json()
    tools = client.get("/_business/chat/tools", headers={"x-anna-service-token": "business-token"})
    assert tools.status_code == 200
    assert {tool["name"] for tool in tools.json()["tools"]} == {
        "chat.emit_page",
        "chat.emit_document",
    }

    emitted = client.post(
        "/_business/chat/tools/call",
        headers={"x-anna-service-token": "business-token"},
        json={
            "workspace_id": "ws_business",
            "actor_user_id": "u_business",
            "run_id": run["id"],
            "name": "chat.emit_document",
            "arguments": {"title": "周报", "markdown": "# 本周完成"},
        },
    )

    assert emitted.status_code == 200
    body = emitted.json()
    assert body["effect"] == "artifact"
    assert body["result"]["artifact"] == {
        "id": "art_1",
        "kind": "doc",
        "title": "周报",
        "content": "# 本周完成",
    }
    stored = client.get(f"/api/chat/runs/{run['id']}", headers=headers).json()
    assert stored["artifacts"][0]["content"] == "# 本周完成"


def test_business_routes_require_token_and_protect_hiker_remote_actor(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    seen: list[tuple[str, dict]] = []

    class CapturingGateway(FakeGateway):
        def call_tool(self, tool_name, arguments):
            seen.append((tool_name, dict(arguments)))
            return super().call_tool(tool_name, arguments)

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=_host_client([]),
        hiker_orchestrator=HikerOrchestrator(
            adapter=CapturingGateway(), settings=RuntimeSettings(hiker_default_actor="admin")
        ),
    )
    client = TestClient(app)

    assert client.get("/_business/status").status_code == 401
    headers = {"x-anna-service-token": "business-token"}
    tools = client.get("/_business/hiker/tools", headers=headers)
    assert tools.status_code == 200
    assert tools.json()["write_capability"]["status"] == "blocked"

    rejected = client.post(
        "/_business/hiker/tools/call",
        headers=headers,
        json={
            "workspace_id": "ws_business",
            "actor_user_id": "anna-user",
            "run_id": "hiker-run-1",
            "name": "hiker.report.get_dashboard_summary",
            "arguments": {"actor_user_id": "attacker"},
        },
    )
    assert rejected.status_code == 422

    result = client.post(
        "/_business/hiker/tools/call",
        headers=headers,
        json={
            "workspace_id": "ws_business",
            "actor_user_id": "anna-user",
            "run_id": "hiker-run-1",
            "name": "hiker.report.get_dashboard_summary",
            "arguments": {},
        },
    )
    assert result.status_code == 200
    assert seen[-1][1]["actor_user_id"] == "admin"


def test_crew_contextual_question_uses_host_and_appends_answer_to_same_channel(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "crew-context-1", "status": "queued"})
        return httpx.Response(
            200,
            json={
                "run_id": "crew-context-1",
                "status": "completed",
                "result": {"assistant_message": "项目当前有一项待评审。"},
            },
        )

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config, transport=httpx.MockTransport(handler)),
        identity_service=identity,
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )
    client = TestClient(app)
    token = identity.login("boss@anna.demo", "crew-demo").token
    auth = {"Authorization": f"Bearer {token}"}
    project = client.post(
        "/api/crew/projects",
        headers=auth,
        json={"goal_text": "项目进展", "sop_template_id": "feature_iteration"},
    ).json()

    response = client.post(
        f"/api/crew/projects/{project['id']}/channel",
        headers=auth,
        json={"body": "@Anna，现在项目进展如何？", "mentions": ["anna"]},
    )
    assert response.status_code == 200
    channel = client.get(
        f"/api/crew/projects/{project['id']}/channel", headers=auth
    ).json()["messages"]
    assert channel[-1]["author_kind"] == "anna"
    assert channel[-1]["body"] == "项目当前有一项待评审。"


def test_crew_proposal_tool_is_typed_observation_and_does_not_mutate_project(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=_host_client([]),
        identity_service=identity,
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )
    client = TestClient(app)
    token = identity.login("boss@anna.demo", "crew-demo").token
    auth = {"Authorization": f"Bearer {token}"}
    project = client.post(
        "/api/crew/projects",
        headers=auth,
        json={"goal_text": "目标", "sop_template_id": "feature_iteration"},
    ).json()
    before = client.get(f"/api/crew/projects/{project['id']}", headers=auth).json()

    response = client.post(
        "/_business/crew/tools/call",
        headers={"x-anna-service-token": "business-token"},
        json={
            "workspace_id": "ws_crew_demo",
            "actor_user_id": "acc_boss",
            "run_id": "crew-plan-1",
            "name": "crew.emit_project_plan",
            "arguments": {"tasks": [{"key": "brief"}]},
        },
    )
    assert response.status_code == 200
    assert response.json()["effect"] == "proposal"
    assert response.json()["result"]["output"]["tasks"][0]["key"] == "brief"
    after = client.get(f"/api/crew/projects/{project['id']}", headers=auth).json()
    assert [task["id"] for task in after["tasks"]] == [
        task["id"] for task in before["tasks"]
    ]


def test_crew_decompose_uses_host_transcript_tool_output_and_preserves_dag(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("ANNA_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "host-plan", "status": "queued"})
        plan = {
            "goal": "目标",
            "summary": "按 Host 规划",
            "tasks": [
                {"key": "brief", "title": "需求简报", "role_required": "产品"},
                {
                    "key": "prd",
                    "title": "PRD",
                    "role_required": "文案",
                    "depends_on": ["brief"],
                },
            ],
        }
        return httpx.Response(
            200,
            json={
                "run_id": "host-plan",
                "status": "completed",
                "result": {"assistant_message": "规划完成"},
                "events": [
                    {
                        "seq": 1,
                        "type": "omp.transcript.message",
                        "payload": {
                            "message": {
                                "role": "assistant",
                                "content": [
                                    {
                                        "type": "toolCall",
                                        "id": "plan-call",
                                        "name": "crew__emit_project_plan",
                                        "arguments": plan,
                                    }
                                ],
                            }
                        },
                    }
                ],
            },
        )

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    app = create_app(
        product_mode=True,
        business_mode_config=config,
        harness_client=HarnessHostClient(config, transport=httpx.MockTransport(handler)),
        identity_service=identity,
        hiker_orchestrator=HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings()),
    )
    client = TestClient(app)
    token = identity.login("boss@anna.demo", "crew-demo").token
    response = client.post(
        "/api/crew/projects/decompose",
        headers={"Authorization": f"Bearer {token}"},
        json={"goal_text": "目标", "sop_template_id": "feature_iteration"},
    )

    assert response.status_code == 200
    project = response.json()
    assert [task["title"] for task in project["tasks"]] == ["需求简报", "PRD"]
