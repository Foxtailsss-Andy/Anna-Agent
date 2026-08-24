"""Home 合并轮 B2 — Chat run 工作空间注入 + workdir.read_file 只读工具。

真值口径:FakeStreamModel.requests 捕获的 ModelRequest 即引擎实发提示/工具集。
覆盖:①有效 workdir → [工作空间] 段入 system + 工具注册;②模型读真文件,
观察进第二轮 messages;③越界路径 → 错误观察、run 不炸;④无效 workdir →
不注入 + workdir.missing 审计 + run 照常 ready(诚实降级)。
"""
import json
from pathlib import Path

from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel, build_engine

_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)

_WORKDIR_ID = "wd_b2test"


def _register_workdir(tmp_path, monkeypatch, folder: Path, name: str = "proj") -> str:
    store = tmp_path / "workdirs.json"
    store.write_text(
        json.dumps(
            {
                "workdirs": [
                    {
                        "id": _WORKDIR_ID,
                        "name": name,
                        "path": str(folder),
                        "last_used_at": "2026-07-12T00:00:00+00:00",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(store))
    return _WORKDIR_ID


def _orchestrator(stream: FakeStreamModel) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=build_engine(stream, settings=_SETTINGS),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_SETTINGS,
    )


def _text_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [[ModelChunk("text_delta", text="好的。"), ModelChunk("final", finish_reason="stop")]]
    )


def _read_then_answer_stream(path: str) -> FakeStreamModel:
    return FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_read",
                            name="workdir.read_file",
                            arguments={"path": path},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
            [
                ModelChunk("text_delta", text="看完了。"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )


def _system_text(stream: FakeStreamModel) -> str:
    assert stream.requests, "engine never called the model"
    return "\n".join(
        str(m.get("content") or "")
        for m in stream.requests[0].messages
        if m.get("role") == "system"
    )


def _read_observations(stream: FakeStreamModel) -> list[dict]:
    assert len(stream.requests) >= 2, "tool round never reached a second model call"
    return [
        m
        for m in stream.requests[1].messages
        if m.get("role") == "tool" and m.get("name") == "workdir.read_file"
    ]


def test_valid_workdir_injects_context_and_registers_read_tool(tmp_path, monkeypatch):
    folder = tmp_path / "proj"
    folder.mkdir()
    (folder / "readme.md").write_text("hello anna", encoding="utf-8")
    wid = _register_workdir(tmp_path, monkeypatch, folder)

    stream = _text_stream()
    run = _orchestrator(stream).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="项目里有什么?",
        workdir_id=wid,
    )

    assert run.status == "ready"
    assert run.workdir_id == wid
    system = _system_text(stream)
    assert "[工作空间]" in system
    assert "readme.md" in system
    tool_names = [tool["name"] for tool in stream.requests[0].tools]
    assert "workdir.read_file" in tool_names
    created = run.audit_events[0]
    assert created.type == "chat.run.created"
    assert created.payload["workdir_id"] == wid


def test_read_file_tool_feeds_real_content_to_next_round(tmp_path, monkeypatch):
    folder = tmp_path / "proj"
    (folder / "notes").mkdir(parents=True)
    (folder / "notes" / "todo.txt").write_text("周一:买牛奶", encoding="utf-8")
    wid = _register_workdir(tmp_path, monkeypatch, folder)

    stream = _read_then_answer_stream("notes/todo.txt")
    run = _orchestrator(stream).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="看看 todo",
        workdir_id=wid,
    )

    assert run.status == "ready"
    observations = _read_observations(stream)
    assert len(observations) == 1
    payload = json.loads(observations[0]["content"])
    assert payload["ok"] is True
    assert payload["path"] == "notes/todo.txt"
    assert "买牛奶" in payload["content"]


def test_read_file_escape_path_returns_error_observation_run_survives(
    tmp_path, monkeypatch
):
    folder = tmp_path / "proj"
    folder.mkdir()
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    wid = _register_workdir(tmp_path, monkeypatch, folder)

    stream = _read_then_answer_stream("../secret.txt")
    run = _orchestrator(stream).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="读 ../secret.txt",
        workdir_id=wid,
    )

    # 越界 = 说明性错误观察(模型可自我纠正),run 照常走完,绝不泄内容。
    assert run.status == "ready"
    payload = json.loads(_read_observations(stream)[0]["content"])
    assert payload["ok"] is False
    assert "越界" in payload["error"]
    assert "outside" not in json.dumps(payload, ensure_ascii=False)


def test_stale_workdir_downgrades_honestly(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "empty-store.json"))

    stream = _text_stream()
    run = _orchestrator(stream).start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="hi",
        workdir_id="wd_gone",
    )

    # 解析不到:不注入、不挂工具、审计 workdir.missing,run 照常 ready。
    assert run.status == "ready"
    assert "[工作空间]" not in _system_text(stream)
    tool_names = [tool["name"] for tool in stream.requests[0].tools]
    assert "workdir.read_file" not in tool_names
    missing = [e for e in run.audit_events if e.type == "workdir.missing"]
    assert len(missing) == 1
    assert missing[0].payload == {"workdir_id": "wd_gone"}
