/**
 * 收件箱纯逻辑(F5)· 报销四步 stepper step 映射 · 卡片归类
 * 零捏造:step 由后端投影真值(submitted/drafted/awaiting_approval/verified)驱动。
 */
import { describe, expect, it } from "vitest";

import {
  reimbursementStepper,
  STEPPER_LABELS,
  inboxLaneTitle,
  reworkVersionPill,
  isChannelGrown,
} from "../inboxModel";

describe("reimbursementStepper · 四步映射(提交→校验建单→审批→回读核验)", () => {
  it("四步标签固定", () => {
    expect(STEPPER_LABELS).toEqual(["提交", "校验建单", "审批", "回读核验"]);
  });

  it("awaiting_approval:提交✓ 校验✓ 审批=当前 回读=虚", () => {
    const m = reimbursementStepper("awaiting_approval");
    expect(m.steps.map((s) => s.state)).toEqual(["done", "done", "current", "todo"]);
    // 连线:提交—绿—校验建单—灰—审批—灰—回读
    expect(m.connectors).toEqual(["done", "idle", "idle"]);
  });

  it("submitted:仅第一步当前,其余待办", () => {
    const m = reimbursementStepper("submitted");
    expect(m.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(m.connectors).toEqual(["idle", "idle", "idle"]);
  });

  it("drafted:提交✓ 校验建单=当前(入当前步的线为灰)", () => {
    const m = reimbursementStepper("drafted");
    expect(m.steps.map((s) => s.state)).toEqual(["done", "current", "todo", "todo"]);
    // 绿线仅出现在两 done 步之间;入 current 步的线为灰
    expect(m.connectors).toEqual(["idle", "idle", "idle"]);
  });

  it("verified:四步全 done,连线全绿", () => {
    const m = reimbursementStepper("verified");
    expect(m.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(m.connectors).toEqual(["done", "done", "done"]);
  });

  it("未知 step → 兜底第一步当前(不崩)", () => {
    const m = reimbursementStepper("???");
    expect(m.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
  });
});

describe("inboxLaneTitle · 三组标题与空态", () => {
  it("三组标题固定文案", () => {
    expect(inboxLaneTitle("todo")).toBe("待我做");
    expect(inboxLaneTitle("review")).toBe("待我审");
    expect(inboxLaneTitle("mentions")).toBe("@我");
  });
});

describe("reworkVersionPill · 返工版本 pill(F6)", () => {
  it("最新版 1 → v1→v2", () => {
    expect(reworkVersionPill(1)).toBe("v1→v2");
  });
  it("最新版 2 → v2→v3", () => {
    expect(reworkVersionPill(2)).toBe("v2→v3");
  });
  it("无版本(null/undefined/<1)→ null(零捏造,不渲染)", () => {
    expect(reworkVersionPill(null)).toBeNull();
    expect(reworkVersionPill(undefined)).toBeNull();
    expect(reworkVersionPill(0)).toBeNull();
  });
});

describe("isChannelGrown · 频道生长判定(F6)", () => {
  it("origin=channel → true", () => {
    expect(isChannelGrown("channel")).toBe(true);
  });
  it("origin=sop / 缺省 → false", () => {
    expect(isChannelGrown("sop")).toBe(false);
    expect(isChannelGrown(undefined)).toBe(false);
    expect(isChannelGrown(null)).toBe(false);
  });
});
