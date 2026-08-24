/**
 * ChronicleLine · 编年行(event 族)+ 五族共用行骨架(1a 右列 + 1d)
 *
 * 导出:
 * - RowAuthor 类型 + Knot(结形:Anna 鸢尾瓣 / 人圆 / Agent 方 r5,盖脊线);
 * - MsgHead(serif 署名 12.5/700 · 时间 mono 9.5 · audit 号 mono 9px 右缘;say 无号);
 * - MessageRow(结 + 头 + 子内容 —— 五族同一骨架);
 * - MentionBody(正文 @提及 → pill,iris/delegate 双色系;以 mentions 数组为准);
 * - AnchorChip(准星 chip → dispatchRingCall);Crosshair 图标。
 * - ChronicleLine 本体 = event 族:正文 + @pill + 可选锚点 chip。
 */

import { IrisPetal } from "../../../components/anna/IrisPetal";
import type { CrewTask } from "../crewModel";
import { dispatchRingCall } from "../graph/graphMotion";
import { ArtifactChip, type ReaderTarget } from "./AttachmentChip";
import { deriveArtifactChip } from "./artifactChip";
import { splitMentions, type MentionMeta } from "./channelModel";

/* ---------------- 类型 ---------------- */

export interface RowAuthor {
  /** anna=鸢尾瓣结 · human=圆结 · agent=方 r5 结 */
  kind: "anna" | "human" | "agent";
  name: string;
  /** agent 结的职能图元(文案/设计/验收);其余忽略 */
  role?: string;
  /** 人/Agent 结的回退首字 */
  initial: string;
}

/* ---------------- 图标(内联 SVG · 1.5px · currentColor · 无 emoji) ---------------- */

export function Crosshair({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}

function AgentGlyph({ role }: { role?: string }) {
  switch ((role ?? "").trim()) {
    case "文案":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M5 7h14M5 12h9M5 17h14" />
        </svg>
      );
    case "设计":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="9.5" cy="9.5" r="4" />
          <rect x="11.5" y="11.5" width="8" height="8" rx="1.5" />
        </svg>
      );
    case "验收":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    default:
      return null;
  }
}

/* ---------------- 结形(盖脊线) ---------------- */

export function Knot({ author }: { author: RowAuthor }) {
  if (author.kind === "anna") {
    return (
      <span className="ir-chan-knot ir-chan-knot--anna" aria-hidden="true">
        <IrisPetal size={13} />
      </span>
    );
  }
  if (author.kind === "agent") {
    const glyph = <AgentGlyph role={author.role} />;
    return (
      <span className="ir-chan-knot ir-chan-knot--agent" aria-hidden="true">
        {glyph ?? author.initial}
      </span>
    );
  }
  return (
    <span className="ir-chan-knot ir-chan-knot--human" aria-hidden="true">
      {author.initial}
    </span>
  );
}

/* ---------------- 署名头 ---------------- */

export function MsgHead({
  author,
  time,
  audit,
}: {
  author: RowAuthor;
  time: string;
  audit: string;
}) {
  return (
    <div className="ir-chan-head">
      <span className={`ir-chan-head__by${author.kind === "anna" ? " ir-chan-head__by--anna" : ""}${author.kind === "agent" ? " ir-chan-head__by--agent" : ""}`}>
        {author.name}
      </span>
      {time && <span className="ir-chan-head__time">{time}</span>}
      {audit && <span className="ir-chan-head__audit">{audit}</span>}
    </div>
  );
}

/* ---------------- 行骨架(五族共用) ---------------- */

export function MessageRow({
  author,
  time,
  audit,
  children,
  className,
}: {
  author: RowAuthor;
  time: string;
  audit: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`ir-chan-row ir-chan-row--${author.kind}${className ? ` ${className}` : ""}`}>
      <Knot author={author} />
      <div className="ir-chan-row__main">
        <MsgHead author={author} time={time} audit={audit} />
        {children}
      </div>
    </div>
  );
}

/* ---------------- 正文 @提及 → pill ---------------- */

export function MentionBody({
  body,
  mentions,
  className,
}: {
  body: string;
  mentions: MentionMeta[];
  className?: string;
}) {
  const segments = splitMentions(body, mentions);
  return (
    <div className={className ?? "ir-chan-body"}>
      {segments.map((seg, i) =>
        seg.type === "mention" ? (
          <span
            key={i}
            className={`ir-chan-pill${seg.isAgent ? " ir-chan-pill--agent" : ""}${seg.isCoordinator ? " ir-chan-pill--anna" : ""}`}
          >
            @{seg.name}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  );
}

/* ---------------- 锚点 chip(→ 画布点名环) ---------------- */

export function AnchorChip({ taskId, label = "跳到节点" }: { taskId: string; label?: string }) {
  return (
    <button
      type="button"
      className="ir-chan-anchor"
      onClick={() => dispatchRingCall(taskId)}
      title="在工作图上定位该节点"
    >
      <Crosshair />
      {label}
    </button>
  );
}

/* ---------------- event 族本体 ---------------- */

export interface ChronicleLineProps {
  author: RowAuthor;
  time: string;
  audit: string;
  body: string;
  mentions: MentionMeta[];
  /** 该行指向的任务(有则给锚点 chip → 点名环) */
  taskId: string | null;
  /** 交付事件所指任务(有真产物则嵌 R1 chip,零捏造:无产物无 chip) */
  task?: CrewTask;
  onOpenReader?: (target: ReaderTarget) => void;
  onDownload?: (target: ReaderTarget) => void;
  /** 定位到工作图节点(缺省 no-op;页面接线=回图+点名环)。有 chip 时内置于 chip 准星。 */
  onLocate?: (taskId: string) => void;
}

export function ChronicleLine({ author, time, audit, body, mentions, taskId, task, onOpenReader, onDownload, onLocate }: ChronicleLineProps) {
  const chip = deriveArtifactChip(task);
  return (
    <MessageRow author={author} time={time} audit={audit}>
      <MentionBody body={body} mentions={mentions} />
      {chip && (
        <div className="ir-chan-eventchip">
          <ArtifactChip chip={chip} onOpenReader={onOpenReader} onDownload={onDownload} onLocate={onLocate} />
        </div>
      )}
      {/* 去重:有 chip 时定位内置于准星;仅无 chip 的事件行保留下方「跳到节点」。 */}
      {taskId && !chip && (
        <div className="ir-chan-anchorrow">
          <AnchorChip taskId={taskId} />
        </div>
      )}
    </MessageRow>
  );
}

export default ChronicleLine;
