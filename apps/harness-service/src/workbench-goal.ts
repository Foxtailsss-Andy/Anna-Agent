/**
 * Session Goal: a user-authorized objective that the Host may pursue across
 * several ordinary Workbench Runs.
 *
 * The Goal never runs a model itself. After each Run reaches a terminal state
 * the Host decides — from durable evidence only (terminal status and the OMP
 * todo plan) — whether to submit one more ordinary Run through the same
 * Workbench admission path, or to settle the Goal. A model's claim of being
 * done never completes a Goal: a finished plan moves it to `awaiting_review`
 * and only the user's explicit confirmation completes it.
 */

export const GOAL_DEFAULT_MAX_RUNS = 4;
export const GOAL_MAX_RUNS_LIMIT = 8;

export type GoalStatus =
  | "active"
  | "paused"
  | "awaiting_review"
  | "completed"
  | "stopped"
  | "budget_exhausted"
  | "failed";

export type GoalPermissionMode = "readonly" | "contained-write";

export interface WorkbenchGoalRecord {
  readonly goal_id: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly max_runs: number;
  readonly run_ids: readonly string[];
  readonly permission_mode: GoalPermissionMode;
  readonly resource_refs: readonly string[];
  readonly source_event_id?: string;
  readonly last_reason?: string;
  readonly plan_progress?: { readonly completed: number; readonly total: number };
  readonly created_at: string;
  readonly updated_at: string;
}

export type PlanTaskStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface PlanSnapshot {
  readonly phases: ReadonlyArray<{
    readonly name: string;
    readonly tasks: ReadonlyArray<{ readonly content: string; readonly status: PlanTaskStatus; readonly blocker?: string }>;
  }>;
}

export interface GoalRunEvidence {
  /** Canonical terminal status of the latest Goal Run, or undefined while it is still running. */
  readonly terminalStatus?: string;
  /** Admission failure of the latest Goal Run (the Run never started). */
  readonly admissionError?: string;
  readonly failureReason?: string;
  readonly plan?: PlanSnapshot;
  readonly hasFinalText: boolean;
}

export type GoalDecision =
  | { readonly kind: "wait" }
  | { readonly kind: "continue"; readonly reason: "plan_incomplete" | "run_timed_out" }
  | { readonly kind: "settle"; readonly status: GoalStatus; readonly reason: string };

/** Counts open/finished plan items; abandoned items count as resolved but not completed. */
export function planProgress(plan: PlanSnapshot | undefined): { completed: number; total: number; open: number; blocked: number } | undefined {
  if (plan === undefined) return undefined;
  let completed = 0;
  let total = 0;
  let open = 0;
  let blocked = 0;
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      total += 1;
      if (task.status === "completed") completed += 1;
      else if (task.status !== "abandoned") open += 1;
      if (task.status === "blocked") blocked += 1;
    }
  }
  return total === 0 ? undefined : { completed, total, open, blocked };
}

export function decideGoal(goal: WorkbenchGoalRecord, latest: GoalRunEvidence): GoalDecision {
  if (goal.status !== "active") return { kind: "wait" };
  if (latest.admissionError !== undefined) {
    return { kind: "settle", status: "failed", reason: `run_failed:${latest.admissionError}` };
  }
  if (latest.terminalStatus === undefined) return { kind: "wait" };
  const exhausted = goal.run_ids.length >= goal.max_runs;
  switch (latest.terminalStatus) {
    case "cancelled":
      return { kind: "settle", status: "paused", reason: "run_cancelled" };
    case "failed":
      return { kind: "settle", status: "failed", reason: `run_failed:${latest.failureReason ?? "unknown"}` };
    case "awaiting_input":
    case "awaiting_approval":
      return { kind: "settle", status: "paused", reason: `run_${latest.terminalStatus}` };
    case "timed_out":
      return exhausted
        ? { kind: "settle", status: "budget_exhausted", reason: "budget_exhausted" }
        : { kind: "continue", reason: "run_timed_out" };
    case "completed": {
      const progress = planProgress(latest.plan);
      if (progress === undefined) {
        // No durable plan: the model's final answer is a claim, not a proof.
        return { kind: "settle", status: "awaiting_review", reason: "final_answer_without_plan" };
      }
      if (progress.open === 0) return { kind: "settle", status: "awaiting_review", reason: "plan_complete" };
      // Only blocked items left: another Run cannot unblock a user decision.
      if (progress.open === progress.blocked) return { kind: "settle", status: "paused", reason: "plan_blocked" };
      return exhausted
        ? { kind: "settle", status: "budget_exhausted", reason: "budget_exhausted" }
        : { kind: "continue", reason: "plan_incomplete" };
    }
    default:
      return { kind: "wait" };
  }
}

export function renderPlan(plan: PlanSnapshot | undefined): string {
  if (plan === undefined || plan.phases.length === 0) return "（上一轮没有留下 todo 计划）";
  const mark: Record<PlanTaskStatus, string> = {
    completed: "[x]",
    in_progress: "[>]",
    pending: "[ ]",
    blocked: "[!]",
    abandoned: "[-]",
  };
  return plan.phases.map((phase) => [
    `${phase.name}`,
    ...phase.tasks.map((task) => `  ${mark[task.status]} ${task.content}${task.blocker ? `（阻塞：${task.blocker}）` : ""}`),
  ].join("\n")).join("\n");
}

/** Host-authored prompt for the next ordinary Run of an active Goal. */
export function continuationPrompt(
  goal: WorkbenchGoalRecord,
  plan: PlanSnapshot | undefined,
  reason: "plan_incomplete" | "run_timed_out" | "user_resumed",
): string {
  const next = goal.run_ids.length + 1;
  return [
    `【目标续跑 ${next}/${goal.max_runs}】Host 按用户授权的目标模式自动发起本轮（不是用户新输入）。`,
    `用户目标：${goal.objective}`,
    `上一轮结束原因：${reason === "run_timed_out" ? "单轮预算用尽（未完成）" : reason === "user_resumed" ? "用户已恢复目标" : "计划仍有未完成项"}`,
    "当前 todo 计划：",
    renderPlan(plan),
    "请先用 todo 工具恢复/更新计划（init 时保留已完成项的状态），然后继续执行未完成项，不要重复已完成的工作。",
    "全部完成后给出简洁总结，并说明用户可如何验证结果；如果需要用户决定或缺少权限，请明确说明并停止。",
  ].join("\n");
}

export function parsePlan(details: unknown): PlanSnapshot | undefined {
  if (!isRecord(details) || !Array.isArray(details.phases)) return undefined;
  const statuses = new Set<PlanTaskStatus>(["pending", "in_progress", "completed", "abandoned", "blocked"]);
  const phases: Array<PlanSnapshot["phases"][number]> = [];
  for (const phase of details.phases) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return undefined;
    const tasks: Array<PlanSnapshot["phases"][number]["tasks"][number]> = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || !statuses.has(task.status as PlanTaskStatus)) return undefined;
      tasks.push({
        content: task.content,
        status: task.status as PlanTaskStatus,
        ...(typeof task.blocker === "string" && task.blocker !== "" ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name: phase.name, tasks });
  }
  return { phases };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
