/**
 * AgentComposer · Composer 家族(五面共用,《设计说明 · Iris》§6.3)
 *
 * 底条槽位(左→右,从此固定):
 *   附件(站位,随上传通道)· 调优(真)· 权限 pill(W4)· CTX 环(W5)
 *   · 弹性 · 模型档位(W2)· 停止(运行中)/ 发送
 *
 * 站位纪律:未接通的能力 = 虚线 chip + 禁用,不做假响应。
 * 传 null/undefined 的槽位渲染为站位;传实值则为真控件。
 * 运行中:发送键 35% 不可用,显示停止键。
 */

import { useCallback, useRef } from 'react';
import './AgentComposer.css';

export type PermissionMode = 'default' | 'readonly' | 'bypass';
export type ModelTier = 'lite' | 'default' | 'craft';

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: '权限·默认',
  readonly: '权限·只读',
  bypass: '权限·bypass',
};

export interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  running?: boolean;
  onStop?: () => void;
  placeholder?: string;
  /** 调优(真) */
  onTune?: () => void;
  tuneActive?: boolean;
  /** W4 权限 pill:undefined = 虚线站位 */
  permission?: PermissionMode;
  onPermissionClick?: () => void;
  /** W5 CTX:undefined = 虚线站位;数值 0-100,>80 转琥珀 */
  ctxPercent?: number;
  /** W2 模型档位:undefined = 不渲染(未上线不占位) */
  modelTier?: ModelTier;
  onModelTierChange?: (tier: ModelTier) => void;
  /** 底部说明行,如 "Ctrl/⌘ + Enter 发送 · 内容由 AI 生成,请注意甄别" */
  footnote?: string;
}

function CtxRing({ percent }: { percent: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const warn = percent > 80;
  return (
    <span className={`acp__ctx${warn ? ' acp__ctx--warn' : ''}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r={r} fill="none" stroke="var(--tint-strong)" strokeWidth="2" />
        <circle
          cx="7" cy="7" r={r} fill="none"
          stroke={warn ? 'var(--warn)' : 'var(--iris)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
          transform="rotate(-90 7 7)"
        />
      </svg>
      CTX {Math.round(percent)}%
    </span>
  );
}

export function AgentComposer(props: AgentComposerProps) {
  const {
    value, onChange, onSend, running = false, onStop,
    placeholder = '追问、补充,或吩咐下一件事…',
    footnote = 'Ctrl/⌘ + Enter 发送 · 内容由 AI 生成,请注意甄别',
  } = props;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !running && value.trim()) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend, running, value],
  );

  /* textarea 自适应高度 */
  const autoGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  return (
    <div className="acp">
      <div className="acp__card">
        <textarea
          ref={inputRef}
          className="acp__input"
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => { onChange(e.target.value); autoGrow(); }}
          onKeyDown={handleKeyDown}
        />
        <div className="acp__bar">
          {/* 附件:站位(随上传通道上线) */}
          <button type="button" className="acp__chip acp__chip--stub" disabled title="即将上线">附件</button>

          {/* 调优:真 */}
          <button
            type="button"
            className={`acp__chip${props.tuneActive ? ' acp__chip--active' : ''}`}
            onClick={props.onTune}
          >
            调优
          </button>

          {/* 权限 pill(W4):站位 or 真;激活 = iris tinted */}
          {props.permission === undefined ? (
            <button type="button" className="acp__chip acp__chip--stub" disabled title="即将上线">权限·默认</button>
          ) : (
            <button
              type="button"
              className={`acp__chip${props.permission !== 'default' ? ' acp__chip--active' : ''}`}
              onClick={props.onPermissionClick}
            >
              {PERMISSION_LABEL[props.permission]}
            </button>
          )}

          {/* CTX 环(W5):站位 or 真 */}
          {props.ctxPercent === undefined ? (
            <button type="button" className="acp__chip acp__chip--stub" disabled title="即将上线">CTX —%</button>
          ) : (
            <CtxRing percent={props.ctxPercent} />
          )}

          <span className="acp__spacer" />

          {/* 模型档位(W2) */}
          {props.modelTier !== undefined && (
            <span className="acp__tier" role="radiogroup" aria-label="模型档位">
              {(['lite', 'default', 'craft'] as const).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  role="radio"
                  aria-checked={props.modelTier === tier}
                  className={`acp__tier-opt${props.modelTier === tier ? ' acp__tier-opt--on' : ''}`}
                  onClick={() => props.onModelTierChange?.(tier)}
                >
                  {tier}
                </button>
              ))}
            </span>
          )}

          {running && (
            <button type="button" className="acp__stop" onClick={onStop}>停止</button>
          )}
          <button
            type="button"
            className="acp__send"
            disabled={running || !value.trim()}
            onClick={onSend}
            aria-label="发送"
          >
            ↑
          </button>
        </div>
      </div>
      {footnote && <div className="acp__foot">{footnote}</div>}
    </div>
  );
}

export default AgentComposer;
