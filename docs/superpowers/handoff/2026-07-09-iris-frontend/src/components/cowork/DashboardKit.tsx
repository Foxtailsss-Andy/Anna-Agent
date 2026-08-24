/**
 * DashboardKit · Cowork 看板五段式套件(《设计说明 · Iris》§7;高保真:设计画布 5c)
 *
 * 五段式(顺序不动):
 *   ① AlertBand 焦点警示带(琥珀书脊,「向 Anna 追问」接副驾并注入问题)
 *   ② KpiCard 带(hero = 鸢尾描边 + 左上花晕,全屏唯一强调卡;含 Sparkline)
 *   ③ ChartCard 图表行(TrendChart / MetricBar;渐变一律收于透明)
 *   ④ InsightCard 洞察 + 建议动作(AskChip = iris tinted,target 注入副驾)
 *   ⑤ ReadingFold「Anna 解读」可折叠(阅读版式 68ch)
 *
 * 纪律:ProvenanceLine 必在(「由代码计算,非模型生成」);
 * 未连接 ERP → 整面走 StateNote offline,不做演示数字。
 */

import { useId, useState } from 'react';
import './DashboardKit.css';

/* ---------------- ProvenanceLine ---------------- */

export function ProvenanceLine({ text }: { text: string }) {
  return <div className="dbk-prov">{text}</div>;
}

/* ---------------- ① 焦点警示带 ---------------- */

export interface AlertBandProps {
  label?: string;
  children: React.ReactNode;
  askLabel?: string;
  onAsk?: () => void;
}

export function AlertBand({ label = '最需关注', children, askLabel = '向 Anna 追问', onAsk }: AlertBandProps) {
  return (
    <div className="dbk-alert">
      <span className="dbk-alert__spine" aria-hidden="true" />
      <div className="dbk-alert__body">
        <span className="dbk-alert__label">{label}</span>
        <span className="dbk-alert__text">{children}</span>
        {onAsk && (
          <span className="dbk-alert__ask">
            <button type="button" className="dbk-ask" onClick={onAsk}>{askLabel}</button>
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------------- 追问 chip ---------------- */

export function AskChip({ label = '追问', small = false, onClick }: { label?: string; small?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`dbk-ask${small ? ' dbk-ask--sm' : ''}`} onClick={onClick}>{label}</button>
  );
}

/* ---------------- Sparkline(渐变收于透明) ---------------- */

function sparkPath(values: number[], w: number, h: number, pad = 3): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');
}

export function Sparkline({ values, height = 30 }: { values: number[]; height?: number }) {
  const id = useId().replace(/:/g, '');
  const w = 220;
  const line = sparkPath(values, w, height);
  return (
    <svg className="dbk-kpi__spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="var(--iris)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--iris)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w} ${height} L0 ${height} Z`} fill={`url(#sp${id})`} />
      <path d={line} stroke="var(--iris)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------- ② KPI 卡 ---------------- */

export interface KpiCardProps {
  label: string;
  value: string;
  deltaText?: string;
  deltaTone?: 'ok' | 'warn' | 'neutral';
  hero?: boolean;
  /** 仅 hero 建议携带 */
  spark?: number[];
}

export function KpiCard({ label, value, deltaText, deltaTone = 'neutral', hero = false, spark }: KpiCardProps) {
  const delta = deltaText && (
    <span className={`dbk-kpi__delta${deltaTone !== 'neutral' ? ` dbk-kpi__delta--${deltaTone}` : ''}`}>{deltaText}</span>
  );
  return (
    <div className={`dbk-kpi${hero ? ' dbk-kpi--hero' : ''}`}>
      <div className="dbk-kpi__label">{label}</div>
      {hero ? (
        <div className="dbk-kpi__row"><span className="dbk-kpi__value">{value}</span>{delta}</div>
      ) : (
        <>
          <div className="dbk-kpi__value">{value}</div>
          {delta}
        </>
      )}
      {spark && <Sparkline values={spark} />}
    </div>
  );
}

/* ---------------- ③ 图表卡壳 + 趋势图 + 指标条 ---------------- */

export interface ChartCardProps {
  title: string;
  metaText?: string;
  legend?: { label: string; color: string }[];
  children: React.ReactNode;
}

export function ChartCard({ title, metaText, legend, children }: ChartCardProps) {
  return (
    <div className="dbk-chart">
      <div className="dbk-chart__head">
        <span className="dbk-chart__title">{title}</span>
        {metaText && <span className="dbk-chart__meta">{metaText}</span>}
      </div>
      <div className="dbk-chart__body">{children}</div>
      {legend && (
        <div className="dbk-chart__legend">
          {legend.map((l) => (
            <span key={l.label}>
              <span className="dbk-chart__legend-swatch" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface TrendSeries {
  label: string;
  /** 建议:主序列 var(--iris),对照序列 var(--gold) */
  color: string;
  values: number[];
  /** 首序列可开面积填充(渐变收于透明) */
  area?: boolean;
}

export function TrendChart({ series, height = 150 }: { series: TrendSeries[]; height?: number }) {
  const id = useId().replace(/:/g, '');
  const w = 420;
  const all = series.flatMap((s) => s.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const toPath = (values: number[]) =>
    values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * w).toFixed(1)} ${(height - 10 - ((v - min) / span) * (height - 30)).toFixed(1)}`)
      .join(' ');
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ display: 'block', minHeight: 120 }} aria-hidden="true">
      <defs>
        <linearGradient id={`tr${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="var(--iris)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--iris)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {series.map((s, i) => (
        <g key={s.label}>
          {s.area && i === 0 && (
            <path d={`${toPath(s.values)} L${w} ${height} L0 ${height} Z`} fill={`url(#tr${id})`} />
          )}
          <path d={toPath(s.values)} stroke={s.color} strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
      ))}
      <line x1="0" y1={height - 1} x2={w} y2={height - 1} stroke="var(--line)" />
    </svg>
  );
}

export interface MetricBarProps {
  name: string;
  /** mono 账本值,如 "¥121,000 · 47 天" */
  valueText: string;
  /** 0–1 */
  ratio: number;
  tone?: 'iris' | 'warn';
}

export function MetricBar({ name, valueText, ratio, tone = 'iris' }: MetricBarProps) {
  return (
    <div className="dbk-bar">
      <div className="dbk-bar__head">
        <span>{name}</span>
        <span className="dbk-bar__meta">{valueText}</span>
      </div>
      <div className="dbk-bar__track">
        <span className={`dbk-bar__fill dbk-bar__fill--${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}

/* ---------------- ④ 洞察卡 ---------------- */

export function InsightCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dbk-insight">
      <div className="dbk-insight__title">{title}</div>
      <div className="dbk-insight__row">{children}</div>
    </div>
  );
}

/* ---------------- ⑤ Anna 解读(可折叠) ---------------- */

export function ReadingFold({ title = 'Anna 解读', defaultOpen = false, children }: { title?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="dbk-reading">
      <button type="button" className="dbk-reading__btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="dbk-reading__caret">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      <div className={`dbk-reading__lift${open ? ' is-open' : ''}`}>
        <div><div className="dbk-reading__body">{children}</div></div>
      </div>
    </div>
  );
}
