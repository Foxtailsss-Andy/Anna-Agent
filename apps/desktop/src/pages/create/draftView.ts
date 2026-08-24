/**
 * draftView · Create run(CreateDraftRun)→ 呈现模型(纯函数,可 vitest 单测,无 DOM/React)
 *
 * 现状校准(2026-07-10 对 services/create/app/schemas.py + 一条实跑 run):
 *  · CreateArtifact 无 `title` / 无 `content`;内容在 `preview`,标识在 `skill_id/prompt_id/tool_id`。
 *    → 展示名优先取 preview frontmatter 的 `name:`(skill)/`title:`(prompt),回落 *_id,再回落 prompt 摘要。
 *  · status ∈ generating|validating|ready_for_review|saved|failed(非 brief 假设的 draft/activated/failed)。
 *    → ready_for_review=「待激活/草稿」;saved=「已激活」;failed=error_message 原文。
 *  · run id 形如 `create_run_001`(可读),非 6 位哈希 → runTag 取尾号「run 001」,非 create_ 前缀回落首 6。
 * 偏差已在 A1 地图 / 本文件记录;brief 的 draftView 假设按现状弯折。
 */

type Rec = Record<string, unknown>;

const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});

export type PreviewKind = "markdown" | "code" | "text";
export type StatusTone = "ok" | "run" | "fail" | "muted";

export interface DraftView {
  runId: string;
  runTag: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  statusTone: StatusTone;
  errorMessage: string;
  errorCode: string;
  name: string;
  version: string;
  hasArtifact: boolean;
  preview: string;
  previewKind: PreviewKind;
}

export interface HubItem {
  runId: string;
  runTag: string;
  name: string;
  /** 「技能 · v1.0.0 · 待激活」(类型·版本?·状态) */
  metaText: string;
  /** 「来源 Create · run 001」 */
  sourceText: string;
  status: string;
  statusLabel: string;
  statusTone: StatusTone;
  preview: string;
  previewKind: PreviewKind;
}

export interface HubGroup {
  key: string;
  label: string;
  items: HubItem[];
}

const KIND_LABEL: Record<string, string> = {
  skill: "技能",
  prompt: "提示词",
  python_tool: "Python 工具",
};

const STATUS_LABEL: Record<string, string> = {
  generating: "构建中",
  validating: "校验中",
  ready_for_review: "待激活",
  saved: "已激活",
  failed: "构建未通过",
};

const STATUS_TONE: Record<string, StatusTone> = {
  generating: "run",
  validating: "run",
  ready_for_review: "run",
  saved: "ok",
  failed: "fail",
};

/** create_run_001 → "run 001";其余回落首 6 位。 */
export function runTag(id: string): string {
  const m = /_(\d+)$/.exec(id);
  if (m) return `run ${m[1]}`;
  return id ? id.slice(0, 6) : "run —";
}

/**
 * 剥离 preview 首块 YAML frontmatter,取键值对。
 * list 型键(如 `allowed_tools:` 后跟缩进 `  - item` 行,见 orchestrator._skill_markdown)
 * 拼接为 "item1 / item2";键已声明但值/列表为空 → 取 "—"(权限字段"空"是真事实,不可与"键不存在"混同,
 * 键不存在则不入结果 → ledgerLines 不编行)。
 */
function parseFrontmatter(src: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (!value) {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const item = /^\s+-\s*(.*)$/.exec(lines[i + 1]);
        if (!item || !item[1].trim()) break;
        items.push(item[1].trim());
        i++;
      }
      value = items.length > 0 ? items.join("、") : "—";
    }
    out[key] = value;
  }
  return out;
}

/** 剥去 frontmatter 后的正文(用于引用摘录 + markdown 预览;frontmatter 事实已在账本/卡呈现)。 */
export function previewBody(src: string): string {
  return src.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function snippet(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function artifactId(artifact: Rec): string {
  return str(artifact.skill_id) || str(artifact.prompt_id) || str(artifact.tool_id);
}

function draftName(run: Rec, artifact: Rec, preview: string): string {
  const fm = parseFrontmatter(preview);
  const fmName = fm.name || fm.title;
  if (fmName) return fmName;
  const id = artifactId(artifact);
  if (id) return id;
  const prompt = str(run.prompt).trim();
  if (prompt) return prompt.length > 24 ? `${prompt.slice(0, 24)}…` : prompt;
  return "未命名草稿";
}

function previewKindOf(kind: string): PreviewKind {
  if (kind === "python_tool") return "code";
  if (kind === "skill" || kind === "prompt") return "markdown";
  return "text";
}

export function toDraftView(run: Rec): DraftView {
  const artifact = rec(run.artifact);
  const hasArtifact = run.artifact !== null && typeof run.artifact === "object";
  const kind = str(artifact.kind) || str(run.kind);
  const status = str(run.status);
  const preview = str(artifact.preview);
  return {
    runId: str(run.id),
    runTag: runTag(str(run.id)),
    kind,
    kindLabel: KIND_LABEL[kind] ?? (kind || "产物"),
    status,
    statusLabel: STATUS_LABEL[status] ?? (status || "未知"),
    statusTone: STATUS_TONE[status] ?? "muted",
    errorMessage: str(run.error_message),
    errorCode: str(run.error_code),
    name: draftName(run, artifact, preview),
    version: parseFrontmatter(preview).version ?? "",
    hasArtifact,
    preview,
    previewKind: previewKindOf(kind),
  };
}

/** name/title/version 已在别处呈现(展示名 / 版本号),账本额外行跳过,避免重复。 */
const LEDGER_CONSUMED_KEYS = new Set(["name", "title", "version"]);

/**
 * frontmatter 中除展示名/版本外的其余键(权限字段 allowed_tools/forbidden_tools、
 * description/owner/domain 等元信息)→ 原样入账本(mono 真值行,键存在才编,一字不改)。
 */
function frontmatterLedgerLines(preview: string): string[] {
  return Object.entries(parseFrontmatter(preview))
    .filter(([key]) => !LEDGER_CONSUMED_KEYS.has(key))
    .map(([key, value]) => `${key}: ${value}`);
}

/** 构建账本行(全真值,mono 深色面板)。 */
export function ledgerLines(run: Rec): string[] {
  const v = toDraftView(run);
  const lines: string[] = [];
  lines.push(`${v.runTag} · ${v.name} · ${v.statusLabel}`);
  lines.push(`kind: ${v.kind || "—"}`);
  const id = artifactId(rec(run.artifact));
  if (id) lines.push(`id: ${id}`);
  lines.push(`artifacts ${v.hasArtifact ? 1 : 0}${v.version ? ` · v${v.version}` : ""}`);
  lines.push(...frontmatterLedgerLines(v.preview));
  const evidence = evidenceLine(run);
  if (evidence) lines.push(evidence);
  lines.push("──");
  lines.push(statusDetail(v));
  return lines;
}

/* ================= C3 · 产出校验卡(校对基准 P-07;行=真字段,缺省不编) ================= */

export interface VerificationRow {
  ok: boolean;
  text: string;
}

/**
 * CreateRun 三个真校验面 → 校验卡行:
 *   validation(valid/errors)· sandbox_result(passed/exit_code)· activation_eligibility。
 * 字段为 null → 不出行(诚实);全 null → 返回 [](卡不渲染)。
 */
export function verificationRows(run: Rec): VerificationRow[] {
  const rows: VerificationRow[] = [];
  const validation = run.validation;
  if (validation !== null && typeof validation === "object") {
    const val = validation as Rec;
    const errors = Array.isArray(val.errors) ? (val.errors as unknown[]).map((e) => String(e)) : [];
    const ok = val.valid !== false;
    rows.push({ ok, text: ok ? "读回校验通过" : `读回校验未通过：${errors.join("；") || "见错误"}` });
  }
  const sandbox = run.sandbox_result;
  if (sandbox !== null && typeof sandbox === "object") {
    const sb = sandbox as Rec;
    const ok = sb.passed === true;
    const exit = typeof sb.exit_code === "number" ? ` · exit ${sb.exit_code}` : "";
    rows.push({ ok, text: `沙箱评测 ${ok ? "通过" : "未通过"}${exit}` });
  }
  const elig = run.activation_eligibility;
  if (elig !== null && typeof elig === "object") {
    const el = elig as Rec;
    const ok = el.activation_allowed === true;
    const reasons = Array.isArray(el.blocking_reasons)
      ? (el.blocking_reasons as unknown[]).map((r) => String(r))
      : [];
    rows.push({ ok, text: ok ? "激活资格 · ready" : `激活受限 · ${reasons.join("、") || "见原因"}` });
  }
  return rows;
}

/** 礼成条真值:瞬间数 = audit_events 条数;时长 = 首末 created_at 差(无则空)。 */
export function ceremonyFacts(run: Rec): { moments: number; durationText: string } {
  const evs = Array.isArray(run.audit_events) ? (run.audit_events as Rec[]) : [];
  const ts = evs.map((e) => Date.parse(str(e.created_at))).filter((n) => !Number.isNaN(n));
  const durationText = ts.length >= 2 ? `${((Math.max(...ts) - Math.min(...ts)) / 1000).toFixed(1)}s` : "";
  return { moments: evs.length, durationText };
}

/** 校验 / 沙箱真证据(有才出)。 */
function evidenceLine(run: Rec): string {
  const validation = run.validation;
  if (validation !== null && typeof validation === "object") {
    const val = validation as Rec;
    const errors = Array.isArray(val.errors) ? (val.errors as unknown[]).map((e) => String(e)) : [];
    return val.valid === false
      ? `校验未通过：${errors.join("；") || "见错误"}`
      : "读回校验通过";
  }
  const sandbox = run.sandbox_result;
  if (sandbox !== null && typeof sandbox === "object") {
    const sb = sandbox as Rec;
    const exit = typeof sb.exit_code === "number" ? ` · exit ${sb.exit_code}` : "";
    return `沙箱 ${sb.passed ? "通过" : "未通过"}${exit}`;
  }
  return "";
}

function statusDetail(v: DraftView): string {
  switch (v.status) {
    case "ready_for_review":
      return "草稿 · 待激活";
    case "saved":
      return "已激活 · 已落库";
    case "failed":
      return v.errorMessage || v.errorCode || "构建未通过";
    case "generating":
      return "构建中 · 请稍候";
    case "validating":
      return "校验中";
    default:
      return v.statusLabel;
  }
}

/** run 列表 → 产物网格卡(仅含 artifact 的 run;无 artifact 的 run 只在 Create 历史可见)。 */
export function hubItems(runs: Rec[]): HubItem[] {
  return runs
    .filter((run) => run.artifact !== null && typeof run.artifact === "object")
    .map((run) => {
      const v = toDraftView(run);
      const metaText = [v.kindLabel, v.version ? `v${v.version}` : "", v.statusLabel]
        .filter(Boolean)
        .join(" · ");
      return {
        runId: v.runId,
        runTag: v.runTag,
        name: v.name,
        metaText,
        sourceText: `来源 Create · ${v.runTag}`,
        status: v.status,
        statusLabel: v.statusLabel,
        statusTone: v.statusTone,
        preview: v.preview,
        previewKind: v.previewKind,
      };
    });
}

/** 按状态分组(已激活 → 草稿 → 其他),仅非空组,固定顺序(PetalDivider 分隔用)。 */
export function groupHubItems(items: HubItem[]): HubGroup[] {
  const saved: HubItem[] = [];
  const draft: HubItem[] = [];
  const other: HubItem[] = [];
  for (const item of items) {
    if (item.status === "saved") saved.push(item);
    else if (item.status === "ready_for_review") draft.push(item);
    else other.push(item);
  }
  return [
    { key: "saved", label: "已激活", items: saved },
    { key: "draft", label: "草稿 · 待激活", items: draft },
    { key: "other", label: "其他", items: other },
  ].filter((g) => g.items.length > 0);
}

/** 「在 Chat 使用」预填(真导航文案)。 */
export function useInChatPrefill(item: HubItem): string {
  return `基于产物《${item.name}》（${item.runTag}）：`;
}

/** 「引用到对话」预填:引言取真内容(剥 frontmatter)首 200 字。 */
export function quotePrefill(item: HubItem): string {
  const body = previewBody(item.preview);
  return `引用《${item.name}》的内容：\n> ${snippet(body, 200)}`;
}
