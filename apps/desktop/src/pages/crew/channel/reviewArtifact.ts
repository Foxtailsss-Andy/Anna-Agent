/**
 * reviewArtifact · R-F1 纯函数:评审门 → 被评审 producer 的最新产物正文。
 *
 * 门(is_gate)的 `reviews_task_id` 指向 producer 任务;取其 `artifact_versions` 最新版
 * (退化到扁平 `artifact` 字段)。解析不到 producer → null(不造产物);producer 在但
 * 无产物 → latest=null(评审卡据此显「尚无产物,无法评审」并禁用「通过」)。
 * 零捏造:一切来自项目快照真任务。
 */

import type { CrewTask } from "../crewModel";

export interface ArtifactVersionLite {
  /** 版本号;来自扁平 artifact 字段(无版本历史)时为 null → 不渲染版本 pill */
  version: number | null;
  content: string;
  submitted_at: string | null;
}

export interface ReviewedArtifact {
  producerId: string;
  producerTitle: string;
  /** 最新产物正文;producer 无任何产物时为 null */
  latest: ArtifactVersionLite | null;
  /** 版本历史条数(0 = 无版本历史) */
  versionCount: number;
}

export function resolveReviewedArtifact(
  gate: CrewTask | undefined | null,
  tasks: readonly CrewTask[],
): ReviewedArtifact | null {
  if (!gate || !gate.reviews_task_id) return null;
  const producer = tasks.find((t) => t.id === gate.reviews_task_id);
  if (!producer) return null;

  const versions = [...(producer.artifact_versions ?? [])].sort(
    (a, b) => b.version - a.version,
  );

  let latest: ArtifactVersionLite | null = null;
  if (versions.length > 0 && (versions[0].content ?? "").trim() !== "") {
    latest = {
      version: versions[0].version,
      content: versions[0].content,
      submitted_at: versions[0].submitted_at,
    };
  }
  if (!latest && (producer.artifact ?? "").trim() !== "") {
    latest = { version: null, content: producer.artifact as string, submitted_at: null };
  }

  return {
    producerId: producer.id,
    producerTitle: (producer.title ?? "").trim(),
    latest,
    versionCount: versions.length,
  };
}
