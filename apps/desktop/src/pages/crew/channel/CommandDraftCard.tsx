/**
 * CommandDraftCard · +任务 起草卡(1d ⑥):结=Anna 瓣 · border iris .35 r12
 *   头「＋任务 · Anna 起草」+ 来源行;勾选行×N(框 15px,默认全勾;未勾=不下推);
 *   「确认下推 · n 项」iris 实心 pill(n 随勾选实时变,0 时禁用)+「调整」站位 disabled
 *   +「取消」。确认下推 = ADR-002 人落章:调 confirm API(服务端按 index 解析真草案),
 *   成功后卡落「已确认·已下推」章(血缘回链检测)+ 对新任务逐一 dispatchRingCall。
 *
 *   确认为 Boss-only(服务端 owner 校验);非 Boss 时确认钮禁用并给提示。
 *   卡内交互态(勾选/取消/批注)随消息 id 稳定 key 在轮询间存活。
 */

import { useState } from "react";

import { ApiError } from "../../../lib/api/client";
import { confirmChannelCommand, type ChannelMessage, type CrewProject } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { dispatchRingCall } from "../graph/graphMotion";
import { AnchorChip, MessageRow, type RowAuthor } from "./ChronicleLine";
import {
  allIndexes,
  buildConfirmPayload,
  commandDrafts,
  commandSourceText,
  isCommandConfirmed,
  selectedCount,
} from "./channelModel";

function ConfirmedSeal() {
  return (
    <span className="ir-chan-cmd__done" aria-hidden="true">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
      已确认 · 已下推
    </span>
  );
}

export interface CommandDraftCardProps {
  author: RowAuthor;
  time: string;
  message: ChannelMessage;
  tasks: CrewTask[];
  projectId: string;
  isOwner: boolean;
  onRefresh: (project?: CrewProject) => void;
}

export function CommandDraftCard({ author, time, message, tasks, projectId, isOwner, onRefresh }: CommandDraftCardProps) {
  const drafts = commandDrafts(message);
  const sourceText = commandSourceText(message);
  const confirmed = isCommandConfirmed(message.id, tasks);
  const grown = tasks.filter((t) => t.origin === "channel" && t.created_from_message_id === message.id);

  const [selected, setSelected] = useState<Set<number>>(() => allIndexes(drafts.length));
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = selectedCount(selected, drafts.length);

  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const onConfirm = async () => {
    if (n === 0 || busy || !isOwner) return;
    setBusy(true);
    setError(null);
    try {
      const { draft_indexes } = buildConfirmPayload(message.id, selected, drafts.length);
      const project = await confirmChannelCommand(projectId, message.id, draft_indexes);
      // 对新生任务逐一发起点名环(生长四幕由画布轮询 diff 触发,此处仅居中点名)
      (project.tasks ?? [])
        .filter((t) => t.origin === "channel" && t.created_from_message_id === message.id)
        .forEach((t) => dispatchRingCall(t.id));
      onRefresh(project);
    } catch (e) {
      setError(e instanceof ApiError ? e.body || String(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fromLine =
    `来自 ${author.name}${time ? ` ${time}` : ""} 的话` + (sourceText ? `：“${sourceText}”` : "");

  return (
    <MessageRow author={author} time={time} audit="">
      <div className="ir-chan-card ir-chan-cmd">
        <div className="ir-chan-cmd__head">
          <span className="ir-chan-cmd__badge">＋任务 · Anna 起草</span>
          {confirmed ? <ConfirmedSeal /> : <span className="ir-chan-cmd__draftflag">起草 · 未落图</span>}
        </div>
        <div className="ir-chan-cmd__from">{fromLine}</div>

        {confirmed ? (
          <div className="ir-chan-cmd__grown">
            {grown.map((t) => (
              <div key={t.id} className="ir-chan-cmd__grownrow">
                <span className="ir-chan-cmd__growntitle">{t.title}</span>
              </div>
            ))}
            <div className="ir-chan-cardchips">
              {grown[0] && <AnchorChip taskId={grown[0].id} label="跳到新节点" />}
              <span className="ir-chan-cmd__auditable">audit 可溯</span>
            </div>
          </div>
        ) : dismissed ? (
          <div className="ir-chan-cmd__cancelled">已取消起草（未下推）</div>
        ) : (
          <>
            <div className="ir-chan-cmd__list">
              {drafts.map((d, i) => {
                const on = selected.has(i);
                return (
                  <label key={i} className={`ir-chan-draft${on ? "" : " is-off"}`}>
                    <input type="checkbox" className="ir-chan-draft__box" checked={on} onChange={() => toggle(i)} />
                    <span className="ir-chan-draft__main">
                      <span className="ir-chan-draft__title">{d.title}</span>
                      <span className="ir-chan-draft__detail">
                        {on
                          ? [
                              d.role ? `建议：${d.role}` : "",
                              d.depends_on.length ? `依赖：${d.depends_on.map((x) => `“${x}”`).join("、")}` : "",
                              d.acceptance ? `验收：${d.acceptance}` : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "未勾选 = 不下推"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="ir-chan-cmd__actions">
              <button
                type="button"
                className="ir-chan-btn ir-chan-btn--iris"
                disabled={n === 0 || busy || !isOwner}
                onClick={onConfirm}
                title={!isOwner ? "只有项目负责人可以确认下推" : undefined}
              >
                确认下推 · {n} 项
              </button>
              <button type="button" className="ir-chan-btn ir-chan-btn--ghost" disabled aria-disabled="true">
                调整
              </button>
              <button type="button" className="ir-chan-cmd__cancel" disabled={busy} onClick={() => setDismissed(true)}>
                取消
              </button>
            </div>
            {!isOwner && <div className="ir-chan-cmd__hint">只有项目负责人可以确认下推</div>}
          </>
        )}
        {error && <div className="ir-chan-err">{error}</div>}
      </div>
    </MessageRow>
  );
}

export default CommandDraftCard;
