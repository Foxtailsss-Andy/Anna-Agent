from pathlib import Path

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.chat.app.orchestrator import ChatOrchestrator
from services.memory.app.store import BusinessMemoryStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


HEADERS = {
    "X-Anna-Workspace-ID": "demo",
    "X-Anna-User-ID": "u_demo",
}


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="secret-key",
    model_name="mimo-v2.5-pro",
    erp_mcp_server="https://erp.example/mcp",
)


class ConnectedErpGateway:
    """A connected ERP gateway exposing the read-only finance query tool."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - not reached here
        raise AssertionError("chat API test answers from text, no tool call expected")


def _text_answer_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="这是通过模型生成的 Chat 回答。"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )


def _orchestrator(memory_store=None) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS,
            deps=QueryDeps(stream_model=_text_answer_stream()),
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        memory_store=memory_store,
    )


def test_chat_api_lists_templates_creates_run_and_saves_result(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    chat = _orchestrator(memory_store=memory_store)
    client = TestClient(create_app(chat_orchestrator=chat))

    templates_response = client.get("/api/chat/prompt-templates", headers=HEADERS)
    create_response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "message": "帮我总结这段材料",
            "template_id": "summarize",
        },
    )
    created = create_response.json()
    save_response = client.post(
        f"/api/chat/runs/{created['id']}/save",
        headers=HEADERS,
        json={"saved_by": "u_demo"},
    )

    assert templates_response.status_code == 200
    assert [template["id"] for template in templates_response.json()["templates"]] == [
        "summarize",
        "analyze",
        "task_plan",
        "associate_goal",
    ]
    assert create_response.status_code == 200
    assert created["status"] == "ready"
    assert created["assistant_message"] == "这是通过模型生成的 Chat 回答。"
    assert save_response.status_code == 200
    assert save_response.json()["saved_memory_id"]
    assert memory_store.count("demo") == 1


def test_chat_api_rejects_identity_mismatch(tmp_path):
    chat = _orchestrator(memory_store=BusinessMemoryStore(tmp_path / "memory.sqlite3"))
    client = TestClient(create_app(chat_orchestrator=chat))

    response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={
            "workspace_id": "other",
            "actor_user_id": "u_demo",
            "message": "帮我总结这段材料",
            "template_id": "summarize",
        },
    )

    assert response.status_code == 403


def _multi_answer_orchestrator(rounds: int) -> ChatOrchestrator:
    """N 轮 fake 流(每轮一次纯文本作答),供多 run 列表测试。"""
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS,
            deps=QueryDeps(
                stream_model=FakeStreamModel(
                    [
                        [
                            ModelChunk("text_delta", text=f"第 {i + 1} 轮回答。"),
                            ModelChunk("final", finish_reason="stop"),
                        ]
                        for i in range(rounds)
                    ]
                )
            ),
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )


def test_list_chat_runs_returns_newest_first_and_scopes_to_identity():
    chat = _multi_answer_orchestrator(rounds=4)
    client = TestClient(create_app(chat_orchestrator=chat))
    other_actor_headers = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_other"}
    other_ws_headers = {"X-Anna-Workspace-ID": "ws2", "X-Anna-User-ID": "u_demo"}

    def _create(headers, message):
        response = client.post(
            "/api/chat/runs",
            headers=headers,
            json={
                "workspace_id": headers["X-Anna-Workspace-ID"],
                "actor_user_id": headers["X-Anna-User-ID"],
                "message": message,
            },
        )
        assert response.status_code == 200
        return response.json()

    first = _create(HEADERS, "第一问")
    _create(other_actor_headers, "他人的问题")   # 同 workspace 异 actor → 不应出现
    _create(other_ws_headers, "别处的问题")       # 异 workspace → 不应出现
    second = _create(HEADERS, "第二问")

    listing = client.get("/api/chat/runs", headers=HEADERS)
    assert listing.status_code == 200
    runs = listing.json()
    assert [run["id"] for run in runs] == [second["id"], first["id"]]  # newest-first
    assert [run["message"] for run in runs] == ["第二问", "第一问"]
    assert all(run["assistant_message"] for run in runs)
    # 时间戳来源:audit_events[0].created_at(FE 依赖此字段,锁进契约)
    assert runs[0]["audit_events"][0]["created_at"]


def test_get_chat_run_detail_scopes_to_identity():
    chat = _multi_answer_orchestrator(rounds=1)
    client = TestClient(create_app(chat_orchestrator=chat))
    created = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "回看这轮"},
    ).json()

    detail = client.get(f"/api/chat/runs/{created['id']}", headers=HEADERS)
    assert detail.status_code == 200
    assert detail.json()["id"] == created["id"]
    assert detail.json()["assistant_message"] == "第 1 轮回答。"

    stranger = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_other"}
    denied = client.get(f"/api/chat/runs/{created['id']}", headers=stranger)
    assert denied.status_code == 403  # _assert_run_access 对跨身份实测抛 403(run access denied)

    missing = client.get("/api/chat/runs/does-not-exist", headers=HEADERS)
    assert missing.status_code == 404


# --- P3 refinement: model profiles / skill override / Boss directive --------

from dataclasses import replace as _dc_replace  # noqa: E402

_PROFILE_SETTINGS = _dc_replace(
    _CONFIGURED_SETTINGS,
    model_profiles=(
        {
            "id": "alt",
            "label": "Alt 模型",
            "provider": "openai-compatible",
            "endpoint": "https://alt.example/v1/chat/completions",
            "model_name": "alt-model",
            "api_key": "alt-key",
        },
    ),
    agent_directives={"chat": "永远用中文回答，并以「好的 Boss」开头。"},
)


def test_chat_model_profiles_endpoint_synthesizes_default_and_sanitizes():
    chat = _orchestrator()
    client = TestClient(create_app(chat_orchestrator=chat))
    response = client.get("/api/chat/model-profiles", headers=HEADERS)
    assert response.status_code == 200
    payload = response.json()
    assert payload["default_profile_id"] == "default"
    assert [p["id"] for p in payload["profiles"]] == ["default"]
    default = payload["profiles"][0]
    assert default["model_name"] == "mimo-v2.5-pro"
    assert "api_key" not in default and "endpoint" not in default


def test_chat_run_uses_selected_profile_and_injects_boss_directive():
    captured: dict[str, object] = {}

    def engine_factory(settings):
        fake = _text_answer_stream()
        captured["fake"] = fake
        captured["endpoint"] = settings.model_endpoint
        return QueryEngine(settings=settings, deps=QueryDeps(stream_model=fake))

    chat = ChatOrchestrator(
        engine=QueryEngine(
            settings=_PROFILE_SETTINGS, deps=QueryDeps(stream_model=_text_answer_stream())
        ),
        engine_factory=engine_factory,
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_PROFILE_SETTINGS,
    )
    client = TestClient(create_app(chat_orchestrator=chat))
    response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "message": "你好",
            "model_profile_id": "alt",
        },
    )
    run = response.json()
    assert response.status_code == 200
    assert run["status"] == "ready"
    assert run["model_profile_id"] == "alt"
    # per-profile engine got the resolved settings variant
    assert captured["endpoint"] == "https://alt.example/v1/chat/completions"
    # Boss 附加指令 injected into the system prompt of the actual model request
    request = captured["fake"].requests[0]
    system_content = request.messages[0]["content"]
    assert "[Boss 附加指令]" in system_content
    assert "永远用中文回答" in system_content


def test_chat_run_unknown_profile_fails_honestly():
    chat = _orchestrator()
    client = TestClient(create_app(chat_orchestrator=chat))
    response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "message": "你好",
            "model_profile_id": "ghost",
        },
    )
    run = response.json()
    assert response.status_code == 200
    assert run["status"] == "failed"
    assert run["error_code"] == "model_profile_not_found"


def test_chat_run_skill_override_reaches_loader():
    chat = _orchestrator()
    client = TestClient(create_app(chat_orchestrator=chat))
    response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "message": "你好",
            "skill_id": "no/such-skill",
        },
    )
    run = response.json()
    assert response.status_code == 200
    assert run["skill_id"] == "no/such-skill"
    assert run["status"] == "failed"  # default skill would have loaded fine


def test_chat_emit_page_lands_artifact_via_harness_loop():
    """P4 交付闭环:模型经引擎调用 chat.emit_page → run.artifacts 落库 + 审计。"""
    from services.runtime.app.engine.capability import ModelToolCall

    page_html = "<html><head><title>周报</title></head><body>ok</body></html>"
    stream = FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    finish_reason="tool_calls",
                    tool_calls=[
                        ModelToolCall(
                            id="call_emit",
                            name="chat.emit_page",
                            arguments={"title": "团队周报", "html": page_html},
                        )
                    ],
                )
            ],
            [
                ModelChunk("text_delta", text="网页已提交到画布。"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    chat = ChatOrchestrator(
        engine=QueryEngine(settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=stream)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )
    client = TestClient(create_app(chat_orchestrator=chat))
    response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "做个周报网页"},
    )
    run = response.json()
    assert response.status_code == 200
    assert run["status"] == "ready"
    assert [a["kind"] for a in run["artifacts"]] == ["page"]
    assert run["artifacts"][0]["title"] == "团队周报"
    assert run["artifacts"][0]["content"] == page_html
    assert any(e["type"] == "chat.artifact.emitted" for e in run["audit_events"])
    # emit 工具对模型可见(schema 注册)
    tools = [t["name"] for t in stream.requests[0].tools]
    assert "chat.emit_page" in tools and "chat.emit_document" in tools
