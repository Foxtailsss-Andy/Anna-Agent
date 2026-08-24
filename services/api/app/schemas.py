from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


class CreateReimbursementRunRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    input_text: str
    # Optional invoice/receipt attachments, each an Anna-imported reference
    # ({"name", "uri": "anna://attachment/<sha256>/<name>"}). Attached at run
    # start so they flow into the draft and reach the MCP on create_draft.
    attachments: list[dict[str, Any]] | None = None


class CreateHikerDashboardRunRequest(BaseModel):
    workspace_id: str
    actor_user_id: str


class CreateHikerAssistantRunRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    question: str


class CreateAssociateReceivablesRunRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    period: str
    goal_text: str


class CreateAssociateNodeApprovalRequest(BaseModel):
    requested_by: str


class CreateChatRunRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    message: str
    # L1 continuity - carry the prior turn's returned thread_id to continue a
    # conversation; None = a fresh thread (first turn self-references its run id).
    thread_id: str | None = None
    template_id: str | None = None
    # P3 refinement - per-run model profile + skill overrides (None -> defaults).
    model_profile_id: str | None = None
    skill_id: str | None = None
    # Home merge M2 - per-run agent (expert) directive selection (None -> "chat").
    agent_id: str | None = None
    # Home merge B2 - per-run workdir (工作空间 registry id): valid -> file-tree
    # context injected + workdir.read_file tool; stale -> workdir.missing audit.
    workdir_id: str | None = None


class SaveChatRunRequest(BaseModel):
    saved_by: str


class InterjectChatRunRequest(BaseModel):
    """J3 插话:运行中对 run 补一句话(不是新 run)。"""

    text: str


class ApproveAssociateNodeRequest(BaseModel):
    approved_by: str


class RejectAssociateNodeRequest(BaseModel):
    rejected_by: str


class CreateSkillDraftRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    prompt: str


class CreateDraftRequest(BaseModel):
    workspace_id: str
    actor_user_id: str
    prompt: str
    kind: str = "skill"
    # Home merge B1 - per-run agent (expert) directive selection (None -> "create").
    agent_id: str | None = None
    # Home merge B2 - per-run workdir (工作空间 registry id): valid -> [工作空间]
    # context appended to the system prompt; stale -> workdir.missing audit.
    workdir_id: str | None = None
    # Home merge B3 - Ask/Bypass approval mode. Stored + audited this round;
    # enforcement lands with write tools / Code mode. Invalid values are
    # rejected here by the Literal (422).
    permission_mode: Literal["ask", "bypass"] = "ask"


class SaveCreateSkillDraftRequest(BaseModel):
    confirmed_by: str


class ApproveSubmitRequest(BaseModel):
    approved_by: str


class RejectSubmitRequest(BaseModel):
    rejected_by: str


class AnswerMissingFieldsRequest(BaseModel):
    answers: dict[str, Any]


class AddModelProfileRequest(BaseModel):
    id: str
    label: str
    provider: str = "openai-compatible"
    endpoint: str
    model_name: str
    api_key: str | None = None


class UpdateRuntimeConfigRequest(BaseModel):
    model_provider: str | None = None
    model_endpoint: str | None = None
    model_name: str | None = None
    model_api_key: str | None = None
    reimbursement_mcp_server: str | None = None
    reimbursement_mcp_api_key: str | None = None
    reimbursement_skill_id: str | None = None
    reimbursement_probe_draft: dict[str, Any] | None = None
    erp_mcp_server: str | None = None
    erp_mcp_api_key: str | None = None
    hiker_mcp_server: str | None = None
    hiker_mcp_api_key: str | None = None
    associate_receivables_skill_id: str | None = None
    chat_skill_id: str | None = None
    # P3 refinement - multi-LLM profiles + per-agent Boss directives.
    model_profiles: list[dict[str, Any]] | None = None
    agent_directives: dict[str, str] | None = None
