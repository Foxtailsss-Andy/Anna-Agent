/** railState · 折叠导轨 reducer —— 断点 <1280 自动折叠,手动切换优先(手动后不再自动) */
import { describe, expect, it } from "vitest";

import { RAIL_BREAKPOINT, initialRailState, railReducer } from "../../../components/shell/railState";

describe("initialRailState(按首帧视口宽定初值)", () => {
  it("窄于断点 → 折叠;宽于断点 → 展开;均为非手动", () => {
    expect(initialRailState(1000)).toEqual({ collapsed: true, manual: false });
    expect(initialRailState(1440)).toEqual({ collapsed: false, manual: false });
    // 恰在断点 = 不折叠(<1280 才折叠)
    expect(initialRailState(RAIL_BREAKPOINT)).toEqual({ collapsed: false, manual: false });
  });
});

describe("viewport 事件(未手动时随断点)", () => {
  it("变窄到 <1280 → 折叠;变宽 → 展开", () => {
    let s = initialRailState(1440);
    s = railReducer(s, { type: "viewport", width: 1200 });
    expect(s.collapsed).toBe(true);
    s = railReducer(s, { type: "viewport", width: 1400 });
    expect(s.collapsed).toBe(false);
    expect(s.manual).toBe(false);
  });
});

describe("toggle(手动切换优先)", () => {
  it("toggle 翻转 collapsed 并置 manual=true", () => {
    const s = railReducer(initialRailState(1440), { type: "toggle" });
    expect(s).toEqual({ collapsed: true, manual: true });
  });

  it("手动后 viewport 事件不再改变折叠态(手动优先,本会话不自动)", () => {
    let s = initialRailState(1440); // 展开
    s = railReducer(s, { type: "toggle" }); // 手动折叠
    expect(s).toEqual({ collapsed: true, manual: true });
    s = railReducer(s, { type: "viewport", width: 1600 }); // 若自动应展开,但手动优先
    expect(s.collapsed).toBe(true);
    s = railReducer(s, { type: "viewport", width: 800 });
    expect(s.collapsed).toBe(true);
    expect(s.manual).toBe(true);
  });

  it("手动展开后即便变窄也保持展开", () => {
    let s = initialRailState(1000); // 自动折叠
    s = railReducer(s, { type: "toggle" }); // 手动展开
    expect(s).toEqual({ collapsed: false, manual: true });
    s = railReducer(s, { type: "viewport", width: 900 });
    expect(s.collapsed).toBe(false);
  });
});
