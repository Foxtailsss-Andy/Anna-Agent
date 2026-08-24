/**
 * CrewListView · 项目详情「列表」视图(视图切换真实现)
 *   任务行 = 状态章(复用七态章视觉)+ 标题 + 职能点 + assignee + 状态词 +(有版本 v{n});
 *   门行 = 门章 + 「评审门」。行点击 → 开抽屉;行尾 = 就地主动作(与节点同一 helper)。
 *   零捏造:全来自 project.tasks。
 */

import { useMemo } from "react";

import type { TeamMember } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import {
  gateVisual,
  nodePrimaryAction,
  roleColorSlug,
  statusWord,
  taskVisual,
  type NodeActionOp,
} from "../graph/graphMapping";
import { latestArtifactVersion } from "./helpers";
import { MemberAvatar } from "./MemberBits";
import { GateSeal, StateSeal } from "./StateSeal";

export interface CrewListViewProps {
  tasks: CrewTask[];
  members: TeamMember[];
  ownerUserId: string;
  /** 会话身份(判 canClaim:免登录无身份 → 不给「认领」) */
  sessionUserId: string | null;
  onOpenTask: (taskId: string) => void;
  /** 行尾就地主动作(与画布节点一致:认领/开始/执行/提交/评审/看原因) */
  onPrimary: (taskId: string, op: NodeActionOp) => void;
}

export function CrewListView({ tasks, members, ownerUserId, sessionUserId, onOpenTask, onPrimary }: CrewListViewProps) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const canClaim = !!sessionUserId;

  if (tasks.length === 0) {
    return <div className="ir-insp-list ir-insp-list--empty">工作图为空 —— 任务下推后在此列出。</div>;
  }

  return (
    <div className="ir-insp-list" role="list">
      {tasks.map((t) => {
        const assignee = t.assignee_member_id ? memberMap.get(t.assignee_member_id) ?? null : null;
        const role = (t.role_required ?? "").trim();
        const version = latestArtifactVersion(t);
        const visual = t.is_gate ? "done" : taskVisual(t, byId);
        const primary = nodePrimaryAction(t, visual, members, canClaim);
        const actBtn = primary && (
          <button
            type="button"
            className="ir-insp-listrow__run"
            onClick={() => onPrimary(t.id, primary.op)}
            title={primary.label}
          >
            {primary.label}
          </button>
        );

        if (t.is_gate) {
          const gv = gateVisual(t);
          return (
            <div key={t.id} className="ir-insp-listrow-wrap" role="listitem">
              <button type="button" className="ir-insp-listrow ir-insp-listrow--gate" onClick={() => onOpenTask(t.id)}>
                <GateSeal tone={gv} />
                <span className="ir-insp-listrow__title">{t.title}</span>
                <span className="ir-insp-listrow__kind">评审门</span>
                <span className="ir-insp-listrow__spacer" />
                <span className={`ir-insp-listrow__word ir-insp-listrow__word--gate-${gv}`}>
                  {gv === "passed" ? "已通过" : gv === "active" ? "活跃" : "待就绪"}
                </span>
              </button>
              {actBtn}
            </div>
          );
        }

        const word = statusWord(visual);
        return (
          <div key={t.id} className="ir-insp-listrow-wrap" role="listitem">
            <button type="button" className="ir-insp-listrow" onClick={() => onOpenTask(t.id)}>
              <StateSeal visual={visual} />
              <span className="ir-insp-listrow__title">{t.title}</span>
              {role && (
                <span className="ir-insp-listrow__role">
                  <span className={`ir-insp-roledot ir-insp-roledot--${roleColorSlug(role)}`} aria-hidden="true" />
                  {role}
                </span>
              )}
              <span className="ir-insp-listrow__spacer" />
              {assignee && (
                <span className="ir-insp-listrow__who">
                  <MemberAvatar member={assignee} isOwner={assignee.id === ownerUserId} size={18} />
                  {assignee.display_name}
                </span>
              )}
              {version != null && <span className="ir-insp-listrow__ver">v{version}</span>}
              <span className={`ir-insp-listrow__word ir-insp-listrow__word--${visual}`}>{word || "完成"}</span>
            </button>
            {actBtn}
          </div>
        );
      })}
    </div>
  );
}

export default CrewListView;
