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
