"""Home 合并轮 M2 — per-run 专家选择(agent_id)注入验证。

Chat run 带 agent_id 时,该 Agent 的附加指令(runtime config agent_directives)
注入本次 run 的 system prompt;缺省仍用域默认 "chat" 的指令。
真值口径:FakeStreamModel.requests 捕获的 ModelRequest.messages 即引擎实发提示。
"""
from dataclasses import replace
from pathlib import Path

from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel, build_engine

_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    agent_directives={
        "chat": "平常心,先给结论。",
        "hiker": "Hiker 口径:先确认客户范围,再给数。",
    },
)


def _text_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [[ModelChunk("text_delta", text="好的。"), ModelChunk("final", finish_reason="stop")]]
    )


def _orchestrator(stream: FakeStreamModel, settings: RuntimeSettings) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=build_engine(stream, settings=settings),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
    )


def _system_text(stream: FakeStreamModel) -> str:
    assert stream.requests, "engine never called the model"
    messages = stream.requests[0].messages
    return "\n".join(
        str(m.get("content") or "") for m in messages if m.get("role") == "system"
    )


def test_agent_id_selects_that_agents_directive():
    stream = _text_stream()
    run = _orchestrator(stream, _SETTINGS).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="看下这个月的费用",
        agent_id="hiker",
    )

    assert run.status == "ready"
    assert run.agent_id == "hiker"
    system = _system_text(stream)
    assert "Hiker 口径:先确认客户范围,再给数。" in system
    assert "平常心,先给结论。" not in system
    created = run.audit_events[0]
    assert created.type == "chat.run.created"
    assert created.payload["agent_id"] == "hiker"


def test_agent_id_defaults_to_chat_directive():
    stream = _text_stream()
    run = _orchestrator(stream, _SETTINGS).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="随便聊聊",
    )

    assert run.status == "ready"
    assert run.agent_id is None
    assert "平常心,先给结论。" in _system_text(stream)


def test_agent_id_with_blank_directive_falls_back_to_none():
    settings = replace(_SETTINGS, agent_directives={"chat": "", "hiker": "  "})
    stream = _text_stream()
    run = _orchestrator(stream, settings).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="hi",
        agent_id="hiker",
    )

    # 空白指令 = 无指令(agent_directive() 返回 None),run 照常成功。
    assert run.status == "ready"
    assert "hiker" == run.agent_id
