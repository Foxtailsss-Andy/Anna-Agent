import { describe, expect, it } from "vitest";

import {
  SHOWCASE_BADGES,
  SHOWCASE_CAPABILITIES,
  SHOWCASE_STAGES,
  SHOWCASE_STEPS,
  SHOWCASE_TITLE,
  showcaseStateLabel,
} from "../showcaseModel";

describe("showcaseModel", () => {
  it("keeps the built-in demo clearly marked as sample data", () => {
    expect(SHOWCASE_TITLE).toBe("周会行动项闭环");
    expect(SHOWCASE_BADGES).toContain("内置案例");
    expect(SHOWCASE_BADGES).toContain("示例数据");
    expect(SHOWCASE_BADGES).toContain("3-5 分钟体验");
  });

  it("covers the full Crew demonstration arc", () => {
    expect(SHOWCASE_STAGES.map((stage) => stage.id)).toEqual([
      "intake",
      "actions",
      "parallel",
      "review",
      "waiting",
    ]);
    expect(SHOWCASE_STAGES.some((stage) => stage.state === "active")).toBe(true);
    expect(SHOWCASE_STAGES.some((stage) => stage.state === "waiting")).toBe(true);
    expect(SHOWCASE_STAGES.some((stage) => stage.detail.includes("blocked"))).toBe(false);
    expect(SHOWCASE_CAPABILITIES.map((cap) => cap.label)).toEqual([
      "Coordination Proposal",
      "Versioned Artifact",
      "Parallel Work",
      "Human Gate",
      "Dependency Unlock",
    ]);
    expect(SHOWCASE_STEPS).toHaveLength(4);
  });

  it("maps showcase state labels for UI chips", () => {
    expect(showcaseStateLabel("done")).toBe("已完成");
    expect(showcaseStateLabel("active")).toBe("待处理");
    expect(showcaseStateLabel("blocked")).toBe("需恢复");
    expect(showcaseStateLabel("waiting")).toBe("等待中");
  });
});
