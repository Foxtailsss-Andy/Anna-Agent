/**
 * ProposalCard · Anna Coordination Proposal 确认卡(CONTRACTS §2 · crew.propose_changes)
 *
 * 一张卡 = Anna 的一次结构化协作提案:N 个新任务(角色 / 依赖 / 「放在「X」之前」/ 负责人)
 * + M 条既有任务的指派(任务标题 → 成员名 · 理由)。确认前不是事实(未落图):
 * - 每项默认勾选,未勾 = 不采纳;「采纳 · n 项」= confirmChannelCommand(draft_indexes, assignment_indexes),
 *   Boss-only(服务端 owner 校验),服务端按 index 从命令行解析真提案,客户端不重发内容;
 * - payload.source.type === "workbench_run" → 「来自 Anna 对话」溯源;
 * - 已确认:草案血缘回链命中(created_from_message_id)或本卡刚采纳成功;只读呈现。
 * 名字解析走花名册 / 项目任务;解析不到原样显示 id(不臆造)。
 */

import { useState } from "react";

import { IrisPetal } from "../../../components/anna/IrisPetal";
import { ApiError } from "../../../lib/api/client";
import { confirmChannelCommand, type ChannelMessage, type CrewProject, type TeamMember } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { dispatchRingCall } from "../graph/graphMotion";
import { AnchorChip, MessageRow, type RowAuthor } from "./ChronicleLine";
import { allIndexes, isCommandConfirmed } from "./channelModel";
import type { ProposalDraft, ProposalView } from "./intentCard";

function ConfirmedSeal() {
  return (
    <span className="ir-chan-cmd__done">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
      已确认 · 已下推
    </span>
  );
}

const quoted = (titles: string[]) => titles.map((t) => `“${t}”`).join("、");

export interface ProposalCardProps {
  author: RowAuthor;
  time: string;
  message: ChannelMessage;
  proposal: ProposalView;
  members: TeamMember[];
  tasks: CrewTask[];
  projectId: string;
  isOwner: boolean;
  /** 非 Workbench 来源时的发言者名(引子用) */
  originAuthorName: string;
  onRefresh: (project?: CrewProject) => void;
  /** Server fact: a confirmation row in the channel points at this card. */
  confirmedInChannel?: boolean;
}

export function ProposalCard({
  author,
  time,
  message,
  proposal,
  members,
  tasks,
  projectId,
  isOwner,
  originAuthorName,
  onRefresh,
  confirmedInChannel = false,
}: ProposalCardProps) {
  const { drafts, assignments, fromWorkbenchRun, summary, suggestedAssignee } = proposal;
  const [pickedDrafts, setPickedDrafts] = useState<Set<number>>(() => allIndexes(drafts.length));
  const [pickedAssignments, setPickedAssignments] = useState<Set<number>>(() => allIndexes(assignments.length));
  const [adopted, setAdopted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grown = tasks.filter((t) => t.origin === "channel" && t.created_from_message_id === message.id);
  const confirmed = adopted || confirmedInChannel || isCommandConfirmed(message.id, tasks);
  if (dismissed && !confirmed) return null;

  const memberName = (id: string) => members.find((m) => m.id === id)?.display_name?.trim() || id;
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title?.trim() || id;
  const n = drafts.filter((_, i) => pickedDrafts.has(i)).length
    + assignments.filter((_, i) => pickedAssignments.has(i)).length;

  const toggle = (set: (fn: (s: Set<number>) => Set<number>) => void, i: number) =>
    set((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const adopt = async () => {
    if (busy || !isOwner || n === 0) return;
    setBusy(true);
    setError(null);
    try {
      const draftIndexes = drafts.map((_, i) => i).filter((i) => pickedDrafts.has(i));
      const assignmentIndexes = assignments.map((_, i) => i).filter((i) => pickedAssignments.has(i));
      const project = await confirmChannelCommand(projectId, message.id, draftIndexes, assignmentIndexes);
      const assigned = new Set(assignmentIndexes.map((i) => assignments[i].task_id));
      (project.tasks ?? [])
        .filter((t) => (t.origin === "channel" && t.created_from_message_id === message.id) || assigned.has(t.id))
        .forEach((t) => dispatchRingCall(t.id));
      setAdopted(true);
      onRefresh(project);
    } catch (e) {
      setError(e instanceof ApiError ? e.body || String(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const draftDetail = (d: ProposalDraft) =>
    [
      d.role ? `角色：${d.role}` : "",
      d.depends_on.length ? `依赖：${quoted(d.depends_on)}` : "",
      d.insert_before.length ? `放在${quoted(d.insert_before)}之前` : "",
      d.assignee_id ? `负责人：${memberName(d.assignee_id)}` : "",
      d.acceptance ? `验收：${d.acceptance}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <MessageRow author={author} time={time} audit="">
      <div className="ir-chan-card ir-chan-intent ir-chan-proposal">
        {!confirmed && <span className="ir-chan-intent__draft" aria-hidden="true">草稿</span>}
        <div className="ir-chan-intent__head">
          <IrisPetal size={12} />
          <span className="ir-chan-intent__watch">Anna 协调 · 提案</span>
          {confirmed ? (
            <ConfirmedSeal />
          ) : (
            <>
              <span className="ir-chan-intent__stage">起草</span>
              <span className="ir-chan-intent__ungraph">未落图</span>
            </>
          )}
        </div>

        {fromWorkbenchRun && <div className="ir-chan-proposal__source">来自 Anna 对话</div>}
        <div className="ir-chan-intent__lead">
          {summary ?? (fromWorkbenchRun ? "Anna 提议以下变更：" : `从 ${originAuthorName} 的发言里听出以下变更：`)}
        </div>
        {suggestedAssignee && drafts.length > 0 && (
          <div className="ir-chan-proposal__suggested">
            发言中 @ 指定：{memberName(suggestedAssignee)}（首个采纳的新任务）
          </div>
        )}

        {drafts.length > 0 && (
          <div className="ir-chan-proposal__section">
            <div className="ir-chan-proposal__label">新任务</div>
            <div className="ir-chan-cmd__list">
              {drafts.map((d, i) => {
                const on = confirmed || pickedDrafts.has(i);
                const title = d.title.trim() || "未命名任务";
                const detail = draftDetail(d);
                return (
                  <label key={i} className={`ir-chan-draft${on ? "" : " is-off"}`}>
                    {!confirmed && (
                      <input
                        type="checkbox"
                        className="ir-chan-draft__box"
                        checked={on}
                        onChange={() => toggle(setPickedDrafts, i)}
                        disabled={busy}
                        aria-label={`采纳新任务“${title}”`}
                      />
                    )}
                    <span className="ir-chan-draft__main">
                      <span className="ir-chan-draft__title">{title}</span>
                      {detail && <span className="ir-chan-draft__detail">{on ? detail : "未勾选 = 不采纳"}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {assignments.length > 0 && (
          <div className="ir-chan-proposal__section">
            <div className="ir-chan-proposal__label">指派</div>
            <div className="ir-chan-cmd__list">
              {assignments.map((a, i) => {
                const on = confirmed || pickedAssignments.has(i);
                const line = `${taskTitle(a.task_id)} → ${memberName(a.member_id)}`;
                return (
                  <label key={i} className={`ir-chan-draft${on ? "" : " is-off"}`}>
                    {!confirmed && (
                      <input
                        type="checkbox"
                        className="ir-chan-draft__box"
                        checked={on}
                        onChange={() => toggle(setPickedAssignments, i)}
                        disabled={busy}
                        aria-label={`采纳指派“${line}”`}
                      />
                    )}
                    <span className="ir-chan-draft__main">
                      <span className="ir-chan-draft__title">{line}</span>
                      {a.reason && <span className="ir-chan-draft__detail">{on ? a.reason : "未勾选 = 不采纳"}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {confirmed ? (
          grown[0] && (
            <div className="ir-chan-cardchips">
              <AnchorChip taskId={grown[0].id} label="跳到新节点" />
            </div>
          )
        ) : (
          <>
            <div className="ir-chan-intent__actions">
              <button
                type="button"
                className="ir-chan-btn ir-chan-btn--iris"
                disabled={busy || !isOwner || n === 0}
                onClick={adopt}
                title={!isOwner ? "只有项目负责人可以采纳" : undefined}
              >
                {busy ? "采纳中……" : `采纳 · ${n} 项`}
              </button>
              <button type="button" className="ir-chan-intent__ignore" disabled={busy} onClick={() => setDismissed(true)}>
                忽略
              </button>
            </div>
            {!isOwner && <div className="ir-chan-cmd__hint">只有项目负责人可以采纳</div>}
          </>
        )}
        {error && <div className="ir-chan-err">{error}</div>}
      </div>
    </MessageRow>
  );
}

export default ProposalCard;
