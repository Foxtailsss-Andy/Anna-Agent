/**
 * friendlyError · C5 错误人话契约
 *   C2 codes → 场景化中文;未知 code 回落 detail;非 JSON 回落原 body;非 ApiError → String(e)。
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "../../../../lib/api/client";
import { friendlyTaskError, statusWordCn } from "../friendlyError";

const apiErr = (status: number, body: string) => new ApiError(status, body);

describe("friendlyTaskError · ApiError → 人话", () => {
  it("task_not_startable(409)→ 场景化人话,带状态词", () => {
    const msg = friendlyTaskError(
      apiErr(409, JSON.stringify({ detail: "raw", code: "task_not_startable", task_status: "submitted" })),
    );
    expect(msg).toContain("待审"); // statusWordCn(submitted)
    expect(msg).toContain("开始");
    expect(msg).not.toContain("raw"); // 不再裸吐 detail
  });

  it("task_not_runnable(409)→ 场景化人话", () => {
    const msg = friendlyTaskError(
      apiErr(409, JSON.stringify({ code: "task_not_runnable", task_status: "done" })),
    );
    expect(msg).toContain("已完成");
    expect(msg).toContain("不可执行");
  });

  it("task_is_gate(409)→ 门专属人话(不用开始/不提交,直接评审)", () => {
    const msg = friendlyTaskError(
      apiErr(409, JSON.stringify({ detail: { code: "task_is_gate", task_status: "todo" } })),
    );
    expect(msg).toContain("评审门");
    expect(msg).toContain("通过或驳回");
  });

  it("task_not_assignable(409)→ 改派受阻人话(让执行者提交或频道协调)", () => {
    const msg = friendlyTaskError(
      apiErr(409, JSON.stringify({ detail: { code: "task_not_assignable", task_status: "running" } })),
    );
    expect(msg).toContain("改派");
    expect(msg).toContain("推进中");
    expect(msg).toContain("频道");
  });

  it("FastAPI 真实线上体:HTTPException(detail=dict) 双层嵌套也解得开", () => {
    // 实测 wire 形状:{"detail":{"detail":"…","code":"task_not_startable","task_status":"submitted"}}
    const wire = JSON.stringify({
      detail: { detail: "「设计稿」当前状态为待审,无法开始。", code: "task_not_startable", task_status: "submitted" },
    });
    const msg = friendlyTaskError(apiErr(409, wire));
    expect(msg).toContain("待审");
    expect(msg).toContain("无需手动开始");
  });

  it("已知 code 但缺 task_status → 无状态词也成句", () => {
    const msg = friendlyTaskError(apiErr(409, JSON.stringify({ code: "task_not_startable" })));
    expect(msg).toContain("开始");
  });

  it("未知 code → 回落 detail 原文", () => {
    expect(
      friendlyTaskError(apiErr(400, JSON.stringify({ detail: "别的错误", code: "whatever" }))),
    ).toBe("别的错误");
  });

  it("空 body(无可解析、无 detail)→ HTTP 状态兜底句", () => {
    expect(friendlyTaskError(apiErr(503, ""))).toContain("503");
  });

  it("非 JSON 体 → 回落原 body", () => {
    expect(friendlyTaskError(apiErr(500, "Internal Server Error"))).toBe("Internal Server Error");
  });

  it("非 ApiError → String(e)", () => {
    expect(friendlyTaskError(new Error("boom"))).toBe("Error: boom");
    expect(friendlyTaskError("plain string")).toBe("plain string");
  });
});

describe("statusWordCn · 原始状态 → 中文(precheck 复用同源)", () => {
  it("已知映射 / 未知回落原值 / 非串 → 空", () => {
    expect(statusWordCn("submitted")).toBe("待审");
    expect(statusWordCn("running")).toBe("执行中");
    expect(statusWordCn("done")).toBe("已完成");
    expect(statusWordCn("weird_status")).toBe("weird_status");
    expect(statusWordCn(null)).toBe("");
    expect(statusWordCn(42)).toBe("");
  });
});
