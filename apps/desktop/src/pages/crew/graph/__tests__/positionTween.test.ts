/**
 * positionTween · DEV-4 JS 位置补间纯函数(缓动 / 插值 / 位移判定)
 *
 * 契约:elk 新布局落定 → rAF 240ms 逐帧插值,边随节点逐帧跟随不脱线;
 *   缓动 = cubic-bezier(0.2,0,0,1)(--ease-lift);首帧/新节点原地出现不滑移。
 */
import { describe, expect, it } from "vitest";

import {
  easeLift,
  interpolatePositions,
  makeCubicBezier,
  positionsDiffer,
} from "../positionTween";

const m = (o: Record<string, [number, number]>) =>
  new Map(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));

describe("makeCubicBezier / easeLift(--ease-lift 掀开)", () => {
  it("端点钳制:ease(0)=0, ease(1)=1", () => {
    expect(easeLift(0)).toBe(0);
    expect(easeLift(1)).toBe(1);
    expect(easeLift(-0.2)).toBe(0);
    expect(easeLift(1.5)).toBe(1);
  });

  it("单调不减(缓动全程推进)", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const y = easeLift(i / 20);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it("cubic-bezier(0.2,0,0,1) 前段快:中点输出已过半程(>0.5)", () => {
    expect(easeLift(0.5)).toBeGreaterThan(0.5);
    expect(easeLift(0.5)).toBeLessThan(1);
  });

  it("退化 cubic-bezier(0,0,1,1) ≈ 恒等(线性)", () => {
    const lin = makeCubicBezier(0, 0, 1, 1);
    expect(lin(0.25)).toBeCloseTo(0.25, 4);
    expect(lin(0.5)).toBeCloseTo(0.5, 4);
    expect(lin(0.75)).toBeCloseTo(0.75, 4);
  });
});

describe("interpolatePositions(t=0 / 0.5 / 1)", () => {
  const from = m({ a: [0, 0], b: [100, 200] });
  const to = m({ a: [50, 50], b: [100, 0] });

  it("rawT=0 → 起点集", () => {
    const r = interpolatePositions(from, to, 0);
    expect(r.get("a")).toEqual({ x: 0, y: 0 });
    expect(r.get("b")).toEqual({ x: 100, y: 200 });
  });

  it("rawT=1 → 终点集", () => {
    const r = interpolatePositions(from, to, 1);
    expect(r.get("a")).toEqual({ x: 50, y: 50 });
    expect(r.get("b")).toEqual({ x: 100, y: 0 });
  });

  it("rawT=0.5 → 介于起终(缓动后仍在包围盒内)", () => {
    const r = interpolatePositions(from, to, 0.5);
    const a = r.get("a")!;
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(50);
    expect(a.y).toBeGreaterThan(0);
    expect(a.y).toBeLessThan(50);
  });

  it("恒等缓动下线性:rawT=0.5 取几何中点", () => {
    const r = interpolatePositions(from, to, 0.5, (x) => x);
    expect(r.get("a")).toEqual({ x: 25, y: 25 });
    expect(r.get("b")).toEqual({ x: 100, y: 100 });
  });

  it("新节点(from 无该 id)→ 原地出现(起点=终点,不滑移)", () => {
    const r = interpolatePositions(new Map(), to, 0.3);
    expect(r.get("a")).toEqual({ x: 50, y: 50 });
    expect(r.get("b")).toEqual({ x: 100, y: 0 });
  });

  it("只出 to 中的 id(from 多余 id 不残留)", () => {
    const r = interpolatePositions(m({ a: [0, 0], stale: [9, 9] }), m({ a: [10, 0] }), 1);
    expect([...r.keys()]).toEqual(["a"]);
  });
});

describe("positionsDiffer(位移判定)", () => {
  it("同位(容差内)→ false;移位 → true", () => {
    expect(positionsDiffer(m({ a: [0, 0] }), m({ a: [0.2, 0] }))).toBe(false);
    expect(positionsDiffer(m({ a: [0, 0] }), m({ a: [5, 0] }))).toBe(true);
  });
  it("新增 id → true", () => {
    expect(positionsDiffer(m({ a: [0, 0] }), m({ a: [0, 0], b: [1, 1] }))).toBe(true);
  });
  it("空起点 + 有终点 → true(首帧落位);空↔空 → false", () => {
    expect(positionsDiffer(new Map(), m({ a: [0, 0] }))).toBe(true);
    expect(positionsDiffer(new Map(), new Map())).toBe(false);
  });
});
