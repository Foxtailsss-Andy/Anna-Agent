"""Anna 无界面入口 —— 进程内驱动一次 chat run,JSONL 帧流出 stdout。

Anna 至今只有两个入口:FastAPI(``main.create_app``)和 Electron 外壳。两者都
假定「有个人在看屏幕」。任何**自动化**消费者 —— Terminal-Bench / Harbor 的
agent adapter、CI 冒烟、脚本化回归 —— 都得先起 HTTP 服务、再从
``%APPDATA%\\anna\\runtime-info.json`` 猜端口、再自己拼 SSE 解析器。这个模块
补上缺的那一环。

三条纪律:

* **不新建第二条路径**。这里只是既有 ``ChatOrchestrator.create_run`` +
  ``stream_existing_run`` 的一个薄驱动 —— 与线上 ``POST /api/chat/runs/submit``
  背后跑的是同一个 orchestrator、同一个引擎、同一份判断层。评测器测到的必须
  是产品本身,不是为评测特制的旁路。
* **帧逐字节同形**。每行 JSON 都过 SSE 侧那唯一一份 ``_jsonify_frame``,所以
  ``anna_agent.py`` 之类的外部消费者解析 JSONL 与解析 SSE 得到同一份结构。
* **终态诚实**。退出码三分:办妥 0 / 失败 1 / **可续办暂停 2**。顶到
  ``max_turns`` 却没做完不是成功 —— 把它当 0 上报,是评测里最坏的一种谎。

用法::

    python -m services.api.app.headless --prompt "..." [--workdir DIR]

模型端点/API Key 从既有 ``RuntimeSettings.from_env`` 读(runtime.json + env),
与桌面端完全一致;本模块不引入任何新配置源。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, TextIO

from services.chat.app.evaluator import build_judge, total_tool_calls
from services.chat.app.orchestrator import ChatOrchestrator
from services.chat.app.schemas import ChatRun
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.workdir_store import load_workdirs, save_workdirs

# 复用 SSE 路由那一份帧规范化 + workdir id 派生:同一个真值源,永不漂移。
# (私有名跨模块导入是刻意的 —— 复制一份实现才是真正的风险。)
from .routes.chat import _jsonify_frame
from .routes.workdirs import _now as _workdir_now
from .routes.workdirs import _workdir_id


# 桌面免登录身份 = headless 默认身份,与 runtime_config.local_session_identity 同调:
# 无人值守跑批不该因为「没登录」而失败。
DEFAULT_WORKSPACE_ID = "demo"
DEFAULT_ACTOR_USER_ID = "u_demo"

# 退出码 = 终态。0/1 之外单列 2,是因为「可续办暂停」既不是办妥也不是失败:
# 调用方要么续办(POST .../continue 的进程内等价物),要么如实记为未完成。
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_SUSPENDED = 2
EXIT_NO_TERMINAL = 3

# run.status → 退出码。未知状态落 EXIT_NO_TERMINAL(宁可报「说不清」也不谎报办妥)。
_STATUS_EXIT_CODES = {
    "ready": EXIT_OK,
    "saved": EXIT_OK,
    "failed": EXIT_FAILED,
    "awaiting_continue": EXIT_SUSPENDED,
}

# 汇总行的帧类型。刻意带 ``headless.`` 前缀:它不是引擎帧,是本入口的产物,
# 不能与 SSE 词表(text_delta / tool_start / step / event / done / error)混淆。
RESULT_FRAME_TYPE = "headless.result"


def register_workdir(path: str, name: str | None = None) -> str:
    """把一个真实目录登记进工作空间注册表,返回 ``workdir_id``(幂等)。

    与 ``POST /api/workdirs`` 同一套语义与同一份 id 派生(路径 sha1 前 12 位),
    所以对同一目录反复调用只会刷新 ``last_used_at``,不会堆出重复条目。
    路径不存在 / 不是目录 → ``ValueError``(诚实失败,不静默造一个空上下文)。
    """
    raw = (path or "").strip()
    if not raw:
        raise ValueError("workdir path is required")
    p = Path(raw).expanduser()
    if not p.exists():
        raise ValueError(f"workdir path does not exist: {raw}")
    if not p.is_dir():
        raise ValueError(f"workdir path is not a directory: {raw}")
    norm = str(p.resolve())
    workdir_id = _workdir_id(norm)
    items = load_workdirs()
    for item in items:
        if item.get("id") == workdir_id:
            item["last_used_at"] = _workdir_now()
            save_workdirs(items)
            return workdir_id
    items.append(
        {
            "id": workdir_id,
            "name": (name or "").strip() or p.resolve().name or norm,
            "path": norm,
            "last_used_at": _workdir_now(),
        }
    )
    save_workdirs(items)
    return workdir_id


def build_orchestrator(
    settings: RuntimeSettings | None = None, *, judge: bool = True
) -> ChatOrchestrator:
    """生产同款装配:真引擎 + 真 ERP gateway + (可选)独立法官判断层。

    与 ``main.create_app`` 的 chat 装配一致,唯二差别是不接 run store / memory
    store —— headless 是一次性驱动,不需要跨进程持久化,也不落业务记忆。
    ``judge=False`` 关掉判断层(评测「不带 Evaluator 的基线」时用),此时判断层
    惰性无操作、零评估事件,与配置关闭时字节等价。
    """
    resolved = settings or RuntimeSettings.from_env()
    return ChatOrchestrator(
        settings=resolved,
        evaluator_judge=build_judge(resolved) if judge else None,
    )


def _emit(out: TextIO, frame: dict[str, Any]) -> None:
    """写一行 JSON 并立刻 flush —— 消费者是管道另一端的活进程,不能等缓冲。"""
    out.write(json.dumps(frame, ensure_ascii=False) + "\n")
    out.flush()


def _token_totals(run: ChatRun) -> tuple[int | None, int | None]:
    """从审计事件汇总 token 用量;提供方没报就是 ``None``(诚实规则,不臆造 0)。"""
    input_tokens: int | None = None
    output_tokens: int | None = None
    for event in run.audit_events:
        if event.type != "model.call.completed":
            continue
        got_in = event.payload.get("input_tokens")
        got_out = event.payload.get("output_tokens")
        if isinstance(got_in, int):
            input_tokens = (input_tokens or 0) + got_in
        if isinstance(got_out, int):
            output_tokens = (output_tokens or 0) + got_out
    return input_tokens, output_tokens


def _result_frame(run: ChatRun, exit_code: int) -> dict[str, Any]:
    """终态汇总:一行读完这次 run 的结论 + 成本,无需回放整条帧流。"""
    input_tokens, output_tokens = _token_totals(run)
    return {
        "type": RESULT_FRAME_TYPE,
        "run_id": run.id,
        "thread_id": run.thread_id,
        "status": run.status,
        "exit_code": exit_code,
        "error_code": run.error_code,
        "error_message": run.error_message,
        "assistant_message": run.assistant_message,
        "tool_calls": total_tool_calls(run),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "evaluation_continuations": run.evaluation_continuations,
    }


async def run_headless(
    orchestrator: ChatOrchestrator,
    *,
    prompt: str,
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    actor_user_id: str = DEFAULT_ACTOR_USER_ID,
    workdir_id: str | None = None,
    thread_id: str | None = None,
    agent_id: str | None = None,
    skill_id: str | None = None,
    out: TextIO | None = None,
) -> int:
    """驱动一次 run,流式打帧,返回退出码。

    先 ``create_run``(拿到 run 对象)再 ``stream_existing_run``,而不是用
    ``stream_run`` —— 因为**暂停态不发终态帧**:顶到 ``max_turns`` 时生成器只是
    干净地结束,``done``/``error`` 都不会来。手里攥着 run 对象,终态才总是可读。
    """
    sink = out if out is not None else sys.stdout
    run = orchestrator.create_run(
        workspace_id=workspace_id,
        actor_user_id=actor_user_id,
        message=prompt,
        model_profile_id=None,
        skill_id=skill_id,
        agent_id=agent_id,
        workdir_id=workdir_id,
        thread_id=thread_id,
    )
    stream = orchestrator.stream_existing_run(run)
    try:
        async for frame in stream:
            _emit(sink, _jsonify_frame(frame))
    finally:
        # 与 SSE 路由同款:把 close 传进内层生成器,让 client_disconnected
        # 收尾在本次 aclose 内同步跑完(单纯 async for 不会触发)。
        await stream.aclose()
    exit_code = _STATUS_EXIT_CODES.get(run.status, EXIT_NO_TERMINAL)
    _emit(sink, _result_frame(run, exit_code))
    return exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m services.api.app.headless",
        description="Drive ONE Anna chat run in-process and stream JSONL frames to stdout.",
    )
    parser.add_argument("--prompt", required=True, help="任务指令（user 消息）")
    parser.add_argument(
        "--prompt-file",
        default=None,
        help="从文件读取指令并覆盖 --prompt（指令含换行或引号时用）",
    )
    parser.add_argument("--workdir", default=None, help="工作空间目录（只读上下文注入）")
    parser.add_argument("--thread-id", dest="thread_id", default=None, help="续聊线程 id")
    parser.add_argument("--agent-id", dest="agent_id", default=None, help="专家（附加指令）id")
    parser.add_argument("--skill-id", dest="skill_id", default=None, help="覆盖默认 Skill id")
    parser.add_argument(
        "--workspace-id", dest="workspace_id", default=DEFAULT_WORKSPACE_ID
    )
    parser.add_argument(
        "--actor-user-id", dest="actor_user_id", default=DEFAULT_ACTOR_USER_ID
    )
    parser.add_argument(
        "--no-judge",
        dest="judge",
        action="store_false",
        help="关掉判断层（Evaluator）；默认与桌面端一致，开启",
    )
    parser.set_defaults(judge=True)
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    # stdout 必须是 UTF-8:中文帧内容在 Windows 默认代码页下会直接炸。
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8")
    prompt = args.prompt
    if args.prompt_file:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    workdir_id = register_workdir(args.workdir) if args.workdir else None
    orchestrator = build_orchestrator(judge=args.judge)
    return asyncio.run(
        run_headless(
            orchestrator,
            prompt=prompt,
            workspace_id=args.workspace_id,
            actor_user_id=args.actor_user_id,
            workdir_id=workdir_id,
            thread_id=args.thread_id,
            agent_id=args.agent_id,
            skill_id=args.skill_id,
        )
    )


if __name__ == "__main__":  # pragma: no cover - 进程入口
    raise SystemExit(main())
