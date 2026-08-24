/**
 * CoworkStates · Cowork 看板共用状态呈现(R5 修复轮 · 复审 Fix 1/Fix 2/Fix 3)
 *
 * HikerPage 展示层碎片:
 *  · resolveDashboardFullState:整面态裁决(加载 / 未连接 / 失败,零演示数字)——
 *    刻意是普通函数而非 JSX 组件,调用方要拿到真正的 `null`(而非「渲染为 null 的元素」永远
 *    truthy)去判断「要不要整面呈现」。
 *  · DashboardRefreshBadge:页头内联「刷新中…」指示(细环 spinner,Fix 3 iris 字面量已 token 化)。
 *  · DashboardRefreshErrorChip:刷新失败但仍保留旧快照时的紧凑页头提示(Fix 2)。
 *  · DashboardShell:两页共用的 ir-cowork 根壳(滚动区 + 整面态卡片 + 内容栈 + 副驾挂载点)。
 */

import type { ReactNode } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { dashboardFailKind } from "./snapshotView";
import { hhmm, type RefreshError } from "./useDashboardRun";

/* ---------------- 整面态(首取 loading / 未连接 / 失败) ---------------- */

export interface DashboardFullStateArgs {
  loading: boolean;
  hasSnapshot: boolean;
  status: string;
  errorCode: string;
  errorMessage: string;
  loadingText: string;
  /** offline 文案里的连接对象名 */
  offlineNoun: string;
}

export function resolveDashboardFullState({
  loading,
  hasSnapshot,
  status,
  errorCode,
  errorMessage,
  loadingText,
  offlineNoun,
}: DashboardFullStateArgs): ReactNode | null {
  if (loading && !hasSnapshot) {
    return <StateNote kind="loading" text={loadingText} />;
  }
  if (status === "failed") {
    return dashboardFailKind(errorCode, errorMessage) === "offline" ? (
      <StateNote
        kind="offline"
        text={`尚未连接 ${offlineNoun} · 看板将在接通后呈现真实数据，不做演示数字（${errorCode || "not_connected"}）`}
      />
    ) : (
      <StateNote kind="error" text={errorMessage || errorCode || "看板运行失败"} />
    );
  }
  return null;
}

/* ---------------- 页头内联刷新 spinner(Fix 3:iris 字面量 → token 化) ---------------- */

export function DashboardRefreshBadge() {
  return (
    <span className="ir-cwk-head__refreshing">
      <span className="anna-spin ir-cwk-spinner" />
      刷新中……
    </span>
  );
}

/* ---------------- 刷新失败但保留旧快照:紧凑页头 chip(Fix 2) ---------------- */

/** 摘要:优先 error_code,否则 connection message,裁剪避免页头过长(真值 only,不编造)。 */
function summarizeRefreshError(error: RefreshError): string {
  const raw = error.code || error.message || "未知错误";
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
}

export function DashboardRefreshErrorChip({
  error,
  loadedAt,
}: {
  error: RefreshError;
  loadedAt: Date | null;
}) {
  const tone = dashboardFailKind(error.code, error.message) === "offline" ? "warn" : "danger";
  return (
    <div className={`ir-cwk-head__refresh-err ir-cwk-head__refresh-err--${tone}`}>
      刷新失败 · {summarizeRefreshError(error)} · 数据仍为 {hhmm(loadedAt)} 快照
    </div>
  );
}

/* ---------------- 页根壳:ir-cowork 包裹 + 整面态卡片 + 内容栈 + 副驾挂载点 ---------------- */

export function DashboardShell({
  squeeze,
  header,
  fullState,
  hasView,
  slideOver,
  children,
}: {
  squeeze: boolean;
  header: ReactNode;
  fullState: ReactNode | null;
  hasView: boolean;
  slideOver: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`ir-cowork${squeeze ? " ir-cowork--squeeze" : ""}`}>
      <div className="ir-cowork__scroll">
        {fullState ? header : null}
        {fullState && (
          <div className="ir-cowork__state">
            <div className="ir-cowork__state-card">{fullState}</div>
          </div>
        )}

        {hasView && (
          <div className="ir-cowork__stack">
            {header}
            {children}
          </div>
        )}
      </div>

      {slideOver}
    </div>
  );
}
