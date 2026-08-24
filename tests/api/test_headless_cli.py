"""Anna headless 入口(JSONL 帧流)—— TB/Harbor 接入的地基,RED 先行。

Anna 至今只有 FastAPI + Electron 两个入口:任何外部评测器(Terminal-Bench /
Harbor adapter、CI 冒烟、脚本化回归)都得先起一个 HTTP 服务、再猜端口。
``services/api/app/headless.py`` 补上缺的那一环 —— **进程内**驱动一次真实
chat run(既有 orchestrator/engine 路径,不走 HTTP、不起 Electron),
把线上 SSE 的同一份帧逐行 JSON 打到 stdout,退出码即终态。

四条契约,全部用既有 ``FakeStreamModel`` 惯用法驱动(零 token、零网络):

* ① 正常完成 → 每行都是合法 JSON;帧序列与 SSE 同形(``event`` / ``text_delta``
  / ``done``);最后一行是 ``headless.result`` 汇总,退出码 0。
* ② preflight 失败(模型未配置)→ ``error`` 帧 + 退出码 1;错误码诚实出现在
  汇总行里,绝不静默成功。
* ③ ``max_turns`` 顶满 → 可续办暂停(``awaiting_continue``),退出码 2 —— 与
  失败(1)、成功(0)三态分明。评测器把「没做完」当「做完了」是最坏的谎。
* ④ ``--workdir`` 注册幂等,且真的把 [工作空间] 段注入模型 system prompt。
"""
from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path

from services.api.app import headless
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelResponse,
    ModelToolCall,
)
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)

_UNCONFIGURED_SETTINGS = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

_CONTINUE_MARKER = "继续完成剩余任务"


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - 本用例不派发 ERP
        raise AssertionError("headless CLI tests never dispatch an ERP tool")


def _text_answer_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="headless 回答。"),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )


class _AlwaysToolModel(FakeStreamModel):
    """每轮都调 ``plan.update``(引擎原生工具,不落 ERP)—— 直到顶满 max_turns。"""

    def respond(self, request: ModelRequest) -> ModelResponse:
        last_user = ""
        for message in request.messages:
            if message.get("role") == "user":
                last_user = str(message.get("content") or "")
        if _CONTINUE_MARKER in last_user:  # pragma: no cover - headless 不续跑
            return ModelResponse(
                assistant_message="已完成。", tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message=None,
            tool_calls=[
                ModelToolCall(
                    id="call_plan",
                    name="plan.update",
                    arguments={
                        "items": [{"id": "1", "title": "推进任务", "status": "in_progress"}]
                    },
                )
            ],
            finish_reason="tool_calls",
        )


def _orchestrator(stream_model, settings: RuntimeSettings) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(settings=settings, deps=QueryDeps(stream_model=stream_model)),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
    )


def _drive(orchestrator: ChatOrchestrator, **kwargs) -> tuple[int, list[dict]]:
    """跑一次 headless run,返回 ``(exit_code, 解析后的 JSONL 帧)``。"""
    out = io.StringIO()
    code = asyncio.run(
        headless.run_headless(orchestrator, prompt="请做一件事。", out=out, **kwargs)
    )
    lines = [line for line in out.getvalue().splitlines() if line.strip()]
    return code, [json.loads(line) for line in lines]


# --- ① 正常完成:JSONL 合法、帧与 SSE 同形、退出码 0 ---------------------------


def test_headless_streams_jsonl_and_exits_zero():
    orchestrator = _orchestrator(_text_answer_stream(), _CONFIGURED_SETTINGS)
    code, frames = _drive(orchestrator)

    assert code == headless.EXIT_OK
    types = [frame["type"] for frame in frames]
    assert "text_delta" in types
    assert "done" in types
    # done 帧携带的 run 必须是纯 JSON(与 SSE 侧同一个 _jsonify_frame 规范化)。
    done = next(frame for frame in frames if frame["type"] == "done")
    assert done["run"]["status"] == "ready"
    assert isinstance(done["run"], dict)
    # 审计事件帧同样已 JSON 化,评测器可直接读 model.call.completed 的 token 数。
    events = [frame for frame in frames if frame["type"] == "event"]
    assert events and all(isinstance(frame["event"], dict) for frame in events)

    result = frames[-1]
    assert result["type"] == "headless.result"
    assert result["status"] == "ready"
    assert result["exit_code"] == headless.EXIT_OK
    assert result["assistant_message"] == "headless 回答。"
    assert result["error_code"] is None
    assert result["run_id"] == done["run"]["id"]
    assert result["tool_calls"] == 0


# --- ② preflight 失败:错误码诚实上浮,退出码 1 -------------------------------


def test_headless_failed_run_exits_one_and_reports_error_code():
    orchestrator = _orchestrator(_text_answer_stream(), _UNCONFIGURED_SETTINGS)
    code, frames = _drive(orchestrator)

    assert code == headless.EXIT_FAILED
    assert any(frame["type"] == "error" for frame in frames)
    result = frames[-1]
    assert result["type"] == "headless.result"
    assert result["status"] == "failed"
    assert result["error_code"] == "model_not_configured"
    assert result["exit_code"] == headless.EXIT_FAILED


# --- ③ max_turns 顶满:可续办暂停 ≠ 成功,退出码 2 ----------------------------


def test_headless_exhausted_run_exits_suspended_not_ok():
    orchestrator = _orchestrator(_AlwaysToolModel(), _CONFIGURED_SETTINGS)
    code, frames = _drive(orchestrator)

    assert code == headless.EXIT_SUSPENDED
    # 暂停不是终态帧:没有 done、没有 error —— 只有 run.suspended 审计帧。
    assert not any(frame["type"] in ("done", "error") for frame in frames)
    suspended = [
        frame
        for frame in frames
        if frame["type"] == "event" and frame["event"]["type"] == "run.suspended"
    ]
    assert suspended
    result = frames[-1]
    assert result["status"] == "awaiting_continue"
    assert result["exit_code"] == headless.EXIT_SUSPENDED
    assert result["tool_calls"] > 0


# --- ④ --workdir:注册幂等 + 真注入 system prompt ------------------------------


def test_register_workdir_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "workdirs.json"))
    target = tmp_path / "task"
    target.mkdir()

    first = headless.register_workdir(str(target))
    second = headless.register_workdir(str(target))

    assert first == second
    from services.runtime.app.workdir_store import load_workdirs

    assert len([it for it in load_workdirs() if it["id"] == first]) == 1


def test_headless_workdir_is_injected_into_system_prompt(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "workdirs.json"))
    target = tmp_path / "task"
    target.mkdir()
    (target / "README.md").write_text("hello", encoding="utf-8")
    workdir_id = headless.register_workdir(str(target))

    stream = _text_answer_stream()
    orchestrator = _orchestrator(stream, _CONFIGURED_SETTINGS)
    code, _frames = _drive(orchestrator, workdir_id=workdir_id)

    assert code == headless.EXIT_OK
    system_prompt = str(stream.requests[0].messages[0]["content"])
    assert "[工作空间]" in system_prompt
    assert "README.md" in system_prompt
    # 工作空间挂上后,只读的 workdir.read_file 才对模型可见。
    assert any(tool["name"] == "workdir.read_file" for tool in stream.requests[0].tools)


# --- CLI 解析:argv → 参数,不依赖真实模型 ------------------------------------


def test_parse_args_requires_prompt_and_accepts_workdir():
    args = headless.parse_args(["--prompt", "做事", "--workdir", ".", "--thread-id", "t1"])
    assert args.prompt == "做事"
    assert args.workdir == "."
    assert args.thread_id == "t1"
    assert args.workspace_id == headless.DEFAULT_WORKSPACE_ID
    assert args.actor_user_id == headless.DEFAULT_ACTOR_USER_ID
