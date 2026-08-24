/**
 * useDashboardRun · Cowork 看板通用数据机(R5 修复轮 · 复审 Fix 1/Fix 2)
 *
 * HikerPage 的「创建看板 run + 首取一次 + 刷新」状态机
 * 一份 ~30 行几乎相同的 load/fetchedRef 逻辑,现收敛到此处:
 *  · StrictMode 安全:fetchedRef 保证一次挂载只自动首取一次。
 *  · load(fetchRun, keepStale):fetchRun 现取(不缓存闭包),换期间等参数变化时由调用方
 *    传入携带最新参数的 fetchRun,避免闭包过期。
 *  · 刷新失败裁决(Fix 2,复审 Important #2):若已有「好」旧快照(run 非 failed),刷新失败
 *    不覆盖它 —— 保留旧 run,只在 refreshError 挂一条摘要供页头渲染紧凑 chip;
 *    首取失败(尚无好旧快照)才整面 offline/error(现状不变)。
 *  · 归约 nextDashboardState 是纯函数,脱离 DOM 可单测(见 useDashboardRun.test.ts),
 *    不引入测试 DOM 框架。
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

export type RunRecord = Record<string, unknown>;

export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** 更新于 HH:MM(本地时区);无值 → "—" */
export function hhmm(date: Date | null): string {
  if (!date) return "—";
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

export interface RefreshError {
  code: string;
  message: string;
}

export interface DashboardState {
  run: RunRecord | null;
  loading: boolean;
  loadedAt: Date | null;
  /** 刷新失败且已有好旧快照时挂载(紧凑 chip 态);下次 start/success 清空 */
  refreshError: RefreshError | null;
}

export type DashboardEvent =
  | { type: "start"; keepStale: boolean }
  | { type: "success"; run: RunRecord; at: Date }
  | { type: "failure"; run: RunRecord };

export const INITIAL_DASHBOARD_STATE: DashboardState = {
  run: null,
  loading: false,
  loadedAt: null,
  refreshError: null,
};

/** 好旧快照 = 有 run 且非 failed(合成的失败态 run 不算「好」)。 */
const hasGoodSnapshot = (run: RunRecord | null): boolean => !!run && str(run.status) !== "failed";

/**
 * 纯归约(Fix 2 核心裁决,可单测,不依赖 DOM/React)。
 *  · start:keepStale=false(首取 / 换数据集)→ 清空 run 进入整面 loading;
 *           keepStale=true(刷新)→ 保留 run,清旧 refreshError(新一轮尝试重新裁决)。
 *  · success:落地新 run、刷新 loadedAt、清 refreshError。
 *  · failure:若之前是「好」旧快照 → 保留旧 run 不变,只挂 refreshError(紧凑 chip);
 *            否则(首取失败 / 旧值本就是失败态)→ run 换成合成失败 run,整面 offline/error。
 */
export function nextDashboardState(prev: DashboardState, event: DashboardEvent): DashboardState {
  switch (event.type) {
    case "start":
      return {
        ...prev,
        run: event.keepStale ? prev.run : null,
        loading: true,
        refreshError: null,
      };
    case "success":
      return { run: event.run, loading: false, loadedAt: event.at, refreshError: null };
    case "failure":
      if (hasGoodSnapshot(prev.run)) {
        return {
          ...prev,
          loading: false,
          refreshError: { code: str(event.run.error_code), message: str(event.run.error_message) },
        };
      }
      return { run: event.run, loading: false, loadedAt: prev.loadedAt, refreshError: null };
    default:
      return prev;
  }
}

export interface UseDashboardRun extends DashboardState {
  /** loading 且仍有旧 run 挂着(区别于首取/换数据集的整面 loading) */
  refreshing: boolean;
  /** fetchRun 每次调用现取,由调用方携带最新参数(如期间) */
  load: (fetchRun: () => Promise<RunRecord>, keepStale: boolean) => void;
}

/** initialFetchRun 仅用于挂载时的自动首取一次;其闭包变化不重触发(参数变化由调用方显式 load()）。 */
export function useDashboardRun(initialFetchRun: () => Promise<RunRecord>): UseDashboardRun {
  const [state, dispatch] = useReducer(nextDashboardState, INITIAL_DASHBOARD_STATE);
  const fetchedRef = useRef(false); // 一次挂载只自动首取一次(StrictMode 安全)

  const load = useCallback((fetchRun: () => Promise<RunRecord>, keepStale: boolean) => {
    dispatch({ type: "start", keepStale });
    fetchRun()
      .then((r) => dispatch({ type: "success", run: r, at: new Date() }))
      .catch((e) => {
        // 网络/HTTP 层失败(非 200 业务失败):合成 error 态,原文如实
        dispatch({
          type: "failure",
          run: { status: "failed", error_code: "client_error", error_message: String(e) },
        });
      });
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    load(initialFetchRun, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { ...state, refreshing: state.loading && state.run !== null, load };
}
