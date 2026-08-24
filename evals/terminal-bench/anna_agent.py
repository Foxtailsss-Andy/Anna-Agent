"""Harbor agent adapter for Anna —— Terminal-Bench 2.1 接入(情况 B:自定义 Adapter)。

Harbor 0.20.0 内置 agent 名单里没有 Anna(``harbor run --help`` 的 ``-a`` 枚举),
所以按评测协议 §五「情况 B」写最小自定义 Adapter。

选型:``BaseAgent``(host 侧),不是 ``BaseInstalledAgent``
--------------------------------------------------------
``BaseInstalledAgent`` 的前提是「Harness CLI 装在任务容器内部」。Anna 是
Windows 上的 FastAPI 后端 + Electron 外壳,带自己的 Python 3.12 venv、
``.anna/state`` SQLite、runtime.json 配置树 —— 把它塞进每个 Linux 任务容器既
不现实也不诚实。Anna 是**容器外**的控制方,正是 ``BaseAgent`` 的形状
(``harbor/agents/dspy_rlm.py`` 是同类先例:host 侧跑循环,容器只经
``environment.exec`` 触达)。

Adapter 的边界(§五:只负责启动 Harness、传入任务、收集轨迹、返回结果)
--------------------------------------------------------------------
1. 把容器工作目录**只读**镜像到 host 临时目录,登记成 Anna 的「工作空间」;
2. 用 Anna 自己的 venv 起 ``python -m services.api.app.headless``,任务指令原样
   传入(不改写、不加提示、不夹带任何 Terminal-Bench 知识);
3. 收 JSONL 帧流 → 落 ``anna-frames.jsonl`` + ATIF ``trajectory.json``;
4. 把 token/成本/工具调用填进 ``AgentContext``。

**本文件不含任何 Terminal-Bench 专属逻辑、硬编码答案或按题分支。** 唯一与题目
形态相关的常量是容器工作目录默认值 ``/app``,且可用 ``--ak`` 覆盖。

诚实披露:Anna 当前无法改动容器
-------------------------------
Anna 的 chat 工具白名单(``services/runtime/app/chat_tool_registry.py``)是
``erp.finance.query`` / ``chat.emit_page`` / ``chat.emit_document`` /
``run.plan``,外加 per-run 只读的 ``workdir.read_file``。**没有 shell、没有写
文件、没有编辑。** 因此本 Adapter 没有、也无法有一条「Anna 工具调用 →
``environment.exec``」的回桥:容器在整个 run 期间保持不变,verifier 会给出
reward 0。那是**真实的能力失败**,不是接入错误 —— 所以这里绝不伪造成功,
也绝不把它包装成 infra 异常来掩盖。缺口以事实形式记进
``context.metadata``(``container_bridge="none"``、``environment_mutations=0``、
Anna 实际调用过的工具名),留给报告归因。

反过来,**真正的 infra 故障必须抛**(§七:不得把基础设施失败伪装成 Agent 失
败):Anna 起不来、模型未配置、鉴权/限流失败 —— 这些一律 raise,让 Harbor 记
成 agent error 而不是 0 分。

用法(目录名带连字符,不能作点分模块路径,故走 PYTHONPATH)::

    PYTHONPATH=/path/to/Anna/evals/terminal-bench \\
    ANNA_PYTHON=/path/to/Anna/.venv/Scripts/python.exe \\
    ANNA_REPO=/path/to/Anna \\
    harbor run -d terminal-bench/terminal-bench-2-1 --agent anna_agent:AnnaAgent
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Anna headless 汇总行的帧类型(services/api/app/headless.py 的 RESULT_FRAME_TYPE)。
ANNA_RESULT_FRAME = "headless.result"

# Anna 的 headless 退出码(同上模块)。
ANNA_EXIT_OK = 0
ANNA_EXIT_FAILED = 1
ANNA_EXIT_SUSPENDED = 2

# 这些 error_code 是**环境/配置**问题,不是 Agent 能力问题 —— 按协议 §七 单列
# Infrastructure Failure。Adapter 遇到就 raise,绝不让它们混进能力得分。
INFRA_ERROR_CODES = frozenset(
    {
        "model_not_configured",
        "mcp_connector_not_ready",
        "model_provider_unavailable",
        "model_rate_limited",
        "model_call_timeout",
        "model_unauthorized",
    }
)

# 容器里的任务工作目录。Harbor 任务约定 ``/app``(见 harbor/agents 内多处),
# 可用 ``--ak container_workdir=/somewhere`` 覆盖。不是 TB 专属知识。
DEFAULT_CONTAINER_WORKDIR = "/app"

ATIF_SCHEMA_VERSION = "ATIF-v1.7"


class AnnaAgentStartupError(RuntimeError):
    """Anna 没能跑起来 —— 接入/环境问题,不是 Agent 能力问题。"""


class AnnaAgent(BaseAgent):
    """Host 侧驱动 Anna 的 Harbor adapter。"""

    # 我们自己写 trajectory.json(Harbor 只读不写),所以声明支持 ATIF 导出。
    SUPPORTS_ATIF: bool = True
    # Anna 只在 Windows host 上跑,但**任务容器**是 Linux;这个开关说的是任务
    # 环境的 OS,不是 Anna 的 OS,故保持 False。
    SUPPORTS_WINDOWS: bool = False

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        anna_repo: str | None = None,
        anna_python: str | None = None,
        container_workdir: str = DEFAULT_CONTAINER_WORKDIR,
        sync_workdir: bool = True,
        judge: bool = True,
        timeout_sec: int = 1800,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._repo = Path(anna_repo or os.environ.get("ANNA_REPO", ".")).resolve()
        self._python = anna_python or os.environ.get("ANNA_PYTHON") or ""
        self._container_workdir = container_workdir
        self._sync_workdir = sync_workdir
        self._judge = judge
        self._timeout_sec = timeout_sec
        self._version: str | None = None

    # --- Harbor 契约 -------------------------------------------------------

    @staticmethod
    def name() -> str:
        return "anna"

    def version(self) -> str | None:
        """Anna 的准确 commit(§三要求记录 Harness 的版本/commit)。"""
        if self._version is not None:
            return self._version
        try:
            out = subprocess.run(
                ["git", "-C", str(self._repo), "rev-parse", "--short", "HEAD"],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self._version = (out.stdout or "").strip() or "unknown"
        except Exception:  # noqa: BLE001 — 取不到版本不该毁掉一次 trial
            self._version = "unknown"
        return self._version

    async def setup(self, environment: BaseEnvironment) -> None:
        """容器内零安装 —— Anna 全程在 host 侧。

        只做一件事:确认 Anna 真的能被拉起(解释器存在 + 仓库存在)。宁可在
        setup 阶段炸,也不要跑到一半才发现根本没装 —— 前者 Harbor 归成 agent
        setup 错误,后者会被误读成任务失败。
        """
        if not self._python:
            raise AnnaAgentStartupError(
                "ANNA_PYTHON is not set (path to Anna's venv python);"
                " pass --ak anna_python=... or export ANNA_PYTHON"
            )
        if not Path(self._python).exists():
            raise AnnaAgentStartupError(f"Anna python not found: {self._python}")
        if not (self._repo / "services" / "api" / "app" / "headless.py").exists():
            raise AnnaAgentStartupError(
                f"Anna headless entry not found under {self._repo};"
                " pass --ak anna_repo=... or export ANNA_REPO"
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        host_workdir = await self._mirror_container_workdir(environment)

        frames, stderr_text, exit_code = await asyncio.to_thread(
            self._drive_anna, instruction, host_workdir
        )

        (self.logs_dir / "anna-frames.jsonl").write_text(
            "\n".join(json.dumps(frame, ensure_ascii=False) for frame in frames) + "\n",
            encoding="utf-8",
        )
        if stderr_text:
            (self.logs_dir / "anna-stderr.log").write_text(stderr_text, encoding="utf-8")

        result = next(
            (f for f in reversed(frames) if f.get("type") == ANNA_RESULT_FRAME), None
        )
        self._write_trajectory(frames, instruction=instruction, result=result)
        self._populate_context(context, frames, result, exit_code)

        if result is None:
            raise AnnaAgentStartupError(
                "Anna produced no headless.result frame"
                f" (exit={exit_code}); stderr tail: {stderr_text[-2000:]}"
            )
        error_code = result.get("error_code")
        if error_code in INFRA_ERROR_CODES:
            # §七:模型未配置 / 鉴权 / 限流 = Infrastructure Failure,单列。
            raise AnnaAgentStartupError(
                f"Anna run failed with an infrastructure error: {error_code}"
                f" — {result.get('error_message')}"
            )

    # --- 内部实现 ----------------------------------------------------------

    async def _mirror_container_workdir(
        self, environment: BaseEnvironment
    ) -> Path | None:
        """把容器工作目录**只读**镜像到 host,给 Anna 当「工作空间」。

        单向:host 侧的任何改动都不会回写容器(Anna 也没有写工具)。镜像失败
        一律降级为「无工作空间」并记日志 —— 不炸 trial:没有上下文的 run 仍是
        一次真实的、可归因的能力观测。
        """
        if not self._sync_workdir:
            return None
        host_dir = Path(tempfile.mkdtemp(prefix="anna-tb-workdir-"))
        try:
            await environment.download_dir(self._container_workdir, host_dir)
        except Exception:  # noqa: BLE001 — 镜像失败不该毁掉一次能力观测
            self.logger.warning(
                "failed to mirror container %s into %s; running without a workspace",
                self._container_workdir,
                host_dir,
                exc_info=True,
            )
            return None
        return host_dir

    def _drive_anna(
        self, instruction: str, host_workdir: Path | None
    ) -> tuple[list[dict], str, int]:
        """起 headless 子进程,逐行收帧。返回 ``(frames, stderr, exit_code)``。

        子进程隔离是刻意的:Anna 有自己的 Python 3.12 venv 和依赖树,与 Harbor
        的进程环境无关 —— 任何一方升级依赖都不会拖垮另一方。Adapter 只认
        JSONL 契约。
        """
        prompt_path = self.logs_dir / "instruction.txt"
        prompt_path.write_text(instruction, encoding="utf-8")

        argv = [
            self._python,
            "-m",
            "services.api.app.headless",
            "--prompt",
            "",  # 真正的指令走 --prompt-file,避免命令行长度/转义问题
            "--prompt-file",
            str(prompt_path),
        ]
        if host_workdir is not None:
            argv += ["--workdir", str(host_workdir)]
        if not self._judge:
            argv.append("--no-judge")

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"

        proc = subprocess.run(
            argv,
            cwd=str(self._repo),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=self._timeout_sec,
            check=False,
        )
        frames: list[dict] = []
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                frames.append(json.loads(line))
            except json.JSONDecodeError:
                # 非 JSON 的杂音(warning 之类)不丢:留证据,不装作没看见。
                frames.append({"type": "adapter.unparsed_stdout", "line": line})
        return frames, proc.stderr or "", proc.returncode

    def _populate_context(
        self,
        context: AgentContext,
        frames: list[dict],
        result: dict | None,
        exit_code: int,
    ) -> None:
        """把 run 的成本与**能力缺口事实**填进 Harbor 的结果对象。"""
        tools_called = [
            str(f.get("name"))
            for f in frames
            if f.get("type") == "tool_start" and f.get("name")
        ]
        if result is not None:
            context.n_input_tokens = result.get("input_tokens")
            context.n_output_tokens = result.get("output_tokens")
        context.metadata = {
            "anna_exit_code": exit_code,
            "anna_status": (result or {}).get("status"),
            "anna_error_code": (result or {}).get("error_code"),
            "anna_suspended": exit_code == ANNA_EXIT_SUSPENDED,
            "anna_tools_called": tools_called,
            "anna_tool_call_count": (result or {}).get("tool_calls"),
            "anna_evaluation_continuations": (result or {}).get(
                "evaluation_continuations"
            ),
            # 能力缺口的事实陈述(关于 ADAPTER 的事实,不是对 Anna 的猜测):
            # 本 Adapter 没有实现任何「Anna 工具 → environment.exec」的回桥,
            # 因为 Anna 没有可执行的工具。容器因此保持不变。
            "container_bridge": "none",
            "environment_mutations": 0,
            "capability_note": (
                "Anna exposes no shell/file-write/edit tool, so this adapter"
                " issues no commands into the task container; the container is"
                " unchanged and any reward 0 is a genuine capability failure,"
                " not an adapter defect."
            ),
        }

    # --- ATIF trajectory ---------------------------------------------------

    def _write_trajectory(
        self, frames: list[dict], *, instruction: str, result: dict | None
    ) -> None:
        """写 ``trajectory.json``(ATIF)。转换失败只警告,绝不毁掉 trial。"""
        try:
            document = frames_to_atif(
                frames,
                instruction=instruction,
                agent_version=self.version() or "unknown",
                model_name=self.model_name,
                session_id=self.session_id,
                trajectory_id=str(uuid.uuid4()),
                result=result,
            )
        except Exception:  # noqa: BLE001 — 轨迹是证据,不是运行的前置条件
            self.logger.warning("failed to build ATIF trajectory", exc_info=True)
            return
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(document, indent=2, ensure_ascii=False), encoding="utf-8"
        )


def frames_to_atif(
    frames: list[dict],
    *,
    instruction: str,
    agent_version: str,
    model_name: str | None = None,
    session_id: str | None = None,
    trajectory_id: str | None = None,
    result: dict | None = None,
) -> dict:
    """Anna JSONL 帧流 → ATIF trajectory dict(纯函数,便于离线校验)。

    切分规则来自 Anna 的帧词表:每个 ``model.call.started`` 审计事件开一轮;
    该轮内的 ``text_delta`` 拼成 assistant 消息,``model.call.completed`` 的
    ``requested_tool_names`` 变成 tool_calls,随后的 ``tool_done`` 逐个配成
    observation。第 1 步固定是 user 的原始指令(ATIF 要求 steps 非空)。
    """
    from harbor.models.trajectories.agent import Agent
    from harbor.models.trajectories.final_metrics import FinalMetrics
    from harbor.models.trajectories.metrics import Metrics
    from harbor.models.trajectories.observation import Observation
    from harbor.models.trajectories.observation_result import ObservationResult
    from harbor.models.trajectories.step import Step
    from harbor.models.trajectories.tool_call import ToolCall
    from harbor.models.trajectories.trajectory import Trajectory

    steps = [
        Step(
            step_id=1,
            timestamp=_now_iso(),
            source="user",
            message=instruction,
        )
    ]

    turns = _split_turns(frames)
    for index, turn in enumerate(turns):
        step_id = index + 2
        tool_calls = [
            ToolCall(
                tool_call_id=f"anna-{step_id}-{i}",
                function_name=name,
                arguments={},  # Anna 的线上帧不外泄工具入参(脱敏纪律)
            )
            for i, name in enumerate(turn["requested_tools"])
        ]
        observation = None
        if turn["tool_results"] and tool_calls:
            observation = Observation(
                results=[
                    ObservationResult(
                        source_call_id=tool_calls[min(i, len(tool_calls) - 1)].tool_call_id,
                        content=content,
                    )
                    for i, content in enumerate(turn["tool_results"])
                ]
            )
        steps.append(
            Step(
                step_id=step_id,
                timestamp=turn["timestamp"] or _now_iso(),
                source="agent",
                model_name=turn["model_name"] or model_name,
                message=turn["text"],
                tool_calls=tool_calls or None,
                observation=observation,
                metrics=Metrics(
                    prompt_tokens=turn["input_tokens"],
                    completion_tokens=turn["output_tokens"],
                ),
                llm_call_count=1,
            )
        )

    if result is not None and (result.get("assistant_message") or "").strip():
        steps.append(
            Step(
                step_id=len(steps) + 1,
                timestamp=_now_iso(),
                source="agent",
                model_name=model_name,
                message=str(result["assistant_message"]),
                llm_call_count=0,
            )
        )

    trajectory = Trajectory(
        schema_version=ATIF_SCHEMA_VERSION,
        session_id=session_id,
        trajectory_id=trajectory_id or str(uuid.uuid4()),
        agent=Agent(name="anna", version=agent_version, model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=(result or {}).get("input_tokens"),
            total_completion_tokens=(result or {}).get("output_tokens"),
            total_steps=len(steps),
        ),
    )
    return trajectory.to_json_dict(exclude_none=True)


def _split_turns(frames: list[dict]) -> list[dict]:
    """按 ``model.call.started`` 切轮;每轮收 text / 工具请求 / 工具结果 / token。"""
    turns: list[dict] = []
    current: dict | None = None
    for frame in frames:
        kind = frame.get("type")
        if kind == "event":
            event = frame.get("event") or {}
            event_type = event.get("type")
            payload = event.get("payload") or {}
            if event_type == "model.call.started":
                current = {
                    "text": "",
                    "requested_tools": [],
                    "tool_results": [],
                    "input_tokens": None,
                    "output_tokens": None,
                    "model_name": payload.get("model_name"),
                    "timestamp": event.get("created_at"),
                }
                turns.append(current)
            elif event_type == "model.call.completed" and current is not None:
                current["requested_tools"] = [
                    str(n) for n in (payload.get("requested_tool_names") or [])
                ]
                current["input_tokens"] = payload.get("input_tokens")
                current["output_tokens"] = payload.get("output_tokens")
        elif kind == "text_delta" and current is not None:
            current["text"] += str(frame.get("text") or "")
        elif kind == "tool_done" and current is not None:
            current["tool_results"].append(f"{frame.get('name')} completed")
    return turns


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


logging.getLogger(__name__).addHandler(logging.NullHandler())
