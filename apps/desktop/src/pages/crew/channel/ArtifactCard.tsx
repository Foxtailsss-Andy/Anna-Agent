/**
 * ArtifactCard · 产物卡(1d + R1):结=作者(Agent 方)· white 渐变卡 r12
 *   有真产物 → 嵌 R1 附件 chip(图标+名+vN+字数+展开/全幅阅读/定位/下载);无产物 → 退回
 *   标题行(零捏造:无产物无 chip)。
 *   定位去重:有 chip 时定位内置于 chip 准星;仅无 chip 的产物行保留下方「跳到节点」。
 *   「打开抽屉」入口撤除——任务推进/管理归工作图(心智:频道管读与定位,图管推进与管理)。
 *   isNew(轮询后新到)→ cardRise 入场(§3d 活动行完成后产物卡接棒)。
 */

import type { CrewTask } from "../crewModel";
import { ArtifactChip, type ReaderTarget } from "./AttachmentChip";
import { deriveArtifactChip } from "./artifactChip";
import { AnchorChip, MessageRow, type RowAuthor } from "./ChronicleLine";

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

export interface ArtifactCardProps {
  author: RowAuthor;
  time: string;
  audit: string;
  body: string;
  taskId: string | null;
  task: CrewTask | undefined;
  /** 轮询后新到 → cardRise 入场动画 */
  isNew?: boolean;
  onOpenReader?: (target: ReaderTarget) => void;
  onDownload?: (target: ReaderTarget) => void;
  /** 定位到工作图节点(缺省 no-op;页面接线=回图+点名环)。有 chip 时内置于 chip 准星。 */
  onLocate?: (taskId: string) => void;
}

export function ArtifactCard({ author, time, audit, body, taskId, task, isNew, onOpenReader, onDownload, onLocate }: ArtifactCardProps) {
  const chip = deriveArtifactChip(task);
  const title = (task?.title ?? "").trim() || body;
  // 摘要仅在无 chip 且与标题不同时另起一行(有 chip 时「展开」即全文,不重复)。
  const summary = !chip && body && body !== title ? body : "";

  return (
    <MessageRow author={author} time={time} audit={audit}>
      <div className={`ir-chan-card ir-chan-artifact${isNew ? " ir-chan-artifact--rise" : ""}`}>
        {chip ? (
          <ArtifactChip chip={chip} onOpenReader={onOpenReader} onDownload={onDownload} onLocate={onLocate} />
        ) : (
          <div className="ir-chan-artifact__head">
            <span className="ir-chan-artifact__icon" aria-hidden="true">
              <FileIcon />
            </span>
            <span className="ir-chan-artifact__title">{title}</span>
          </div>
        )}
        {summary && <div className="ir-chan-artifact__summary">{summary}</div>}
        {/* 去重:有 chip 时定位内置于准星;仅无 chip 的产物行保留下方「跳到节点」。 */}
        {taskId && !chip && (
          <div className="ir-chan-cardchips">
            <AnchorChip taskId={taskId} />
          </div>
        )}
      </div>
    </MessageRow>
  );
}

export default ArtifactCard;
