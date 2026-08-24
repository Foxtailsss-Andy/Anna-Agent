/**
 * SurfaceKit · P4 界面套件(《设计说明 · Iris》§7 + 设计画布 5e/5f)
 *
 * Create:
 *   CreateHero — 衬线「描述,即构建」+ 鸢尾光晕(白名单:hero=空态层级)+ 绽放鸢尾
 *   WorkshopTabs — 五标签:1 真 + 4 虚线站位(W9 点亮)
 *   DraftLedger — draft 预览 mono 账本(全站唯一深色面板)
 * 产物中心:
 *   SourceFilter — 来源过滤(Create 真 / Chat·Code 虚线)
 *   HubCard — 网格卡(§6.5:icon + 名 + 类型·版本·状态 + 来源 + 「引用到对话 / 在 Chat 使用」)
 * 设置:
 *   SettingsCard / SegmentedControl / Switch — Boss 视角 5 卡;
 *   「开发者模式」开关后整屏接管运行时状态页(内容不删,只分层,D4 解法)
 */

import './SurfaceKit.css';

/* ================= Create ================= */

export function CreateHero({ title = '描述,即构建', subtitle, children }: {
  title?: string;
  subtitle?: string;
  /** 放 AgentComposer 或输入卡 */
  children?: React.ReactNode;
}) {
  return (
    <div className="crt-hero">
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        {/* 绽放鸢尾 52(空态层级);占本屏点缀名额 */}
        <BloomIrisLocal />
      </div>
      <div className="crt-hero__title">{title}</div>
      {subtitle && <div className="crt-hero__sub">{subtitle}</div>}
      {children && <div className="crt-hero__composer">{children}</div>}
    </div>
  );
}

/** 内联绽放鸢尾(与 components/anna/IrisPetal.tsx 的 BloomIris 一致,避免跨目录耦合) */
function BloomIrisLocal({ size = 52 }: { size?: number }) {
  const id = Math.random().toString(36).slice(2, 8);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`hs${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#C7C9EF" /><stop offset="1" stopColor="#575BC4" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id={`hf${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#575BC4" stopOpacity="0.6" /><stop offset="1" stopColor="#8B8ED9" stopOpacity="0.14" />
        </linearGradient>
      </defs>
      <path d="M50 6 C62 21 62 42 50 56 C38 42 38 21 50 6 Z" fill={`url(#hs${id})`} opacity="0.9" />
      <path d="M50 56 C36 47 27 32 29 15 C44 21 51 37 50 56 Z" fill={`url(#hs${id})`} opacity="0.62" />
      <path d="M50 56 C64 47 73 32 71 15 C56 21 49 37 50 56 Z" fill={`url(#hs${id})`} opacity="0.62" />
      <path d="M50 56 C33 53 19 61 13 78 C31 84 47 75 50 56 Z" fill={`url(#hf${id})`} />
      <path d="M50 56 C67 53 81 61 87 78 C69 84 53 75 50 56 Z" fill={`url(#hf${id})`} />
      <path d="M50 56 C45 70 45 84 50 95 C55 84 55 70 50 56 Z" fill={`url(#hf${id})`} opacity="0.8" />
      <circle cx="50" cy="55" r="2.4" fill="#CBBB8E" />
    </svg>
  );
}

export interface WorkshopTab {
  id: string;
  label: string;
  /** true = 虚线站位(W9 点亮前) */
  stub?: boolean;
}

export function WorkshopTabs({ tabs, activeId, onActivate }: {
  tabs: WorkshopTab[];
  activeId: string;
  onActivate: (id: string) => void;
}) {
  return (
    <div className="crt-tabs" role="tablist">
      {tabs.map((t) =>
        t.stub ? (
          <button key={t.id} type="button" className="crt-tab crt-tab--stub" disabled title="即将上线">
            {t.label} · 即将上线
          </button>
        ) : (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeId === t.id}
            className={`crt-tab${activeId === t.id ? ' crt-tab--on' : ''}`}
            onClick={() => onActivate(t.id)}
          >
            {t.label}
          </button>
        ),
      )}
    </div>
  );
}

export function DraftLedger({ heading = 'DRAFT · 构建账本', lines }: { heading?: string; lines: string[] }) {
  return (
    <div className="crt-ledger">
      <div className="crt-ledger__head">{heading}</div>
      {lines.map((line, i) => <div key={i}>{line}</div>)}
    </div>
  );
}

/* ================= 产物中心 ================= */

export interface SourceOption {
  id: string;
  label: string;
  stub?: boolean;
}

export function SourceFilter({ options, activeId, onActivate }: {
  options: SourceOption[];
  activeId: string;
  onActivate: (id: string) => void;
}) {
  return (
    <div className="hub-filters">
      {options.map((o) =>
        o.stub ? (
          <button key={o.id} type="button" className="hub-filter hub-filter--stub" disabled title="即将上线">
            {o.label} · 即将上线
          </button>
        ) : (
          <button
            key={o.id}
            type="button"
            className={`hub-filter${activeId === o.id ? ' hub-filter--on' : ''}`}
            onClick={() => onActivate(o.id)}
          >
            {o.label}
          </button>
        ),
      )}
    </div>
  );
}

export function HubGrid({ children }: { children: React.ReactNode }) {
  return <div className="hub-grid">{children}</div>;
}

export function HubCard({ name, metaText, sourceText, onQuote, onUseInChat }: {
  name: string;
  /** 「网页 · v3 · 已定稿」 */
  metaText: string;
  /** 「来源 Create · run 9F3KE2」 */
  sourceText: string;
  onQuote?: () => void;
  onUseInChat?: () => void;
}) {
  return (
    <div className="hub-card">
      <div className="hub-card__head">
        <span className="hub-card__tile" aria-hidden="true">◇</span>
        <span style={{ minWidth: 0 }}>
          <span className="hub-card__name" style={{ display: 'block' }}>{name}</span>
          <span className="hub-card__meta" style={{ display: 'block' }}>{metaText}</span>
        </span>
      </div>
      <div className="hub-card__source">{sourceText}</div>
      <div className="hub-card__actions">
        <button type="button" className="hub-card__act hub-card__act--primary" onClick={onUseInChat}>在 Chat 使用</button>
        <button type="button" className="hub-card__act" onClick={onQuote}>引用到对话</button>
      </div>
    </div>
  );
}

/* ================= 设置 ================= */

export function SettingsCard({ title, statusChip, statusTone = 'ok', desc, children }: {
  title: string;
  statusChip?: string;
  statusTone?: 'ok' | 'stub';
  desc?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="set-card">
      <div className="set-card__head">
        <span className="set-card__title">{title}</span>
        {statusChip && <span className={`set-card__chip set-card__chip--${statusTone}`}>{statusChip}</span>}
      </div>
      {desc && <div className="set-card__desc">{desc}</div>}
      {children && <div className="set-card__body">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, note }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  note?: string;
}) {
  return (
    <div className="set-switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="set-switch"
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
      {label && <span>{label}</span>}
      {note && <span className="set-switch-note">{note}</span>}
    </div>
  );
}

export function SegmentedControl<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <span className="set-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`set-seg__opt${value === o.value ? ' set-seg__opt--on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
