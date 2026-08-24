/**
 * inspect/helpers · 从真数据派生的小工具。
 *
 * run_ref / artifact_versions 现为 CrewTask(crewModel.ts)正式字段(F6 清理镜像);
 * 此处直接读取,不再 cast。
 */

import type { ChannelMessage } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";

/** 任务的 run_ref:优先 task.run_ref;回退最近一条带 run_ref 的频道行。 */
export function taskRunRef(task: CrewTask, channel: readonly ChannelMessage[]): string | null {
  if (task.run_ref) return task.run_ref;
  const rows = channel.filter((m) => m.task_id === task.id && m.run_ref);
  return rows.length ? (rows[rows.length - 1].run_ref as string) : null;
}

/** audit 号(右上):优先 run_ref,回退最近一条该任务频道行的 audit_ref(#a…);皆无 → null。 */
export function auditRefFor(task: CrewTask, channel: readonly ChannelMessage[]): string | null {
  if (task.run_ref) return task.run_ref;
  const rows = channel.filter((m) => m.task_id === task.id && m.audit_ref);
  return rows.length ? rows[rows.length - 1].audit_ref : null;
}

/** 最新产物版本号(artifact_versions 最大 version);无版本 → null(零捏造,不渲染 pill)。 */
export function latestArtifactVersion(task: CrewTask): number | null {
  const vs = task.artifact_versions;
  if (!vs || vs.length === 0) return null;
  return vs.reduce((mx, v) => (v.version > mx ? v.version : mx), vs[0].version);
}
