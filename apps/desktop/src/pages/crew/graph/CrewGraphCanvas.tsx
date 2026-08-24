/**
 * CrewGraphCanvas · Work Graph 画布装配(F2 签名视觉件)
 *
 * - 制图桌五层(纸面渐变/双尺网格羽化/双辉光漂移/灯下白纱/工作框+四角规矩线);
 * - React Flow + elkjs 分层 LR(并行段纵向展开,长链保持水平·可横向平移;#5 去强制折返);
 * - 轮询 3s(getProject + listChannel)→ diff 驱动动效:生长四幕(一次性)、
 *   完成落笔、布局滑移 240ms 吸收跳变;
 * - P1 焦点呼吸唯一(频道 seq 判定;无 running 全静);P6 点名环(crew:ring-call);
 * - 底栏:缩放条 0.5-1.5 + 计数 mono「节点 N · 门 M · R 行」/「图例」pill +
 *   mono「同步 HH:MM:SS · 轮询 3s」(全部真值);
 * - 空态即空态;数据单源:轮询结果经 onSnapshot 交还父级,再由 props 流回。
 */

import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  getProject,
  listChannel,
  type ChannelMessage,
  type CrewProject,
  type TeamMember,
} from "../../../lib/api/crew";
import { GateNode, type GateNodeData } from "./GateNode";
import { GraphLegend } from "./GraphLegend";
import { TaskNode, type TaskNodeData } from "./TaskNode";
import { crewEdgeTypes, type CrewEdgeData } from "./edges";
import {
  buildGraph,
  deriveFocus,
  gatePassedTime,
  nodePrimaryAction,
  originAuditRef,
  type NodeActionOp,
} from "./graphMapping";
import {
  GROWTH_WINDOW_MS,
  INK_WINDOW_MS,
  RING_EVENT,
  RING_PAN_MS,
  RING_TOTAL_MS,
  reduceMotion,
  seedMotion,
  withinWindow,
  type MotionState,
} from "./graphMotion";
import { interpolatePositions, positionsDiffer } from "./positionTween";
import { nodeSize, useElkLayout, type NodePos } from "./useElkLayout";
import "./ChartingTable.css";

const POLL_MS = 3000;

const nodeTypes = { crewTask: TaskNode, crewGate: GateNode };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function hhmmss(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface CrewGraphCanvasProps {
  projectId: string;
  project: CrewProject;
  channel: ChannelMessage[];
  members: TeamMember[];
  /** 轮询快照交还父级(健康条/频道列同源刷新);props 流回即单一事实源 */
  onSnapshot: (project: CrewProject, channel: ChannelMessage[] | null) => void;
  /** F4 单击任务节点 → 轻检视(锚点为节点视口矩形) */
  onInspect?: (taskId: string, anchor: { left: number; top: number; width: number; height: number }) => void;
  /** F4 双击任务节点 → 任务抽屉 */
  onOpenDrawer?: (taskId: string) => void;
  /** F4 被轻检视选中的任务(选中环接管 + 呼吸暂歇) */
  selectedTaskId?: string | null;
  /** 当前会话身份(判 canClaim:免登录无身份 → 不给「认领」) */
  sessionUserId?: string | null;
  /** #2 节点就地主动作:DetailPage 装配真 API + 开抽屉/轻检视 */
  onNodePrimary?: (
    taskId: string,
    op: NodeActionOp,
    anchor: { left: number; top: number; width: number; height: number },
  ) => void;
}

/* ---------------- 缩放条(独立订阅 viewport,避免整画布随帧重渲) ---------------- */

function ZoomBar() {
  const { zoom } = useViewport();
  const rf = useReactFlow();
  return (
    <div className="crewg-zoom" role="group" aria-label="缩放">
      <button type="button" className="crewg-zoom__btn" aria-label="缩小" onClick={() => rf.zoomOut({ duration: 120 })}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <span className="crewg-zoom__pct">{Math.round(zoom * 100)}%</span>
      <button type="button" className="crewg-zoom__btn" aria-label="放大" onClick={() => rf.zoomIn({ duration: 120 })}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        className="crewg-zoom__btn"
        aria-label="适配视图"
        onClick={() => rf.fitView({ padding: 0.18, duration: prefersReducedMotion() ? 0 : 240 })}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
    </div>
  );
}

/* ---------------- 画布本体 ---------------- */

function CanvasInner({
  projectId,
  project,
  channel,
  members,
  onSnapshot,
  onInspect,
  onOpenDrawer,
  selectedTaskId,
  sessionUserId,
  onNodePrimary,
}: CrewGraphCanvasProps) {
  const rf = useReactFlow();
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [motion, setMotion] = useState<MotionState | null>(null);
  const [ring, setRing] = useState<{ taskId: string; at: number } | null>(null);
  const [, setPurgeTick] = useState(0);
  /* DEV-4:补间后逐帧的显示位置(单源;边随之逐帧重算,不脱线) */
  const [displayPos, setDisplayPos] = useState<Map<string, NodePos>>(() => new Map());
  const displayRef = useRef<Map<string, NodePos>>(new Map());
  const tweenRaf = useRef<number | null>(null);

  /* -- 焦点(P1)与图装配 -- */
  const focusId = useMemo(
    () => deriveFocus(project.tasks ?? [], channel),
    [project, channel],
  );
  const graph = useMemo(() => buildGraph(project, focusId), [project, focusId]);
  const layout = useElkLayout(graph);

  /* -- DEV-4:elk 新布局落定 → JS 位置补间(rAF 240ms cubic-bezier(.2,0,0,1))。
        CSS transform 过渡已撤(它让节点滑而边瞬时钉终点 → 脱线);逐帧 setNodes,
        边天然逐帧跟随。首帧(初次挂载)/ reduced-motion / 无实质位移 → 直接落位。
        单同步补间(生长错峰降级为单拍,见偏差登记)。 */
  useEffect(() => {
    if (!layout) return;
    const target = layout.positions;
    const prev = displayRef.current;
    const commit = (m: Map<string, NodePos>) => {
      displayRef.current = m;
      setDisplayPos(m);
    };
    if (tweenRaf.current != null) {
      cancelAnimationFrame(tweenRaf.current);
      tweenRaf.current = null;
    }
    if (prev.size === 0 || prefersReducedMotion() || !positionsDiffer(prev, target)) {
      commit(new Map(target));
      return;
    }
    const from = new Map(prev);
    const start = performance.now();
    const DUR = 240;
    const step = (t: number) => {
      const raw = Math.min(1, (t - start) / DUR);
      commit(interpolatePositions(from, target, raw));
      tweenRaf.current = raw < 1 ? requestAnimationFrame(step) : null;
    };
    tweenRaf.current = requestAnimationFrame(step);
    return () => {
      if (tweenRaf.current != null) {
        cancelAnimationFrame(tweenRaf.current);
        tweenRaf.current = null;
      }
    };
  }, [layout]);

  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  /* -- 轮询 3s:真快照交还父级(props 流回,单源) -- */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [p, ch] = await Promise.all([
          getProject(projectId),
          listChannel(projectId).catch(() => null),
        ]);
        if (!alive) return;
        setLastSync(new Date());
        onSnapshot(p, ch);
      } catch {
        /* 网络抖动:保留上一个真快照,不造数 */
      }
    };
    const iv = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSnapshot 由父级 useCallback 稳定
  }, [projectId]);

  /* -- diff → 动效 reducer(初载 seed 不动画;新 id 才生长) -- */
  const snapKey = useMemo(() => {
    const dones = graph.nodes.filter((n) => n.kind === "task" && n.visual === "done");
    return `${graph.nodes.map((n) => n.id).join(",")}::${graph.edges
      .map((e) => e.id)
      .join(",")}::${dones.map((n) => n.id).join(",")}`;
  }, [graph]);
  useEffect(() => {
    const snap = {
      nodeIds: graph.nodes.map((n) => n.id),
      edgeIds: graph.edges.map((e) => e.id),
      doneIds: graph.nodes
        .filter((n) => n.kind === "task" && n.visual === "done")
        .map((n) => n.id),
    };
    setMotion((m) => (m === null ? seedMotion(snap) : reduceMotion(m, snap, Date.now())));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapKey 即结构签名
  }, [snapKey]);

  /* -- born/ink 窗口到期 → 重渲一次摘掉动效类(一次性不重播) -- */
  useEffect(() => {
    if (!motion) return;
    const now = Date.now();
    const expiries = [
      ...Object.values(motion.bornNodes).map((at) => at + GROWTH_WINDOW_MS),
      ...Object.values(motion.bornEdges).map((at) => at + GROWTH_WINDOW_MS),
      ...Object.values(motion.inkAt).map((at) => at + INK_WINDOW_MS),
    ].filter((t) => t > now);
    if (expiries.length === 0) return;
    const t = setTimeout(() => setPurgeTick((x) => x + 1), Math.min(...expiries) - now + 60);
    return () => clearTimeout(t);
  }, [motion]);

  /* -- P6 点名环:监听频道锚点事件 → 平移居中 → 单次环 -- */
  useEffect(() => {
    const onRing = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId) setRing({ taskId: detail.taskId, at: Date.now() });
    };
    window.addEventListener(RING_EVENT, onRing);
    return () => window.removeEventListener(RING_EVENT, onRing);
  }, []);
  useEffect(() => {
    if (!ring || !layout) return;
    const node = graph.nodes.find((n) => n.id === ring.taskId);
    const pos = layout.positions.get(ring.taskId);
    if (node && pos) {
      const s = nodeSize(node);
      void rf.setCenter(pos.x + s.width / 2, pos.y + s.height / 2, {
        zoom: rf.getZoom(),
        duration: prefersReducedMotion() ? 0 : RING_PAN_MS,
      });
    }
    const t = setTimeout(() => setRing(null), RING_PAN_MS + RING_TOTAL_MS + 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随 ring 触发(布局/图取当次值)
  }, [ring]);

  /* -- 首次布局完成 → fitView 一次 --
     宽扁 DAG(横向长链)若强行全览会压到 minZoom(节点小、上下大留白);
     给首屏一个可读下限 0.72——节点保持可读,超出宽度可横向平移;
     底栏「适配」按钮仍全览(见 fit 按钮,无下限)。 */
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && layout && layout.positions.size > 0) {
      fitted.current = true;
      requestAnimationFrame(() => {
        void rf.fitView({ padding: 0.16, minZoom: 0.72, maxZoom: 1 });
        // 宽图撞 minZoom 时 fitView 居中会裁两头——阅读方向左→右,回锚左缘
        requestAnimationFrame(() => {
          const vp = rf.getViewport();
          if (vp.x < 0) {
            let minX = Infinity;
            layout.positions.forEach((p) => { if (p.x < minX) minX = p.x; });
            if (Number.isFinite(minX)) rf.setViewport({ ...vp, x: 24 - minX * vp.zoom });
          }
        });
      });
    }
  }, [layout, rf]);

  /* -- RF 节点/边装配 -- */
  const now = Date.now();

  const rfNodes = useMemo<Node[]>(() => {
    if (!layout) return [];
    return graph.nodes.map((n) => {
      // DEV-4:位置取补间后的显示值(边逐帧跟随);补间未起前回退到 elk 终点
      const pos = displayPos.get(n.id) ?? layout.positions.get(n.id) ?? { x: 0, y: 0 };
      const size = nodeSize(n);
      const born = withinWindow(motion?.bornNodes[n.id], now, GROWTH_WINDOW_MS);
      const ringing = ring?.taskId === n.id;
      const common = {
        id: n.id,
        position: pos,
        width: size.width,
        height: size.height,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
      };
      // #2 就地主动作:状态→唯一主动作 + 一键处理器(点击时从 DOM 取锚点矩形)
      const primary = nodePrimaryAction(n.task, n.visual, members, !!sessionUserId);
      const onPrimary =
        primary && onNodePrimary
          ? (e: React.MouseEvent) => {
              const el = (e.currentTarget as HTMLElement).closest(".react-flow__node") as HTMLElement | null;
              const r = el?.getBoundingClientRect();
              onNodePrimary(
                n.id,
                primary.op,
                r
                  ? { left: r.left, top: r.top, width: r.width, height: r.height }
                  : { left: 0, top: 0, width: 0, height: 0 },
              );
            }
          : undefined;
      if (n.kind === "gate") {
        const data: GateNodeData = {
          node: n,
          passedAt: gatePassedTime(project, n.id),
          born,
          ringing,
          primary,
          onPrimary,
        };
        return { ...common, type: "crewGate", data };
      }
      const assignee = n.task.assignee_member_id
        ? memberMap.get(n.task.assignee_member_id) ?? null
        : null;
      const data: TaskNodeData = {
        node: n,
        assignee,
        assigneeIsOwner: !!assignee && assignee.id === project.owner_user_id,
        originAudit: originAuditRef(n.task, channel),
        born,
        ink: withinWindow(motion?.inkAt[n.id], now, INK_WINDOW_MS),
        ringing,
        selected: selectedTaskId === n.id,
        primary,
        onPrimary,
      };
      return { ...common, type: "crewTask", data };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now 仅用于窗口过滤,由 motion/purge/补间 驱动
  }, [graph, layout, displayPos, motion, ring, memberMap, members, project, channel, selectedTaskId, sessionUserId, onNodePrimary]);

  // #5 边确定性:布局 resolve 前不发边(否则首帧边引用无坐标节点 → 漏画/端点飘 0,0);
  // 与 rfNodes 同门,节点与边随 layout 一起入场,消除 async 竞态。
  const rfEdges = useMemo<Edge[]>(
    () =>
      layout
        ? graph.edges.map((e) => {
            const data: CrewEdgeData = {
              kind: e.kind,
              born: withinWindow(motion?.bornEdges[e.id], Date.now(), GROWTH_WINDOW_MS),
            };
            return {
              id: e.id,
              source: e.source,
              target: e.target,
              type: "crew" as const,
              data,
              ...(e.kind === "rework" ? { sourceHandle: "loop-out", targetHandle: "loop-in" } : {}),
            };
          })
        : [],
    [graph, motion, layout],
  );

  const empty = (project.tasks ?? []).length === 0;

  /* -- F4 单击/双击任务节点 → 轻检视/抽屉(仅任务;门不开双卡) -- */
  const nodeAnchor = (
    event: React.MouseEvent,
  ): { left: number; top: number; width: number; height: number } | null => {
    const el = (event.target as HTMLElement | null)?.closest(".react-flow__node") as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const handleNodeClick = (event: React.MouseEvent, node: Node) => {
    if (node.type !== "crewTask" || !onInspect) return;
    const anchor = nodeAnchor(event);
    if (anchor) onInspect(node.id, anchor);
  };
  const handleNodeDoubleClick = (_event: React.MouseEvent, node: Node) => {
    if (node.type !== "crewTask" || !onOpenDrawer) return;
    onOpenDrawer(node.id);
  };

  return (
    <div className="crewg">
      {/* 制图桌五层(纸面/双尺网格/双辉光/白纱/工作框),节点浮其上 */}
      <div className="crewg-table" aria-hidden="true">
        <div className="crewg-table__paper" />
        <div className="crewg-table__grid" />
        <div className="crewg-table__glow crewg-table__glow--a" />
        <div className="crewg-table__glow crewg-table__glow--b" />
        <div className="crewg-table__veil" />
        <div className="crewg-table__frame">
          <span className="crewg-table__corner crewg-table__corner--tl" />
          <span className="crewg-table__corner crewg-table__corner--tr" />
          <span className="crewg-table__corner crewg-table__corner--bl" />
          <span className="crewg-table__corner crewg-table__corner--br" />
        </div>
      </div>

      {empty ? (
        <div className="crewg-empty">工作图为空 —— 任务下推后在此生长。</div>
      ) : (
        <ReactFlow
          className="crewg-flow"
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={crewEdgeTypes}
          minZoom={0.5}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          panOnDrag
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          proOptions={{ hideAttribution: true }}
        />
      )}

      {/* 底栏(1a):左=缩放条 + 计数 mono;右=图例 pill + 同步 mono */}
      <div className="crewg-bar crewg-bar--left">
        <ZoomBar />
        {!empty && (
          <span className="crewg-bar__mono">
            节点 {graph.taskCount} · 门 {graph.gateCount}
            {layout && layout.rows > 0 ? ` · ${layout.rows} 行` : ""}
          </span>
        )}
      </div>
      <div className="crewg-bar crewg-bar--right">
        <GraphLegend />
        {lastSync && (
          <span className="crewg-bar__mono">
            同步 {hhmmss(lastSync)} · 轮询 {POLL_MS / 1000}s
          </span>
        )}
      </div>
    </div>
  );
}

export function CrewGraphCanvas(props: CrewGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export default CrewGraphCanvas;
