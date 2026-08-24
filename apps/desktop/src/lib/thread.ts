/**
 * Anna · 会话轮次标签(L1b,纯函数,可 vitest 单测)
 *
 * 诚实纪律(ADR-002):会话轮次 chip 只在「真的续聊」时出现 —— 后端仅当把同 thread
 * 的既往 user/assistant 对拼进本轮模型请求时,才补发 `chat.thread.continued`
 * 审计(payload.prior_turns = 纳入的对数)。本函数只读这条真审计:
 *   - 有该事件且 prior_turns ≥ 1 → 「会话第 {prior_turns + 1} 轮」
 *   - 无该事件 / 载荷缺失或异常 → null(不出 chip,绝不显示「第 1 轮」)
 *
 * 入参 = run.audit_events(ChatRun JSON 里的审计数组,元素形如
 * {type, run_id, payload, created_at});非数组一律 null(防御性,不猜)。
 */

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  v !== null && typeof v === "object" ? (v as Rec) : {};

export function threadTurnLabel(auditEvents: unknown): string | null {
  if (!Array.isArray(auditEvents)) return null;
  for (const ev of auditEvents) {
    const e = asRecord(ev);
    if (e.type !== "chat.thread.continued") continue;
    const prior = asRecord(e.payload).prior_turns;
    // 真续聊才发此事件;prior_turns 缺失/非有限数/< 1(无既往对)一律不出 chip。
    if (typeof prior !== "number" || !Number.isFinite(prior) || prior < 1) return null;
    return `会话第 ${prior + 1} 轮`;
  }
  return null;
}

export default threadTurnLabel;
