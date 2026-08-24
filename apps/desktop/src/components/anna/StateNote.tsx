/**
 * StateNote · 状态语法(全产品七态中的 5 个非运行态;《设计说明 · Iris》§6.7)
 *
 * 七态纪律:每个数据面都要出 空 / 加载 / 运行中(流式) / 完成 / 失败 / 未连接 / 站位。
 * 运行中与完成由 LoopCard / 业务组件承担;其余五态用本组件统一语法:
 *   empty      空 = 留白 + 一句将发生什么(可配鸢尾瓣,占点缀名额)
 *   loading    加载 = iris 细环 + mono 一句
 *   error      错误 = danger-soft 圆角块 + error 原文 mono(禁止裸 error_code 横幅)
 *   offline    未连接 = warn-soft 块 + 等待真实数据
 *   stub       站位 = 虚线 + 「即将上线」(诚实红线:禁用,绝不做假响应)
 */

import { IrisPetal } from './IrisPetal';

export type StateKind = 'empty' | 'loading' | 'error' | 'offline' | 'stub';

export interface StateNoteProps {
  kind: StateKind;
  /** empty:将发生什么;error:error 帧原文;offline:说明;stub:能力名 */
  text: string;
  /** empty 态可配鸢尾瓣(注意每屏点缀上限 2 处) */
  petal?: boolean;
}

const box: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  lineHeight: 1.8,
  borderRadius: 12,
  padding: '14px 16px',
};

export function StateNote({ kind, text, petal = false }: StateNoteProps) {
  switch (kind) {
    case 'empty':
      return (
        <div style={{ ...box, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '24px 16px', color: 'var(--ink-2)', textAlign: 'center' }}>
          {petal && <IrisPetal size={26} />}
          <span>{text}</span>
        </div>
      );
    case 'loading':
      return (
        <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 9, color: 'var(--ink-2)' }}>
          <span
            className="anna-spin"
            style={{
              width: 13, height: 13, borderRadius: '50%', flex: 'none',
              border: '2px solid rgb(87 91 196 / 22%)', borderTopColor: 'var(--iris)',
              animation: 'anna-spin 0.9s linear infinite',
            }}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{text}</span>
        </div>
      );
    case 'error':
      return (
        <div style={{ ...box, background: 'var(--danger-soft)', border: '1px solid var(--danger-line)', color: 'var(--danger-deep)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
        </div>
      );
    case 'offline':
      return (
        <div style={{ ...box, background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          {text}
        </div>
      );
    case 'stub':
      return (
        <div
          aria-disabled="true"
          style={{ ...box, border: '1px dashed var(--line-strong)', color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span>{text}</span>
          <span style={{ fontSize: 11, border: '1px dashed var(--line-strong)', borderRadius: 999, padding: '1px 9px', flex: 'none' }}>即将上线</span>
        </div>
      );
  }
}

export default StateNote;
