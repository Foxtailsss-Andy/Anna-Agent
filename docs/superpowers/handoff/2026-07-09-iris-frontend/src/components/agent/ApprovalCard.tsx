/**
 * ApprovalCard · 通用审批卡(《设计说明 · Iris》§6.4,W4 通用化)
 *
 * = LoopCard 暂停形态:嵌在 awaiting 回合末端(LoopCard 的 approvalSlot),
 * 不再是报销页私有 UI。数据源:awaiting_approval 帧 reason + detail。
 *
 * 两种变体:
 *  - confirm:字段网格逐项对账(值用 mono)+ ▸ 原始 payload + 「返回修改 / 确认提交」
 *  - supplement:同壳换「请您补充」表单(number / date / text / file;file 为站位=虚线禁用)
 *
 * 语体:「提交前需要您确认」「请您补充」「运行已暂停,等您示下」。
 * 诚实纪律:payload 原文 mono 呈现,一字不改。
 */

import { useState } from 'react';
import './ApprovalCard.css';

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface ApprovalField {
  label: string;
  value: string;
  /** 金额/单号等账本值用 mono(默认 true) */
  mono?: boolean;
}

export interface SupplementField {
  id: string;
  label: string;
  type: 'number' | 'date' | 'text' | 'file';
  placeholder?: string;
}

export interface ApprovalCardProps {
  /** confirm(默认)= 对账确认;supplement = 缺信息补充 */
  variant?: 'confirm' | 'supplement';
  title?: string;
  risk?: ApprovalRisk;
  /** confirm:字段网格(来自 awaiting_approval.detail 的呈现映射) */
  fields?: ApprovalField[];
  /** ▸ 原始 payload(帧原文,JSON 序列化后传入) */
  payloadText?: string;
  /** supplement:表单字段 */
  supplementFields?: SupplementField[];
  onConfirm?: (values?: Record<string, string>) => void;
  onRevise?: () => void;
  confirmLabel?: string;
  reviseLabel?: string;
}

const RISK_LABEL: Record<ApprovalRisk, string> = { low: '风险 · 低', medium: '风险 · 中', high: '风险 · 高' };

export function ApprovalCard(props: ApprovalCardProps) {
  const {
    variant = 'confirm',
    title = variant === 'confirm' ? '提交前需要您确认' : '请您补充',
    risk,
    fields = [],
    payloadText,
    supplementFields = [],
  } = props;
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="apv">
      <div className="apv__spine" aria-hidden="true" />
      <div className="apv__body">
        <div className="apv__head">
          <span className="apv__title">{title}</span>
          {risk && <span className={`apv__risk apv__risk--${risk}`}>{RISK_LABEL[risk]}</span>}
        </div>

        {variant === 'confirm' ? (
          <div className="apv__grid">
            {fields.map((f) => (
              <div key={f.label}>
                <div className="apv__k">{f.label}</div>
                <div className={`apv__v${f.mono !== false ? ' apv__v--mono' : ''}`}>{f.value}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="apv__form">
            {supplementFields.map((f) => (
              <label key={f.id}>
                <span className="apv__k">{f.label}</span>
                {f.type === 'file' ? (
                  /* 附件随上传通道上线:站位 = 虚线禁用(诚实纪律) */
                  <span className="apv__input apv__input--stub" title="即将上线">附件 · 即将上线</span>
                ) : (
                  <input
                    className="apv__input"
                    type={f.type}
                    placeholder={f.placeholder}
                    value={values[f.id] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        )}

        {payloadText && (
          <>
            <button
              type="button"
              className="apv__payload-btn"
              aria-expanded={payloadOpen}
              onClick={() => setPayloadOpen((v) => !v)}
            >
              {payloadOpen ? '▾' : '▸'} 原始 payload
            </button>
            <div className={`apv__payload-lift${payloadOpen ? ' is-open' : ''}`}>
              <div><div className="apv__payload">{payloadText}</div></div>
            </div>
          </>
        )}

        <div className="apv__actions">
          <button type="button" className="apv__btn apv__btn--tinted" onClick={props.onRevise}>
            {props.reviseLabel ?? '返回修改'}
          </button>
          <button
            type="button"
            className="apv__btn apv__btn--filled"
            onClick={() => props.onConfirm?.(variant === 'supplement' ? values : undefined)}
          >
            {props.confirmLabel ?? (variant === 'confirm' ? '确认提交' : '提交补充')}
          </button>
          <span className="apv__note">运行已暂停,等您示下</span>
        </div>
      </div>
    </div>
  );
}

export default ApprovalCard;
