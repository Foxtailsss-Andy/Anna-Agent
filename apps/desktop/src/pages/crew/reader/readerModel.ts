/**
 * readerModel · R1 产物阅读器纯逻辑(零捏造:一切派生自真产物元数据)
 *
 * - CanvasView / canvasViewReducer:详情页画布区视图态(图 ↔ 阅读器),
 *   open / switchVersion / back 三迁移;switchVersion 仅在 reader 态生效。
 * - resolveArtifact:任务 + 花名册 + 目标版本 → 阅读器解析(选中版本正文 / 字数 /
 *   产出者 / 提交时刻 / 版本列表);无真产物 → null(调用方降级空态)。
 * - readerBreadcrumb:项目 › 任务 › 产物名(去连续重复,任务名=产物名时不显两遍)。
 * - formatSubmittedAt / formatReaderFooter:mono 页脚「vN · N 字 · 产出者 M · 时刻」。
 */

import type { CrewTask } from "../crewModel";
import { groupThousands } from "../channel/artifactChip";

/* ---------------- 画布视图态(图 ↔ 阅读器) ---------------- */

export type CanvasView =
  | { kind: "graph" }
  | { kind: "reader"; taskId: string; version?: number; gateId?: string };

export type CanvasAction =
  | { type: "openReader"; taskId: string; version?: number; gateId?: string }
  | { type: "switchVersion"; version: number }
  | { type: "backToGraph" };

export const INITIAL_CANVAS_VIEW: CanvasView = { kind: "graph" };

/**
 * 画布视图 reducer(纯):
 * - openReader:进入阅读器(带可选版本;缺省 = 最新;可携 gateId = 对照评审态,
 *   底部钉「通过/驳回」——一屏两键);
 * - switchVersion:仅在阅读器态改版本(图态忽略,不越权造态;保 gateId);
 * - backToGraph:回图(ESC / 回到图 同此)。
 */
export function canvasViewReducer(state: CanvasView, action: CanvasAction): CanvasView {
  switch (action.type) {
    case "openReader":
      return { kind: "reader", taskId: action.taskId, version: action.version, gateId: action.gateId };
    case "switchVersion":
      return state.kind === "reader"
        ? { kind: "reader", taskId: state.taskId, version: action.version, gateId: state.gateId }
        : state;
    case "backToGraph":
      return { kind: "graph" };
    default:
      return state;
  }
}

/* ---------------- 产物解析(选中版本 → 阅读器数据) ---------------- */

export interface ArtifactVersion {
  version: number;
  content: string;
  submitted_at: string;
}

export interface ResolvedArtifact {
  taskId: string;
  taskTitle: string;
  /** 产物名(现数据模型 = 任务标题;deriveArtifactChip 同源) */
  artifactName: string;
  /** 全部非空版本,version 降序(供 vN ⌄ 菜单);扁平 artifact 时为空数组 */
  versions: ArtifactVersion[];
  /** 选中版本号;扁平 artifact(无版本历史)为 null(版本 pill 不渲染) */
  version: number | null;
  content: string;
  /** 字数 = 正文字符数(真实元数据) */
  charCount: number;
  /** 选中版本的提交时刻(ISO 原串);扁平 artifact 无 → null */
  submittedAt: string | null;
  /** 产出者:assignee 显示名 → 缺则职能(role)→ 皆缺 null */
  producer: string | null;
}

interface Roster {
  id: string;
  display_name?: string;
  kind?: string;
}

function resolveProducer(task: CrewTask, members: readonly Roster[]): string | null {
  const mem = task.assignee_member_id
    ? members.find((m) => m.id === task.assignee_member_id)
    : undefined;
  const name = (mem?.display_name ?? "").trim();
  if (name) return name;
  const role = (task.role_required ?? "").trim();
  return role || null;
}

/**
 * 任务 + 花名册 + 目标版本 → 阅读器解析。
 * 优先版本历史(非空正文);requestedVersion 命中则取该版,否则取最新;
 * 无版本历史退化到扁平 `artifact`(version=null);两者皆无 → null(无产物无阅读)。
 */
export function resolveArtifact(
  task: CrewTask | null | undefined,
  members: readonly Roster[],
  requestedVersion?: number,
): ResolvedArtifact | null {
  if (!task) return null;
  const all: ArtifactVersion[] = [...(task.artifact_versions ?? [])]
    .filter((v) => (v.content ?? "").trim() !== "")
    .sort((a, b) => b.version - a.version);
  const taskTitle = (task.title ?? "").trim() || "产物";

  let version: number | null = null;
  let content = "";
  let submittedAt: string | null = null;

  if (all.length > 0) {
    const chosen =
      (requestedVersion != null ? all.find((v) => v.version === requestedVersion) : undefined) ??
      all[0];
    version = chosen.version;
    content = chosen.content;
    submittedAt = (chosen.submitted_at ?? "").trim() || null;
  } else if ((task.artifact ?? "").trim() !== "") {
    content = task.artifact as string;
  } else {
    return null;
  }

  return {
    taskId: task.id,
    taskTitle,
    artifactName: taskTitle,
    versions: all,
    version,
    content,
    charCount: content.length,
    submittedAt,
    producer: resolveProducer(task, members),
  };
}

/* ---------------- 面包屑 / 页脚 ---------------- */

/**
 * 面包屑:项目 › 任务 › 产物名。去空段 + 去连续重复
 * (现数据模型任务名 = 产物名,避免同名连显两遍)。
 */
export function readerBreadcrumb(
  projectName: string,
  taskTitle: string,
  artifactName: string,
): string[] {
  const raw = [projectName, taskTitle, artifactName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const seg of raw) {
    if (out.length === 0 || out[out.length - 1] !== seg) out.push(seg);
  }
  return out;
}

/** ISO → `YYYY-MM-DD HH:MM`(非 ISO 诚实回落原串;空 → 空串)。 */
export function formatSubmittedAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** mono 页脚串「vN · 2,005 字 · 产出者 M · 2026-07-20 16:31」(缺段自动略去)。 */
export function formatReaderFooter(r: {
  version: number | null;
  charCount: number;
  producer: string | null;
  submittedAt: string | null;
}): string {
  const parts: string[] = [];
  if (r.version != null) parts.push(`v${r.version}`);
  parts.push(`${groupThousands(r.charCount)} 字`);
  if (r.producer) parts.push(`产出者 ${r.producer}`);
  const when = formatSubmittedAt(r.submittedAt);
  if (when) parts.push(when);
  return parts.join(" · ");
}

/* ---------------- 评审就绪度(#1 评审等待态) ---------------- */

/** 门 readiness 门槛:父任务已交付 = 状态进入待审/在审/完成任一。 */
const GATE_READY_STATUSES = new Set(["submitted", "in_review", "done"]);

export interface ReviewReadiness {
  /** 全部 depends_on 都已交付 → 可开评(镜像后端门 readiness) */
  ready: boolean;
  /** 尚未交付的父任务标题(按 depends_on 序;供「还差 X 交付后开评」) */
  missing: string[];
}

/**
 * 评审就绪度(镜像后端门 readiness):门的每个 depends_on 都进入
 * {submitted|in_review|done} → ready;否则列出未到位父任务标题(按 depends_on 序)。
 *
 * 用于阅读器评审条「等待态」:双亲门(如设计评审需设计稿 + 技术预研皆交付)只交了
 * 一份时,门休眠、旧逻辑评审条不渲染→用户「点去评审却无评审按钮」;此谓词给出
 * 「还差『技术预研』交付后开评」的诚实解释。悬空依赖(byId 无)跳过(不造)。纯函数。
 */
export function reviewReadiness(
  gate: CrewTask,
  byId: Map<string, CrewTask>,
): ReviewReadiness {
  const missing: string[] = [];
  for (const depId of gate.depends_on ?? []) {
    const dep = byId.get(depId);
    if (!dep) continue; // 悬空依赖不计(与 dependencyChain 同惯例)
    if (!GATE_READY_STATUSES.has(dep.status)) {
      missing.push((dep.title ?? "").trim() || dep.id);
    }
  }
  return { ready: missing.length === 0, missing };
}
