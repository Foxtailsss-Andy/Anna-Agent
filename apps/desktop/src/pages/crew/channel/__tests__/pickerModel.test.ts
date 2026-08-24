/**
 * pickerModel · R4a @拾取器纯函数测试
 * 覆盖:花名册过滤(随「An」实时过滤)· ↑↓ 循环回绕 · 光标处 @partial 侦测
 *      · 以 @名 替换 partial 的光标插入 · @ 成员 pill 补前导空格。
 */
import { describe, expect, it } from "vitest";

import {
  activeMentionQuery,
  cycleIndex,
  filterMembers,
  insertAtSign,
  insertMentionAtCaret,
  toPickerMember,
  withAnnaCoordinator,
} from "../pickerModel";

const roster = [
  { id: "a1", name: "Andy", isAgent: false },
  { id: "a2", name: "Anna·Design", isAgent: true },
  { id: "a3", name: "Bob", isAgent: false },
  { id: "a4", name: "Agent·Scribe", isAgent: true },
];

describe("filterMembers(随 @ 后文本实时过滤,保持花名册序)", () => {
  it("「An」→ 命中 Andy / Anna·Design(保持原序)", () => {
    expect(filterMembers(roster, "An").map((m) => m.id)).toEqual(["a1", "a2"]);
  });
  it("大小写不敏感", () => {
    expect(filterMembers(roster, "bob").map((m) => m.id)).toEqual(["a3"]);
    expect(filterMembers(roster, "SCRIBE").map((m) => m.id)).toEqual(["a4"]);
  });
  it("空 query → 整册", () => {
    expect(filterMembers(roster, "").map((m) => m.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(filterMembers(roster, "   ")).toHaveLength(4);
  });
  it("无匹配 → 空(浮层将安静收起)", () => {
    expect(filterMembers(roster, "zzz")).toEqual([]);
  });
});

describe("cycleIndex(↑↓ 循环回绕)", () => {
  it("下行到底回 0", () => {
    expect(cycleIndex(3, 2, 1)).toBe(0);
    expect(cycleIndex(3, 0, 1)).toBe(1);
  });
  it("上行到顶回末位", () => {
    expect(cycleIndex(3, 0, -1)).toBe(2);
    expect(cycleIndex(3, 2, -1)).toBe(1);
  });
  it("空列表 → 0", () => {
    expect(cycleIndex(0, 0, 1)).toBe(0);
  });
});

describe("activeMentionQuery(光标处的 @partial)", () => {
  it("行首 @ + partial", () => {
    expect(activeMentionQuery("@An", 3)).toEqual({ at: 0, query: "An" });
  });
  it("空白后 @(空 query)", () => {
    expect(activeMentionQuery("你好 @", 4)).toEqual({ at: 3, query: "" });
  });
  it("@ 与光标间有空白 → 非活跃(片段已结束)", () => {
    expect(activeMentionQuery("@Andy 说", 7)).toBeNull();
  });
  it("邮箱 a@b 不误触发(@ 前是词字)", () => {
    expect(activeMentionQuery("x@host", 6)).toBeNull();
  });
  it("无 @ → null", () => {
    expect(activeMentionQuery("纯文本", 3)).toBeNull();
  });
  it("光标只覆盖到 partial 中段", () => {
    // "请 @And|y" 光标在 And 后
    expect(activeMentionQuery("请 @Andy", 6)).toEqual({ at: 2, query: "And" });
  });
});

describe("insertMentionAtCaret(以 @名 替换 partial)", () => {
  it("替换正在键入的 @partial,尾随空格,光标随之", () => {
    const r = insertMentionAtCaret("请 @An", 5, "Andy");
    expect(r.text).toBe("请 @Andy ");
    expect(r.caret).toBe(r.text.length);
  });
  it("保留 partial 之后的文本", () => {
    const r = insertMentionAtCaret("@An 开始", 3, "Andy");
    expect(r.text).toBe("@Andy  开始");
    expect(r.caret).toBe("@Andy ".length);
  });
  it("无活跃片段 → 光标处插入", () => {
    const r = insertMentionAtCaret("你好", 2, "Andy");
    expect(r.text).toBe("你好@Andy ");
  });
  it("含「·」的 Agent 名照样插入", () => {
    const r = insertMentionAtCaret("@Ag", 3, "Agent·Scribe");
    expect(r.text).toBe("@Agent·Scribe ");
  });
});

describe("insertAtSign(@ 成员 pill → 光标插 @)", () => {
  it("词字后补前导空格", () => {
    expect(insertAtSign("你好", 2)).toEqual({ text: "你好 @", caret: 4 });
  });
  it("空白后直接插 @", () => {
    expect(insertAtSign("你好 ", 3)).toEqual({ text: "你好 @", caret: 4 });
  });
  it("空文本直接插 @", () => {
    expect(insertAtSign("", 0)).toEqual({ text: "@", caret: 1 });
  });
});

describe("toPickerMember(TeamMember → 行)", () => {
  it("agent 判定 + 名回退 id", () => {
    expect(
      toPickerMember({ id: "x", workspace_id: "w", email: "", display_name: "", role: "设计", kind: "agent" }),
    ).toEqual({ id: "x", name: "x", role: "设计", isAgent: true });
    expect(
      toPickerMember({ id: "y", workspace_id: "w", email: "", display_name: "Andy", role: "工程", kind: "human" }),
    ).toEqual({ id: "y", name: "Andy", role: "工程", isAgent: false });
  });
});

describe("withAnnaCoordinator(系统 Anna 协调入口)", () => {
  it("在真实成员前稳定加入 Anna,且不与真实 anna id 冲突", () => {
    const rows = withAnnaCoordinator([
      { id: "anna", workspace_id: "w", email: "", display_name: "Anna Account", role: "人", kind: "human" },
      { id: "acc_agent", workspace_id: "w", email: "", display_name: "Agent·Check", role: "验收", kind: "agent" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["anna", "acc_agent"]);
    expect(rows[0]).toEqual({
      id: "anna",
      name: "Anna",
      role: "协调者",
      isAgent: false,
      isCoordinator: true,
    });
  });
});
