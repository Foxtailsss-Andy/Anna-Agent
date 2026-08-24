/**
 * LoopCard · 灵魂组件(五面共用)— 三级下钻版
 * 规格:《设计说明 · Iris》§6.1 + 《Runtime 三级下钻 Brief 2026-07-09》
 *
 * 三级信息架构(分组单元 = 回合):
 *   L1 折叠行:拟人状态标签(flavor,可关)+ 聚合摘要 + 时态图标(素的)+ 耗时
 *   L2 展开回合:有序 Step 列(思考/工具/系统/错误,类型点区分)
 *   L3 掀单步:真 args + 真 result/stdout + exit(素颜,persona 不许触碰)
 *
 * 硬规则:Step 无 L3(无留存原文)→ 不出箭头、不可掀。
 * 四态:running(当前回合展开)/ done(收拢为礼成条)/
 *       failed(失败回合展开、失败步默认掀到 L3、动效全停)/ awaiting(⏳ 等外部输入)。
 * 用户手动掀开/折叠后尊重用户选择,不再被自动态覆写。
 *
 * 嵌套预留:未来 Step 可能是子运行(subagent 自带三级)——
 * 届时给 Step 增加 subTree?: RunTree,在 L3 位置递归渲染 <TurnList>(结构已按此留位)。
 */

import { useMemo, useState } from 'react';
import type { RunState, Step, StepL3Tool, Turn } from '../../lib/turns';
import { turnSummary } from '../../lib/turns';
import type { PlanProgress } from '../../lib/plan';
import './LoopCard.css';

export type LoopState = 'running' | 'awaiting' | 'done' | 'error';

/** 拟人状态标签(flavor 通道:呈现映射,可整体关闭;不盖成败真值) */
export const DEFAULT_PERSONA_LABELS: Record<Turn['status'], string> = {
  running: '正在办',
  ok: '办妥',
  fail: '没有办成',
  awaiting: '等您示下',
};

export interface LoopCardProps {
  state: LoopState;
  /** 「当下」行文案 = step.intent 引擎原文;error 时如「生成网页产物,未能完成」 */
  nowIntent?: string;
  /** 前端计时,如 "00:26" */
  elapsedText?: string;
  turns: Turn[];
  plan?: PlanProgress | null;
  /** 计划条右侧:模型 · tokens(provider 真报才显示) */
  usageText?: string;
  /** 拟人层开关(铁律 3:flavor 独立、可关);默认开 */
  persona?: boolean;
  personaLabels?: Partial<Record<Turn['status'], string>>;
  /** truncated 凭证懒加载:返回全文(后端已脱敏) */
  onLoadFull?: (stepId: string) => Promise<string>;
  ceremony?: {
    momentCount: number;
    planText?: string;
    usageText?: string;
    seal?: boolean;
  };
  failure?: {
    consumedText?: string;
    onResume?: () => void;
    onAudit?: () => void;
    onCopyError?: () => void;
  };
  /** 审批卡(§6.4)嵌入位:awaiting 回合末端 */
  approvalSlot?: React.ReactNode;
}

/* ---- 落笔勾 ---- */
function InkCheck({ size = 10 }: { size?: number }) {
  return (
    <svg className="loop-ink-check" width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.2 5 9 10 3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---- L3 · 素颜凭证 ---- */
function L3Panel({ step, onLoadFull }: { step: Step; onLoadFull?: (id: string) => Promise<string> }) {
  const [loading, setLoading] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const [textExpanded, setTextExpanded] = useState(false);
  const l3 = step.l3;
  if (!l3) return null;

  if (l3.form === 'text') {
    const long = l3.text.split('\n').length > 12 || l3.text.length > 800;
    return (
      <div className={`run-l3${l3.tone === 'danger' ? ' run-l3--danger' : ''}`}>
        <div className={`run-l3__text${long && !textExpanded ? ' run-l3__text--clamped' : ''}`}>{l3.text}</div>
        {long && (
          <button type="button" className="run-l3__more" onClick={() => setTextExpanded((v) => !v)}>
            {textExpanded ? '收起' : '展开全文'}
          </button>
        )}
      </div>
    );
  }

  const t = l3 as StepL3Tool;
  const result = fullText ?? t.resultPreview;

  return (
    <div className={`run-l3${step.status === 'fail' ? ' run-l3--danger' : ''}${t.restricted ? ' run-l3--restricted' : ''}`}>
      {t.restricted && (
        <div className="run-l3__lock">🔒 受限视角 · 已脱敏摘要;完整凭证仅 run owner / 开发者可见</div>
      )}
      {t.contract && (
        <div className="run-l3__field"><span className="run-l3__key">contract</span><span className="run-l3__val">{t.contract}</span></div>
      )}
      {t.argsPreview && (
        <div className="run-l3__field"><span className="run-l3__key">args</span><span className="run-l3__val">{t.argsPreview}</span></div>
      )}
      {result && (
        <div className="run-l3__field"><span className="run-l3__key">result</span><span className="run-l3__val">{result}</span></div>
      )}
      {t.exitText && (
        <div className="run-l3__field"><span className="run-l3__key">exit</span><span className="run-l3__val run-l3__exit">{t.exitText}</span></div>
      )}
      {t.truncated && !fullText && (
        <>
          <div className="run-l3__trunc-note">
            已截断预览{t.bytes != null ? ` · 全文 ${t.bytes.toLocaleString()} bytes` : ''}
          </div>
          {onLoadFull && (
            <button
              type="button"
              className="run-l3__more"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try { setFullText(await onLoadFull(step.id)); } finally { setLoading(false); }
              }}
            >
              {loading && <span className="run-l3__more-spin" />}
              {loading ? '加载中…' : '展开更多'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ---- L2 · 单步 ---- */
function StepRow({ step, animate, onLoadFull }: { step: Step; animate: boolean; onLoadFull?: (id: string) => Promise<string> }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !!step.defaultOpen; // 失败步默认掀到 L3 留证;用户操作后尊重用户
  const expandable = !!step.l3; // 硬规则:无 L3 → 不出箭头、不可掀
  const isCurrent = step.status === 'running';

  const dotClass = [
    'run-step__dot',
    step.status === 'fail'
      ? 'run-step__dot--fail'
      : isCurrent
        ? (animate ? 'run-step__dot--running anna-breath' : 'run-step__dot--tool')
        : `run-step__dot--${step.kind}`,
  ].join(' ');

  const Tag: 'button' | 'div' = expandable ? 'button' : 'div';

  return (
    <div className="run-step">
      <Tag
        className={[
          'run-step__row',
          expandable ? 'run-step__row--expandable' : '',
          isCurrent ? 'run-step__row--current' : '',
        ].join(' ')}
        type={expandable ? 'button' : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setUserOpen(!open) : undefined}
      >
        <span className={dotClass} />
        <span className={`run-step__label${step.status === 'fail' ? ' run-step__label--fail' : ''}`}>{step.label}</span>
        {step.status === 'ok' && step.kind === 'tool' && <span className="run-step__ok">✓</span>}
        {step.status === 'fail' && <span className="run-step__fail">✕</span>}
        {step.status === 'waiting' && <span className="run-step__wait">⏳</span>}
        {isCurrent && animate && <span className="run-step__spinner anna-spin" />}
        <span className={`run-step__meta${step.status === 'fail' ? ' run-step__meta--fail' : isCurrent ? ' run-step__meta--now' : ''}`}>
          {step.status === 'fail'
            ? `失败 ${open ? '▾' : '▸'}`
            : isCurrent
              ? '现在'
              : `${step.durationText ?? ''}${expandable ? (open ? ' ▾' : ' ▸') : ''}`}
        </span>
      </Tag>
      {expandable && (
        <div className={`run-l3-lift${open ? ' is-open' : ''}`}>
          <div><L3Panel step={step} onLoadFull={onLoadFull} /></div>
        </div>
      )}
    </div>
  );
}

/* ---- L1 + L2 · 回合 ---- */
function TurnBlock({
  turn, cardState, persona, personaLabels, onLoadFull, approvalSlot,
}: {
  turn: Turn;
  cardState: LoopState;
  persona: boolean;
  personaLabels: Record<Turn['status'], string>;
  onLoadFull?: (id: string) => Promise<string>;
  approvalSlot?: React.ReactNode;
}) {
  // 默认态:done→折叠;running/failed/awaiting 的当事回合→展开
  const autoOpen = turn.status === 'running' || turn.status === 'fail' || turn.status === 'awaiting';
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? autoOpen; // 用户手动后尊重用户选择
  const animate = cardState === 'running'; // 完成/失败=动效全停(§3 留白)

  const icon =
    turn.status === 'running' ? (
      animate ? <span className="run-l1__spinner anna-spin" /> : <span className="run-l1__icon--waiting">·</span>
    ) : turn.status === 'ok' ? (
      <span className="run-l1__icon--ok">✓</span>
    ) : turn.status === 'fail' ? (
      <span className="run-l1__icon--fail">✕</span>
    ) : (
      <span className="run-l1__icon--waiting">⏳</span>
    );

  return (
    <div className="run-turn">
      <button type="button" className="run-l1" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <span className="run-l1__caret">{open ? '▾' : '▸'}</span>
        <span className="run-l1__icon">{icon}</span>
        <span className={`run-l1__label${turn.status === 'fail' ? ' run-l1__label--fail' : ''}`}>
          {turn.index === 0 ? '准备' : `第 ${turn.index} 回合`}
        </span>
        {persona && <span className="run-l1__persona">{personaLabels[turn.status]}</span>}
        <span className="run-l1__summary">{turnSummary(turn)}</span>
        <span className="run-l1__meta">{turn.durationText ?? ''}</span>
      </button>
      <div className={`run-l2-lift${open ? ' is-open' : ''}`}>
        <div>
          <div className="run-l2">
            {turn.steps.map((step) => (
              <StepRow key={step.id} step={step} animate={animate} onLoadFull={onLoadFull} />
            ))}
            {turn.status === 'awaiting' && approvalSlot}
          </div>
        </div>
      </div>
      {turn.narration && <div className="run-narration">{turn.narration}</div>}
    </div>
  );
}

export function LoopCard(props: LoopCardProps) {
  const { state, turns, plan, usageText, persona = true } = props;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false); // 窄容器降级的手动展开
  const personaLabels = useMemo(
    () => ({ ...DEFAULT_PERSONA_LABELS, ...props.personaLabels }),
    [props.personaLabels],
  );
  const stepCount = useMemo(() => turns.reduce((n, t) => n + t.steps.length, 0), [turns]);

  const card = (
    <div className={['loop-card', `loop-card--${state}`, state === 'done' ? 'loop-card--review' : ''].join(' ')}>
      <div className="loop-card__spine" aria-hidden="true" />
      <div className="loop-card__body">
        {state !== 'done' && (
          <div className="loop-now">
            <span className="loop-now__dot anna-breath" />
            <span className={`loop-now__intent${state === 'running' ? ' anna-shimmer-text' : ''}`}>{props.nowIntent}</span>
            {props.elapsedText && <span className="loop-now__clock">{props.elapsedText}</span>}
          </div>
        )}

        <button type="button" className="loop-fold" aria-expanded={processOpen} onClick={() => setProcessOpen((v) => !v)}>
          {processOpen ? '▾' : '▸'} 过程 {stepCount} 个瞬间
        </button>

        <div className={`run-turns${processOpen || state === 'done' ? ' is-forced-open' : ''}`}>
          {turns.map((turn) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              cardState={state}
              persona={persona}
              personaLabels={personaLabels}
              onLoadFull={props.onLoadFull}
              approvalSlot={props.approvalSlot}
            />
          ))}
        </div>

        {state === 'error' && props.failure && (
          <>
            <div className="loop-hair" />
            <div className="loop-fail-actions">
              <button type="button" className="loop-btn loop-btn--filled" onClick={props.failure.onResume}>↻ 从断点续办</button>
              <button type="button" className="loop-btn loop-btn--tinted" onClick={props.failure.onAudit}>查看审计</button>
              <button type="button" className="loop-btn loop-btn--tinted" onClick={props.failure.onCopyError}>复制错误</button>
              {props.failure.consumedText && <span className="loop-fail-actions__consumed">{props.failure.consumedText}</span>}
            </div>
          </>
        )}

        {state !== 'error' && plan && (
          <>
            <div className="loop-hair" />
            <div className="loop-plan">
              <span className="loop-plan__label">计划 {plan.done}/{plan.total}</span>
              <span className="loop-plan__segs" aria-hidden="true">
                {plan.items.map((item) => (
                  <span key={item.id} className={`loop-plan__seg${item.status === 'done' ? ' loop-plan__seg--done' : ''}`} />
                ))}
              </span>
              {plan.currentTitle && <span className="loop-plan__current">正在:{plan.currentTitle}</span>}
              {usageText && <span className="loop-plan__usage">{usageText}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );

  /* 完成态:收拢为礼成条(320ms),▸ 回看重开全部回合 */
  if (state === 'done' && props.ceremony) {
    const c = props.ceremony;
    return (
      <div className="loop-host">
        <div className="loop-ceremony">
          <span className="loop-ceremony__check"><InkCheck /></span>
          <span className="loop-ceremony__title">礼成</span>
          <span className="loop-ceremony__summary">{c.momentCount} 个瞬间{c.planText ? ` · ${c.planText}` : ''}</span>
          {c.usageText && <span className="loop-ceremony__usage">{c.usageText}</span>}
          <button type="button" className="loop-ceremony__review" aria-expanded={reviewOpen} onClick={() => setReviewOpen((v) => !v)}>
            {reviewOpen ? '▾ 收起' : '▸ 回看'}
          </button>
          {c.seal !== false && <AnSealInline />}
        </div>
        <div className={`loop-review-lift${reviewOpen ? ' is-open' : ''}`}>
          <div>{card}</div>
        </div>
      </div>
    );
  }

  return <div className="loop-host">{card}</div>;
}

/** 「安」印:只落在礼成条(§5) */
function AnSealInline() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 18, height: 18,
        border: '1px solid #C99B95', borderRadius: 4,
        color: 'var(--danger)',
        fontFamily: 'var(--font-serif)', fontSize: 10, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transform: 'rotate(-4deg)', flex: 'none',
      }}
    >
      安
    </span>
  );
}

export default LoopCard;
