from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from services.reimbursement.app.audit import AuditEvent


CreateRunStatus = Literal[
    "generating",
    "validating",
    "ready_for_review",
    "saved",
    "failed",
    # "interrupted" (L2 P2 状态外置):进程重启后,库里仍处非终态的 draft run
    # 被诚实标记为 interrupted(失败类终态,FE 原样显示状态串)。
    "interrupted",
]


class CreateArtifact(BaseModel):
    kind: Literal["skill", "prompt", "python_tool"]
    path: str
    preview: str
    skill_id: str | None = None
    prompt_id: str | None = None
    tool_id: str | None = None


class CreateValidationResult(BaseModel):
    valid: bool
    loaded_skill_id: str | None = None
    allowed_tools: list[str] = Field(default_factory=list)
    forbidden_tools: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class CreateSandboxResult(BaseModel):
    passed: bool
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    workdir: str
    timed_out: bool = False
    output_truncated: bool = False
    preflight_policy: str = "ast_import_and_side_effect_preflight"
    timeout_seconds: int = 5
    max_output_bytes: int = 8192
    env_allowlist: list[str] = Field(default_factory=lambda: ["PYTHONIOENCODING"])
    secret_boundary: str = "subprocess_env_allowlist"


class CreateActivationEligibility(BaseModel):
    activation_allowed: bool
    safe_for_review: bool
    blocking_reasons: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)


class CreateDraftRun(BaseModel):
    id: str
    workspace_id: str
    actor_user_id: str
    prompt: str
    kind: Literal["skill", "prompt", "python_tool"] = "skill"
    # Home 合并轮 B1 — per-run 专家选择(None → 域默认 "create" 的附加指令)。
    agent_id: str | None = None
    # Home 合并轮 B2 — per-run 工作空间(workdir 注册表 id):有效则 [工作空间]
    # 文件树摘要追加到 system prompt 末尾(create 单次调用无工具循环,仅上下文
    # 注入);失效审计 workdir.missing 后照常进行(诚实降级)。
    workdir_id: str | None = None
    # Home 合并轮 B3 — Ask/Bypass 审批档位:本轮真存真审计(created 审计携带),
    # create 管线今日无受门动作(单次调用无写工具;激活本就是显式用户确认),
    # 拦截点随后续写工具/Code 模式点亮。非法值由 pydantic Literal 挡。
    permission_mode: Literal["ask", "bypass"] = "ask"
    status: CreateRunStatus
    artifact: CreateArtifact | None = None
    validation: CreateValidationResult | None = None
    sandbox_result: CreateSandboxResult | None = None
    activation_eligibility: CreateActivationEligibility | None = None
    audit_events: list[AuditEvent] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
