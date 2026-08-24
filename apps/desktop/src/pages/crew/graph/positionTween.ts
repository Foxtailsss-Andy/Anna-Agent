/**
 * positionTween · DEV-4 布局迁移 JS 位置补间(纯函数,可测)
 *
 * 病根(诊断 05 §2c):节点靠 CSS `transition: transform 240ms` 滑移,React Flow 却把
 * 边瞬时钉在终点坐标 → 每次重排,边都「脱线」240ms。改法:elk 新布局落定时,用 rAF 在
 * 240ms 内把每个节点从旧位置缓动插到新位置,逐帧 setNodes —— 边随节点逐帧重算,天然贴合。
 * 缓动 = cubic-bezier(0.2,0,0,1)(= --ease-lift)。此处只出纯插值;rAF 时钟住画布组件,
 * 首帧(初次挂载)与 reduced-motion 均直接落位(不补间)。
 */

import type { NodePos } from "./useElkLayout";

/**
 * 生成 cubic-bezier 缓动求值器(x∈[0,1] → y∈[0,1]);端点钳制。
 * 经典 UnitBezier:Newton 迭代解 x(t)=x,失败则二分兜底。
 */
export function makeCubicBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (x: number) => number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveX(x)));
}

/** --ease-lift(掀开):cubic-bezier(0.2,0,0,1)。 */
export const easeLift = makeCubicBezier(0.2, 0, 0, 1);

/**
 * 位置插值:对 `to` 中每个 id,从 `from` 的旧位(缺省=终点,即新节点原地出现、不滑移)
 * 缓动插到终点。rawT∈[0,1] 内部过缓动;rawT≤0 → 起点集,rawT≥1 → 终点集。
 */
export function interpolatePositions(
  from: ReadonlyMap<string, NodePos>,
  to: ReadonlyMap<string, NodePos>,
  rawT: number,
  ease: (x: number) => number = easeLift,
): Map<string, NodePos> {
  const e = rawT <= 0 ? 0 : rawT >= 1 ? 1 : ease(rawT);
  const out = new Map<string, NodePos>();
  for (const [id, target] of to) {
    const start = from.get(id) ?? target;
    out.set(id, {
      x: start.x + (target.x - start.x) * e,
      y: start.y + (target.y - start.y) * e,
    });
  }
  return out;
}

/**
 * `to` 相对 `from` 是否有实质位移(>eps px,或有新 id)。无变化 → 不必补间(直接落位)。
 * 空 `from`(首帧)+ 非空 `to` → true(需落位,但由调用方判首帧直接落而非补间)。
 */
export function positionsDiffer(
  from: ReadonlyMap<string, NodePos>,
  to: ReadonlyMap<string, NodePos>,
  eps = 0.5,
): boolean {
  if (from.size === 0) return to.size > 0;
  for (const [id, pt] of to) {
    const pf = from.get(id);
    if (!pf) return true;
    if (Math.abs(pf.x - pt.x) > eps || Math.abs(pf.y - pt.y) > eps) return true;
  }
  return false;
}
