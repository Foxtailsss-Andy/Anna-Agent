/**
 * MentionPicker · R4a @拾取器浮层(3h 版式)—— 受控呈现件,状态由 Composer 持有
 *
 * 位置:composer 上方(bottom:100%+10px,避让中文 IME 候选窗)。
 * 头「协作对象 · 过滤「x」」+「↑↓ · Enter」;行=头像(人圆/Agent 方 r8/Anna 协调瓣)+ 名/职能 + 徽记;
 * 当前项 iris 高亮;底 hint「继续输入过滤 · 组词中 Enter 不触发」;向下指针。
 * 键盘(↑↓/Enter/Esc)在 Composer 层处理;此处 hover 改 activeIndex、click 确认。
 */

import type { PickerMember } from "./pickerModel";

export interface MentionPickerProps {
  members: PickerMember[];
  query: string;
  activeIndex: number;
  onSelect: (m: PickerMember) => void;
  onHover: (index: number) => void;
}

export function MentionPicker({ members, query, activeIndex, onSelect, onHover }: MentionPickerProps) {
  return (
    <div className="ir-chan-mpick" role="listbox" aria-label="选择协调者或成员">
      <div className="ir-chan-mpick__head">
        <span className="ir-chan-mpick__filter">
          协作对象{query ? ` · 过滤“${query}”` : ""}
        </span>
        <span className="ir-chan-mpick__keys" aria-hidden="true">↑↓ · Enter</span>
      </div>
      <div className="ir-chan-mpick__list">
        {members.map((m, i) => (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            className={`ir-chan-mpick__opt${i === activeIndex ? " is-active" : ""}`}
            // mousedown(非 click)确认:避免 textarea 先 blur 打断插入
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(m);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <span
              className={`ir-chan-mpick__avatar${m.isAgent ? " ir-chan-mpick__avatar--agent" : ""}${m.isCoordinator ? " ir-chan-mpick__avatar--anna" : ""}`}
              aria-hidden="true"
            >
              {(m.name.trim()[0] ?? "·").toUpperCase()}
            </span>
            <span className="ir-chan-mpick__idn">
              <span className="ir-chan-mpick__name">{m.name}</span>
              {m.role && <span className="ir-chan-mpick__role">{m.role}</span>}
            </span>
            <span className={`ir-chan-mpick__badge${m.isAgent ? " ir-chan-mpick__badge--agent" : ""}${m.isCoordinator ? " ir-chan-mpick__badge--anna" : ""}`}>
              {m.isCoordinator ? "协调" : m.isAgent ? "AGENT" : "人"}
            </span>
          </button>
        ))}
      </div>
      <div className="ir-chan-mpick__hint">继续输入过滤 · 组词中 Enter 不触发</div>
      <span className="ir-chan-mpick__pointer" aria-hidden="true" />
    </div>
  );
}

export default MentionPicker;
