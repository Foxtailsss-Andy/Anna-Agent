/**
 * intentCard · R4b Anna 监察确认卡纯函数(C3 意图确认卡的 payload 判别)
 *
 * 后端 draft_intent_card 落 kind="command" 行,payload:
 *   { drafts:[{title,role,depends_on,acceptance}], origin:"anna_coordination",
 *     origin_message_id, created_from_message_id, suggested_assignee, text }
 *
 * - isIntentCommand:origin==="anna_coordination"|"intent" → Anna 协调提案变体;否则标准「+任务」卡(origin 缺省/manual)。
 * - intentSuggestedAssignee:被派者(首个 @ 指定的成员 id;无 → null)。
 * - intentAssigneeIsAgent:被派者经花名册解析为 agent(kind==="agent")→ 采纳即 auto-pilot。
 * - intentOriginMessageId / intentSourceText:溯源到触发 say。
 * - coordinationProposal:crew.propose_changes 提案(drafts 带 insert_before/assignee_id + assignments
 *   + source)→ ProposalView;旧 payload → null(旧卡照旧渲染)。
 */

import type { TeamMember } from "../../../lib/api/crew";

interface HasPayload {
  payload?: Record<string, unknown> | null;
}

/** Anna 协调提案:新 origin=anna_coordination,旧 origin=intent 保留兼容。 */
export function isIntentCommand(msg: HasPayload): boolean {
  return !!msg.payload && (
    msg.payload.origin === "anna_coordination" || msg.payload.origin === "intent"
  );
}

/** 被派者成员 id(payload.suggested_assignee = 触发 say 的首个 mention);无 → null。 */
export function intentSuggestedAssignee(msg: HasPayload): string | null {
  const v = msg.payload?.suggested_assignee;
  return typeof v === "string" && v !== "" ? v : null;
}

/** 触发意图卡的 say 消息 id(溯源)。 */
export function intentOriginMessageId(msg: HasPayload): string | null {
  const v = msg.payload?.origin_message_id;
  return typeof v === "string" && v !== "" ? v : null;
}

/** 触发 say 的原话(payload.text);缺 → null。 */
export function intentSourceText(msg: HasPayload): string | null {
  const v = msg.payload?.text;
  return typeof v === "string" ? v : null;
}

/**
 * 被派者是否 agent —— 决定「采纳并开跑」(delegate 紫,采纳即 auto-pilot)vs「采纳上图」。
 * 经花名册按 id 解析 kind;无被派者或非成员 → false。
 */
export function intentAssigneeIsAgent(
  msg: HasPayload,
  members: readonly TeamMember[],
): boolean {
  const id = intentSuggestedAssignee(msg);
  if (!id) return false;
  return members.find((m) => m.id === id)?.kind === "agent";
}

/* ---------------- Coordination Proposal(CONTRACTS §2 crew.propose_changes) ---------------- */

export interface ProposalDraft {
  title: string;
  role: string;
  depends_on: string[];
  /** 须等本新任务的既有任务标题 → 「放在「X」之前」 */
  insert_before: string[];
  acceptance: string;
  assignee_id: string | null;
}

export interface ProposalAssignment {
  task_id: string;
  member_id: string;
  reason: string;
}

export interface ProposalView {
  drafts: ProposalDraft[];
  assignments: ProposalAssignment[];
  /** payload.source.type === "workbench_run" → 「来自 Anna 对话」 */
  fromWorkbenchRun: boolean;
  /** 提案摘要(payload.text);缺 → null */
  summary: string | null;
  /** @Anna 意图卡的发言中 @ 指定成员(服务端确认时落到首个采纳的新任务);无 → null */
  suggestedAssignee: string | null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Coordination Proposal 视图:payload 带 `assignments` 数组、任一草案带非空 `insert_before`,
 * 或来源是 Workbench Run → 新提案卡;否则 null(旧意图卡,照旧渲染)。
 * 缺字段补空,不造字段值;未知形状的条目(非对象)跳过。
 */
export function coordinationProposal(msg: HasPayload): ProposalView | null {
  const payload = msg.payload;
  if (!payload) return null;
  const rawDrafts = Array.isArray(payload.drafts) ? payload.drafts : [];
  const drafts: ProposalDraft[] = rawDrafts.map((d) => {
    const o = record(d);
    const assignee = o.assignee_id;
    return {
      title: str(o.title),
      role: str(o.role),
      depends_on: strings(o.depends_on),
      insert_before: strings(o.insert_before),
      acceptance: str(o.acceptance),
      assignee_id: typeof assignee === "string" && assignee !== "" ? assignee : null,
    };
  });
  const source = record(payload.source);
  const fromWorkbenchRun = source.type === "workbench_run";
  const hasAssignments = Array.isArray(payload.assignments);
  if (!hasAssignments && !fromWorkbenchRun && !drafts.some((d) => d.insert_before.length > 0)) return null;
  const assignments: ProposalAssignment[] = (hasAssignments ? (payload.assignments as unknown[]) : [])
    .filter((a) => a !== null && typeof a === "object")
    .map((a) => {
      const o = record(a);
      return { task_id: str(o.task_id), member_id: str(o.member_id), reason: str(o.reason) };
    });
  const summary = typeof payload.text === "string" && payload.text.trim() !== "" ? payload.text : null;
  return { drafts, assignments, fromWorkbenchRun, summary, suggestedAssignee: intentSuggestedAssignee(msg) };
}
