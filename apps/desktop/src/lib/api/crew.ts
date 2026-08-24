/**
 * Crew API 客户端(fetch 风格沿 chat.ts;经 apiFetch 注身份头)。
 *
 * 鉴权:Crew/通知/团队路由走 Bearer(services/api/app/routes/crew.py:_session);
 *   桌面免登录(local-runtime)无 token → 调用侧 catch 降级空态(绝不造数)。
 *   已登录(boss@anna.demo 等)带 token → 真数据。identity 头由 apiFetch 附带(无害)。
 * 契约来源:B1a(31ce1a2)crew.py + schemas.py;未上线端点(inbox/memory/frames = B2/B3)
 *   保留客户端方法,调用处 404 容错 → 空。
 */

import { apiJson } from "./client";
import { getToken } from "./identity";
import type { CrewProject, CrewTask } from "../../pages/crew/crewModel";

export type { CrewProject, CrewTask };

/* ---------------- 契约类型(镜像后端 schemas) ---------------- */

/** services/crew/app/schemas.py:ChannelMessage */
export interface ChannelMessage {
  id: string;
  project_id: string;
  workspace_id: string;
  seq: number;
  author_kind: "anna" | "member" | "worker";
  author_member_id: string | null;
  worker_profile_ref?: string | null;
  caused_by_execution_id?: string | null;
  kind: "event" | "artifact" | "review" | "say" | "command";
  body: string;
  task_id: string | null;
  run_ref: string | null;
  mentions: string[];
  audit_ref: string;
  /** kind="command" 草案行的结构化附加(drafts / text / created_from_message_id);其余族为 null */
  payload?: Record<string, unknown> | null;
  created_at: string;
}

/** services/crew/app/schemas.py:TaskDraft(命令起草的候选任务,待 Boss 确认) */
export interface TaskDraft {
  title: string;
  role: string;
  /** 引用其他草案(按标题;任务尚未落地) */
  depends_on: string[];
  acceptance: string;
}

/** services/crew/app/schemas.py:Notification */
export interface CrewNotification {
  id: string;
  workspace_id: string;
  to_member_id: string;
  kind: "assigned" | "mention" | "review_due" | "rejected" | "blocked" | "approval" | "unlocked";
  title: string;
  deep_link: string;
  project_id: string | null;
  task_id: string | null;
  read_at: string | null;
  idempotency_key: string;
  created_at: string;
}

/** services/crew/app/schemas.py:SopTaskSpec */
export interface SopTaskSpec {
  key: string;
  title: string;
  role_required: string;
  depends_on: string[];
  is_gate: boolean;
  reviews: string | null;
  acceptance_criteria: string | null;
}

/** services/crew/app/schemas.py:SopTemplate */
export interface SopTemplate {
  id: string;
  name: string;
  description: string;
  tasks: SopTaskSpec[];
}

export interface CrewShowcaseResponse {
  scenario_id: "weekly_action_closure_v1";
  scenario_version: number;
  project: CrewProject;
  created: boolean;
  migrated: boolean;
  warnings: string[];
}

/** services/identity/app/schemas.py:Account(团队成员;GET /api/auth/team) */
export interface TeamMember {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string;
  role: string;
  kind: "human" | "agent" | string;
}

/* ---------------- 收件箱聚合(B3;services/crew/app/inbox.py 真形状) ---------------- */

/** 待我做:已派给我的任务(assigned/rework)+ 预派排队(queued)。 */
export interface TodoCard {
  card_kind: "assigned" | "rework" | "queued";
  project_id: string;
  project_goal: string;
  task_id: string;
  title: string;
  role_required: string;
  status: string;
  /** F6:任务来源("sop"|"channel");"channel" → 呈现「由频道生长」行(1e) */
  origin?: string;
  /** F6:最新产物版本号(B4);返工卡据此渲染 v{n}→v{n+1} pill(1e Andy「v1→v2」) */
  artifact_version?: number;
  /** rework:驳回理由(评审人批注) */
  rework_reason?: string;
  /** queued:解锁条件文案(如「『设计评审』通过后解锁」) */
  unlocked_after?: string;
}

/** 待我审:我 owner 项目里就绪的评审门。 */
export interface ReviewGateCard {
  card_kind: "gate";
  project_id: string;
  project_goal: string;
  gate_task_id: string;
  gate_title: string;
  reviews_title: string | null;
  acceptance_criteria: string | null;
}

/** 待我审:报销投影卡(approvals_projection;由路由折入 review 组)。 */
export interface ReviewReimbursementCard extends ApprovalCard {
  card_kind: "reimbursement";
}

export type ReviewCard = ReviewGateCard | ReviewReimbursementCard;

/** @我:频道 say 行里 @ 了我。 */
export interface MentionCard {
  project_id: string;
  project_goal: string;
  message_id: string;
  author_member_id: string | null;
  body: string;
  task_id: string | null;
  created_at: string;
}

export interface CrewInbox {
  todo: TodoCard[];
  review: ReviewCard[];
  mentions: MentionCard[];
}

/** 报销四步投影卡(services/crew/app/approvals_projection.py:project_run) */
export interface ApprovalCard {
  run_id: string;
  applicant: string;
  amount: number;
  currency: string;
  step: "submitted" | "drafted" | "awaiting_approval" | "verified";
  deep_link: string;
  updated_at: string | null;
  approval_id: string | null;
}

/** 项目共识条目(B1b,未上线) */
export interface MemoryItem {
  id: string;
  kind: string;
  text: string;
}

/** run 帧(B2,未上线;结构沿 chat 帧,读取即透传) */
export type RunFrame = Record<string, unknown>;

/* ---------------- 鉴权头 ---------------- */

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ---------------- 项目 / 模板 / 团队 ---------------- */

export async function listProjects(): Promise<CrewProject[]> {
  const res = await apiJson<{ projects: CrewProject[] }>("/api/crew/projects", {
    headers: authHeaders(),
  });
  return res.projects ?? [];
}

export async function ensureCrewShowcase(): Promise<CrewShowcaseResponse> {
  return apiJson<CrewShowcaseResponse>("/api/crew/showcase/ensure", {
    method: "POST",
    headers: authHeaders(),
  });
}

export function getProject(projectId: string): Promise<CrewProject> {
  return apiJson<CrewProject>(`/api/crew/projects/${projectId}`, { headers: authHeaders() });
}

/** 从 SOP 模板建项目(模板库「用此模板建项目」);工作图按流程长出来。 */
export function createProject(goalText: string, templateId: string): Promise<CrewProject> {
  return apiJson<CrewProject>("/api/crew/projects", {
    method: "POST",
    headers: authHeaders(),
    json: { goal_text: goalText, sop_template_id: templateId },
  });
}

export async function listTemplates(): Promise<SopTemplate[]> {
  const res = await apiJson<{ templates: SopTemplate[] }>("/api/crew/templates", {
    headers: authHeaders(),
  });
  return res.templates ?? [];
}

export async function listTeam(): Promise<TeamMember[]> {
  const res = await apiJson<{ members: TeamMember[] }>("/api/auth/team", {
    headers: authHeaders(),
  });
  return res.members ?? [];
}

/* ---------------- 频道 ---------------- */

export async function listChannel(projectId: string): Promise<ChannelMessage[]> {
  const res = await apiJson<{ messages: ChannelMessage[] }>(
    `/api/crew/projects/${projectId}/channel`,
    { headers: authHeaders() },
  );
  return res.messages ?? [];
}

/** 说点什么(F3 composer:say 入频道编年,@提及去重由调用侧组装) */
export function postChannel(
  projectId: string,
  body: string,
  mentions: string[] = [],
): Promise<ChannelMessage> {
  return apiJson<ChannelMessage>(`/api/crew/projects/${projectId}/channel`, {
    method: "POST",
    headers: authHeaders(),
    json: { body, mentions },
  });
}

/* ---------------- 评审(就地驱动状态机;B3 既有端点) ---------------- */

/**
 * 评审门:approved=true 通过(下游解锁)/ false 驳回(退回返工,批注注入重跑上下文)。
 * taskId = 门任务 id;返回刷新后的项目(评审卡按此就地驱动状态机)。
 */
export function reviewTask(
  projectId: string,
  taskId: string,
  approved: boolean,
  comment?: string | null,
): Promise<CrewProject> {
  return apiJson<CrewProject>(`/api/crew/projects/${projectId}/tasks/${taskId}/review`, {
    method: "POST",
    headers: authHeaders(),
    json: { approved, comment: comment ?? null },
  });
}

/* ---------------- 任务写操作(认领/改派/开始/提交;F1/B 既有端点) ---------------- */

/** 改派 / 认领(assign 给某成员;认领即 assign 给自己)。 */
export function assignTask(
  projectId: string,
  taskId: string,
  memberId: string,
): Promise<CrewProject> {
  return apiJson<CrewProject>(`/api/crew/projects/${projectId}/tasks/${taskId}/assign`, {
    method: "POST",
    headers: authHeaders(),
    json: { member_id: memberId },
  });
}

/** 开始(assigned → running)。 */
export function startTask(projectId: string, taskId: string): Promise<CrewProject> {
  return apiJson<CrewProject>(`/api/crew/projects/${projectId}/tasks/${taskId}/start`, {
    method: "POST",
    headers: authHeaders(),
  });
}

/** 提交产物(running/rework → submitted;下游评审门解锁)。 */
export function submitTask(
  projectId: string,
  taskId: string,
  artifact: string,
): Promise<CrewProject> {
  return apiJson<CrewProject>(`/api/crew/projects/${projectId}/tasks/${taskId}/submit`, {
    method: "POST",
    headers: authHeaders(),
    json: { artifact },
  });
}

/**
 * 显式触发 Agent 执行(run-agent):后台起一个隔离只读子代理产出该任务,立即返回
 * {run_ref}(status=running);产出经同一状态机 submit(→ submitted 待审),失败 → blocked
 * (绝不假完成)。run_ref 落任务 → 抽屉 trace 逐帧回放。仅对 agent-kind assignee 的
 * assigned|rework 任务提供入口(见 inspectModel.canRunAgent)。
 */
export function runAgentTask(
  projectId: string,
  taskId: string,
): Promise<{ run_ref: string; task_id: string; status: string }> {
  return apiJson<{ run_ref: string; task_id: string; status: string }>(
    `/api/crew/projects/${projectId}/tasks/${taskId}/run-agent`,
    { method: "POST", headers: authHeaders() },
  );
}

/* ---------------- 频道「+任务」两段式(B3;起草 → Boss 确认下推) ---------------- */

/** 第一段:把一条频道话起草为 1..N≤3 个任务草案(任何成员),命令行落频道。 */
export function channelCommand(
  projectId: string,
  text: string,
  sourceMessageId?: string | null,
): Promise<{ message_id: string; drafts: TaskDraft[] }> {
  return apiJson<{ message_id: string; drafts: TaskDraft[] }>(
    `/api/crew/projects/${projectId}/channel/command`,
    {
      method: "POST",
      headers: authHeaders(),
      json: sourceMessageId ? { text, source_message_id: sourceMessageId } : { text },
    },
  );
}

/**
 * 第二段(Boss-only):按 index 下推命令行草案的子集(服务端从命令行解析真草案,
 * 客户端不可捏造);返回落地新任务后的项目。
 */
export function confirmChannelCommand(
  projectId: string,
  messageId: string,
  draftIndexes?: number[],
): Promise<CrewProject> {
  return apiJson<CrewProject>(`/api/crew/projects/${projectId}/channel/command/confirm`, {
    method: "POST",
    headers: authHeaders(),
    json:
      draftIndexes !== undefined
        ? { message_id: messageId, draft_indexes: draftIndexes }
        : { message_id: messageId },
  });
}

/* ---------------- 通知 ---------------- */

export async function listNotifications(unreadOnly = false): Promise<CrewNotification[]> {
  const q = unreadOnly ? "?unread=1" : "";
  const res = await apiJson<{ notifications: CrewNotification[] }>(
    `/api/crew/notifications${q}`,
    { headers: authHeaders() },
  );
  return res.notifications ?? [];
}

export function markNotificationRead(notificationId: string): Promise<CrewNotification> {
  return apiJson<CrewNotification>(`/api/crew/notifications/${notificationId}/read`, {
    method: "PATCH",
    headers: authHeaders(),
  });
}

/* ---------------- 收件箱 / 共识 / 帧(B2/B3,未上线:调用处 404 → 空) ---------------- */

export function getInbox(): Promise<CrewInbox> {
  return apiJson<CrewInbox>("/api/crew/inbox", { headers: authHeaders() });
}

/** 工作空间报销 run 的四步投影(Boss 视角;GET /api/crew/approvals)。 */
export async function listApprovals(): Promise<ApprovalCard[]> {
  const res = await apiJson<{ approvals: ApprovalCard[] }>("/api/crew/approvals", {
    headers: authHeaders(),
  });
  return res.approvals ?? [];
}

export async function getProjectMemory(projectId: string): Promise<MemoryItem[]> {
  const res = await apiJson<{ items: MemoryItem[] }>(`/api/crew/projects/${projectId}/memory`, {
    headers: authHeaders(),
  });
  return res.items ?? [];
}

export function upsertProjectMemory(
  projectId: string,
  item: { id?: string; kind: string; text: string },
): Promise<MemoryItem> {
  return apiJson<MemoryItem>(`/api/crew/projects/${projectId}/memory`, {
    method: "PUT",
    headers: authHeaders(),
    json: item,
  });
}

export function deleteProjectMemory(projectId: string, itemId: string): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>(`/api/crew/projects/${projectId}/memory/${itemId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function getRunFrames(runRef: string, fromSeq = 0): Promise<RunFrame[]> {
  const res = await apiJson<{ frames: RunFrame[] }>(
    `/api/crew/runs/${runRef}/frames?from_seq=${fromSeq}`,
    { headers: authHeaders() },
  );
  return res.frames ?? [];
}
