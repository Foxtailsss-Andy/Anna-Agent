/**
 * Anna · 判断层诚实标注(J2 前端,纯函数,可 vitest 单测)
 *
 * J2 Evaluator 在宣布办妥前会复核一次。复核发现没真办成、且自动补办后仍不达时,
 * 它**不假装成功也不判 run 失败**,而是留下 `run.evaluation.flagged {gaps}`。
 * 那条审计如果只躺在时间线里,答案区读起来仍然像一次干净的成功 —— 判断层最有价值
 * 的产品结果(诚实告诉你哪里没办到)就等于没交付。本函数把它取出来给答案区。
 *
 * 诚实纪律(ADR-002):只认 `run.evaluation.flagged` 这一条真凭证。
 *   - 干净的 run(零评估事件)→ null
 *   - 评估被跳过(fail-open,`run.evaluation.skipped`)→ null:没得出结论就不吓唬用户
 *   - 复核通过(achieved)→ null
 *   - 有 flagged → 出条;gaps 原文照登(后端 parse_verdict 已代码钳过 ≤5 条 ≤120 字),
 *     非字符串/空串剔除;多次 flagged 取**最后一次**(补办后的结论,不叠加旧的)
 *
 * 入参 = run.audit_events(元素形如 {type, run_id, payload, created_at});
 * 非数组一律 null(防御性,不猜)。
 */

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  v !== null && typeof v === "object" ? (v as Rec) : {};

export interface EvaluationNotice {
  /** 判断层写下的缺口原文(可能为空数组:标注是真的,只是没列条目) */
  gaps: string[];
}

export function evaluationNotice(auditEvents: unknown): EvaluationNotice | null {
  if (!Array.isArray(auditEvents)) return null;
  let latest: Rec | null = null;
  for (const item of auditEvents) {
    const e = asRecord(item);
    if (e.type === "run.evaluation.flagged") latest = e;
  }
  if (latest === null) return null;
  const raw = asRecord(latest.payload).gaps;
  const gaps = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
    : [];
  return { gaps };
}

export default evaluationNotice;
