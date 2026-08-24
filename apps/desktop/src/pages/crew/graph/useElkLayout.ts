/**
 * useElkLayout · elkjs 分层布局(LR,并行段纵向展开,长链保持水平)
 *
 * 纯映射(toElkGraph/nodeSize/countRows)与 hook 分离可测;elkjs 经动态 import
 * 只在浏览器加载(vitest node 环境不拉大包)。
 * #5 修正:去掉 aspectRatio + wrapping 的强制折返 —— 原折返把线性链折成 2~3 行,
 *   产生大幅斜跨回边,视觉「像断了」。改为干净的从左到右分层:并行任务(设计稿 ∥
 *   技术预研)天然纵向展开,长链保持一条水平队列(画布横向平移/缩放消化超宽)。
 *   nodePlacement=BRANDES_KOEPF(边尽量水平对齐,少斜跨)+ crossingMinimization
 *   开(并行分支不打结)+ considerModelOrder(轮询间顺序稳定,少抖动)。
 * rework 回路边不进布局(叠加层画上弧,不扰 DAG 分层)。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { CrewGraph, GraphNode } from "./graphMapping";

/* ---------------- 设计硬尺寸 ---------------- */

/** 任务卡 188×min66(1c:188×66 · r14 · 内边距 11/13)。 */
export const TASK_W = 188;
export const TASK_H = 66;
/** 附加行(阻塞卡点 / 频道生长溯源)每行 +25。 */
export const NOTE_H = 25;
/** 门盒 96×92:菱形 44×44 rotate45(外接 ≈62)+ 标签 + mono 两行。 */
export const GATE_W = 96;
export const GATE_H = 92;

export interface NodePos {
  x: number;
  y: number;
}

export function nodeSize(node: GraphNode): { width: number; height: number } {
  if (node.kind === "gate") return { width: GATE_W, height: GATE_H };
  let height = TASK_H;
  if (node.visual === "blocked" && node.task.blocker) height += NOTE_H;
  if (node.task.origin === "channel") height += NOTE_H;
  return { width: TASK_W, height };
}

/* ---------------- elk 输入映射(纯) ---------------- */

export interface ElkInput {
  id: string;
  layoutOptions: Record<string, string>;
  children: { id: string; width: number; height: number }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

export const ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  // 层间(水平)拉开,层内(纵向:并行分支)略紧凑
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.nodeNode": "38",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  // #5:干净 LR —— 不折返。边尽量水平对齐(少斜跨)、并行分支不打结、顺序稳定。
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]",
};

export function toElkGraph(graph: CrewGraph): ElkInput {
  return {
    id: "crew-graph",
    layoutOptions: ELK_OPTIONS,
    children: graph.nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
    edges: graph.edges
      .filter((e) => e.kind !== "rework")
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
}

/* ---------------- 行数(底栏「N 行」) ---------------- */

const ROW_TOLERANCE = 40;

/** 非门节点按 y 聚类计行(容差 40px;门悬于行间不计)。 */
export function countRows(
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, NodePos>,
): number {
  const ys = nodes
    .filter((n) => n.kind === "task")
    .map((n) => positions.get(n.id)?.y)
    .filter((y): y is number => y !== undefined)
    .sort((a, b) => a - b);
  let rows = 0;
  let bandEnd = -Infinity;
  for (const y of ys) {
    if (y > bandEnd) {
      rows += 1;
      bandEnd = y + ROW_TOLERANCE;
    }
  }
  return rows;
}

/* ---------------- hook(elkjs 动态加载,仅浏览器) ---------------- */

export interface ElkLayoutResult {
  positions: Map<string, NodePos>;
  rows: number;
}

type ElkLike = {
  layout: (graph: ElkInput) => Promise<{
    children?: { id: string; x?: number; y?: number }[];
  }>;
};

let elkPromise: Promise<ElkLike> | null = null;
function getElk(): Promise<ElkLike> {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(
      (m) => new m.default() as unknown as ElkLike,
    );
  }
  return elkPromise;
}

/** elk 失败时的诚实退路:按依赖深度排横列、同列纵排(仍是真 DAG,只是不齐整)。 */
function fallbackPositions(graph: CrewGraph): Map<string, NodePos> {
  const depth = new Map<string, number>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depthOf = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    const deps = node?.task.depends_on ?? [];
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((x) => depthOf(x, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const lanes = new Map<number, number>();
  const pos = new Map<string, NodePos>();
  for (const n of graph.nodes) {
    const d = depthOf(n.id, new Set());
    const lane = lanes.get(d) ?? 0;
    lanes.set(d, lane + 1);
    pos.set(n.id, { x: 28 + d * (TASK_W + 64), y: 28 + lane * (TASK_H + 44) });
  }
  return pos;
}

/**
 * 结构签名变化时重算布局(节点 id+尺寸+边 id;kind 变化如 rework 出现不触发 ——
 * rework 边不进布局)。返回 null 直到首次布局完成(画布待位,不闪 0,0)。
 */
export function useElkLayout(graph: CrewGraph): ElkLayoutResult | null {
  const [result, setResult] = useState<ElkLayoutResult | null>(null);
  const generation = useRef(0);

  const signature = useMemo(() => {
    const ns = graph.nodes.map((n) => {
      const s = nodeSize(n);
      return `${n.id}:${s.width}x${s.height}`;
    });
    const es = graph.edges.filter((e) => e.kind !== "rework").map((e) => e.id);
    return `${ns.join("|")}::${es.join("|")}`;
  }, [graph]);

  useEffect(() => {
    if (graph.nodes.length === 0) {
      setResult({ positions: new Map(), rows: 0 });
      return;
    }
    const gen = ++generation.current;
    let alive = true;
    getElk()
      .then((elk) => elk.layout(toElkGraph(graph)))
      .then((laid) => {
        if (!alive || gen !== generation.current) return;
        const positions = new Map<string, NodePos>();
        for (const c of laid.children ?? []) {
          positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
        }
        setResult({ positions, rows: countRows(graph.nodes, positions) });
      })
      .catch(() => {
        if (!alive || gen !== generation.current) return;
        const positions = fallbackPositions(graph);
        setResult({ positions, rows: countRows(graph.nodes, positions) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 结构签名即依赖(kind 翻转不重排)
  }, [signature]);

  return result;
}
