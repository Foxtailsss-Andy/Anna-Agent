/**
 * graphMotion · 轮询 diff → 动效队列纯 reducer(P1 呼吸唯一 / P2 生长四幕 / P6 点名环)
 *
 * 原则:所有动效对应真事件 ——
 * - 生长四幕只属「新出现」的节点/边(seedMotion 初载不动画;一次性不重播);
 * - 落笔 300ms 只属「既有节点 → done」的转变(新生即 done 只算生长);
 * - 返工边通过后消隐 = 直接从 known 移除,无退场动画(不留疤);
 * - 窗口过期即 purge(reduce 传 now,保持纯函数可测)。
 *
 * 生长四幕时序(设计说明 §四,总程 ≈1.1s + 晕 3s 淡出):
 *   幕一 让位 240ms(elk 重算 + 滑移,错峰 30ms)
 *   幕二 画入 300ms(新边 dashoffset,iris 3s 归常)
 *   幕三 显形 240ms(y+8 scale .96→1)
 *   幕四 定名 320ms(金线一周 + iris 晕 3s 淡出)
 *
 * 点名环(P6):平移居中 320ms → 环入场 240ms → 驻留 2.4s → 淡出 600ms,单次。
 * 事件总线:window CustomEvent "crew:ring-call" {detail:{taskId}} —— F3 频道锚点派发,
 * F2 画布监听;dispatchRingCall 即发起端接口。
 */

/* ---------------- 生长四幕时序常量 ---------------- */

export const GROWTH_YIELD_MS = 240;
export const GROWTH_YIELD_STAGGER_MS = 30;
export const GROWTH_DRAW_MS = 300;
export const GROWTH_REVEAL_MS = 240;
export const GROWTH_NAME_MS = 320;
export const GROWTH_HALO_MS = 3000;

/** born 条目存活窗:四幕 + 晕淡出 + 余量(也是 reduced-motion 静态描边 3s 的时钟)。 */
export const GROWTH_WINDOW_MS =
  GROWTH_YIELD_MS + GROWTH_DRAW_MS + GROWTH_REVEAL_MS + GROWTH_NAME_MS + GROWTH_HALO_MS + 200;

/** 落笔(完成勾描画 300ms 单次)存活窗。 */
export const INK_WINDOW_MS = 1200;

/* ---------------- 点名环常量(P6) ---------------- */

export const RING_EVENT = "crew:ring-call";
export const RING_PAN_MS = 320;
export const RING_ENTER_MS = 240;
export const RING_DWELL_MS = 2400;
export const RING_FADE_MS = 600;
export const RING_TOTAL_MS = RING_ENTER_MS + RING_DWELL_MS + RING_FADE_MS;

/** 发起端接口(F3 频道锚点 chip 将调用;F2 画布 addEventListener 同名事件)。 */
export function dispatchRingCall(taskId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RING_EVENT, { detail: { taskId } }));
}

/* ---------------- 定位(频道文档 → 图节点)视图前置(O-C) ---------------- */

export interface LocatePlan {
  /** 阅读器占据画布区 → 需先回图(canvasView.kind !== "graph") */
  backToGraph: boolean;
  /** 列表视图 → 需切回图视图(view !== "graph") */
  switchToGraph: boolean;
}

/**
 * 定位前置视图决策(纯):频道「定位」点名前,画布区须先落在图上。
 * - 阅读器态(reader)→ 先回图;
 * - 列表视图(list)→ 切图;
 * - 已在图 → 直接点名(两者皆 false)。
 * 二者相互独立(阅读器可叠在列表视图之上,两步都需)。任一为 true 即表示画布将由
 * 卸载→挂载,点名环须待其挂载(RING_EVENT 监听注册)后再派发,否则事件先于挂载丢失
 * —— 见 CrewProjectDetailPage.handleLocate 的 rAF 延迟派发。
 */
export function planLocate(
  canvasKind: "graph" | "reader",
  view: "graph" | "list",
): LocatePlan {
  return {
    backToGraph: canvasKind !== "graph",
    switchToGraph: view !== "graph",
  };
}

/* ---------------- diff reducer ---------------- */

export interface MotionSnapshot {
  nodeIds: string[];
  edgeIds: string[];
  doneIds: string[];
}

export interface MotionState {
  known: MotionSnapshot;
  /** 节点 id → 出生时刻(生长四幕队列;窗口内有效) */
  bornNodes: Record<string, number>;
  /** 边 id → 出生时刻(画入 300ms;返工边同样走画入) */
  bornEdges: Record<string, number>;
  /** 节点 id → 转 done 时刻(落笔 300ms 单次) */
  inkAt: Record<string, number>;
}

/** 初载:全部视为已知,零动画(墨迹已干,不重演历史)。 */
export function seedMotion(snap: MotionSnapshot): MotionState {
  return { known: snap, bornNodes: {}, bornEdges: {}, inkAt: {} };
}

function carry(
  prev: Record<string, number>,
  alive: ReadonlySet<string>,
  now: number,
  windowMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(prev)) {
    if (alive.has(id) && now - at <= windowMs) next[id] = at;
  }
  return next;
}

/**
 * 轮询 diff:新 id → born;既有节点转 done → ink;消失 id / 过窗条目 → purge。
 * 纯函数:同輸入同输出;时间由调用方注入。
 */
export function reduceMotion(
  prev: MotionState,
  snap: MotionSnapshot,
  now: number,
): MotionState {
  const prevNodes = new Set(prev.known.nodeIds);
  const prevEdges = new Set(prev.known.edgeIds);
  const prevDone = new Set(prev.known.doneIds);
  const aliveNodes = new Set(snap.nodeIds);
  const aliveEdges = new Set(snap.edgeIds);

  const bornNodes = carry(prev.bornNodes, aliveNodes, now, GROWTH_WINDOW_MS);
  const bornEdges = carry(prev.bornEdges, aliveEdges, now, GROWTH_WINDOW_MS);
  const inkAt = carry(prev.inkAt, aliveNodes, now, INK_WINDOW_MS);

  for (const id of snap.nodeIds) {
    if (!prevNodes.has(id)) bornNodes[id] = now;
  }
  for (const id of snap.edgeIds) {
    if (!prevEdges.has(id)) bornEdges[id] = now;
  }
  for (const id of snap.doneIds) {
    // 落笔仅限「既有节点」的转变;新生节点走生长,不落笔
    if (!prevDone.has(id) && prevNodes.has(id)) inkAt[id] = now;
  }

  return { known: snap, bornNodes, bornEdges, inkAt };
}

/** born/ink 是否仍在窗口内(渲染侧过滤;与 reduce 的 purge 同一口径)。 */
export function withinWindow(at: number | undefined, now: number, windowMs: number): boolean {
  return at !== undefined && now - at <= windowMs;
}
