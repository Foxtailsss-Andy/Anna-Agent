/**
 * ReviewCard · 评审卡(1d):结=Anna 瓣 · 金线滚边(频道内唯一金)r12
 *   金菱章「审」+「评审卡 · {门任务名}」+「对象 · …」(来自后端 body,B4 落 kind=review)。
 *   「通过」ok-soft / 「驳回＋批注」danger-soft;批注区默认收起,点驳回展开、必填。
 *   调既有 review API(POST …/tasks/{门 id}/review)→ onRefresh:评审就地驱动状态机。
 *
 * 仅当该门仍「活跃」(gateVisual==active)才给动作钮;已决(passed/dormant)显只读态,
 * 防重复评审(与画布活跃门指同一事实,金线预算共用)。
 */

import { useState } from "react";

import { ApiError } from "../../../lib/api/client";
import { reviewTask, type CrewProject } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { gateVisual } from "../graph/graphMapping";
import { ArtifactChip, type ReaderTarget } from "./AttachmentChip";
import type { ArtifactChipData } from "./artifactChip";
import { MessageRow, type RowAuthor } from "./ChronicleLine";
import { resolveReviewedArtifact, type ReviewedArtifact } from "./reviewArtifact";

function GoldSeal() {
  return (
    <span className="ir-chan-review__seal" aria-hidden="true">
      审
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/**
 * 内嵌被评审产物(#1 核心 + R1):门下方嵌同一 R1 附件 chip(展开=内嵌读全文、
 * 全幅阅读=上抛 C4)。无产物 → 显「尚无产物,无法评审」(禁用通过的依据)。
 */
function ReviewArtifact({
  reviewed,
  onOpenReader,
  onDownload,
  onLocate,
}: {
  reviewed: ReviewedArtifact;
  onOpenReader?: (target: ReaderTarget) => void;
  onDownload?: (target: ReaderTarget) => void;
  onLocate?: (taskId: string) => void;
}) {
  const v = reviewed.latest;
  if (!v) {
    return (
      <div className="ir-chan-review__art ir-chan-review__art--empty">
        尚无产物，无法评审 —— 待{reviewed.producerTitle ? `“${reviewed.producerTitle}”` : "上游"}提交后再审。
      </div>
    );
  }
  const chip: ArtifactChipData = {
    taskId: reviewed.producerId,
    title: reviewed.producerTitle || "产物",
    ext: "md",
    version: v.version,
    charCount: v.content.length,
    content: v.content,
  };
  return (
    <div className="ir-chan-review__art">
      <ArtifactChip chip={chip} onOpenReader={onOpenReader} onDownload={onDownload} onLocate={onLocate} />
    </div>
  );
}

export interface ReviewCardProps {
  author: RowAuthor;
  time: string;
  audit: string;
  body: string;
  taskId: string | null;
  task: CrewTask | undefined;
  /** 项目快照任务全集 —— 解析该门被评审 producer 的产物正文(内嵌预览) */
  tasks: CrewTask[];
  projectId: string;
  onRefresh: (project?: CrewProject) => void;
  onOpenReader?: (target: ReaderTarget) => void;
  onDownload?: (target: ReaderTarget) => void;
  /** 定位被评审产物到工作图节点(缺省 no-op;内置于被评审产物 chip 准星) */
  onLocate?: (taskId: string) => void;
  /** 一屏两键:全幅对照评审(左读全文 · 底钉通过/驳回);缺省则只有就地批 */
  onOpenReview?: (gateId: string) => void;
}

export function ReviewCard({ author, time, audit, body, taskId, task, tasks, projectId, onRefresh, onOpenReader, onDownload, onLocate, onOpenReview }: ReviewCardProps) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gate = task ? gateVisual(task) : null;
  const decided = gate !== "active";
  const gateTitle = (task?.title ?? "").trim();
  const heading = gateTitle ? `评审卡 · ${gateTitle}` : "评审卡";

  // #1:内嵌被评审产物;解析得到但无正文 → 盲审兜底,禁用「通过」。
  const reviewed = resolveReviewedArtifact(task, tasks);
  const noArtifact = reviewed != null && reviewed.latest == null;

  const act = async (approved: boolean) => {
    if (!taskId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await reviewTask(projectId, taskId, approved, approved ? null : comment.trim());
      onRefresh(project);
      setRejecting(false);
      setComment("");
    } catch (e) {
      setError(e instanceof ApiError ? e.body || String(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MessageRow author={author} time={time} audit={audit}>
      <div className="ir-chan-card ir-chan-review">
        <div className="ir-chan-review__head">
          <GoldSeal />
          <span className="ir-chan-review__title">{heading}</span>
        </div>
        {body && <div className="ir-chan-review__obj">{body}</div>}

        {reviewed && <ReviewArtifact reviewed={reviewed} onOpenReader={onOpenReader} onDownload={onDownload} onLocate={onLocate} />}

        {/* 一屏两键主路(3e「全幅对照评审」):左读全文,底部钉通过/驳回,判后回图 */}
        {!decided && !noArtifact && onOpenReview && taskId && (
          <button
            type="button"
            className="ir-chan-review__compare"
            onClick={() => onOpenReview(taskId)}
          >
            全幅对照评审
            <span className="ir-chan-review__compare-hint">左读全文 · 底部裁定</span>
          </button>
        )}

        {decided ? (
          <div className={`ir-chan-review__decided ir-chan-review__decided--${gate ?? "dormant"}`}>
            {gate === "passed" ? "已通过" : "待重审"}
          </div>
        ) : (
          <>
            <div className="ir-chan-review__actions">
              <button
                type="button"
                className="ir-chan-btn ir-chan-btn--ok"
                disabled={busy || !taskId || noArtifact}
                title={noArtifact ? "尚无产物，无法通过" : undefined}
                onClick={() => act(true)}
              >
                <CheckIcon />
                通过
              </button>
              <button
                type="button"
                className={`ir-chan-btn ir-chan-btn--danger${rejecting ? " is-armed" : ""}`}
                disabled={busy}
                onClick={() => setRejecting((v) => !v)}
                aria-expanded={rejecting}
              >
                驳回＋批注
              </button>
            </div>
            {rejecting && (
              <div className="ir-chan-review__note">
                <textarea
                  className="ir-chan-review__ta"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="批注（驳回时必填，注入 Agent 重跑上下文）"
                  rows={2}
                />
                <div className="ir-chan-review__noteact">
                  <button
                    type="button"
                    className="ir-chan-btn ir-chan-btn--danger-solid"
                    disabled={busy || comment.trim() === ""}
                    onClick={() => act(false)}
                  >
                    确认驳回
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {error && <div className="ir-chan-err">{error}</div>}
      </div>
    </MessageRow>
  );
}

export default ReviewCard;
