/**
 * graphMapping · 后端项目 → Work Graph 图语汇(纯函数,零捏造)
 *
 * 七态映射(00-master-plan Task F2;以 services/crew/app/schemas.py TaskStatus 实名为准):
 *   pending 待就绪   = blocked 且依赖未满足(recompute_readiness 未 ready)
 *   ready   就绪     = todo(后端不变量:todo 即依赖已满足)| assigned(已认领未开始)
 *   running 执行中   = running
 *   review  待审     = submitted | in_review
 *   blocked 阻塞     = blocked 且(带 blocker 卡点 或 依赖已全完却停滞)
 *   rework  返工     = rework
 *   done    完成     = done
 *
 * 门三态:dormant(blocked)/ active(未完的其余态,金线)/ passed(done)。
 * 边三型 + 供电流:powered 实线 / dormant 虚线 5-4 / rework 回路(驳回时画入,
 *   通过后消隐)/ flow 全图唯一流动(指向焦点执行节点)/ reviewLive(活跃门入边,
 *   亮但不流动 —— 1b「供电边转移」)。
 * 焦点(P1 唯一呼吸):频道事件 seq 最大且 task_id 指向 running 任务;
 *   退化=数组序最后一个 running;无 running → null(零呼吸,不装忙)。
 */

import type { CrewTask } from "../crewModel";

/* ---------------- 类型 ---------------- */

export type TaskVisual =
  | "pending"
  | "ready"
  | "running"
  | "review"
  | "blocked"
  | "rework"
  | "done";

export type GateVisual = "dormant" | "active" | "passed";

export type EdgeKind = "powered" | "dormant" | "flow" | "reviewLive" | "rework";

export interface GraphNode {
  id: string;
  kind: "task" | "gate";
  task: CrewTask;
  /** 非门的七态;门节点也给出底层态(仅供健康计数,渲染走 gate) */
  visual: TaskVisual;
  /** 门三态;非门为 null */
  gate: GateVisual | null;
  /** P1 焦点(唯一呼吸);由 buildGraph 按传入 focusTaskId 标记 */
  focus: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface CrewGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 非门任务数(底栏「节点 N」) */
  taskCount: number;
  /** 门数(底栏「门 N」) */
  gateCount: number;
}

/* ---------------- 七态 / 门三态 ---------------- */

function depsAllDone(task: CrewTask, byId: Map<string, CrewTask>): boolean {
  return (task.depends_on ?? []).every((id) => byId.get(id)?.status === "done");
}

/**
 * C1(精修二轮)执行中判定 —— 唯一真源。
 * 「执行中」= 后端 status==="running" 或路由层在飞注解 run_inflight(queued+running 全程 true)。
 * 节点视觉 / 焦点资格 / 健康计数三处共用此谓词,保证「图 ↔ 频道 ↔ 健康条」三处同源同拍。
 */
export function isTaskActive(task: CrewTask): boolean {
  return task.status === "running" || task.run_inflight === true;
}

/** 非门任务 → 七态(含 ready 推导:blocked 且依赖未满足 = 待就绪,非真阻塞)。 */
export function taskVisual(task: CrewTask, byId: Map<string, CrewTask>): TaskVisual {
  // C1:在飞即执行中 —— 后端 status 尚未翻 running(queued)也按执行中呈现。
  if (isTaskActive(task)) return "running";
  switch (task.status) {
    case "todo":
    case "assigned":
      return "ready";
    case "running":
      return "running";
    case "submitted":
    case "in_review":
      return "review";
    case "rework":
      return "rework";
    case "done":
      return "done";
    case "blocked":
      if (task.blocker || depsAllDone(task, byId)) return "blocked";
      return "pending";
    default:
      // 未知状态按待就绪呈现(诚实降级,不猜进度)
      return "pending";
  }
}

/** 门 → 三态:blocked=待就绪(含被驳回后等返工)/ done=已通过 / 其余=活跃(金线)。 */
export function gateVisual(task: CrewTask): GateVisual {
  if (task.status === "done") return "passed";
  if (task.status === "blocked") return "dormant";
  return "active";
}

/* ---------------- 节点就地主动作(#2 Asana 就地一键) ---------------- */

export type NodeActionOp =
  | "claim"
  | "start"
  | "execute"
  | "submit"
  | "review"
  | "seeReason";

export interface NodePrimaryAction {
  op: NodeActionOp;
  label: string;
  /** primary=iris 实心(推进)· attention=金(评审门)· ghost=次要(看原因) */
  tone: "primary" | "attention" | "ghost";
}

/**
 * 节点唯一主动作(Asana 就地一键):按后端 status × assignee 类型给一个主动作,
 * 无可推进动作 → null(不硬造按钮)。零副作用;`members` 仅用于判 assignee 是否 agent。
 *
 * - 门:活跃 → 「评审」(打开评审面,非就地审批 —— 就地审批仍属 P1 站位);其余 → null。
 * - todo(未派)→ 「认领」(需会话身份 canClaim;桌面免登录无身份 → 无认领处 → null)。
 * - assigned:agent → 「执行」(手动冗余入口,后端已 auto-run)· 人 → 「开始」。
 * - running:人 → 「提交」(开抽屉提交区)· agent → null(它在跑,不塞手动动作)。
 * - rework:agent → 「执行」(带批注重跑)· 人 → 「提交」。
 * - blocked:「看原因」(开轻检视读卡点)。
 * - pending / review / done → null(等依赖 / 等门 / 已干)。
 */
export function nodePrimaryAction(
  task: CrewTask,
  visual: TaskVisual,
  members: readonly { id: string; kind: string }[],
  canClaim: boolean,
): NodePrimaryAction | null {
  if (task.is_gate) {
    return gateVisual(task) === "active"
      ? { op: "review", label: "评审", tone: "attention" }
      : null;
  }
  const assignee = task.assignee_member_id
    ? members.find((m) => m.id === task.assignee_member_id) ?? null
    : null;
  const isAgent = assignee?.kind === "agent";
  switch (visual) {
    case "ready":
      if (task.status === "assigned") {
        return isAgent
          ? { op: "execute", label: "执行", tone: "primary" }
          : { op: "start", label: "开始", tone: "primary" };
      }
      // todo(未派):有会话身份才给认领(认领 = 派给自己)
      return canClaim ? { op: "claim", label: "认领", tone: "primary" } : null;
    case "running":
      return isAgent ? null : { op: "submit", label: "提交", tone: "primary" };
    case "rework":
      return isAgent
        ? { op: "execute", label: "执行", tone: "primary" }
        : { op: "submit", label: "提交", tone: "primary" };
    case "blocked":
      return { op: "seeReason", label: "看原因", tone: "ghost" };
    case "pending":
    case "review":
    case "done":
      return null;
  }
}

/* ---------------- 焦点(P1 唯一呼吸) ---------------- */

interface FocusMessage {
  seq: number;
  task_id: string | null;
  kind: string;
}

/**
 * 唯一呼吸判定:seq 最大且 task_id 指向 running 非门任务的 transition 频道行
 * (event/artifact/review);退化=数组序最后一个 running;无 running → null。
 */
export function deriveFocus(
  tasks: CrewTask[],
  channel: readonly FocusMessage[],
): string | null {
  // C1:焦点资格用同一「执行中」谓词(含在飞),与节点视觉 / 计数同源。
  const running = tasks.filter((t) => !t.is_gate && isTaskActive(t));
  if (running.length === 0) return null;
  const runningIds = new Set(running.map((t) => t.id));
  const hinted = channel
    .filter(
      (m) =>
        m.task_id !== null &&
        m.kind !== "say" &&
        m.kind !== "command" &&
        runningIds.has(m.task_id),
    )
    .sort((a, b) => b.seq - a.seq);
  if (hinted.length > 0) return hinted[0].task_id;
  return running[running.length - 1].id;
}

/* ---------------- 图装配(节点 + 边三型 + 供电流) ---------------- */

/**
 * 项目 → 图。edges 规则:
 * - 每条依赖 dep→task 一条边:源 done → powered,否则 dormant;
 * - target=焦点执行节点的第一条 powered 入边 → flow(全图唯一流动;无焦点无 flow);
 * - target=活跃门 且 source=该门被评审任务 → reviewLive(亮但不流动);
 * - 门 gate 的被评审任务处于 rework → 附加 rework 回路边 gate→task(通过后消隐)。
 */
export function buildGraph(
  project: { tasks: CrewTask[] },
  focusTaskId: string | null,
): CrewGraph {
  const tasks = project.tasks ?? [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const nodes: GraphNode[] = tasks.map((t) => ({
    id: t.id,
    kind: t.is_gate ? "gate" : "task",
    task: t,
    visual: taskVisual(t, byId),
    gate: t.is_gate ? gateVisual(t) : null,
    focus: !t.is_gate && t.id === focusTaskId,
  }));

  const edges: GraphEdge[] = [];
  for (const t of tasks) {
    const activeGate = t.is_gate && gateVisual(t) === "active";
    for (const depId of t.depends_on ?? []) {
      const dep = byId.get(depId);
      if (!dep) continue; // 悬空依赖不画边(不造图)
      let kind: EdgeKind = dep.status === "done" ? "powered" : "dormant";
      if (activeGate && t.reviews_task_id === depId) kind = "reviewLive";
      edges.push({ id: `${depId}->${t.id}`, source: depId, target: t.id, kind });
    }
  }

  // 供电流:焦点的第一条 powered 入边升格为 flow(唯一;根节点无入边则无流动)
  if (focusTaskId && byId.has(focusTaskId)) {
    const incoming = edges.find(
      (e) => e.target === focusTaskId && e.kind === "powered",
    );
    if (incoming) incoming.kind = "flow";
  }

  // 返工回路:gate → 被评审任务(任务 rework 时存在;通过后自然消失,不留疤)
  for (const gate of tasks) {
    if (!gate.is_gate || !gate.reviews_task_id) continue;
    const reviewed = byId.get(gate.reviews_task_id);
    if (reviewed && reviewed.status === "rework") {
      edges.push({
        id: `rework:${gate.id}->${reviewed.id}`,
        source: gate.id,
        target: reviewed.id,
        kind: "rework",
      });
    }
  }

  const gateCount = tasks.filter((t) => t.is_gate).length;
  return { nodes, edges, taskCount: tasks.length - gateCount, gateCount };
}

/* ---------------- 状态词 / 职能点 ---------------- */

const STATUS_WORDS: Record<TaskVisual, string> = {
  pending: "待就绪",
  ready: "就绪",
  running: "执行中",
  review: "待审",
  blocked: "阻塞",
  rework: "返工",
  done: "", // 完成无状态词 —— 章(实心勾)即语义
};

export function statusWord(visual: TaskVisual): string {
  return STATUS_WORDS[visual];
}

/**
 * 七态 → 节点根 class(R5 三层状态语言的单一入口:左缘 5px 色条 / 卡面轻染 / 20px 章
 * 皆由 crewg-node--{visual} 驱动)。TaskNode 消费;测试锁定七态各出一唯一类。
 */
export function nodeStateClass(visual: TaskVisual): string {
  return `crewg-node--${visual}`;
}

export type RoleSlug = "product" | "design" | "eng" | "accept" | "other";

/**
 * 职能点 4px 色族(1a/1c):产品 #55589E · 设计 #9C56B8 · 工程 #3E9C82 · 验收 #B98A2F。
 * 文案归产品族(设计稿 1a 将 PRD 起草〔Agent·Scribe/文案〕的职能点画为产品色;
 * 设计只定义四色,不新增色相 —— 偏差登记)。未知职能 → other(墨灰,不猜)。
 */
export function roleColorSlug(role: string): RoleSlug {
  switch ((role ?? "").trim()) {
    case "产品":
    case "文案":
      return "product";
    case "设计":
      return "design";
    case "工程":
      return "eng";
    case "验收":
      return "accept";
    default:
      return "other";
  }
}

/* ---------------- 健康条计数(F2 精化) ---------------- */

/** 真阻塞任务数(七态 blocked;pending 待就绪不算,门不算)。 */
export function blockedCount(tasks: CrewTask[]): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => !t.is_gate && taskVisual(t, byId) === "blocked").length;
}

/** 「Agent 执行中」= assignee 为 agent 成员的 running 任务数(人执行不冒充 Agent)。 */
export function agentRunningCount(
  tasks: CrewTask[],
  members: readonly { id: string; kind: string }[],
): number {
  const agentIds = new Set(members.filter((m) => m.kind === "agent").map((m) => m.id));
  return tasks.filter(
    (t) =>
      !t.is_gate &&
      t.status === "running" &&
      t.assignee_member_id != null &&
      agentIds.has(t.assignee_member_id),
  ).length;
}

/**
 * 「活跃 Agent」= assignee 为 agent 的**执行中**(C1:status running 或在飞)任务数。
 * 供健康条「活跃 Agent N」(C1 三处同源:图流光节点 ↔ 频道活动行 ↔ 健康条计数)。
 * 与 agentRunningCount 的区别:后者仅 status==="running"(保留兼容),本函数并数在飞。
 */
export function agentActiveCount(
  tasks: CrewTask[],
  members: readonly { id: string; kind: string }[],
): number {
  const agentIds = new Set(members.filter((m) => m.kind === "agent").map((m) => m.id));
  return tasks.filter(
    (t) =>
      !t.is_gate &&
      isTaskActive(t) &&
      t.assignee_member_id != null &&
      agentIds.has(t.assignee_member_id),
  ).length;
}

/* ---------------- 审计溯源(门通过时刻 / 频道生长 #a) ---------------- */

interface AuditEventLike {
  type?: unknown;
  payload?: unknown;
  created_at?: unknown;
}

/** HH:MM(解析失败 → null,不猜时间)。 */
function hhmm(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 门通过时刻:audit_events 中 type=crew.task.review 且 payload.task_id=门 id 且
 * approved=true 的最后一条 → HH:MM;找不到 → null(mono 只写「已通过」)。
 */
export function gatePassedTime(
  project: { audit_events?: Record<string, unknown>[] },
  gateId: string,
): string | null {
  const events = (project.audit_events ?? []) as AuditEventLike[];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== "crew.task.review") continue;
    const p = ev.payload as { task_id?: unknown; approved?: unknown } | undefined;
    if (p?.task_id === gateId && p?.approved === true) return hhmm(ev.created_at);
  }
  return null;
}

/**
 * 「由频道生长 · #aN」溯源:task.created_from_message_id → 频道行 audit_ref。
 * 无法回链或行无审计号 → null(只写「由频道生长」,不编号)。
 */
export function originAuditRef(
  task: CrewTask,
  channel: readonly { id: string; audit_ref: string }[],
): string | null {
  if (task.origin !== "channel" || !task.created_from_message_id) return null;
  const msg = channel.find((m) => m.id === task.created_from_message_id);
  return msg?.audit_ref ? msg.audit_ref : null;
}

/* ---------------- 产物徽记(节点近读:有产物 → vN) ---------------- */

/**
 * 节点产物徽记(O-C:「频道文档 ↔ 图节点」双向打通的图侧半 —— 节点显示「有产物 · vN」)。
 * 有产物 → 最新版本号 {version:N};无产物 → null(零捏造:无产物不显徽记)。
 * 口径与 readerModel.resolveArtifact 同源,保证「徽记出现」⟺「频道/抽屉能读到正文」:
 *   ①版本历史优先(仅计非空正文版本,取最大 version)
 *   ②退化扁平 artifact(非空 → v1)
 *   ③皆无 → null
 */
export function artifactBadge(task: CrewTask): { version: number } | null {
  const versions = (task.artifact_versions ?? []).filter(
    (v) => (v.content ?? "").trim() !== "",
  );
  if (versions.length > 0) {
    return { version: Math.max(...versions.map((v) => v.version)) };
  }
  if ((task.artifact ?? "").trim() !== "") return { version: 1 };
  return null;
}
