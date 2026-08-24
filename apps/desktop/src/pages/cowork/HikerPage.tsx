/**
 * HikerPage · Cowork Hiker 客户与合同看板(五段式 · 真快照)— R5 Task 4(修复轮 R5-Fix 已抽共用管道)
 *
 * 段序(不动):页头(ProvenanceLine 来源 = Hiker MCP,只读,无 period)→ AlertBand(risk 计数)
 *   → KPI 带 → 回款进度 / 账龄(MetricBar)→ top_customers ir-table(宽表自身横向滚动)→ anomalies 洞察。
 * 状态裁决见 useDashboardRun.ts;追问 → SlideOverCopilot target="hiker"。
 */

import { useCallback, useState } from "react";

import {
  AlertBand,
  ChartCard,
  InsightCard,
  KpiCard,
  MetricBar,
  ProvenanceLine,
} from "../../components/cowork/DashboardKit";
import { createHikerDashboardRun } from "../../lib/api/hiker";
import { hikerView } from "./snapshotView";
import { SlideOverCopilot } from "./SlideOverCopilot";
import { DashboardRefreshBadge, DashboardRefreshErrorChip, DashboardShell, resolveDashboardFullState } from "./CoworkStates";
import { hhmm, str, useDashboardRun } from "./useDashboardRun";
import "./cowork.css";

export function HikerPage() {
  const [copilot, setCopilot] = useState<{ open: boolean; question: string }>({ open: false, question: "" });

  const { run, loading, loadedAt, refreshError, load } = useDashboardRun(() => createHikerDashboardRun());

  const refresh = useCallback(() => load(() => createHikerDashboardRun(), true), [load]);
  const ask = useCallback((question: string) => setCopilot({ open: true, question }), []);
  const closeCopilot = useCallback(() => setCopilot((c) => ({ ...c, open: false })), []);

  const status = str(run?.status);
  const snapshot = (run?.snapshot ?? null) as Parameters<typeof hikerView>[0] | null;
  const errorCode = str(run?.error_code);
  const errorMessage = str(run?.error_message);

  const fullState = resolveDashboardFullState({
    loading,
    hasSnapshot: !!snapshot,
    status,
    errorCode,
    errorMessage,
    loadingText: "正在装载 Hiker 看板",
    offlineNoun: "Hiker",
  });

  const view = snapshot && status !== "failed" ? hikerView(snapshot) : null;
  const provText = `数据来源：Hiker MCP（只读）· 更新于 ${hhmm(loadedAt)} · 由代码计算，非模型生成`;

  const header = (
    <div className="ir-cwk-head">
      <div className="ir-cwk-head__eyebrow">COWORK · Hiker 客户与合同</div>
      <div className="ir-cwk-head__row">
        <span className="ir-cwk-head__title">客户与合同看板</span>
        <button type="button" className="ir-cwk-refresh" onClick={refresh} disabled={loading}>
          刷新
        </button>
        {loading && <DashboardRefreshBadge />}
      </div>
      <ProvenanceLine text={provText} />
      {refreshError && <DashboardRefreshErrorChip error={refreshError} loadedAt={loadedAt} />}
    </div>
  );

  return (
    <DashboardShell
      squeeze={copilot.open}
      header={header}
      fullState={fullState}
      hasView={!!view}
      slideOver={<SlideOverCopilot open={copilot.open} question={copilot.question} target="hiker" onClose={closeCopilot} />}
    >
      {view && (
        <>
          {/* ① 回款风险警示带 */}
          {view.alert && (
            <AlertBand onAsk={() => ask("请列出已逾期回款的客户与合同明细，并给出催收优先级")}>
              <span className="ir-cwk-alert__title">{view.alert.title}</span>
              <span className="ir-cwk-alert__exp"> · {view.alert.explanation}</span>
            </AlertBand>
          )}

          {/* ② KPI 带 */}
          {view.kpis.length > 0 && (
            <div className="ir-cwk-kpis">
              {view.kpis.map((k) => (
                <div key={k.id} className={`ir-cwk-kpis__cell${k.hero ? " ir-cwk-kpis__cell--hero" : ""}`}>
                  <KpiCard label={k.label} value={k.value} hero={k.hero} />
                </div>
              ))}
            </div>
          )}

          {/* ③ 回款进度 + 账龄 */}
          {(view.collection.length > 0 || view.aging.length > 0) && (
            <div className="ir-cwk-charts">
              {view.collection.length > 0 && (
                <div className="ir-cwk-charts__side">
                  <ChartCard title="回款进度" metaText="计划、实收、未收">
                    <div className="ir-cwk-bars">
                      {view.collection.map((b) => (
                        <MetricBar key={b.name} name={b.name} valueText={b.valueText} ratio={b.ratio} tone={b.tone} />
                      ))}
                    </div>
                  </ChartCard>
                </div>
              )}
              {view.aging.length > 0 && (
                <div className="ir-cwk-charts__side">
                  <ChartCard title="账龄分布" metaText={`${view.aging.length} 档`}>
                    <div className="ir-cwk-bars">
                      {view.aging.map((b) => (
                        <MetricBar key={b.name} name={b.name} valueText={b.valueText} ratio={b.ratio} tone={b.tone} />
                      ))}
                    </div>
                  </ChartCard>
                </div>
              )}
            </div>
          )}

          {/* ④ top_customers 宽表(自身横向滚动) */}
          {view.topCustomers.rows.length > 0 && (
            <div>
              <div className="ir-cwk-section-label" style={{ marginBottom: 6 }}>重点客户</div>
              <div className="ir-table">
                <table className="ir-table__el">
                  <thead>
                    <tr>{view.topCustomers.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {view.topCustomers.rows.map((row, i) => (
                      <tr key={row[0] + String(i)}>
                        {row.map((cell, j) => <td key={j}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ⑤ anomalies 洞察 */}
          {view.insights.length > 0 && (
            <div className="ir-cwk-insights">
              {view.insights.map((i) => (
                <InsightCard key={i.id} title={i.title}>
                  <span className="ir-cwk-insight-item__body">{i.explanation}</span>
                </InsightCard>
              ))}
            </div>
          )}
        </>
      )}
    </DashboardShell>
  );
}

export default HikerPage;
