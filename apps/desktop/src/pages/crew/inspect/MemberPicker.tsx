/**
 * MemberPicker · 改派浮层(选成员 → assign)。抽屉署名行 / popover 执行者行共用。
 *   点「改派」就地弹出成员列表;选中即换 assignee(真 API);Esc/点空白关。
 */

import { useEffect, useRef } from "react";

import type { AssignmentSuggestion, TeamMember } from "../../../lib/api/crew";
import { MemberAvatar } from "./MemberBits";

export function MemberPicker({
  members,
  ownerUserId,
  currentId,
  onPick,
  suggestion,
  suggestionPending,
  onSuggest,
  onAdoptSuggestion,
  suggestionAdopting,
  suggestable,
  taskStatus,
  onClose,
}: {
  members: TeamMember[];
  ownerUserId: string;
  currentId: string | null | undefined;
  onPick: (memberId: string) => void;
  suggestion: AssignmentSuggestion | null;
  suggestionPending: boolean;
  onSuggest: () => void;
  onAdoptSuggestion: () => void;
  suggestionAdopting: boolean;
  suggestable: boolean;
  taskStatus: string;
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
      {suggestable && !currentId && <button type="button" className="ir-insp-picker__suggest" onClick={onSuggest} disabled={suggestionPending || suggestionAdopting}>
        {suggestionPending ? "正在生成建议……" : "建议人选"}
      </button>}
      {suggestion && (
        <div className="ir-insp-picker__suggestion" role="status">
          <div className="ir-insp-picker__suggestion-title">建议结果</div>
          {suggestion.status === "suggested" && suggestion.member_id ? (
            <>
              <div className="ir-insp-picker__suggestion-person">
                {members.find((m) => m.id === suggestion.member_id)?.display_name ?? suggestion.member_id}
              </div>
              <div className="ir-insp-picker__suggestion-fact">
                任务角色：{suggestion.evidence.task_role} · 成员角色：{suggestion.evidence.member_role ?? "未知"}
              </div>
              <div className="ir-insp-picker__suggestion-meta">
                来源：{suggestion.source === "role_rule" ? "角色规则" : "Jev"} · {suggestion.source === "role_rule" ? "未调用模型" : typeof suggestion.meta?.elapsed_ms === "number" ? `判断耗时 ${suggestion.meta.elapsed_ms}ms` : "判断耗时未知"}
              </div>
              {taskStatus === "blocked" && <div className="ir-insp-picker__suggestion-meta">当前任务等待依赖，采纳后仍保持等待。</div>}
              {taskStatus === "todo" && suggestion.evidence.member_kind === "agent" && <div className="ir-insp-picker__suggestion-meta">Worker 就绪后按既有策略执行。</div>}
              <button type="button" className="ir-insp-picker__adopt" onClick={onAdoptSuggestion} disabled={suggestionAdopting}>
                {suggestionAdopting ? "正在采纳……" : "采纳指派"}
              </button>
            </>
          ) : (
            <div className="ir-insp-picker__suggestion-fact">
              {suggestion.reason_code === "suggestion_expired" ? "建议已过期" : `暂无可确认人选（${suggestion.reason_code}）`}。可继续手动选择。
            </div>
          )}
        </div>
      )}
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
