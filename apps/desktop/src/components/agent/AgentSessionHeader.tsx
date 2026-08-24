/**
 * AgentSessionHeader · 身份头(五面共用,《设计说明 · Iris》§6.2 共享解剖 ①)
 * 头像(金线描环 + 衬线「安」)+ 名 + 状态行(ProvenanceLine 槽)
 *
 * 状态文案(大小姐语体,§2):
 *  running → 「正在为您办理 · 00:26」  done → 「已办妥」  error → 「这一步没有办成」
 */

import './AgentSessionHeader.css';

export interface AgentSessionHeaderProps {
  name?: string;
  /** 头像字,默认衬线「安」 */
  avatarText?: string;
  statusText?: string;
  tone?: 'default' | 'error';
  /** ProvenanceLine 等追加内容 */
  children?: React.ReactNode;
}

export function AgentSessionHeader({
  name = 'Anna',
  avatarText = '安',
  statusText,
  tone = 'default',
  children,
}: AgentSessionHeaderProps) {
  return (
    <div className="ash">
      <span className="ash__avatar" aria-hidden="true">{avatarText}</span>
      <span className="ash__name">{name}</span>
      {statusText && (
        <span className={`ash__status${tone === 'error' ? ' ash__status--error' : ''}`}>{statusText}</span>
      )}
      {children}
    </div>
  );
}

export default AgentSessionHeader;
