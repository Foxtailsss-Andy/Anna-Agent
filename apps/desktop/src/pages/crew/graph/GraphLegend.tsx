/**
 * GraphLegend · 右下「图例」pill(1a 底栏)+ 图语汇速查卡
 *
 * 卡内是词表(章形状=状态,色盲安全),非数据 —— 与 1c 图语汇一字一致。
 */

import { useState } from "react";

function LegendBadge({ mod }: { mod: string }) {
  return <span className={`crewg-badge crewg-badge--${mod} crewg-legend__badge`} aria-hidden="true" />;
}

const STATES: { mod: string; label: string }[] = [
  { mod: "pending", label: "待就绪" },
  { mod: "ready", label: "就绪待认领" },
  { mod: "running", label: "执行中" },
  { mod: "review", label: "已提交待审" },
  { mod: "blocked", label: "阻塞" },
  { mod: "rework", label: "返工" },
  { mod: "done", label: "完成" },
];

const GATES: { mod: string; label: string }[] = [
  { mod: "dormant", label: "门 · 待就绪" },
  { mod: "active", label: "门 · 活跃（金线）" },
  { mod: "passed", label: "门 · 已通过" },
];

const EDGES: { mod: string; label: string }[] = [
  { mod: "powered", label: "已通电" },
  { mod: "dormant", label: "休眠" },
  { mod: "flow", label: "供电流（唯一流动）" },
  { mod: "rework", label: "返工回路" },
];

export function GraphLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="crewg-legend">
      {open && (
        <div className="crewg-legend__card" role="note" aria-label="图语汇">
          <div className="crewg-legend__sect">节点七态 · 章形状即状态</div>
          {STATES.map((s) => (
            <div key={s.mod} className="crewg-legend__row">
              {s.mod === "running" ? (
                <span className="crewg-badge crewg-badge--running crewg-legend__badge" aria-hidden="true">
                  <span className="crewg-badge__innerring" />
                </span>
              ) : (
                <LegendBadge mod={s.mod} />
              )}
              <span>{s.label}</span>
            </div>
          ))}
          <div className="crewg-legend__sect">评审门 ◇</div>
          {GATES.map((g) => (
            <div key={g.mod} className="crewg-legend__row">
              <span className={`crewg-legend__gate crewg-legend__gate--${g.mod}`} aria-hidden="true" />
              <span>{g.label}</span>
            </div>
          ))}
          <div className="crewg-legend__sect">依赖边</div>
          {EDGES.map((e) => (
            <div key={e.mod} className="crewg-legend__row">
              <svg width="34" height="8" viewBox="0 0 34 8" aria-hidden="true" className={`crewg-legend__edge crewg-legend__edge--${e.mod}`}>
                <path d="M1 4 H29" />
                <circle cx="31" cy="4" r="2" />
              </svg>
              <span>{e.label}</span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`crewg-pillbtn${open ? " crewg-pillbtn--on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M5 19V9M12 19V5M19 19v-7" />
        </svg>
        图例
      </button>
    </div>
  );
}

export default GraphLegend;
