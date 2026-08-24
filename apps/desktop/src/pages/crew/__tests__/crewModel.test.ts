/** crewModel · 纯函数(进度 x/y · 未读徽标推导 · 健康计数)—— 零捏造:计数为零可隐藏 */
import { describe, expect, it } from "vitest";

import {
  awaitingCount,
  deriveUnreadBadge,
  projectProgress,
  runningCount,
} from "../crewModel";

const T = (status: string) => ({ status });

describe("projectProgress(x=done 任务数 / y=总任务数)", () => {
  it("统计 done 与总数,label = x/y", () => {
    const tasks = [T("done"), T("done"), T("done"), T("running"), T("todo"), T("assigned"), T("blocked")];
    expect(projectProgress(tasks)).toEqual({ done: 3, total: 7, label: "3/7" });
  });

  it("空项目 → 0/0(不崩,label 0/0)", () => {
    expect(projectProgress([])).toEqual({ done: 0, total: 0, label: "0/0" });
  });

  it("全部完成 → x=y", () => {
    expect(projectProgress([T("done"), T("done")])).toMatchObject({ done: 2, total: 2, label: "2/2" });
  });
});

describe("deriveUnreadBadge(0/接口失败 → 隐藏,绝不造数)", () => {
  it("计数为 0 → null(隐藏徽标)", () => {
    expect(deriveUnreadBadge(0)).toBeNull();
  });

  it("接口失败(null/undefined)→ null(隐藏徽标,不造数)", () => {
    expect(deriveUnreadBadge(null)).toBeNull();
    expect(deriveUnreadBadge(undefined)).toBeNull();
  });

  it("正数 → 字符串;>99 收敛为 99+", () => {
    expect(deriveUnreadBadge(2)).toBe("2");
    expect(deriveUnreadBadge(99)).toBe("99");
    expect(deriveUnreadBadge(128)).toBe("99+");
  });

  it("负数(异常)按 0 处理 → null", () => {
    expect(deriveUnreadBadge(-3)).toBeNull();
  });
});

describe("健康条计数(零值 chip 隐藏由调用方按 0 判定)", () => {
  it("runningCount = status==running 的任务数", () => {
    expect(runningCount([T("running"), T("running"), T("done"), T("todo")])).toBe(2);
    expect(runningCount([T("done"), T("todo")])).toBe(0);
  });

  it("awaitingCount = 待审(submitted|in_review)任务数", () => {
    expect(awaitingCount([T("submitted"), T("in_review"), T("done"), T("running")])).toBe(2);
    expect(awaitingCount([T("running"), T("todo")])).toBe(0);
  });
});
