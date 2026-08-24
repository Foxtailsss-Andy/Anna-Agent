/**
 * egressModel(J4)· GET /api/admin/egress → 「数据出境」卡的呈现映射
 *
 * 这张卡回答的是「我的数据到底会去哪」。它唯一的价值是可信,所以映射层只做一件事:
 * 把后端给的**真**字段翻成中文,后端没给的一律留白 —— 不补默认主机、不把没探过的
 * 目的地画成已连接、不在畸形载荷上造行。宁可显示「未配置」,不可显示一个看起来
 * 很完整但其实是前端编的表。
 *
 * 两条后来补上的纪律:
 *
 * 1. **三条声明也是数据**。「无遥测 / 无训练回传 / 记忆在本机」曾经是卡片里写死的
 *    一句话 —— 那等于前端替后端做了承诺,后端哪天真开了遥测,卡片照样嘴硬。现在
 *    它们从载荷读:后端没给就一个字不说,后端给了不诚实的值就出警示条。
 * 2. **读不到 ≠ 空清单**。`egressRows` 读不到清单返回 `null`(卡片说「读不到」),
 *    能读到但一行没有返回 `[]`(卡片说清单是空的)。两种状态各说各的实话。
 */

type Rec = Record<string, unknown>;

export interface EgressRow {
  id: string;
  label: string;
  /** 真实目的地(已配置)或「未配置」 */
  destinationText: string;
  configured: boolean;
  /** 这个目的地会收到什么(后端未给则空串) */
  categoriesText: string;
  /** 连接态文案:已连接 / 已配置 / 后端原样状态 / 未配置 */
  stateText: string;
  tone: "ok" | "warn" | "off";
}

/** 载荷里的四条标准声明 + 披露版本;后端没给的一律 null,前端绝不补默认值。 */
export interface EgressClaims {
  telemetry: boolean | null;
  trainingFeedback: boolean | null;
  memoryLocation: string | null;
  countsAvailable: boolean | null;
  disclosureVersion: number | null;
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** 清单读不到 → null;读得到 → 只保留形态正确的条目。 */
function destinationsOf(payload: unknown): Rec[] | null {
  if (!isRec(payload)) return null;
  const raw = payload.destinations;
  if (!Array.isArray(raw)) return null;
  return raw.filter(isRec);
}

/**
 * 探针态补位:出境路由**不再自己探连接器**(见 admin_runtime.get_egress_disclosure)
 * —— 一张讲「我只往你配置的端点发数据」的卡片,不该因为被打开就发起六次出境请求。
 * 设置页手上已经有 `/api/admin/runtime/status` 那份真值,这里按 id 取用。
 * 只认三个 MCP:模型 API 没有探针,给它编一个「已连接」就是造假。
 */
const PROBED_IDS = new Set(["reimbursement_mcp", "erp_mcp", "hiker_mcp"]);

function mergedProbe(id: string, runtimeStatus: unknown): string {
  if (!PROBED_IDS.has(id) || !isRec(runtimeStatus)) return "";
  const entry = runtimeStatus[id];
  if (!isRec(entry)) return "";
  return str(entry.status);
}

function toRow(item: Rec, runtimeStatus: unknown): EgressRow {
  const configured = item.configured === true;
  const destination = str(item.destination);
  const id = str(item.id);
  // 后端给了就以后端为准;没给才用状态表补位(两者同源,后端优先只是纪律)。
  const probe = str(item.last_probe_status) || mergedProbe(id, runtimeStatus);
  const categories = Array.isArray(item.data_categories)
    ? item.data_categories.filter((c): c is string => typeof c === "string" && c.length > 0)
    : [];

  let stateText: string;
  let tone: EgressRow["tone"];
  if (!configured) {
    // 没配置就是没配置 —— 既没有主机也没探过,两处都不许出现体面的占位。
    stateText = "未配置";
    tone = "off";
  } else if (probe === "connected") {
    stateText = "已连接";
    tone = "ok";
  } else if (probe) {
    // 探针说了别的(unhealthy / not_configured / …)→ 原样回显,不粉饰。
    stateText = probe;
    tone = "warn";
  } else {
    // 已配置但本就没有探针(模型 API)→ 只声称「已配置」,不谎称连得通。
    stateText = "已配置";
    tone = "ok";
  }

  return {
    id,
    label: str(item.label),
    destinationText: configured && destination ? destination : "未配置",
    configured,
    categoriesText: categories.join(" · "),
    stateText,
    tone,
  };
}

/**
 * 出境清单行。`runtimeStatus` = `/api/admin/runtime/status` 载荷(可选),用于补
 * 三个 MCP 的探针态。读不到清单 → `null`(与「后端给了空清单」区分)。
 */
export function egressRows(payload: unknown, runtimeStatus?: unknown): EgressRow[] | null {
  const items = destinationsOf(payload);
  if (items === null) return null;
  return items.map((item) => toRow(item, runtimeStatus));
}

/** 「n/m 已配置」;无数据时留空(不报 0/0 这种看着像真话的假汇总)。 */
export function egressSummary(payload: unknown): string {
  const items = destinationsOf(payload);
  if (items === null || items.length === 0) return "";
  const configured = items.filter((i) => i.configured === true).length;
  return `${configured}/${items.length} 已配置`;
}

/** 四条声明 + 披露版本的真值读出;载荷读不到 → null。 */
export function egressClaims(payload: unknown): EgressClaims | null {
  if (!isRec(payload)) return null;
  return {
    telemetry: boolOrNull(payload.telemetry),
    trainingFeedback: boolOrNull(payload.training_feedback),
    memoryLocation: strOrNull(payload.memory_location),
    countsAvailable: boolOrNull(payload.counts_available),
    disclosureVersion: numOrNull(payload.disclosure_version),
  };
}

const DESC_LEAD = "Anna 只向下面这些你自己配置的端点发送数据。";

/**
 * 卡片描述:固定的前半句 + **由载荷生成**的声明。
 * 后端没给某条声明 → 那条不出现(不是渲染成「无遥测」);给了不诚实的值 →
 * 如实说出它是什么(并由 `egressWarning` 出警示条)。
 */
export function egressDesc(payload: unknown): string {
  const claims = egressClaims(payload);
  if (claims === null) return "";
  const parts: string[] = [];
  if (claims.telemetry === false) parts.push("无遥测");
  else if (claims.telemetry === true) parts.push("有遥测上报");
  if (claims.trainingFeedback === false) parts.push("无训练回传");
  else if (claims.trainingFeedback === true) parts.push("有训练回传");
  if (claims.memoryLocation === "local") parts.push("记忆全部留在本机");
  else if (claims.memoryLocation !== null) parts.push(`记忆位置：${claims.memoryLocation}`);
  return parts.length ? `${DESC_LEAD}${parts.join("，")}。` : DESC_LEAD;
}

/** 任一声明报出「不诚实」的值 → 醒目警示;全诚实或读不到 → null(不吓唬人)。 */
export function egressWarning(payload: unknown): string | null {
  const claims = egressClaims(payload);
  if (claims === null) return null;
  const broken: string[] = [];
  if (claims.telemetry === true) broken.push("遥测已开启");
  if (claims.trainingFeedback === true) broken.push("训练回传已开启");
  if (claims.memoryLocation !== null && claims.memoryLocation !== "local") {
    broken.push(`记忆存放在 ${claims.memoryLocation}`);
  }
  if (!broken.length) return null;
  return `注意：${broken.join(" · ")} —— 本机之外还有数据流向，请核对运行时配置。`;
}

/** v1 自述范围(披露版本 / 有无逐目的地计数);后端没给 → 留白。 */
export function egressScopeNote(payload: unknown): string {
  const claims = egressClaims(payload);
  if (claims === null) return "";
  const parts: string[] = [];
  if (claims.disclosureVersion !== null) parts.push(`披露 v${claims.disclosureVersion}`);
  if (claims.countsAvailable === false) parts.push("尚无逐目的地计数");
  else if (claims.countsAvailable === true) parts.push("含逐目的地计数");
  return parts.join(" · ");
}
