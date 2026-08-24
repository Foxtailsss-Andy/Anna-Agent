/**
 * MemberPicker · 改派浮层(选成员 → assign)。抽屉署名行 / popover 执行者行共用。
 *   点「改派」就地弹出成员列表;选中即换 assignee(真 API);Esc/点空白关。
 */

import { useEffect, useRef } from "react";

import type { TeamMember } from "../../../lib/api/crew";
import { MemberAvatar } from "./MemberBits";

export function MemberPicker({
  members,
  ownerUserId,
  currentId,
  onPick,
  onClose,
}: {
  members: TeamMember[];
  ownerUserId: string;
  currentId: string | null | undefined;
  onPick: (memberId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  return (
    <div className="ir-insp-picker" ref={ref} role="listbox" aria-label="改派给">
      <div className="ir-insp-picker__head">改派给</div>
      {members.length === 0 && <div className="ir-insp-picker__empty">暂无可选成员</div>}
      {members.map((m) => (
        <button
          key={m.id}
          type="button"
          role="option"
          aria-selected={m.id === currentId}
          className={`ir-insp-picker__opt${m.id === currentId ? " is-current" : ""}`}
          onClick={() => onPick(m.id)}
        >
          <MemberAvatar member={m} isOwner={m.id === ownerUserId} size={20} />
          <span className="ir-insp-picker__name">{m.display_name ?? m.id}</span>
          {m.role && <span className="ir-insp-picker__role">{m.role}</span>}
          {m.id === currentId && <span className="ir-insp-picker__cur">当前</span>}
        </button>
      ))}
    </div>
  );
}

export default MemberPicker;
