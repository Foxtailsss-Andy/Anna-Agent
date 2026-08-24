/**
 * interjectNotes(J3 前端)· 插话没送到时,回执必须是实话
 *
 * 插话的整条价值就是「话确实到了正在跑的这次 run」。没到的时候,回退文案是用户
 * 唯一的凭据 —— 它说错一个字,产品就在骗人。这里钉的全是**不许说假话**。
 */
import { describe, expect, it } from "vitest";

import {
  CHANNEL_PENDING_NOTE,
  UNDELIVERED_NOTE,
  interjectRejectedNote,
  restoredDraft,
} from "./interjectNotes";

describe("restoredDraft · 「话先还给你了」必须真的还回去", () => {
  it("输入框空着 → 原样还回", () => {
    expect(restoredDraft("", "帮我加一句结论")).toBe("帮我加一句结论");
    expect(restoredDraft("   ", "帮我加一句结论")).toBe("帮我加一句结论");
  });

  it("这段时间用户又打了字 → 追加,绝不丢掉那句插话", () => {
    // 旧实现是 `prev.trim() ? prev : text` —— 提示说「话先还给你了」,
    // 而那句话其实被静默丢弃了。
    expect(restoredDraft("我再想想", "帮我加一句结论")).toBe("我再想想\n帮我加一句结论");
  });

  it("追加后两句都在(不许任何一句消失)", () => {
    const out = restoredDraft("已有草稿", "补充指示");
    expect(out).toContain("已有草稿");
    expect(out).toContain("补充指示");
  });
});

describe("interjectRejectedNote · 终态各说各的,没有万能的「办完」", () => {
  it("ready / saved → 确实是办完了", () => {
    expect(interjectRejectedNote("ready")).toContain("办完");
    expect(interjectRejectedNote("saved")).toContain("办完");
  });

  it("failed → 说失败,绝不说办完", () => {
    const note = interjectRejectedNote("failed");
    expect(note).toContain("失败");
    expect(note).not.toContain("办完");
  });

  it("interrupted → 说已停止,绝不说办完", () => {
    const note = interjectRejectedNote("interrupted");
    expect(note).toContain("已停止");
    expect(note).not.toContain("办完");
  });

  it("没见过的状态 → 原样回显后端说法,不猜也不美化", () => {
    const note = interjectRejectedNote("zombie");
    expect(note).toContain("zombie");
    expect(note).not.toContain("办完");
  });

  it("后端没给状态 → 说不清楚,同样不许说办完", () => {
    const note = interjectRejectedNote("");
    expect(note).not.toContain("办完");
    expect(note.length).toBeGreaterThan(0);
  });

  it("每一条都交代话去哪了(回退的唯一凭据)", () => {
    for (const status of ["ready", "saved", "failed", "interrupted", "zombie", ""]) {
      expect(interjectRejectedNote(status)).toMatch(/输入框|新的一轮/);
    }
  });
});

describe("固定回执文案", () => {
  it("通道还没建好 → 明说这句还在输入框里(旧实现是零反馈)", () => {
    expect(CHANNEL_PENDING_NOTE).toContain("输入框");
    expect(CHANNEL_PENDING_NOTE).toContain("回车");
  });

  it("网络没送达 → 不假装送到了", () => {
    expect(UNDELIVERED_NOTE).toContain("没送达");
  });
});
