/**
 * IntentConfirmCard · R4b Anna 协调提案确认卡(3i;C3 origin 变体)
 *
 * 草稿态(未采纳=不进图/不进审计):头「Anna 协调 · 提案」+「起草」+「未落图」+「草稿」badge;
 *   引子「从 {speaker} 的发言里听出一项新任务:」+ serif 任务名;字段 负责人/依赖/验收(带 tag);
 *   按钮 采纳上图(iris)/ 调整 / 忽略。被派者为 Agent → 紫预告横条 + 主按钮「采纳并开跑」(delegate 紫)。
 * - 采纳:复用既有 confirm 端点(全草案下推,Boss-only)→ 采纳后对新任务点名环;
 * - 调整:切到标准命令卡(CommandDraftCard 勾选清单;登记:复用既有可编辑件)；
 * - 忽略:200ms 淡出下沉后本地隐藏(reduced-motion 直接消失),不发服务端、不追问。
 * 已确认(血缘回链命中)亦交 CommandDraftCard 呈现「已下推」态,避免双份逻辑。
 */

import { useState } from "react";

import { IrisPetal } from "../../../components/anna/IrisPetal";
import { ApiError } from "../../../lib/api/client";
import { confirmChannelCommand, type ChannelMessage, type CrewProject, type TeamMember } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { dispatchRingCall } from "../graph/graphMotion";
import { CommandDraftCard } from "./CommandDraftCard";
import { MessageRow, type RowAuthor } from "./ChronicleLine";
import { commandDrafts, isCommandConfirmed } from "./channelModel";
import { intentAssigneeIsAgent, intentSuggestedAssignee } from "./intentCard";

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5l12 7-12 7z" />
    </svg>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface IntentConfirmCardProps {
  author: RowAuthor;
  time: string;
  message: ChannelMessage;
  members: TeamMember[];
  tasks: CrewTask[];
  projectId: string;
  isOwner: boolean;
  /** 触发 say 的发言者名(ChannelColumn 由 origin_message_id 解析) */
  originAuthorName: string;
  onRefresh: (project?: CrewProject) => void;
}

export function IntentConfirmCard({
  author,
  time,
  message,
  members,
  tasks,
  projectId,
  isOwner,
  originAuthorName,
  onRefresh,
}: IntentConfirmCardProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = isCommandConfirmed(message.id, tasks);
  const drafts = commandDrafts(message);

  // 已采纳 或 用户点「调整」→ 交标准命令卡(勾选清单 / 已下推态),不重复实现
  if (confirmed || adjusting) {
    return (
      <CommandDraftCard
        author={author}
        time={time}
        message={message}
        tasks={tasks}
        projectId={projectId}
        isOwner={isOwner}
        onRefresh={onRefresh}
      />
    );
  }
  if (dismissed) return null;

  const assigneeId = intentSuggestedAssignee(message);
  const assignee = assigneeId ? members.find((m) => m.id === assigneeId) : undefined;
  const assigneeName = assignee?.display_name?.trim() || assigneeId || "待定";
  const isAgent = intentAssigneeIsAgent(message, members);
  const primary = drafts[0];
  const taskName = (primary?.title ?? "").trim() || "新任务";
  const deps = primary?.depends_on ?? [];
  const acceptance = (primary?.acceptance ?? "").trim();

  const adopt = async () => {
    if (busy || !isOwner) return;
    setBusy(true);
    setError(null);
    try {
      const idx = drafts.map((_, i) => i);
      const project = await confirmChannelCommand(projectId, message.id, idx);
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

  const ignore = () => {
    if (prefersReducedMotion()) {
      setDismissed(true);
      return;
    }
    setDismissing(true);
    window.setTimeout(() => setDismissed(true), 200);
  };

  return (
    <MessageRow author={author} time={time} audit="">
      <div className={`ir-chan-card ir-chan-intent${dismissing ? " is-dismissing" : ""}`}>
        <span className="ir-chan-intent__draft" aria-hidden="true">草稿</span>
        <div className="ir-chan-intent__head">
          <IrisPetal size={12} />
          <span className="ir-chan-intent__watch">Anna 协调 · 提案</span>
          <span className="ir-chan-intent__stage">起草</span>
          <span className="ir-chan-intent__ungraph">未落图</span>
        </div>

        <div className="ir-chan-intent__lead">
          从 {originAuthorName} 的发言里听出一项新任务：
          <span className="ir-chan-intent__taskname">“{taskName}”</span>
        </div>

        <div className="ir-chan-intent__fields">
          <div className="ir-chan-intent__field">
            <span className="ir-chan-intent__flabel">负责人</span>
            {isAgent ? (
              <span className="ir-chan-intent__agentpill">@{assigneeName}</span>
            ) : (
              <>
                <span className="ir-chan-intent__fval">{assigneeName}</span>
                <span className="ir-chan-intent__tag ir-chan-intent__tag--iris">发言中 @ 指定</span>
              </>
            )}
          </div>
          <div className="ir-chan-intent__field">
            <span className="ir-chan-intent__flabel">依赖</span>
            <span className="ir-chan-intent__fval">
              {deps.length ? deps.map((d) => `“${d}”`).join("、") : "无"}
            </span>
            <span className="ir-chan-intent__tag">Anna 建议 · 可改</span>
          </div>
          <div className="ir-chan-intent__field">
            <span className="ir-chan-intent__flabel">验收</span>
            <span className="ir-chan-intent__fval ir-chan-intent__fval--flex">{acceptance || "草稿"}</span>
            <span className="ir-chan-intent__tag">草稿 · 可改</span>
          </div>
          {drafts.length > 1 && (
            <div className="ir-chan-intent__more">
              另起草 {drafts.length - 1} 项（采纳后一并上图，可在“调整”中增删）
            </div>
          )}
        </div>

        {isAgent && (
          <div className="ir-chan-intent__preview">
            <span className="ir-chan-intent__pvdot" aria-hidden="true" />
            采纳后 <b>{assigneeName} 将立即执行</b>
          </div>
        )}

        <div className="ir-chan-intent__actions">
          <button
            type="button"
            className={`ir-chan-btn ${isAgent ? "ir-chan-btn--delegate" : "ir-chan-btn--iris"}`}
            disabled={busy || !isOwner}
            onClick={adopt}
            title={!isOwner ? "只有项目负责人可以采纳上图" : undefined}
          >
            {isAgent ? (
              <>
                <PlayIcon />
                采纳并开跑
              </>
            ) : (
              "采纳上图"
            )}
          </button>
          <button type="button" className="ir-chan-btn ir-chan-btn--ghost" disabled={busy} onClick={() => setAdjusting(true)}>
            调整
          </button>
          <button type="button" className="ir-chan-intent__ignore" disabled={busy} onClick={ignore}>
            忽略
          </button>
        </div>

        {!isOwner && <div className="ir-chan-cmd__hint">只有项目负责人可以采纳上图</div>}
        {error && <div className="ir-chan-err">{error}</div>}
      </div>
    </MessageRow>
  );
}

export default IntentConfirmCard;
