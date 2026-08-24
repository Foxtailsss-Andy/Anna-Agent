from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from services.reimbursement.app.audit import AuditEvent


# "interrupted" (L2 P2 状态外置):进程重启后,库里仍处非终态的 run 被诚实标记
# 为 interrupted —— 失败类终态(不进 thread 历史,FE 原样显示状态串)。
# "awaiting_continue" (L4a P1 上下文治理):模型顶到 max_turns 但任务未完 —— run 暂停
# 为可续办态(非失败、非终态),快照存 suspended_messages,POST .../continue 续跑;
# 进程重启后不被 sweep 判死(库里凭 payload 续跑)。
ChatRunStatus = Literal[
    "generating", "ready", "saved", "failed", "interrupted", "awaiting_continue"
]


class ChatPromptTemplate(BaseModel):
    id: str
    label: str
    description: str
    prompt: str


class ChatRun(BaseModel):
    id: str
    workspace_id: str
    actor_user_id: str
    message: str
    # L1 会话连续性:本 run 所属会话线程。首轮 = 自身 run_id(自指);续聊 = 调用方
    # 传入的 thread_id。同 thread 的既往轮(user/assistant 对,近 N 轮)会被组装进
    # 下一轮的模型请求,实现多轮记忆(组装见 ChatOrchestrator._thread_history_messages)。
    thread_id: str
    template_id: str | None = None
    # P3 refinement — per-run model profile + skill overrides (None → defaults).
    model_profile_id: str | None = None
    skill_id: str | None = None
    # Home 合并轮 M2 — per-run 专家选择:该 Agent 的附加指令注入本次 run 的
    # system prompt(None → 域默认 "chat");真值 = runtime config agent_directives。
    agent_id: str | None = None
    # Home 合并轮 B2 — per-run 工作空间(workdir 注册表 id):有效则文件树摘要
    # 注入 system prompt 并挂 workdir.read_file 只读工具;失效(已删/路径失踪)
    # 审计 workdir.missing 后照常进行(诚实降级,不 fail)。
    workdir_id: str | None = None
    status: ChatRunStatus
    assistant_message: str | None = None
    saved_memory_id: str | None = None
    associate_goal_text: str | None = None
    audit_events: list[AuditEvent] = Field(default_factory=list)
    # P4 交付闭环:emit 工具提交的正式产物(page/doc),随 run 持久、随历史回看。
    artifacts: list[dict] = Field(default_factory=list)
    # W1.T3:模型经 plan.update 维护的任务计划清单(整表替换,幂等)。
    plan: list[dict] = Field(default_factory=list)
    # L4a 续办:max_turns 顶到时的消息快照(含 system+已完成轮次)。仅 status ==
    # "awaiting_continue" 时非空;continue 从这里 + 续办提示恢复引擎。刻意排除在
    # thread 历史组装之外(那只取 ready 轮的 assistant_message)。
    suspended_messages: list[dict] | None = None
    # J2 判断力轮 Evaluator:本 run 已用掉的自动补办次数(上限 =
    # settings.evaluation_max_continuations)。判断层每驱动一次续跑 +1;用来界定
    # 「一次自动补办」的边界,防止死循环。终态判定的裁定与缺口走审计链
    # (run.evaluation.{started,verdict,flagged,skipped}),此字段只做计数。
    evaluation_continuations: int = 0
    error_code: str | None = None
    error_message: str | None = None
