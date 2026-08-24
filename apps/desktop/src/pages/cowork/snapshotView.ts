/**
 * snapshotView · Hiker 看板真快照 → 五段式呈现模型(纯函数,可 vitest 单测)
 *
 * 纪律(ADR-002 · 数据密集页诚实红线):
 *  · 只做真值的形态映射与展示格式化,禁编造、禁推导业务结论(BI 由后端代码计算)。
 *  · 系列色仅 var(--iris)/var(--gold);金额压缩(万/亿)是显示变换,非改数。
 *  · 字段缺省一律不 throw,回落空骨架(未连接/失败态由页面裁决,不在此臆造)。
 *
 * Hiker 客户与合同看板仅展示外部 connector 返回的只读客户、合同与回款摘要；
 * Finance 经营看板已经退出 Cowork 正式主链路。
 */

/* ---------------- 输入形态(schemas.py 现状;全可缺省,防御式) ---------------- */

export interface AnomalyIn {
  id?: string;
  title?: string;
  severity?: "low" | "medium" | "high";
  explanation?: string;
}

export interface HikerKpiIn {
  id?: string;
  label?: string;
  value?: number;
  unit?: string | null;
}
export interface HikerCollectionIn {
  planned_amount?: number;
  actual_amount?: number;
  unreceived_amount?: number;
}
export interface HikerAgingBucketIn {
  id?: string;
  label?: string;
  count?: number;
  amount?: number;
}
export interface HikerCustomerIn {
  customer_name?: string;
  contract_count?: number;
  contract_amount?: number;
  planned_receipt_amount?: number;
  actual_receipt_amount?: number;
  unreceived_amount?: number;
}
export interface HikerSnapshotIn {
  source?: string;
  kpis?: HikerKpiIn[];
  collection?: HikerCollectionIn;
  aging_buckets?: HikerAgingBucketIn[];
  risk_due_soon_count?: number;
  risk_overdue_count?: number;
  top_customers?: HikerCustomerIn[];
  anomalies?: AnomalyIn[];
}

/* ---------------- 输出呈现模型 ---------------- */

export type DeltaTone = "ok" | "warn" | "neutral";

export interface KpiVM {
  id: string;
  label: string;
  value: string;
  deltaText?: string;
  deltaTone: DeltaTone;
  hero: boolean;
  spark?: number[];
}
export interface BarVM {
  name: string;
  valueText: string;
  ratio: number;
  tone: "iris" | "warn";
}
export interface AlertVM {
  title: string;
  explanation: string;
}
export interface InsightVM {
  id: string;
  title: string;
  explanation: string;
  severity: "low" | "medium" | "high";
}
export interface HikerView {
  alert: AlertVM | null;
  kpis: KpiVM[];
  collection: BarVM[];
  aging: BarVM[];
  topCustomers: { columns: string[]; rows: string[][] };
  insights: InsightVM[];
}

/* ---------------- 失败裁决(A1 §0)---------------- */

/**
 * 看板失败态裁决:offline(未连接,warn-soft 零数字)vs error(原文 mono)。
 *  · connector 类 error_code(not_connected|not_ready|not_configured)→ offline。
 *  · 连接层拒绝(Hiker 掉线:WinError 10061 / connection refused / unreachable)→ offline。
 *    现实核对:connector 断开后后端返 error_code='mcp_call_failed' + WinError 10061,
 *    非 connector 类,但语义即「未连接」——故按 message 连接特征收敛为 offline(偏差 D-R5-offline,
 *    对齐 connector offline 的验收预期)。
 *  · 其余(model_not_configured / not_found / 工具参数错等)→ error,如实呈原文。
 */
export function dashboardFailKind(errorCode?: string | null, errorMessage?: string | null): "offline" | "error" {
  const code = errorCode ?? "";
  const msg = errorMessage ?? "";
  // 模型类失败(model_not_configured 等)→ error:看板是代码计算,模型不该阻断,若真失败按错误如实显示。
  if (/model/i.test(code)) return "error";
  if (/not_connected|not_ready|not_configured/i.test(code)) return "offline";
  if (/actively refused|no connection could be made|connection refused|econnrefused|10061|unreachable|failed to establish/i.test(msg)) {
    return "offline";
  }
  return "error";
}

/* ---------------- 显示格式化(真值变换,非改数) ---------------- */

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const num = (v: number | undefined | null): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 去尾零:1248.0 → "1248";182.4 → "182.4" */
const trim1 = (n: number): string => n.toFixed(1).replace(/\.0$/, "");

/** 金额压缩为 ¥万/¥亿(KPI 大数用;设计稿形态 ¥182.4万) */
export function fmtCNYCompact(value: number): string {
  const v = num(value);
  const abs = Math.abs(v);
  if (abs >= 1e8) return `¥${trim1(v / 1e8)}亿`;
  if (abs >= 1e4) return `¥${trim1(v / 1e4)}万`;
  return `¥${Math.round(v).toLocaleString("en-US")}`;
}

/** 台账精度金额(账龄/回款/表格用) */
export function fmtCNYFull(value: number): string {
  return `¥${Math.round(num(value)).toLocaleString("en-US")}`;
}

const isCurrencyUnit = (unit?: string | null): boolean =>
  !!unit && (/¥|cny|rmb|元/i.test(unit));

/** KPI 值:货币 → 压缩;计数(个/家/国)→ 整数 + 单位;其余 → 数 + 单位 */
function fmtKpiValue(value: number, unit?: string | null): string {
  if (isCurrencyUnit(unit)) return fmtCNYCompact(value);
  const v = num(value);
  const n = Number.isInteger(v) ? v.toString() : trim1(v);
  return `${n}${unit ?? ""}`;
}

/* ---------------- Hiker ---------------- */

export function hikerView(snap: HikerSnapshotIn): HikerView {
  // ① 回款风险 AlertBand:仅 >0 的计数进文案
  const overdue = num(snap.risk_overdue_count);
  const dueSoon = num(snap.risk_due_soon_count);
  const riskParts: string[] = [];
  if (overdue > 0) riskParts.push(`已逾期 ${overdue} 笔`);
  if (dueSoon > 0) riskParts.push(`即将到期 ${dueSoon} 笔`);
  const alert: AlertVM | null = riskParts.length
    ? { title: "回款风险", explanation: riskParts.join(" · ") }
    : null;

  // ② KPI 带:hero = kpis[0]
  const kpis: KpiVM[] = arr(snap.kpis).map((k, idx) => ({
    id: k.id ?? "",
    label: k.label ?? "",
    value: fmtKpiValue(num(k.value), k.unit),
    deltaTone: "neutral" as const,
    hero: idx === 0,
  }));

  // ③ 回款进度 MetricBar ×3(对计划额归一)
  const col = snap.collection;
  let collection: BarVM[] = [];
  if (col) {
    const planned = num(col.planned_amount);
    const base = Math.max(1, planned);
    collection = [
      { name: "计划收款", valueText: fmtCNYFull(planned), ratio: planned / base, tone: "iris" },
      { name: "实际收款", valueText: fmtCNYFull(num(col.actual_amount)), ratio: num(col.actual_amount) / base, tone: "iris" },
      { name: "未收款", valueText: fmtCNYFull(num(col.unreceived_amount)), ratio: num(col.unreceived_amount) / base, tone: "warn" },
    ];
  }

  // ④ 账龄桶 MetricBar 列(对最大额归一;逾期桶有额=warn)
  const buckets = arr(snap.aging_buckets);
  const maxBucket = Math.max(1, ...buckets.map((b) => num(b.amount)));
  const aging: BarVM[] = buckets.map((b) => {
    const isOverdue = (b.id ?? "") !== "not_due";
    return {
      name: b.label ?? b.id ?? "",
      valueText: `${num(b.count)} 笔 · ${fmtCNYFull(num(b.amount))}`,
      ratio: num(b.amount) / maxBucket,
      tone: isOverdue && num(b.amount) > 0 ? "warn" : "iris",
    };
  });

  // ⑤ top_customers → ir-table(首列名 + mono 金额列)
  const columns = ["客户", "合同数", "合同额", "计划收款", "实收", "未收"];
  const rows: string[][] = arr(snap.top_customers).map((c) => [
    c.customer_name ?? "",
    num(c.contract_count).toString(),
    fmtCNYCompact(num(c.contract_amount)),
    fmtCNYCompact(num(c.planned_receipt_amount)),
    fmtCNYCompact(num(c.actual_receipt_amount)),
    fmtCNYCompact(num(c.unreceived_amount)),
  ]);

  const insights: InsightVM[] = arr(snap.anomalies).map((a) => ({
    id: a.id ?? "",
    title: a.title ?? "",
    explanation: a.explanation ?? "",
    severity: a.severity ?? "medium",
  }));

  return { alert, kpis, collection, aging, topCustomers: { columns, rows }, insights };
}
