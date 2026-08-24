/**
 * ChannelColumn · 项目频道列(328 宽,1a 右列 + 1d 五卡族 + R1/R2/R4)
 *
 * - 头部 46px「项目频道 · Anna 主持」+ 折叠钮;编年脊线 left:23px 通栏;
 * - 消息按 kind 分派五族:event=编年行(交付事件有产物则嵌 R1 chip)/ artifact=产物卡(R1 chip
 *   + 新到 cardRise)/ review=评审卡(R1 chip)/ say=纸面气泡(外链 → 链接卡)/
 *   command=＋任务草案卡;origin==="intent" → Anna 监察确认卡(R4b);
 * - R2 活动行:在飞 agent 任务钉在时间线底(最新消息之后、composer 之前);
 * - composer(R4a @拾取器 + R6 Enter 发送)在底;
 * - 全幅阅读/下载上抛 C4(onOpenReader/onDownload,缺省 no-op,保 W1 独立编译);
 * - 不自轮询:channel 由 DetailPage 的画布 3s 快照流回;动作后调 onRefresh 立即重取。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { IrisPetal } from "../../../components/anna/IrisPetal";
import { StateNote } from "../../../components/anna/StateNote";
import type { ChannelMessage, CrewProject, TeamMember } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { ActivityRows } from "./ActivityRows";
import { ArtifactCard } from "./ArtifactCard";
import type { ReaderTarget } from "./AttachmentChip";
import { ChronicleLine, type RowAuthor } from "./ChronicleLine";
import { CommandDraftCard } from "./CommandDraftCard";
import { Composer } from "./Composer";
import { IntentConfirmCard } from "./IntentConfirmCard";
import { ReviewCard } from "./ReviewCard";
import { SayBubble } from "./SayBubble";
import { messageFamily, type MentionMeta } from "./channelModel";
import { intentOriginMessageId, isIntentCommand } from "./intentCard";
import { SYSTEM_ANNA_MENTION_ID } from "./pickerModel";
import "./channel.css";

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "right" ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
    </svg>
  );
}

export interface ChannelColumnProps {
  projectId: string;
  project: CrewProject;
  channel: ChannelMessage[] | null;
  members: TeamMember[];
  /** 当前会话是否项目负责人(Boss):门确认下推的权限口径 */
  isOwner: boolean;
  /** 动作后立即重取项目 + 频道(可选传入已知项目做即时更新) */
  onRefresh: (project?: CrewProject) => void;
  /** C4 阅读器入口(缺省 no-op,S-D1 接线);全幅阅读上抛 */
  onOpenReader?: (target: ReaderTarget) => void;
  /** 下载(缺省 no-op,后续切片接线) */
  onDownload?: (target: ReaderTarget) => void;
  /** 定位到工作图节点(缺省 no-op;O-C 页面接线=回图+点名环)。chip 准星消费。 */
  onLocate?: (taskId: string) => void;
  /** 一屏两键评审:全幅对照评审上抛(参数=门任务 id;缺省评审卡就地批) */
  onOpenReview?: (gateId: string) => void;
}

export function ChannelColumn({
  projectId,
  project,
  channel,
  members,
  isOwner,
  onRefresh,
  onOpenReader,
  onDownload,
  onLocate,
  onOpenReview,
}: ChannelColumnProps) {
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  const memberMap = new Map(members.map((m) => [m.id, m]));
  const tasksById = new Map((project.tasks ?? []).map((t) => [t.id, t]));
  const msgById = new Map((channel ?? []).map((m) => [m.id, m]));

  // 新消息 → 编年史滚到底(newest 在下)
  const count = channel?.length ?? 0;
  useLayoutEffect(() => {
    if (count > prevLen.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevLen.current = count;
  }, [count]);
  // 首次装载滚到底
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, []);

  // cardRise:仅对轮询后「新到」的产物卡放入场动画(首屏历史不复播 §3d)
  const seenArtifacts = useRef<Set<string>>(new Set());
  const firstRenderDone = useRef(false);
  useEffect(() => {
    for (const m of channel ?? []) {
      if (messageFamily(m) === "artifact") seenArtifacts.current.add(m.id);
    }
    firstRenderDone.current = true;
  });
  const isNewArtifact = (id: string) => firstRenderDone.current && !seenArtifacts.current.has(id);

  const resolveAuthor = (msg: ChannelMessage): RowAuthor => {
    if (msg.author_kind === "anna") return { kind: "anna", name: "Anna", initial: "A" };
    if (msg.author_kind === "worker") {
      const workerRef = msg.worker_profile_ref ?? msg.author_member_id ?? "";
      const memberId = workerRef.startsWith("member:") ? workerRef.slice("member:".length) : workerRef;
      const mem = memberId ? memberMap.get(memberId) : undefined;
      const name = (mem?.display_name ?? memberId) || "Worker";
      return { kind: "agent", name, role: mem?.role, initial: (name.trim()[0] ?? "W").toUpperCase() };
    }
    const mem = msg.author_member_id ? memberMap.get(msg.author_member_id) : undefined;
    const name = mem?.display_name ?? msg.author_member_id ?? "成员";
    const kind: RowAuthor["kind"] = mem?.kind === "agent" ? "agent" : "human";
    return { kind, name, role: mem?.role, initial: (name.trim()[0] ?? "·").toUpperCase() };
  };

  const resolveMentions = (ids: string[]): MentionMeta[] =>
    ids.map((id) => {
      if (id === SYSTEM_ANNA_MENTION_ID) {
        return { name: "Anna", isAgent: false, isCoordinator: true };
      }
      const mem = memberMap.get(id);
      return { name: mem?.display_name ?? id, isAgent: mem?.kind === "agent" };
    });

  const renderMessage = (msg: ChannelMessage) => {
    const author = resolveAuthor(msg);
    const time = timeOf(msg.created_at);
    const mentions = resolveMentions(msg.mentions ?? []);
    const task: CrewTask | undefined = msg.task_id ? tasksById.get(msg.task_id) : undefined;

    switch (messageFamily(msg)) {
      case "artifact":
        return (
          <ArtifactCard
            key={msg.id}
            author={author}
            time={time}
            audit={msg.audit_ref}
            body={msg.body}
            taskId={msg.task_id}
            task={task}
            isNew={isNewArtifact(msg.id)}
            onOpenReader={onOpenReader}
            onDownload={onDownload}
            onLocate={onLocate}
          />
        );
      case "review":
        return (
          <ReviewCard
            key={msg.id}
            author={author}
            time={time}
            audit={msg.audit_ref}
            body={msg.body}
            taskId={msg.task_id}
            task={task}
            tasks={project.tasks ?? []}
            projectId={projectId}
            onRefresh={onRefresh}
            onOpenReader={onOpenReader}
            onDownload={onDownload}
            onLocate={onLocate}
            onOpenReview={onOpenReview}
          />
        );
      case "say":
        return <SayBubble key={msg.id} author={author} time={time} body={msg.body} mentions={mentions} />;
      case "command": {
        if (isIntentCommand(msg)) {
          const originId = intentOriginMessageId(msg);
          const originMsg = originId ? msgById.get(originId) : undefined;
          const originAuthorName = originMsg ? resolveAuthor(originMsg).name : "发言者";
          return (
            <IntentConfirmCard
              key={msg.id}
              author={author}
              time={time}
              message={msg}
              members={members}
              tasks={project.tasks ?? []}
              projectId={projectId}
              isOwner={isOwner}
              originAuthorName={originAuthorName}
              onRefresh={onRefresh}
            />
          );
        }
        return (
          <CommandDraftCard
            key={msg.id}
            author={author}
            time={time}
            message={msg}
            tasks={project.tasks ?? []}
            projectId={projectId}
            isOwner={isOwner}
            onRefresh={onRefresh}
          />
        );
      }
      default:
        return (
          <ChronicleLine
            key={msg.id}
            author={author}
            time={time}
            audit={msg.audit_ref}
            body={msg.body}
            mentions={mentions}
            taskId={msg.task_id}
            task={task}
            onOpenReader={onOpenReader}
            onDownload={onDownload}
            onLocate={onLocate}
          />
        );
    }
  };

  if (collapsed) {
    return (
      <aside className="ir-crew-channel ir-crew-channel--collapsed">
        <button type="button" className="ir-chan-rail" onClick={() => setCollapsed(false)} aria-label="展开项目频道">
          <Chevron dir="left" />
          <span className="ir-chan-rail__label">项目频道</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="ir-crew-channel">
      <div className="ir-crew-channel__head">
        <IrisPetal size={13} />
        <span className="ir-crew-channel__title">项目频道</span>
        <span className="ir-crew-channel__by">Anna 主持</span>
        <button type="button" className="ir-chan-collapse" onClick={() => setCollapsed(true)} aria-label="折叠频道">
          <Chevron dir="right" />
        </button>
      </div>

      <div className="ir-crew-channel__list" ref={listRef}>
        <span className="ir-crew-channel__spine" aria-hidden="true" />
        {channel === null ? (
          <StateNote kind="loading" text="正在装载频道" />
        ) : channel.length === 0 ? (
          <div className="ir-crew-channel__empty">工作图建好后，编年史从这里开始。</div>
        ) : (
          channel.map(renderMessage)
        )}
        <ActivityRows tasks={project.tasks ?? []} members={members} />
      </div>

      <Composer projectId={projectId} members={members} onRefresh={onRefresh} />
    </aside>
  );
}

export default ChannelColumn;
