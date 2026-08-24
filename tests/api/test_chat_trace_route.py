"""Trace 轮 T1 —— GET /api/chat/runs/{run_id}/trace(§4 TraceDoc,journal+audit 装配,纯读)。

Fixture 装配照抄 ``tests/api/test_chat_api.py``(同款 orchestrator/app/client 起法);
唯一新增是显式注入 ``run_store``(照抄 ``tests/chat/test_background_runs.py``),因为
本路由的 store 读取面(``list_frames_with_meta``)只有真实 SQLiteRunStore 才吃得到——
POST /api/chat/runs 是同步路径,不经 BackgroundRunManager 写帧,所以一个刚创建的 run
在 run_frames 里零帧是诚实的默认态;要断言 agent 根 span,直接经 store 补一帧模拟
真实提交路径会写入的 journal。
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel

HEADERS = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"}

_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="secret-key",
    model_name="mimo-v2.5-pro",
    erp_mcp_server="https://erp.example/mcp",
)


class _ConnectedErpGateway:
    """A connected ERP gateway — trace route tests answer from text, never call a tool."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {"status": "connected", "tool_names": [], "tools": []}

    def call_tool(self, tool_name, arguments):  # pragma: no cover - not reached here
        raise AssertionError("trace route tests answer from text, no tool call expected")


def _text_answer_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="Trace 路由测试回答。"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )


def _client_and_store(tmp_path) -> tuple[TestClient, SQLiteRunStore]:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    chat = ChatOrchestrator(
        engine=QueryEngine(settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=_text_answer_stream())),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=store,
    )
    return TestClient(create_app(chat_orchestrator=chat)), store


def _create_run(client: TestClient) -> str:
    response = client.post(
        "/api/chat/runs",
        headers=HEADERS,
        json={"workspace_id": "demo", "actor_user_id": "u_demo", "message": "看看这轮的 trace"},
    )
    assert response.status_code == 200
    return response.json()["id"]


def test_chat_run_trace_route_returns_honest_empty_shape_with_no_frames(tmp_path):
    client, _store = _client_and_store(tmp_path)
    run_id = _create_run(client)

    res = client.get(f"/api/chat/runs/{run_id}/trace", headers=HEADERS)

    assert res.status_code == 200
    # 同步创建路径不经 BackgroundRunManager 写帧 —— 零帧诚实回空树,不是伪造的假 span。
    assert res.json() == {"trace_id": run_id, "surface": "chat", "spans": []}


def test_chat_run_trace_route_returns_agent_root_span_when_frames_exist(tmp_path):
    client, store = _client_and_store(tmp_path)
    run_id = _create_run(client)
    # 模拟真实提交路径(BackgroundRunManager._writer)会写入的 journal 帧一条。
    store.append_frame(
        "chat", run_id, 1,
        {"type": "step", "phase": "analyze", "intent": "正在思考", "tool": None, "turn": 1},
    )

    res = client.get(f"/api/chat/runs/{run_id}/trace", headers=HEADERS)

    assert res.status_code == 200
    doc = res.json()
    assert doc["trace_id"] == run_id
    assert doc["surface"] == "chat"
    assert isinstance(doc["spans"], list) and doc["spans"]
    assert doc["spans"][0]["kind"] == "agent"


def test_chat_run_trace_route_404_on_unknown_run(tmp_path):
    client, _store = _client_and_store(tmp_path)
    res = client.get("/api/chat/runs/nope/trace", headers=HEADERS)
    assert res.status_code == 404


def test_chat_run_trace_route_403_on_identity_mismatch(tmp_path):
    client, _store = _client_and_store(tmp_path)
    run_id = _create_run(client)
    stranger = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_other"}

    res = client.get(f"/api/chat/runs/{run_id}/trace", headers=stranger)

    assert res.status_code == 403  # _assert_run_access 对跨身份实测抛 403(run access denied)
