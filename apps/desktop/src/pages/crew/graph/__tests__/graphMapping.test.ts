/**
 * graphMapping · 后端项目 → 图语汇(七态/门三态/边三型/供电流)纯函数(F2 RED)
 *
 * 七态映射契约(00-master-plan Task F2,以 schemas.py TaskStatus 实名为准):
 *   待就绪 pending = blocked 且依赖未满足(recompute 未 ready)
 *   就绪 ready     = todo(后端不变量:todo 即依赖已满足)/ assigned(已认领未开始)
 *   执行中 running = running
 *   待审 review    = submitted | in_review
 *   阻塞 blocked   = blocked 且(带 blocker 卡点 或 依赖已全完却停滞)
 *   返工 rework    = rework
 *   完成 done      = done
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import {
  agentActiveCount,
  agentRunningCount,
  artifactBadge,
  blockedCount,
  buildGraph,
  gateVisual,
  isTaskActive,
  nodePrimaryAction,
  nodeStateClass,
  roleColorSlug,
  statusWord,
  taskVisual,
} from "../graphMapping";

let n = 0;
const task = (over: Partial<CrewTask> = {}): CrewTask => ({
  id: `t${++n}`,
  project_id: "p1",
  key: `k${n}`,
  title: `任务${n}`,
  status: "todo",
  role_required: "产品",
  depends_on: [],
  is_gate: false,
  origin: "sop",
  ...over,
});

const byId = (tasks: CrewTask[]) => new Map(tasks.map((t) => [t.id, t]));

describe("taskVisual 七态映射(含 ready 推导)", () => {
  it("todo → ready;assigned → ready(就绪族,认领位由 assignee 区分)", () => {
    const t1 = task({ status: "todo" });
    const t2 = task({ status: "assigned", assignee_member_id: "acc_andy" });
    const m = byId([t1, t2]);
    expect(taskVisual(t1, m)).toBe("ready");
    expect(taskVisual(t2, m)).toBe("ready");
  });

  it("running → running;submitted/in_review → review;rework → rework;done → done", () => {
    const m = byId([]);
    expect(taskVisual(task({ status: "running" }), m)).toBe("running");
    expect(taskVisual(task({ status: "submitted" }), m)).toBe("review");
    expect(taskVisual(task({ status: "in_review" }), m)).toBe("review");
    expect(taskVisual(task({ status: "rework" }), m)).toBe("rework");
    expect(taskVisual(task({ status: "done" }), m)).toBe("done");
  });

  it("blocked + 依赖未完 + 无 blocker → pending(待就绪,不是真阻塞)", () => {
    const dep = task({ status: "running" });
    const t = task({ status: "blocked", depends_on: [dep.id] });
    expect(taskVisual(t, byId([dep, t]))).toBe("pending");
  });

  it("blocked + blocker 卡点 → blocked(真阻塞,原因随卡直陈)", () => {
    const dep = task({ status: "running" });
    const t = task({ status: "blocked", depends_on: [dep.id], blocker: "测试库权限未开通" });
    expect(taskVisual(t, byId([dep, t]))).toBe("blocked");
  });

  it("blocked + 依赖全完(应就绪却停滞)→ blocked", () => {
    const dep = task({ status: "done" });
    const t = task({ status: "blocked", depends_on: [dep.id] });
    expect(taskVisual(t, byId([dep, t]))).toBe("blocked");
  });
});

describe("gateVisual 门三态", () => {
  it("blocked → dormant(待就绪门,含被驳回后等返工)", () => {
    expect(gateVisual(task({ is_gate: true, status: "blocked" }))).toBe("dormant");
  });
  it("done → passed", () => {
    expect(gateVisual(task({ is_gate: true, status: "done" }))).toBe("passed");
  });
  it("todo/assigned/in_review → active(金线)", () => {
    expect(gateVisual(task({ is_gate: true, status: "todo" }))).toBe("active");
    expect(gateVisual(task({ is_gate: true, status: "assigned" }))).toBe("active");
    expect(gateVisual(task({ is_gate: true, status: "in_review" }))).toBe("active");
  });
});

describe("buildGraph 边三型 + 供电流", () => {
  it("依赖边:源 done → powered,否则 dormant(5 4 虚线)", () => {
    const a = task({ status: "done" });
    const b = task({ status: "running", depends_on: [a.id] });
    const c = task({ status: "blocked", depends_on: [b.id] });
    const g = buildGraph({ tasks: [a, b, c] }, null);
    const ab = g.edges.find((e) => e.source === a.id && e.target === b.id);
    const bc = g.edges.find((e) => e.source === b.id && e.target === c.id);
    expect(ab?.kind).toBe("powered");
    expect(bc?.kind).toBe("dormant");
  });

  it("返工回路:被评审任务 rework 时存在 gate→task 的 rework 边;通过后消隐(不留疤)", () => {
    const work = task({ status: "rework", blocker: "验收口径缺失" });
    const gate = task({ is_gate: true, status: "blocked", depends_on: [work.id], reviews_task_id: work.id });
    const g1 = buildGraph({ tasks: [work, gate] }, null);
    const loop = g1.edges.find((e) => e.kind === "rework");
    expect(loop).toBeTruthy();
    expect(loop?.source).toBe(gate.id);
    expect(loop?.target).toBe(work.id);

    const work2 = { ...work, status: "done" };
    const gate2 = { ...gate, status: "done" };
    const g2 = buildGraph({ tasks: [work2, gate2] }, null);
    expect(g2.edges.find((e) => e.kind === "rework")).toBeUndefined();
  });

  it("供电流:全图唯一 flow 边=焦点执行节点的第一条已通电入边;无焦点 → 无 flow", () => {
    const a = task({ status: "done" });
    const b = task({ status: "done" });
    const focus = task({ status: "running", depends_on: [a.id, b.id] });
    const other = task({ status: "running", depends_on: [a.id] });
    const g = buildGraph({ tasks: [a, b, focus, other] }, focus.id);
    const flows = g.edges.filter((e) => e.kind === "flow");
    expect(flows).toHaveLength(1);
    expect(flows[0].source).toBe(a.id);
    expect(flows[0].target).toBe(focus.id);

    const gNone = buildGraph({ tasks: [a, b, focus, other] }, null);
    expect(gNone.edges.filter((e) => e.kind === "flow")).toHaveLength(0);
  });

  it("焦点是根节点(无入边)→ 无 flow(不装忙)", () => {
    const root = task({ status: "running" });
    const g = buildGraph({ tasks: [root] }, root.id);
    expect(g.edges.filter((e) => e.kind === "flow")).toHaveLength(0);
  });

  it("reviewLive:活跃门 ← 其被评审任务 的入边高亮(亮但不流动)", () => {
    const work = task({ status: "done" });
    const gate = task({ is_gate: true, status: "todo", depends_on: [work.id], reviews_task_id: work.id });
    const g = buildGraph({ tasks: [work, gate] }, null);
    const e = g.edges.find((x) => x.source === work.id && x.target === gate.id);
    expect(e?.kind).toBe("reviewLive");
  });

  it("counts:taskCount=非门数,gateCount=门数", () => {
    const a = task();
    const gate = task({ is_gate: true, depends_on: [a.id], reviews_task_id: a.id, status: "blocked" });
    const g = buildGraph({ tasks: [a, gate] }, null);
    expect(g.taskCount).toBe(1);
    expect(g.gateCount).toBe(1);
  });
});

describe("健康条计数(F2 精化)", () => {
  it("blockedCount 只数真阻塞(pending 不算,门不算)", () => {
    const dep = task({ status: "running" });
    const pending = task({ status: "blocked", depends_on: [dep.id] });
    const stuck = task({ status: "blocked", blocker: "权限未开通" });
    const gateDormant = task({ is_gate: true, status: "blocked", depends_on: [dep.id] });
    expect(blockedCount([dep, pending, stuck, gateDormant])).toBe(1);
  });

  it("agentRunningCount 只数 assignee 为 agent 的 running 任务", () => {
    const members = [
      { id: "acc_boss", kind: "human" },
      { id: "acc_agent_design", kind: "agent" },
    ];
    const byAgent = task({ status: "running", assignee_member_id: "acc_agent_design" });
    const byHuman = task({ status: "running", assignee_member_id: "acc_boss" });
    const idle = task({ status: "todo" });
    expect(agentRunningCount([byAgent, byHuman, idle], members)).toBe(1);
  });
});

describe("statusWord / roleColorSlug", () => {
  it("状态词按七态;done 无状态词(章即语义)", () => {
    expect(statusWord("pending")).toBe("待就绪");
    expect(statusWord("ready")).toBe("就绪");
    expect(statusWord("running")).toBe("执行中");
    expect(statusWord("review")).toBe("待审");
    expect(statusWord("blocked")).toBe("阻塞");
    expect(statusWord("rework")).toBe("返工");
    expect(statusWord("done")).toBe("");
  });

  it("职能点:产品/设计/工程/验收 各归其色;文案归产品族;未知 → other", () => {
    expect(roleColorSlug("产品")).toBe("product");
    expect(roleColorSlug("设计")).toBe("design");
    expect(roleColorSlug("工程")).toBe("eng");
    expect(roleColorSlug("验收")).toBe("accept");
    expect(roleColorSlug("文案")).toBe("product");
    expect(roleColorSlug("神秘职能")).toBe("other");
  });
});

describe("nodePrimaryAction · 节点就地主动作(#2 Asana:状态→唯一主动作)", () => {
  const roster = [
    { id: "andy", kind: "human" },
    { id: "scribe", kind: "agent" },
  ];

  it("todo 未派:有会话身份 → 认领;免登录无身份 → null(认领无处落)", () => {
    const t = task({ status: "todo" });
    expect(nodePrimaryAction(t, "ready", roster, true)).toEqual({
      op: "claim",
      label: "认领",
      tone: "primary",
    });
    expect(nodePrimaryAction(t, "ready", roster, false)).toBeNull();
  });

  it("assigned:人 → 开始;agent → 执行(手动冗余入口)", () => {
    expect(
      nodePrimaryAction(task({ status: "assigned", assignee_member_id: "andy" }), "ready", roster, true)?.op,
    ).toBe("start");
    expect(
      nodePrimaryAction(task({ status: "assigned", assignee_member_id: "scribe" }), "ready", roster, true)?.op,
    ).toBe("execute");
  });

  it("running:人 → 提交;agent → null(它在跑,不塞手动)", () => {
    expect(
      nodePrimaryAction(task({ status: "running", assignee_member_id: "andy" }), "running", roster, true)?.op,
    ).toBe("submit");
    expect(
      nodePrimaryAction(task({ status: "running", assignee_member_id: "scribe" }), "running", roster, true),
    ).toBeNull();
  });

  it("rework:agent → 执行(带批注重跑);人 → 提交", () => {
    expect(
      nodePrimaryAction(task({ status: "rework", assignee_member_id: "scribe" }), "rework", roster, true)?.op,
    ).toBe("execute");
    expect(
      nodePrimaryAction(task({ status: "rework", assignee_member_id: "andy" }), "rework", roster, true)?.op,
    ).toBe("submit");
  });

  it("blocked → 看原因(ghost);pending/review/done → null", () => {
    expect(nodePrimaryAction(task({ status: "blocked", blocker: "库权限未开" }), "blocked", roster, true)).toEqual({
      op: "seeReason",
      label: "看原因",
      tone: "ghost",
    });
    expect(nodePrimaryAction(task({ status: "blocked" }), "pending", roster, true)).toBeNull();
    expect(nodePrimaryAction(task({ status: "in_review" }), "review", roster, true)).toBeNull();
    expect(nodePrimaryAction(task({ status: "done" }), "done", roster, true)).toBeNull();
  });

  it("门:活跃 → 评审(attention,开评审面非就地审批);待就绪/已通过 → null", () => {
    expect(nodePrimaryAction(task({ is_gate: true, status: "in_review" }), "done", roster, true)).toEqual({
      op: "review",
      label: "评审",
      tone: "attention",
    });
    expect(nodePrimaryAction(task({ is_gate: true, status: "blocked" }), "done", roster, true)).toBeNull();
    expect(nodePrimaryAction(task({ is_gate: true, status: "done" }), "done", roster, true)).toBeNull();
  });

  it("assignee 已解绑/幽灵 id → 按人(非 agent)处理(不误判 execute)", () => {
    // assigned 但 assignee 不在花名册 → 视为非 agent → 开始(不给 execute)
    expect(
      nodePrimaryAction(task({ status: "assigned", assignee_member_id: "ghost" }), "ready", roster, true)?.op,
    ).toBe("start");
  });
});

describe("isTaskActive · C1 执行中判定(唯一真源:status running 或在飞)", () => {
  it("status running → true", () => {
    expect(isTaskActive(task({ status: "running" }))).toBe(true);
  });
  it("run_inflight 但 status 非 running(queued/assigned)→ true(在飞即执行中)", () => {
    expect(isTaskActive(task({ status: "assigned", run_inflight: true }))).toBe(true);
    expect(isTaskActive(task({ status: "todo", run_inflight: true }))).toBe(true);
  });
  it("既非 running 又无在飞 → false", () => {
    expect(isTaskActive(task({ status: "assigned" }))).toBe(false);
    expect(isTaskActive(task({ status: "submitted", run_inflight: false }))).toBe(false);
  });
});

describe("taskVisual × C1:在飞任务按执行中呈现", () => {
  it("assigned + run_inflight → running 视觉(色条/流光/章三层统一)", () => {
    const t = task({ status: "assigned", run_inflight: true });
    expect(taskVisual(t, byId([t]))).toBe("running");
  });
  it("无在飞注解时,assigned 仍是 ready(不误报执行中)", () => {
    const t = task({ status: "assigned" });
    expect(taskVisual(t, byId([t]))).toBe("ready");
  });
});

describe("agentActiveCount · 活跃 Agent(含在飞;agentRunningCount 仍只数 status)", () => {
  const members = [
    { id: "boss", kind: "human" },
    { id: "scribe", kind: "agent" },
  ];
  it("在飞 agent 任务(status 未翻 running)计入 active,不计入 running", () => {
    const inflight = task({ status: "assigned", run_inflight: true, assignee_member_id: "scribe" });
    const running = task({ status: "running", assignee_member_id: "scribe" });
    expect(agentActiveCount([inflight, running], members)).toBe(2);
    expect(agentRunningCount([inflight, running], members)).toBe(1);
  });
  it("人执行不冒充 Agent;门不计;无派单不计", () => {
    const human = task({ status: "running", assignee_member_id: "boss" });
    const gate = task({ is_gate: true, status: "running", assignee_member_id: "scribe" });
    const unassigned = task({ status: "running" });
    expect(agentActiveCount([human, gate, unassigned], members)).toBe(0);
  });
});

describe("artifactBadge · 节点产物徽记(有产物 → 最新 vN;无 → null,零捏造)", () => {
  it("版本历史存在 → 最新(最大)版本号", () => {
    const t = task({
      artifact_versions: [
        { version: 1, content: "初稿", submitted_at: "2026-07-20T10:00:00Z" },
        { version: 2, content: "终稿", submitted_at: "2026-07-20T12:00:00Z" },
      ],
    });
    expect(artifactBadge(t)).toEqual({ version: 2 });
  });

  it("仅扁平 artifact(无版本历史)→ v1", () => {
    expect(artifactBadge(task({ artifact: "一段产物正文" }))).toEqual({ version: 1 });
  });

  it("无产物(artifact null / 缺省,且无版本历史)→ null", () => {
    expect(artifactBadge(task({ artifact: null }))).toBeNull();
    expect(artifactBadge(task())).toBeNull();
  });

  it("仅空正文版本(无真产物)→ null(徽记出现 ⟺ 可读到正文)", () => {
    const t = task({
      artifact_versions: [{ version: 1, content: "  ", submitted_at: "2026-07-20T10:00:00Z" }],
    });
    expect(artifactBadge(t)).toBeNull();
  });
});

describe("nodeStateClass · 七态 → 节点根 class(R5 三层状态语言入口)", () => {
  it("七态各出一唯一 class", () => {
    const visuals = ["pending", "ready", "running", "review", "blocked", "rework", "done"] as const;
    const classes = visuals.map((v) => nodeStateClass(v));
    expect(classes).toEqual([
      "crewg-node--pending",
      "crewg-node--ready",
      "crewg-node--running",
      "crewg-node--review",
      "crewg-node--blocked",
      "crewg-node--rework",
      "crewg-node--done",
    ]);
    expect(new Set(classes).size).toBe(7);
  });
});
