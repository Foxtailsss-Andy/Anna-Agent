import { describe, expect, it } from "vitest";
import { planProgress } from "./plan";

describe("planProgress", () => {
  it("空计划返回 null(无计划不渲染,诚实纪律)", () => {
    expect(planProgress([])).toBeNull();
  });
  it("进行中按半项计(2 done + 1 in_progress / 4 → 62.5%)", () => {
    const p = planProgress([
      { id: "1", title: "a", status: "done" },
      { id: "2", title: "b", status: "done" },
      { id: "3", title: "c", status: "in_progress" },
      { id: "4", title: "d", status: "pending" },
    ])!;
    expect(p.done).toBe(2);
    expect(p.total).toBe(4);
    expect(p.currentTitle).toBe("c");
    expect(p.ratio).toBeCloseTo(0.625);
  });
});
