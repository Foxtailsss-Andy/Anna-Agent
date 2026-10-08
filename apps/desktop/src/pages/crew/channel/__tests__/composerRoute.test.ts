/**
 * composerSendRoute · Crew composer 的 Enter / 纸飞机路由(review C2)。
 * 有结构化提及非 Anna 成员 → 发频道(与「发频道」同一 mentions 解析);否则 → 问 Anna。
 */
import { describe, expect, it } from "vitest";

import type { TeamMember } from "../../../../lib/api/crew";
import { composerSendRoute } from "../composerRoute";

const members: TeamMember[] = [
  { id: "acc_andy", workspace_id: "w", email: "", display_name: "Andy", role: "工程", kind: "human" },
  { id: "acc_design", workspace_id: "w", email: "", display_name: "Agent·Design", role: "设计", kind: "agent" },
];

describe("composerSendRoute", () => {
  it("picker-inserted @Andy still in the text → channel", () => {
    expect(composerSendRoute("@Andy 看一下登录页", [{ id: "acc_andy", name: "Andy" }], members)).toBe("channel");
  });

  it("typed exact @display_name of a roster member (no picker) → channel", () => {
    expect(composerSendRoute("请 @Agent·Design 出一版稿", [], members)).toBe("channel");
  });

  it("plain question without mentions → anna", () => {
    expect(composerSendRoute("这个项目现在卡在哪？", [], members)).toBe("anna");
  });

  it("only @Anna → anna (Anna is the coordinator, not a channel member)", () => {
    expect(composerSendRoute("@Anna 帮我总结进度", [{ id: "anna", name: "Anna" }], members)).toBe("anna");
  });

  it("@Anna together with a member → channel", () => {
    expect(composerSendRoute("@Anna @Andy 一起看看", [], members)).toBe("channel");
  });

  it("picker-inserted mention later deleted from the text → anna", () => {
    expect(composerSendRoute("算了，直接问", [{ id: "acc_andy", name: "Andy" }], members)).toBe("anna");
  });

  it("@name that is not on the roster is dead text → anna", () => {
    expect(composerSendRoute("@Bob 在吗", [], members)).toBe("anna");
  });

  it("a roster row that reuses the system Anna id is not treated as a member", () => {
    const withAnnaRow: TeamMember[] = [
      ...members,
      { id: "anna", workspace_id: "w", email: "", display_name: "安娜", role: "", kind: "agent" },
    ];
    expect(composerSendRoute("@安娜 你好", [], withAnnaRow)).toBe("anna");
  });
});
