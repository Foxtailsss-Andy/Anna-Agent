/**
 * useElkLayout · 任务/依赖 → elk graph 输入映射(F2 RED)
 *
 * 契约:分层 LR;任务 188×66(卡点行/溯源行各 +25);门盒 96×92;
 *   rework 回路边不进布局(叠加层画弧,不扰 DAG 分层);
 *   #5:干净 LR(去 aspectRatio/wrapping 强制折返),并行段纵向展开。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import { buildGraph } from "../graphMapping";
import {
  GATE_H,
  GATE_W,
  NOTE_H,
  TASK_H,
  TASK_W,
  countRows,
  nodeSize,
  toElkGraph,
} from "../useElkLayout";

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

describe("nodeSize(设计硬规格)", () => {
  it("任务节点 188×66", () => {
    const g = buildGraph({ tasks: [task()] }, null);
    expect(nodeSize(g.nodes[0])).toEqual({ width: TASK_W, height: TASK_H });
    expect(TASK_W).toBe(188);
    expect(TASK_H).toBe(66);
  });

  it("阻塞带卡点行 +25;频道生长溯源行 +25", () => {
    const stuck = task({ status: "blocked", blocker: "测试库权限未开通" });
    const grown = task({ origin: "channel", created_from_message_id: "m1" });
    const g = buildGraph({ tasks: [stuck, grown] }, null);
    const s = g.nodes.find((x) => x.id === stuck.id)!;
    const gr = g.nodes.find((x) => x.id === grown.id)!;
    expect(nodeSize(s).height).toBe(TASK_H + NOTE_H);
    expect(nodeSize(gr).height).toBe(TASK_H + NOTE_H);
    expect(NOTE_H).toBe(25);
  });

  it("门节点盒 96×92(菱形 44 rotate45 + 标签两行)", () => {
    const w = task();
    const gate = task({ is_gate: true, depends_on: [w.id], reviews_task_id: w.id, status: "blocked" });
    const g = buildGraph({ tasks: [w, gate] }, null);
    const gn = g.nodes.find((x) => x.id === gate.id)!;
    expect(nodeSize(gn)).toEqual({ width: GATE_W, height: GATE_H });
    expect(GATE_W).toBe(96);
    expect(GATE_H).toBe(92);
  });
});

describe("toElkGraph(输入映射)", () => {
  it("children 带尺寸;edges 用 sources/targets;id 稳定", () => {
    const a = task({ status: "done" });
    const b = task({ depends_on: [a.id] });
    const g = buildGraph({ tasks: [a, b] }, null);
    const elk = toElkGraph(g);
    expect(elk.children).toHaveLength(2);
    const ca = elk.children.find((c) => c.id === a.id)!;
    expect(ca.width).toBe(TASK_W);
    expect(ca.height).toBe(TASK_H);
    expect(elk.edges).toEqual([
      { id: `${a.id}->${b.id}`, sources: [a.id], targets: [b.id] },
    ]);
  });

  it("rework 回路边不进布局(叠加层画上弧)", () => {
    const w = task({ status: "rework" });
    const gate = task({ is_gate: true, status: "blocked", depends_on: [w.id], reviews_task_id: w.id });
    const g = buildGraph({ tasks: [w, gate] }, null);
    expect(g.edges.some((e) => e.kind === "rework")).toBe(true);
    const elk = toElkGraph(g);
    expect(elk.edges.some((e) => e.id.startsWith("rework:"))).toBe(false);
  });

  it("layoutOptions:layered + RIGHT + 干净分层(#5 去强制折返)", () => {
    const g = buildGraph({ tasks: [task()] }, null);
    const opts = toElkGraph(g).layoutOptions;
    expect(opts["elk.algorithm"]).toBe("layered");
    expect(opts["elk.direction"]).toBe("RIGHT");
    // #5:不再强制折返(aspectRatio/wrapping 会把线性链折出大幅斜跨回边,像断了)
    expect(opts["elk.layered.wrapping.strategy"]).toBeUndefined();
    expect(opts["elk.aspectRatio"]).toBeUndefined();
    // 边尽量水平对齐 + 并行分支不打结
    expect(opts["elk.layered.nodePlacement.strategy"]).toBe("BRANDES_KOEPF");
    expect(opts["elk.layered.crossingMinimization.strategy"]).toBeTruthy();
  });

  it("并行 DAG(设计稿 ∥ 技术预研 → 多父门就绪)→ elk 输入含分叉与汇合", () => {
    // PRD 评审(done)→ 设计稿 ∥ 技术预研 → 设计评审门(依赖两者)
    const prdGate = task({ is_gate: true, status: "done" });
    const design = task({ depends_on: [prdGate.id] });
    const research = task({ depends_on: [prdGate.id] });
    const designGate = task({
      is_gate: true,
      status: "blocked",
      depends_on: [design.id, research.id],
      reviews_task_id: design.id,
    });
    const g = buildGraph({ tasks: [prdGate, design, research, designGate] }, null);
    const elk = toElkGraph(g);
    // 分叉:prdGate 出两条边(→ 设计稿 / → 技术预研)纵向展开
    expect(elk.edges.filter((e) => e.sources[0] === prdGate.id)).toHaveLength(2);
    // 汇合:设计评审门收两条边(多父就绪)
    expect(elk.edges.filter((e) => e.targets[0] === designGate.id)).toHaveLength(2);
  });
});

describe("countRows(底栏「N 行」= 非门节点 y 聚类)", () => {
  it("同一水平带算一行,跨带算多行;门不计", () => {
    const a = task();
    const b = task();
    const c = task();
    const gate = task({ is_gate: true, depends_on: [a.id], reviews_task_id: a.id, status: "blocked" });
    const g = buildGraph({ tasks: [a, b, c, gate] }, null);
    const pos = new Map([
      [a.id, { x: 0, y: 100 }],
      [b.id, { x: 240, y: 112 }],   // 同带(容差内)
      [c.id, { x: 0, y: 420 }],     // 第二行
      [gate.id, { x: 480, y: 400 }] // 门不计行
    ]);
    expect(countRows(g.nodes, pos)).toBe(2);
  });

  it("空图 → 0 行", () => {
    const g = buildGraph({ tasks: [] }, null);
    expect(countRows(g.nodes, new Map())).toBe(0);
  });
});
