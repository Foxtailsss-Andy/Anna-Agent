/**
 * approvalView · 报销 run → ApprovalCard props(纯函数,可 vitest 单测)
 *
 * 数据源 = 线上 ReimbursementRun.model_dump(reality-check 2026-07-10):
 *  - confirm 变体(run.status === "waiting_confirmation"):字段网格取 approval.draft_snapshot 真字段;
 *    risk = approval.risk_level 直通(仅 low/medium/high 才出 chip,未知值留空不造假);
 *    payloadText = approval.payload 的 JSON 原文,一字不改(诚实纪律 · L3 素颜)。
 *  - supplement 变体(run.status === "collecting"):字段清单取 run.missing_fields;
 *    金额→number、日期→date、附件→file(页面级 AttachmentPicker 承接)、其余→text。
 *    D-R6-2:当 collecting 但 missing_fields 为空(模型自由发问,agent_message 承载问题),
 *    回退到核心可编辑草稿字段,让用户仍能补录基本信息(真字段,非造假)。
 *
 * 纪律:只映射真数据,不编造字段值;awaiting 帧到 done 帧之间(无 run)由页面渲染骨架,不进此函数。
 */

import type {
  ApprovalCardProps,
  ApprovalRisk,
  SupplementField,
} from "../../components/agent/ApprovalCard";

type Run = Record<string, unknown>;
const rec = (v: unknown): Run => (v !== null && typeof v === "object" ? (v as Run) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const KNOWN_RISKS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
function toRisk(v: unknown): ApprovalRisk | undefined {
  const s = str(v);
  return s && KNOWN_RISKS.has(s) ? (s as ApprovalRisk) : undefined;
}

/** 金额呈现:数值加千分位 + 币种(真值,不臆造货币符号)。 */
function amountText(amount: unknown, currency: unknown): string | undefined {
  if (amount == null || amount === "") return undefined;
  const n = typeof amount === "number" ? amount : Number(amount);
  const num = Number.isFinite(n) ? n.toLocaleString() : String(amount);
  const cur = str(currency);
  return cur ? `${num} ${cur}` : num;
}

/** confirm 字段呈现映射(draft_snapshot key → 标签 + mono)。仅收非空真值。 */
const CONFIRM_FIELDS: { key: string; label: string; mono: boolean }[] = [
  { key: "external_reimbursement_id", label: "单据号", mono: true },
  // 金额 单独处理(合并 currency)
  { key: "category", label: "费用类别", mono: false },
  { key: "merchant", label: "商户", mono: false },
  { key: "reason", label: "事由", mono: false },
  { key: "expense_date", label: "发生日期", mono: true },
];

/**
 * confirm 变体:仅当 run 停在 waiting_confirmation 且 approval pending 时返回;否则 null。
 * 字段网格取 approval.draft_snapshot(回退 run.draft),金额 mono、事由/类别不 mono。
 */
export function confirmProps(run: Run | null | undefined): ApprovalCardProps | null {
  const r = rec(run);
  if (str(r.status) !== "waiting_confirmation") return null;
  const approval = rec(r.approval);
  if (r.approval == null || str(approval.status) !== "pending") return null;

  const snap = r.approval != null && approval.draft_snapshot != null
    ? rec(approval.draft_snapshot)
    : rec(r.draft);

  const fields: NonNullable<ApprovalCardProps["fields"]> = [];
  // 单据号(置顶)
  const docId = str(snap.external_reimbursement_id);
  if (docId) fields.push({ label: "单据号", value: docId, mono: true });
  // 金额 + 币种
  const amt = amountText(snap.amount, snap.currency);
  if (amt) fields.push({ label: "金额", value: amt, mono: true });
  // 其余(单据号已单列)
  for (const f of CONFIRM_FIELDS) {
    if (f.key === "external_reimbursement_id") continue;
    const val = snap[f.key];
    if (val == null || val === "") continue;
    fields.push({ label: f.label, value: String(val), mono: f.mono });
  }

  return {
    variant: "confirm",
    risk: toRisk(approval.risk_level),
    fields,
    payloadText: JSON.stringify(approval.payload ?? {}, null, 2),
  };
}

/* ---- supplement 字段字典 ---- */

const FIELD_LABEL: Record<string, string> = {
  amount: "金额",
  currency: "币种",
  expense_date: "发生日期",
  category: "费用类别",
  merchant: "商户",
  reason: "事由",
  department_id: "部门",
  cost_center_id: "成本中心",
  project_id: "项目",
  attachments: "发票附件",
};
const FIELD_TYPE: Record<string, SupplementField["type"]> = {
  amount: "number",
  expense_date: "date",
  attachments: "file",
};
/** D-R6-2 回退核心字段(collecting 但后端未给结构化 missing_fields 时)。均为真实可编辑草稿字段。 */
const CORE_SUPPLEMENT_FIELDS = ["amount", "currency", "expense_date", "category", "merchant", "reason"];

function toSupplementField(id: string): SupplementField {
  return {
    id,
    label: FIELD_LABEL[id] ?? id,
    type: FIELD_TYPE[id] ?? "text",
    ...(FIELD_TYPE[id] === "number" ? { placeholder: "0.00" } : {}),
  };
}

/**
 * supplement 变体:仅当 run.status === "collecting" 时返回;否则 null。
 * 字段取 run.missing_fields;为空(模型自由发问)则回退核心可编辑字段(D-R6-2)。
 */
export function supplementProps(run: Run | null | undefined): ApprovalCardProps | null {
  const r = rec(run);
  if (str(r.status) !== "collecting") return null;
  const missing = Array.isArray(r.missing_fields)
    ? (r.missing_fields as unknown[]).map(String).filter(Boolean)
    : [];
  const ids = missing.length > 0 ? missing : CORE_SUPPLEMENT_FIELDS;
  return {
    variant: "supplement",
    supplementFields: ids.map(toSupplementField),
  };
}
