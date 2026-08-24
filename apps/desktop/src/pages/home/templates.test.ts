/** templates(M2)· 占位符定位与库形状 */
import { describe, expect, it } from "vitest";

import {
  CHAT_SCENES,
  CREATE_SCENES,
  nextPlaceholder,
  placeholderRange,
} from "./templates";

describe("placeholderRange", () => {
  it("定位第一个【…】(含括号)", () => {
    const t = "帮我做一个【产品名】的落地页,突出【核心卖点】";
    const r = placeholderRange(t);
    expect(r).not.toBeNull();
    expect(t.slice(r!.start, r!.end)).toBe("【产品名】");
  });

  it("from 之后找下一个;无闭括号/无占位符 → null", () => {
    const t = "A【一】B【二】C";
    const first = placeholderRange(t)!;
    const second = placeholderRange(t, first.end)!;
    expect(t.slice(second.start, second.end)).toBe("【二】");
    expect(placeholderRange("没有占位符")).toBeNull();
    expect(placeholderRange("残缺【没闭")).toBeNull();
  });

  it("nextPlaceholder 到尾回绕到头", () => {
    const t = "A【一】B【二】C";
    const second = placeholderRange(t, 4)!;
    const wrapped = nextPlaceholder(t, second.end)!;
    expect(t.slice(wrapped.start, wrapped.end)).toBe("【一】");
  });
});

describe("模板库形状(V2 H-03:每 kind 3-5 条;Create 场景绑定 kind)", () => {
  it("chat 4 场景,每场景 3-5 条,模板均含占位符", () => {
    expect(CHAT_SCENES).toHaveLength(4);
    for (const s of CHAT_SCENES) {
      expect(s.templates.length).toBeGreaterThanOrEqual(3);
      expect(s.templates.length).toBeLessThanOrEqual(5);
      for (const t of s.templates) expect(placeholderRange(t.text)).not.toBeNull();
    }
  });

  it("create 3 场景各绑定 kind 真参数", () => {
    expect(CREATE_SCENES.map((s) => s.kind)).toEqual(["skill", "prompt", "python_tool"]);
  });
});
