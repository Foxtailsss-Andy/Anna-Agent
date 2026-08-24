/**
 * inspectModel · 轻检视 / 抽屉的纯函数与类型(零捏造:一切来自后端真事件)
 *
 * F4 契约(TDD 先行):
 * - selectPopoverCard:节点 → 双卡态(执行中=Agent 执行白盒 / 其余=待就绪档案白盒)。
 * - drawerOps / popoverOps:操作组随七态映射(1h 底注 + 2a 双卡)。
 * - computePopoverPosition:锚节点上方,近缘自动翻转,水平居中夹逼(2a「永不遮节点」)。
 * - estimateRemaining:进度估算「按同类均值,非承诺」——无历史 → null(只显已耗时)。
 * - dependencyChain / pendingGateCount:人任务「为什么没开始 · 还差 n 道门」依赖链推导。
 * - resolveConsensusHits:memory_hits(id 列)→ 项目共识条目(渲染「[口径] …」chips)。
 * - traceProgress:frames 真算 回合 N · 步骤 M(不造总数)。
 */

import type { CrewTask } from "../crewModel";
import { gateVisual, type GateVisual, type TaskVisual } from "../graph/graphMapping";
import { statusWordCn } from "./friendlyError";

/* ---------------- 双卡态选择 ---------------- */

export type PopoverCard = "live" | "dossier";

/**
 * 双卡:执行中 → Agent 执行白盒(live,回合/步骤/正在/输入·产出);
 * 其余七态 → 待就绪档案白盒(dossier,依赖链/执行者/届时注入)。
 */
export function selectPopoverCard(visual: TaskVisual): PopoverCard {
  return visual === "running" ? "live" : "dossier";
}

/* ---------------- 操作组(状态映射) ---------------- */

export type OpId =
  | "claim"
  | "start"
  | "submit"
  | "execute"
  | "noTime"
  | "toReview"
  | "reassign"
  | "preclaim"
  | "seeDeps"
  | "fullDossier"
  | "toChannel";

export type OpVariant = "primary" | "default" | "danger";

export interface OpButton {
  id: OpId;
  label: string;
  variant: OpVariant;
}

/**
 * 抽屉底部操作组随状态(1h 底注:就绪=认领/开始 · 执行=提交/没空 · 待审=去评审/改派)。
 * pending=提前认领/看依赖(2a 右卡);blocked=改派/没空;done=无操作(墨迹已干)。
 * 署名行的「改派」独立常驻(不在此列)。
 */
export function drawerOps(visual: TaskVisual): OpButton[] {
  switch (visual) {
    case "ready":
      return [
        { id: "claim", label: "认领", variant: "primary" },
        { id: "start", label: "开始", variant: "default" },
      ];
    case "running":
      return [
        { id: "submit", label: "提交", variant: "primary" },
        { id: "noTime", label: "没空", variant: "default" },
      ];
    case "rework":
      return [
        { id: "submit", label: "提交", variant: "primary" },
        { id: "noTime", label: "没空", variant: "default" },
      ];
    case "review":
      return [
        { id: "toReview", label: "去评审", variant: "primary" },
        { id: "reassign", label: "改派", variant: "default" },
      ];
    case "pending":
      return [
        { id: "preclaim", label: "提前认领", variant: "primary" },
        { id: "seeDeps", label: "看依赖", variant: "default" },
      ];
    case "blocked":
      return [
        { id: "reassign", label: "改派", variant: "default" },
        { id: "noTime", label: "没空", variant: "default" },
      ];
    case "done":
      return [];
  }
}

/**
 * 评审门专属操作组(可用性收束):门是「裁定」不是「干活」——任何入口都
 * 只给一个动作。活跃 → 去评审;待就绪 → 看依赖(为什么还没轮到);已通过 → 无。
 * (真机事故:门曾走 drawerOps 的 ready 分支被「认领→开始→提交」一路误导。)
 */
export function gateOps(gv: GateVisual): OpButton[] {
  switch (gv) {
    case "active":
      return [{ id: "toReview", label: "去评审", variant: "primary" }];
    case "dormant":
      return [{ id: "seeDeps", label: "看依赖", variant: "default" }];
    case "passed":
      return [];
  }
}

/**
 * 抽屉/轻检视操作组统一入口:门走 gateOps,任务走 drawerOps + 双按钮收敛。
 */
export function opsForTask(
  task: CrewTask,
  visual: TaskVisual,
  members: readonly { id: string; kind: string }[],
): OpButton[] {
  if (task.is_gate) return gateOps(gateVisual(task));
  return withAgentRun(drawerOps(visual), canRunAgent(task, members));
}

/* ---------------- Agent 执行(run-agent 显式触发,终审 #1) ---------------- */

/**
 * 该任务可否由 UI 显式「执行」触发 run-agent:
 *   assignee 为 agent-kind 成员 且 task.status ∈ {assigned, rework}
 *   (尚未起跑的已派 / 待返工重跑;门任务与人任务永不可执行)。
 * 纯判定,零副作用 —— canRunAgent 的对象是原始 task.status(非派生七态,因
 * assigned 与 todo 同映射为 ready,但只有 assigned 可执行)。
 */
export function canRunAgent(
  task: CrewTask,
  members: readonly { id: string; kind: string }[],
): boolean {
  if (task.is_gate) return false;
  if (task.status !== "assigned" && task.status !== "rework") return false;
  const assignee = task.assignee_member_id;
  if (!assignee) return false;
  return members.some((m) => m.id === assignee && m.kind === "agent");
}

/**
 * 双按钮收敛(DEV-1 / 诊断 2a):agent 任务(assigned|rework)只给「执行」一个推进入口——
 * 剔除并列的「开始」(那是人动作;陈旧窗口里点它会撞后端 assigned 守卫 400)。
 * 保留非 start 的次级操作(如返工态「没空」);人任务(canRun=false)原样返回,仍留「开始」。
 * 供两处入口(抽屉/轻检视)共用;列表视图走 nodePrimaryAction 已是单动作。
 */
export function withAgentRun(buttons: OpButton[], canRun: boolean): OpButton[] {
  if (!canRun) return buttons;
  const secondary = buttons.filter((b) => b.variant !== "primary" && b.id !== "start");
  return [{ id: "execute", label: "执行", variant: "primary" }, ...secondary];
}

/* ---------------- DEV-1 动作前置校验(陈旧竞态守门) ---------------- */

/** 状态敏感、需在触发前对 FRESH 快照复核可用性的推进动作(auto-pilot 竞态高发区)。 */
export const PRECHECK_OPS = new Set<OpId>(["start", "execute", "submit"]);

export interface OpPrecheck {
  /** true=仍可发;false=陈旧,调用侧提示 message + 刷新,不发 mutation */
  ok: boolean;
  /** 不 ok 时的中文人话(导向刷新) */
  message: string | null;
}

const OK_PRECHECK: OpPrecheck = { ok: true, message: null };

/**
 * DEV-1:动作触发前对 FRESH 快照里的该任务复核可用性(诊断 2a:auto-pilot 已在 3s
 * 轮询窗口内把任务从 assigned 推到 running/submitted,陈旧 UI 的「开始/执行/提交」会撞
 * 后端守卫)。陈旧 → ok:false + 人话;调用侧提示并刷新,mutation 不发。
 *
 * 校验对象是 FRESH 后端原始 status(与 lifecycle.py 守卫同口径):
 *   start   valid ⇔ status ∈ {assigned, rework}(start_task)
 *   execute valid ⇔ canRunAgent(agent + assigned|rework)
 *   submit  valid ⇔ status ∈ {running, rework}(submit_task)
 * 其余 op(认领/改派/说话/导航)不做状态前置校验(default ok)。纯函数,零副作用。
 */
export function precheckOp(
  op: OpId,
  freshTask: CrewTask | undefined,
  members: readonly { id: string; kind: string }[],
): OpPrecheck {
  if (!PRECHECK_OPS.has(op)) return OK_PRECHECK;
  if (!freshTask) {
    return { ok: false, message: "该任务已不在最新快照中——可能已被移除或改派，已为你刷新。" };
  }
  const word = statusWordCn(freshTask.status);
  const stale = (msg: string): OpPrecheck => ({ ok: false, message: msg });
  switch (op) {
    case "start":
      if (freshTask.status === "assigned" || freshTask.status === "rework") return OK_PRECHECK;
      return stale(
        `该任务已${word ? `“${word}”` : "推进"}——无需再“开始”，已为你刷新。`,
      );
    case "execute":
      if (canRunAgent(freshTask, members)) return OK_PRECHECK;
      return stale(
        `该任务当前不可执行${word ? `（已“${word}”）` : ""}——多半 Anna 已自动推进，看看产物或评审。`,
      );
    case "submit":
      if (freshTask.status === "running" || freshTask.status === "rework") return OK_PRECHECK;
      return stale(
        `该任务已${word ? `“${word}”` : "推进"}，不在可提交态——已为你刷新。`,
      );
    default:
      return OK_PRECHECK;
  }
}

/**
 * 轻检视浮层操作组:
 *   live(执行中)= 全档案(转抽屉)/ 去频道(暂停后端无能力,不渲染 —— 偏差登记);
 *   dossier = 复用 drawerOps(visual)(pending=提前认领/看依赖 等)。
 * 两卡右下恒为「Esc / 点空白关闭」mono(非按钮,组件渲染)。
 */
export function popoverOps(card: PopoverCard, visual: TaskVisual): OpButton[] {
  if (card === "live") {
    return [
      { id: "fullDossier", label: "全档案", variant: "primary" },
      { id: "toChannel", label: "去频道", variant: "default" },
    ];
  }
  return drawerOps(visual);
}

/* ---------------- 轻检视定位 + 近缘翻转 ---------------- */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Placement = "above" | "below";

export interface PopoverPosition {
  left: number;
  top: number;
  placement: Placement;
  /** caret 相对 popover 左缘的水平位置(已夹逼在卡内) */
  caretLeft: number;
}

export interface PlacementOpts {
  /** 锚点与浮层的间隙(含 caret 高度) */
  gap?: number;
  /** 视口边距(浮层不贴边) */
  margin?: number;
}

/**
 * 锚节点上方居中弹出;上方不够(近上缘)自动翻转到下方(2a「近缘自动翻转 · 永不遮节点」)。
 * 水平居中并夹逼在视口内;caret 始终指向锚点中心(夹逼在卡内 16px)。
 */
export function computePopoverPosition(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: PlacementOpts = {},
): PopoverPosition {
  const gap = opts.gap ?? 12;
  const margin = opts.margin ?? 12;

  const anchorCx = anchor.left + anchor.width / 2;
  let left = anchorCx - size.width / 2;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  left = Math.min(Math.max(left, margin), maxLeft);

  // 优先上方;上边越界 → 翻转下方
  const aboveTop = anchor.top - size.height - gap;
  let placement: Placement = "above";
  let top = aboveTop;
  if (aboveTop < margin) {
    placement = "below";
    top = anchor.top + anchor.height + gap;
  }

  const caretLeft = Math.min(Math.max(anchorCx - left, 16), size.width - 16);
  return { left, top, placement, caretLeft };
}

/* ---------------- 进度估算(诚实:无历史 → null) ---------------- */

export interface Estimate {
  remainingMs: number;
  sampleSize: number;
  /** 「预计还需 ~Xm · 按同类 N 单均值估算,非承诺」 */
  text: string;
}

function roundMin(ms: number): number {
  return Math.max(1, Math.round(ms / 60000));
}

/**
 * 依据历史同类 run 时长(ms 列)与当前已耗时,估算剩余。
 * 无历史(空列)→ null:调用侧只显已耗时,不渲染估算行(零捏造)。
 */
export function estimateRemaining(
  historyMs: readonly number[],
  elapsedMs: number,
): Estimate | null {
  if (!historyMs || historyMs.length === 0) return null;
  const mean = historyMs.reduce((a, b) => a + b, 0) / historyMs.length;
  const remainingMs = Math.max(0, mean - elapsedMs);
  return {
    remainingMs,
    sampleSize: historyMs.length,
    text: `预计还需 ~${roundMin(remainingMs)}m · 按同类 ${historyMs.length} 单均值估算，非承诺`,
  };
}

/* ---------------- 依赖链推导(还差 n 道门) ---------------- */

export interface ChainNode {
  id: string;
  isGate: boolean;
  /** 链尾 = 本任务 */
  self?: boolean;
}

export interface DependencyChain {
  /** 上游未完节点(远→近)+ 链尾本任务 */
  chain: ChainNode[];
  /** 上游未通过的门数量(「还差 n 道门」) */
  gateCount: number;
}

/**
 * 从本任务沿 depends_on 上溯,收集「未完成」上游节点(status != done),
 * 按首见距离由远及近排列,链尾接本任务。gateCount = 其中的门数(「还差 n 道门」)。
 * 悬空依赖跳过(不造链);DAG 上防重(seen 守卫)。
 */
export function dependencyChain(
  task: CrewTask,
  byId: Map<string, CrewTask>,
): DependencyChain {
  const dist = new Map<string, number>();
  const isGateMap = new Map<string, boolean>();
  const seen = new Set<string>([task.id]);
  const stack: { id: string; d: number }[] = [{ id: task.id, d: 0 }];

  while (stack.length) {
    const { id, d } = stack.pop() as { id: string; d: number };
    const t = byId.get(id);
    if (!t) continue;
    for (const dep of t.depends_on ?? []) {
      const dt = byId.get(dep);
      if (!dt) continue; // 悬空依赖不入链
      if (dt.status !== "done" && !dist.has(dep)) {
        dist.set(dep, d + 1);
        isGateMap.set(dep, !!dt.is_gate);
      }
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push({ id: dep, d: d + 1 });
      }
    }
  }

  const upstream = [...dist.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => ({ id, isGate: !!isGateMap.get(id) }));
  const gateCount = upstream.filter((n) => n.isGate).length;
  const chain: ChainNode[] = [
    ...upstream,
    { id: task.id, isGate: !!task.is_gate, self: true },
  ];
  return { chain, gateCount };
}

/** 「还差 n 道门」= 上游未通过的门数(dependencyChain.gateCount 的独立入口,便于单测)。 */
export function pendingGateCount(task: CrewTask, byId: Map<string, CrewTask>): number {
  return dependencyChain(task, byId).gateCount;
}

/* ---------------- 执行者在手负载(真值) ---------------- */

/** 该成员进行中(running|rework)的任务数（「在手 N」;不含门,不含本任务口径由调用侧决定)。 */
export function inHandCount(memberId: string, tasks: readonly CrewTask[]): number {
  return tasks.filter(
    (t) =>
      !t.is_gate &&
      t.assignee_member_id === memberId &&
      (t.status === "running" || t.status === "rework"),
  ).length;
}

/* ---------------- 共识命中溯源(memory_hits → 条目) ---------------- */

export interface ConsensusLike {
  id: string;
  kind: string;
  text: string;
}

/** memory_hits(item id 列)→ 命中的项目共识条目(按命中顺序;未解析的丢弃,不造)。 */
export function resolveConsensusHits<T extends ConsensusLike>(
  memoryHits: readonly string[],
  items: readonly T[],
): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: T[] = [];
  for (const id of memoryHits) {
    const it = byId.get(id);
    if (it) out.push(it);
  }
  return out;
}

/* ---------------- trace 真值进度(回合 N · 步骤 M) ---------------- */

export interface TraceProgress {
  /** 回合数(index>=1,准备回合 index 0 不计) */
  turnCount: number;
  /** 步骤总数(所有回合 steps 求和) */
  stepCount: number;
}

export function traceProgress(
  turns: readonly { index: number; steps: readonly unknown[] }[],
): TraceProgress {
  return {
    turnCount: turns.filter((t) => t.index >= 1).length,
    stepCount: turns.reduce((n, t) => n + t.steps.length, 0),
  };
}

/* ============================================================
   可用性收束二批(O-A)· 抽屉:交付区 / 验收来源 / 过程可见 / 段编号
   —— 用户二检五问的抽屉侧裁决(07-refine2-devplan §6)。
   ============================================================ */

/**
 * ② 验收标准来源标签(用户二检「基于什么制定?」):
 *   origin==="channel" → Anna 从频道对话起草;其余(sop / undefined)→ SOP 模板。
 *   纯映射,零副作用。
 */
export function criteriaSourceLabel(origin: string | undefined): string {
  return origin === "channel" ? "Anna 起草 · 源自频道" : "来自 SOP 模板";
}

/**
 * ③ 执行过程区可见性(用户二检「执行过程是干什么的?」——只属 Agent 任务):
 *   门(裁定席)永不显;有历史 run_ref → 显(重放历史,改派也留);
 *   否则仅当 assignee 为 agent 成员时显(未跑显「待执行」留位)。
 *   人类任务无 run → 整区隐藏,后续段号动态前移。纯判定。
 */
export function processSectionVisible(
  task: CrewTask,
  members: readonly { id: string; kind: string }[],
  hasRunRef: boolean,
): boolean {
  if (task.is_gate) return false;
  if (hasRunRef) return true;
  const assignee = task.assignee_member_id;
  if (!assignee) return false;
  return members.some((m) => m.id === assignee && m.kind === "agent");
}

/**
 * 段编号动态续:②验收 / ③过程 缺席时后续段号顺次前移
 * (元信息永不在隐藏的「3」后显「4」)。artifact 恒 1;缺席段 → null;meta 恒最后。
 */
export interface SectionNumbers {
  artifact: number;
  criteria: number | null;
  process: number | null;
  meta: number;
}

export function sectionNumbers(opts: {
  hasCriteria: boolean;
  hasProcess: boolean;
}): SectionNumbers {
  let n = 1;
  const artifact = n++;
  const criteria = opts.hasCriteria ? n++ : null;
  const process = opts.hasProcess ? n++ : null;
  const meta = n;
  return { artifact, criteria, process, meta };
}

/**
 * ① 交付区上传校验(用户三检「为什么限制 md/txt?word/html 各类格式也该能读入」):
 *   放开扩展名白名单 —— 收编改为**内容判定**(调用侧读 ArrayBuffer → decodeTextFile,
 *   能干净解码为文本才收)。此处只做两道廉价前置:
 *     ① 已知二进制扩展名(docx/pdf/png…)先短路拒绝(不必读文件,快且清楚);
 *     ② ~1MB 上限。二进制悄悄断 Agent grounding,故诚实拒绝,导向导出文本类。
 *   纯函数,不触碰 FileReader(读取 + 解码副作用留调用侧)。
 */
export const ARTIFACT_UPLOAD_MAX_BYTES = 1024 * 1024;

/** 已知二进制扩展名 —— 读之前即短路,免徒劳解码(比内容判定更快更清楚)。 */
const ARTIFACT_BINARY_EXT = new Set([
  "docx",
  "doc",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "zip",
  "pptx",
  "xlsx",
]);

/** 二进制/无法解码为文本的拒绝人话(扩展名短路 + 内容解码失败共用,口径一致)。 */
export const ARTIFACT_BINARY_REJECT =
  "二进制格式（Word、PDF、图片等）暂不支持——请先导出为 markdown、html、纯文本；附件直传在路上（P1）";

export interface ArtifactFileCheck {
  ok: boolean;
  message: string | null;
}

export function validateArtifactFile(name: string, size: number): ArtifactFileCheck {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  // ① 已知二进制扩展名先拦(不读文件)
  if (ARTIFACT_BINARY_EXT.has(ext)) {
    return { ok: false, message: ARTIFACT_BINARY_REJECT };
  }
  // ② 体积上限(1MB)
  if (size > ARTIFACT_UPLOAD_MAX_BYTES) {
    return { ok: false, message: "文件过大（≤1MB）" };
  }
  return { ok: true, message: null };
}

/**
 * ArrayBuffer → 文本(内容判定,配合放开扩展名后的交付区上传):
 *   UTF-8 严格解码(fatal),失败 → null;解码含 NUL(0x00)判为二进制 → null。
 *   诚实取舍:只收能干净读成文本的正文(markdown / html / 纯文本);gb18030 等中文
 *   编码留 P1(桌面导出多为 UTF-8,过度猜测反而悄悄污染 grounding)。纯函数。
 */
export function decodeTextFile(buf: ArrayBuffer): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null; // 非 UTF-8(多为二进制)
  }
  if (text.includes("\u0000")) return null; // NUL = 二进制信号
  return text;
}
