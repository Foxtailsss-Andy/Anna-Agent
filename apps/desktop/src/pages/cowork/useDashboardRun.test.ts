import { describe, expect, it } from "vitest";

import { INITIAL_DASHBOARD_STATE, nextDashboardState } from "./useDashboardRun";
import type { DashboardState, RunRecord } from "./useDashboardRun";

/* R5 修复轮 · Fix 2:刷新失败不得覆盖已有的「好」旧快照,只挂紧凑 refreshError。
 * nextDashboardState 是抽出的纯归约,脱离 DOM 单测(不引入测试 DOM 框架)。 */

const GOOD_RUN: RunRecord = { status: "succeeded", snapshot: { period: "2026-06" } };
const FAILED_RUN: RunRecord = { status: "failed", error_code: "not_connected", error_message: "尚未连接" };

const stateWithGoodRun = (overrides: Partial<DashboardState> = {}): DashboardState => ({
  run: GOOD_RUN,
  loading: false,
  loadedAt: new Date("2026-07-10T10:00:00"),
  refreshError: null,
  ...overrides,
});

describe("nextDashboardState", () => {
  it("start(keepStale=false) 清空 run 并进入 loading(首取/换数据集)", () => {
    const next = nextDashboardState(stateWithGoodRun(), { type: "start", keepStale: false });
    expect(next.run).toBeNull();
    expect(next.loading).toBe(true);
    expect(next.refreshError).toBeNull();
  });

  it("start(keepStale=true) 保留旧 run,清掉旧 refreshError", () => {
    const prev = stateWithGoodRun({ refreshError: { code: "client_error", message: "上次失败" } });
    const next = nextDashboardState(prev, { type: "start", keepStale: true });
    expect(next.run).toBe(GOOD_RUN);
    expect(next.loading).toBe(true);
    expect(next.refreshError).toBeNull();
  });

  it("success 落地新 run、刷新 loadedAt、清 refreshError", () => {
    const at = new Date("2026-07-10T11:00:00");
    const newRun: RunRecord = { status: "succeeded", snapshot: { period: "2026-07" } };
    const next = nextDashboardState(
      stateWithGoodRun({ loading: true, refreshError: { code: "x", message: "y" } }),
      { type: "success", run: newRun, at },
    );
    expect(next.run).toBe(newRun);
    expect(next.loadedAt).toBe(at);
    expect(next.refreshError).toBeNull();
  });

  it("failure 且已有好旧快照(Fix 2 核心):保留旧 run 不变,只挂紧凑 refreshError", () => {
    const prev = stateWithGoodRun({ loading: true });
    const next = nextDashboardState(prev, {
      type: "failure",
      run: { status: "failed", error_code: "mcp_call_failed", error_message: "WinError 10061 actively refused" },
    });
    expect(next.run).toBe(GOOD_RUN); // 旧快照未被顶掉
    expect(next.loading).toBe(false);
    expect(next.loadedAt).toBe(prev.loadedAt); // 更新时间戳不回退
    expect(next.refreshError).toEqual({ code: "mcp_call_failed", message: "WinError 10061 actively refused" });
  });

  it("failure 且首取失败(无旧快照):整面替换为合成失败 run,不挂 refreshError", () => {
    const next = nextDashboardState(INITIAL_DASHBOARD_STATE, { type: "failure", run: FAILED_RUN });
    expect(next.run).toBe(FAILED_RUN);
    expect(next.refreshError).toBeNull();
  });

  it("failure 且旧值本就是失败态(重试仍失败):整面替换,不误判为「好旧快照」", () => {
    const prev: DashboardState = { run: FAILED_RUN, loading: true, loadedAt: null, refreshError: null };
    const nextFailed: RunRecord = { status: "failed", error_code: "not_found", error_message: "period not found" };
    const next = nextDashboardState(prev, { type: "failure", run: nextFailed });
    expect(next.run).toBe(nextFailed);
    expect(next.refreshError).toBeNull();
  });
});
