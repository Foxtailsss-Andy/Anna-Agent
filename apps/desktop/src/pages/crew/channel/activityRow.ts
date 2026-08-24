/**
 * activityRow · R2 频道活动行纯函数(在飞 = 三处同源同拍之一)
 *
 * - selectActiveTasks:执行中 agent 任务(C1 判定 status==="running" || run_inflight;门排除)。
 * - elapsedLabel:run_started_at → 「已运行 MM:SS」;无值/非法 → 「刚刚开始」;>99:59 封顶。
 *
 * elapsed 前端本地推进、以 run_started_at 校准 —— 后端只给「在飞 + 起跑时刻」,不谎报进度%。
 */

import type { CrewTask } from "../crewModel";

/**
 * 执行中的 agent 任务(活动行数据源)。C1:判定 = status==="running" || run_inflight。
 * 评审门(is_gate)排除 —— 门不是被执行的产出任务。多个在飞 → 多行(调用方逐一渲染)。
 * **agentIds 过滤(真机修)**:活动行是 Agent 在飞信号的投影——人类执行以小时/天计,
 * 挂「正在执行 · 刚刚开始」只会误导(Andy 案);给了花名册就只留 agent-assignee 任务。
 */
export function selectActiveTasks(
  tasks: readonly CrewTask[],
  agentIds?: ReadonlySet<string>,
): CrewTask[] {
  return tasks.filter((t) => {
    if (t.is_gate) return false;
    if (t.status !== "running" && t.run_inflight !== true) return false;
    if (agentIds) return !!t.assignee_member_id && agentIds.has(t.assignee_member_id);
    return true;
  });
}

/** MM:SS 封顶:99 分 59 秒(超长 run 不溢出布局;登记为落地选择)。 */
const MAX_ELAPSED_SEC = 99 * 60 + 59;

/**
 * 已运行时长标签。以 run_started_at(ISO)为锚、nowMs 为当前,算出 「已运行 MM:SS」;
 * 无起跑时刻或时刻非法 → 「刚刚开始」;负值夹到 0;>99:59 封顶到 99:59。
 */
export function elapsedLabel(startedAt: string | null | undefined, nowMs: number): string {
  if (!startedAt) return "刚刚开始";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "刚刚开始";
  let sec = Math.floor((nowMs - start) / 1000);
  if (sec < 0) sec = 0;
  if (sec > MAX_ELAPSED_SEC) sec = MAX_ELAPSED_SEC;
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `已运行 ${mm}:${ss}`;
}
