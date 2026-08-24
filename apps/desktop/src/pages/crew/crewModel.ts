/**
 * crewModel · Crew 前端纯函数与类型(零捏造:一切来自后端真事件)
 *
 * - projectProgress:进度 x/y(x=done 任务数,y=总任务数)——侧栏子列表 + 健康条共用。
 * - deriveUnreadBadge:未读徽标推导,0 或接口失败 → null(隐藏,绝不造数)。
 * - runningCount / awaitingCount:健康条 chip 计数(零值由调用方隐藏 chip)。
 *
 * 说明:awaitingCount(「等我处理」)F1 骨架取 待审(submitted|in_review)口径;
 * 逐成员精确聚合属 F5 收件箱,届时按 session member 细化。
 */

/** 后端 CrewTask 契约(services/crew/app/schemas.py:CrewTask)。 */
export interface CrewTask {
  id: string;
  project_id: string;
  key: string;
  title: string;
  description?: string;
  status: string;
  role_required: string;
  assignee_member_id?: string | null;
  depends_on?: string[];
  is_gate?: boolean;
  reviews_task_id?: string | null;
  acceptance_criteria?: string | null;
  artifact?: string | null;
  review_comment?: string | null;
  blocker?: string | null;
  origin?: string;
  created_from_message_id?: string | null;
  /** B2:产出该任务的后台 Agent run(链到帧 trace GET /api/crew/runs/{run_ref}/frames);人工任务为 null */
  run_ref?: string | null;
  /** C1(精修二轮):后台 run 在飞注解(路由层出,queued+running 全程 true);「执行中」判定 = status==="running" || run_inflight */
  run_inflight?: boolean;
  /** C1:run 起跑时刻(ISO,worker 写、终态清);活动行 elapsed 本地推进以此校准,无值显「刚刚开始」 */
  run_started_at?: string | null;
  /** B4:产物版本历史(submit/agent 产出追加,version 递增);无则版本 pill 不渲染(零捏造) */
  artifact_versions?: { version: number; content: string; submitted_at: string }[];
}

/** 后端 CrewProject 契约(schemas.py:CrewProject)。 */
export interface CrewProject {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  goal_text: string;
  sop_template_id: string;
  status: "active" | "completed";
  tasks: CrewTask[];
  audit_events?: Record<string, unknown>[];
  source?: string;
  showcase?: {
    scenario_id: string;
    version: number;
    locale: string;
    mode: string;
  } | null;
}

export interface Progress {
  done: number;
  total: number;
  /** `${done}/${total}` —— mono 展示 */
  label: string;
}

type StatusLike = { status: string };

/** 进度:done 任务 / 总任务(含评审门,均为 CrewTask 条目)。 */
export function projectProgress(tasks: StatusLike[]): Progress {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  return { done, total, label: `${done}/${total}` };
}

/**
 * 未读徽标:接口失败(null/undefined)或 0 及以下 → null(隐藏,不造数);
 * >99 收敛为 "99+"。
 */
export function deriveUnreadBadge(count: number | null | undefined): string | null {
  if (count == null || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** 执行中任务数(status==running)——健康条「Agent 执行中」chip。 */
export function runningCount(tasks: StatusLike[]): number {
  return tasks.filter((t) => t.status === "running").length;
}

/** 待审任务数(submitted|in_review)——健康条「等我处理」chip(F1 骨架口径)。 */
export function awaitingCount(tasks: StatusLike[]): number {
  return tasks.filter((t) => t.status === "submitted" || t.status === "in_review").length;
}
