/**
 * graphMotion · 轮询 diff → 动效队列纯 reducer(F2 RED)
 *
 * P2 契约:生长四幕只属「新出现」的节点/边;初载不动画;一次性不重播;
 *   窗口过期即purge;返工边通过后消隐(不留疤,无退场动画)。
 * 落笔:既有节点 转 done 才落笔一次;初载已 done / 新生即 done 不落笔。
 * P6:点名环事件总线名 crew:ring-call,单次 240ms 入场 + 2.4s 驻留 + 600ms 淡出。
 */
import { describe, expect, it } from "vitest";

import {
  GROWTH_WINDOW_MS,
  INK_WINDOW_MS,
  RING_EVENT,
  RING_PAN_MS,
  RING_TOTAL_MS,
  planLocate,
  reduceMotion,
  seedMotion,
  type MotionSnapshot,
} from "../graphMotion";

const snap = (over: Partial<MotionSnapshot> = {}): MotionSnapshot => ({
  nodeIds: ["a", "b"],
  edgeIds: ["a->b"],
  doneIds: ["a"],
  ...over,
});

describe("seedMotion(初载不动画)", () => {
  it("首个快照 → 无 born、无 ink", () => {
    const s = seedMotion(snap());
    expect(Object.keys(s.bornNodes)).toHaveLength(0);
    expect(Object.keys(s.bornEdges)).toHaveLength(0);
    expect(Object.keys(s.inkAt)).toHaveLength(0);
  });
});

describe("reduceMotion(diff 驱动生长)", () => {
  it("新增节点+新边 → born 记录出生时刻(生长四幕队列)", () => {
    const s0 = seedMotion(snap());
    const s1 = reduceMotion(
      s0,
      snap({ nodeIds: ["a", "b", "c"], edgeIds: ["a->b", "b->c"] }),
      1000,
    );
    expect(s1.bornNodes).toEqual({ c: 1000 });
    expect(s1.bornEdges).toEqual({ "b->c": 1000 });
  });

  it("同一快照重放 → 不重播(born 时刻不刷新)", () => {
    const s0 = seedMotion(snap());
    const grown = snap({ nodeIds: ["a", "b", "c"], edgeIds: ["a->b", "b->c"] });
    const s1 = reduceMotion(s0, grown, 1000);
    const s2 = reduceMotion(s1, grown, 2000);
    expect(s2.bornNodes).toEqual({ c: 1000 });
    expect(s2.bornEdges).toEqual({ "b->c": 1000 });
  });

  it("窗口过期 → purge(born 条目按 GROWTH_WINDOW_MS 清理)", () => {
    const s0 = seedMotion(snap());
    const grown = snap({ nodeIds: ["a", "b", "c"], edgeIds: ["a->b", "b->c"] });
    const s1 = reduceMotion(s0, grown, 1000);
    const s2 = reduceMotion(s1, grown, 1000 + GROWTH_WINDOW_MS + 1);
    expect(s2.bornNodes).toEqual({});
    expect(s2.bornEdges).toEqual({});
  });

  it("既有节点转 done → inkAt 落笔一次;窗口过期 purge", () => {
    const s0 = seedMotion(snap({ doneIds: ["a"] }));
    const s1 = reduceMotion(s0, snap({ doneIds: ["a", "b"] }), 500);
    expect(s1.inkAt).toEqual({ b: 500 });
    const s2 = reduceMotion(s1, snap({ doneIds: ["a", "b"] }), 500 + INK_WINDOW_MS + 1);
    expect(s2.inkAt).toEqual({});
  });

  it("新生即 done 的节点 → 只算生长,不落笔", () => {
    const s0 = seedMotion(snap());
    const s1 = reduceMotion(
      s0,
      snap({ nodeIds: ["a", "b", "c"], doneIds: ["a", "c"] }),
      700,
    );
    expect(s1.bornNodes).toEqual({ c: 700 });
    expect(s1.inkAt).toEqual({});
  });

  it("消失的 id(返工边通过后消隐)→ 从 known 与 born 中移除,不留疤", () => {
    const s0 = seedMotion(snap({ edgeIds: ["a->b", "rework:g->a"] }));
    const s1 = reduceMotion(s0, snap({ edgeIds: ["a->b"] }), 100);
    expect(s1.known.edgeIds).toEqual(["a->b"]);
    expect(s1.bornEdges["rework:g->a"]).toBeUndefined();
  });
});

describe("点名环常量(P6 契约)", () => {
  it("事件总线名 crew:ring-call(F3 频道锚点将派发同名事件)", () => {
    expect(RING_EVENT).toBe("crew:ring-call");
  });
  it("时序:平移 320ms;入场 240 + 驻留 2400 + 淡出 600 = 3240ms 单次", () => {
    expect(RING_PAN_MS).toBe(320);
    expect(RING_TOTAL_MS).toBe(240 + 2400 + 600);
  });
});

describe("planLocate · 定位前置视图决策(reader→回图 / list→切图 / graph→直接)", () => {
  it("阅读器态 → 先回图(backToGraph),视图在图则不切", () => {
    expect(planLocate("reader", "graph")).toEqual({ backToGraph: true, switchToGraph: false });
  });
  it("列表视图 → 切回图(switchToGraph),无阅读器则不回", () => {
    expect(planLocate("graph", "list")).toEqual({ backToGraph: false, switchToGraph: true });
  });
  it("已在图 → 直接点名(两步皆免)", () => {
    expect(planLocate("graph", "graph")).toEqual({ backToGraph: false, switchToGraph: false });
  });
  it("阅读器叠在列表视图之上 → 回图 + 切图(两步都需)", () => {
    expect(planLocate("reader", "list")).toEqual({ backToGraph: true, switchToGraph: true });
  });
});

describe("born 边:仅真新边(DEV-4:快照刷新同 id 不复播画入)", () => {
  it("新 edge id → born;既有 id 刷新 → 不 born;再刷新 → born 时刻不变", () => {
    const base = snap({ edgeIds: ["a->b"] });
    const s0 = seedMotion(base);
    // 同 id 刷新:seed 已知,不 born
    const s1 = reduceMotion(s0, base, 1000);
    expect(s1.bornEdges).toEqual({});
    // 真新边 b->c:born 记时
    const s2 = reduceMotion(s1, snap({ edgeIds: ["a->b", "b->c"] }), 2000);
    expect(s2.bornEdges).toEqual({ "b->c": 2000 });
    // 同 id 再刷新:不复播(born 时刻不刷新)
    const s3 = reduceMotion(s2, snap({ edgeIds: ["a->b", "b->c"] }), 3000);
    expect(s3.bornEdges).toEqual({ "b->c": 2000 });
  });
});
