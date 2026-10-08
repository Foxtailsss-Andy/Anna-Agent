/**
 * WorkbenchChatPanel · Home 的 Workbench 会话视图(F2)。
 *
 * 纯投影:所有内容来自 Host 的 session/run 投影(CONTRACTS §1),不自造进度、token 或成功态。
 *   - 历史:session.messages 按序各渲染一次(用户右侧气泡 / 助手左侧 CrewMarkdown 气泡);
 *     乐观 prompt 只在投影里还没有该 Run 的用户消息时出现。
 *   - 流式:当前 Run 未终态且 live_output.text 非空 → 进行中的助手气泡;持久化消息到达或终态即让位。
 *   - 过程:plan(阶段→任务)+ tools 活动;沙箱徽标与权限 chip。
 *   - Goal 卡:目标、状态、轮次、计划进度、最近原因与该状态下 Host 允许的动作。
 *   - 执行过程:TraceDrawer(source="workbench")读 /api/workbench/runs/:id/trace。
 */
import { useState } from "react";

import type {
  WorkbenchEvent,
  WorkbenchGoal,
  WorkbenchGoalStatus,
  WorkbenchMessage,
  WorkbenchPlan,
  WorkbenchPlanTaskStatus,
  WorkbenchRun,
  WorkbenchSession,
  WorkbenchToolActivity,
} from "../../lib/api/workbench";
import { CrewMarkdown } from "../crew/CrewMarkdown";
import { TraceDrawer } from "../trace/TraceDrawer";
import type { WorkbenchGoalAction, WorkbenchResult } from "./useWorkbenchSession";
import "./WorkbenchChatPanel.css";

export interface WorkbenchChatPanelProps {
  session: WorkbenchSession | null;
  /** Current Run projection (fresher than session.runs right after submit). */
  run?: WorkbenchRun | null;
  prompt: string;
  status: string;
  runId: string | null;
  error: string | null;
  capabilities: string[];
  events: WorkbenchEvent[];
  onStop: () => void;
  composer: React.ReactNode;
  /** Short feedback above the composer (e.g. whether a steer was accepted). */
  notice?: string | null;
  /** Goal card actions; omitted → the card is read-only. */
  onGoalAction?: (action: WorkbenchGoalAction, options?: { maxRuns?: number }) => Promise<WorkbenchResult> | void;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "awaiting_input", "awaiting_approval"]);

const STATUS_LABELS: Record<string, string> = {
  queued: "已排队",
  running: "正在办理",
  completed: "已办妥",
  cancelled: "已停止",
  failed: "这一步没有办成",
  timed_out: "已超时",
  awaiting_input: "等待补充信息",
  awaiting_approval: "等待审批",
  not_started: "准备中",
};

const TASK_ICON: Record<WorkbenchPlanTaskStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  abandoned: "⊘",
  blocked: "!",
};

const TASK_LABEL: Record<WorkbenchPlanTaskStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  abandoned: "已放弃",
  blocked: "受阻",
};

const TOOL_LABEL: Record<WorkbenchToolActivity["status"], string> = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  unknown: "状态未知",
};

const GOAL_STATUS_LABEL: Record<WorkbenchGoalStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  awaiting_review: "待你确认",
  completed: "已完成",
  stopped: "已停止",
  budget_exhausted: "轮数已用完",
  failed: "未能完成",
};

/** Actions the Host accepts per Goal status (CONTRACTS §1.5). Order = render order. */
const GOAL_ACTIONS: Record<WorkbenchGoalStatus, Array<{ action: WorkbenchGoalAction; label: string }>> = {
  active: [{ action: "pause", label: "暂停" }, { action: "stop", label: "停止" }],
  paused: [{ action: "resume", label: "继续" }, { action: "stop", label: "停止" }],
  awaiting_review: [{ action: "complete", label: "确认完成" }],
  completed: [],
  stopped: [],
  budget_exhausted: [{ action: "resume", label: "继续" }],
  failed: [{ action: "resume", label: "继续" }],
};

const GOAL_REASON_LABEL: Record<string, string> = {
  plan_incomplete: "计划未完成，继续下一轮",
  run_timed_out: "上一轮超时",
  plan_complete: "计划已全部完成，等你确认",
  final_answer_without_plan: "已给出最终答复（未使用计划）",
  run_cancelled: "运行已取消",
  user_paused: "已由你暂停",
  user_stopped: "已由你停止",
  budget_exhausted: "轮数预算已用完",
  plan_blocked: "剩下的计划项被阻塞，需要你来决定",
  run_awaiting_input: "这一轮在等你的输入",
  run_awaiting_approval: "这一轮在等你的审批",
  user_confirmed: "已由你确认完成",
  user_resumed: "已由你恢复",
};

const GOAL_MAX_RUNS_LIMIT = 8;

/** Actions for the Goal's status; at the Run limit, “继续” becomes “再给 1 轮” (raises max_runs). */
function goalActions(goal: WorkbenchGoal): Array<{ action: WorkbenchGoalAction; label: string; maxRuns?: number }> {
  const atLimit = goal.runs_used >= goal.max_runs;
  if ((goal.status === "budget_exhausted" || goal.status === "failed") && atLimit) {
    return goal.max_runs < GOAL_MAX_RUNS_LIMIT
      ? [{ action: "resume", label: "再给 1 轮", maxRuns: goal.max_runs + 1 }]
      : [];
  }
  return GOAL_ACTIONS[goal.status] ?? [];
}

function goalReasonText(reason: string): string {
  if (reason.startsWith("run_failed:")) return `运行失败（${reason.slice("run_failed:".length)}）`;
  return GOAL_REASON_LABEL[reason] ?? reason;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function toolDuration(tool: WorkbenchToolActivity): string | null {
  if (tool.ended_at === undefined) return null;
  const start = Date.parse(tool.started_at);
  const end = Date.parse(tool.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return fmtMs(end - start);
}

function isContinuation(message: WorkbenchMessage, run: WorkbenchRun | undefined): boolean {
  return message.role === "user" && (run?.trigger === "goal_continuation" || message.content.startsWith("【目标续跑"));
}

/** Messages grouped by Run in session order (the Host lists each Run's messages contiguously). */
function groupByRun(messages: WorkbenchMessage[]): Array<{ runId: string; messages: WorkbenchMessage[] }> {
  const groups: Array<{ runId: string; messages: WorkbenchMessage[] }> = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (last && last.runId === message.run_id) last.messages.push(message);
    else groups.push({ runId: message.run_id, messages: [message] });
  }
  return groups;
}

function MessageBubble({ message, run, extraClass = "" }: { message: WorkbenchMessage; run?: WorkbenchRun; extraClass?: string }) {
  if (isContinuation(message, run)) {
    return (
      <div className="ir-workbench-chat__continuation">
        <span className="ir-workbench-chat__continuation-tag">目标续跑 · Host 自动</span>
        <details className="ir-workbench-chat__continuation-prompt">
          <summary>查看续跑指令</summary>
          <div>{message.content}</div>
        </details>
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className={`ir-workbench-chat__message ir-workbench-chat__message--assistant${extraClass}`}>
        <CrewMarkdown source={message.content} />
      </div>
    );
  }
  return (
    <div className={`ir-workbench-chat__message ir-workbench-chat__message--user${extraClass}`}>
      {message.content}
    </div>
  );
}

function PlanView({ plan }: { plan: WorkbenchPlan }) {
  const tasks = plan.phases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  return (
    <div className="ir-workbench-chat__plan" aria-label="计划">
      <div className="ir-workbench-chat__process-label">计划 · {done}/{tasks.length} 完成</div>
      {plan.phases.map((phase, phaseIndex) => (
        <div key={`${phase.name}-${phaseIndex}`} className="ir-workbench-chat__phase">
          <div className="ir-workbench-chat__phase-name">{phase.name}</div>
          <ul className="ir-workbench-chat__tasks">
            {phase.tasks.map((task, taskIndex) => (
              <li key={`${task.content}-${taskIndex}`} className={`ir-workbench-chat__task ir-workbench-chat__task--${task.status}`}>
                <span className="ir-workbench-chat__task-icon" aria-label={TASK_LABEL[task.status] ?? task.status}>
                  {TASK_ICON[task.status] ?? "·"}
                </span>
                <span className="ir-workbench-chat__task-text">
                  {task.content}
                  {task.blocker && <span className="ir-workbench-chat__task-blocker">{task.blocker}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ToolsView({ tools }: { tools: WorkbenchToolActivity[] }) {
  return (
    <div className="ir-workbench-chat__tools" aria-label="工具活动">
      <div className="ir-workbench-chat__process-label">工具 · {tools.length}</div>
      <ul className="ir-workbench-chat__toollist">
        {tools.map((tool) => {
          const duration = toolDuration(tool);
          return (
            <li key={tool.call_id} className={`ir-workbench-chat__tool ir-workbench-chat__tool--${tool.status}`}>
              <span className="ir-workbench-chat__tool-name">{tool.name}</span>
              <span className="ir-workbench-chat__tool-status">{TOOL_LABEL[tool.status] ?? tool.status}</span>
              {tool.summary && <span className="ir-workbench-chat__tool-summary">{tool.summary}</span>}
              {duration && <span className="ir-workbench-chat__tool-ms">{duration}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GoalCard({ goal, onAction }: { goal: WorkbenchGoal; onAction?: WorkbenchChatPanelProps["onGoalAction"] }) {
  const [pending, setPending] = useState<WorkbenchGoalAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const actions = onAction ? goalActions(goal) : [];
  const act = async (action: WorkbenchGoalAction, maxRuns?: number) => {
    if (!onAction || pending) return;
    setPending(action);
    setFailure(null);
    try {
      const result = await onAction(action, maxRuns === undefined ? undefined : { maxRuns });
      if (result && !result.ok) setFailure(result.error);
    } finally {
      setPending(null);
    }
  };
  return (
    <section className={`ir-workbench-chat__goal ir-workbench-chat__goal--${goal.status}`} aria-label="目标">
      <div className="ir-workbench-chat__goal-head">
        <span className="ir-workbench-chat__goal-kicker">目标模式</span>
        <span className="ir-workbench-chat__goal-status">{GOAL_STATUS_LABEL[goal.status] ?? goal.status}</span>
      </div>
      <div className="ir-workbench-chat__goal-objective">{goal.objective}</div>
      <div className="ir-workbench-chat__goal-meta">
        <span>第 {goal.runs_used}/{goal.max_runs} 轮</span>
        {goal.plan_progress && <span>计划 {goal.plan_progress.completed}/{goal.plan_progress.total}</span>}
        {goal.permission_mode === "contained-write" && <span>可修改工作目录</span>}
      </div>
      {goal.last_reason && <div className="ir-workbench-chat__goal-reason">{goalReasonText(goal.last_reason)}</div>}
      {failure && <div className="ir-workbench-chat__goal-error" role="alert">{failure}</div>}
      {actions.length > 0 && (
        <div className="ir-workbench-chat__goal-actions">
          {actions.map(({ action, label, maxRuns }) => (
            <button
              key={action}
              type="button"
              className={`ir-workbench-chat__goal-action ir-workbench-chat__goal-action--${action}`}
              disabled={pending !== null}
              onClick={() => void act(action, maxRuns)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkbenchChatPanel({
  session,
  run: runProp,
  prompt,
  status,
  runId,
  error,
  capabilities,
  events,
  onStop,
  composer,
  notice,
  onGoalAction,
}: WorkbenchChatPanelProps) {
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const messages = session?.messages ?? [];
  const runsById = new Map((session?.runs ?? []).map((item) => [item.run_id, item]));
  const run = (runProp && runProp.run_id === runId ? runProp : undefined) ?? (runId ? runsById.get(runId) : undefined);
  const goal = session?.goal ?? null;
  const terminal = run !== undefined && (TERMINAL.has(run.status) || run.admission_status === "failed");
  const isRunning = !terminal && (status === "queued" || status === "running" || status === "not_started");

  const groups = groupByRun(messages);
  const currentHasUserMessage = runId !== null && messages.some((message) => message.run_id === runId && message.role === "user");
  const optimisticPrompt = !currentHasUserMessage && prompt.trim() ? prompt : "";
  const currentAssistant = messages.filter((message) => message.run_id === runId && message.role === "assistant");
  const live = run?.live_output;
  const liveText = !terminal && live ? live.text : "";
  const lastPersisted = currentAssistant.at(-1)?.content.trim() ?? "";
  // The persisted message replaces the live buffer when it carries the streamed text.
  const livePersisted = liveText.trim() !== "" && lastPersisted !== "" && lastPersisted.startsWith(liveText.trim());
  const showLive = liveText.trim() !== "" && !livePersisted;
  const thinking = !terminal && live !== undefined && live.text.trim() === "" && live.reasoning_chars > 0;
  const statusText = showLive ? "正在生成" : thinking ? "思考中……" : STATUS_LABELS[status] ?? status;

  const firstUser = messages.find((message) => message.role === "user" && !isContinuation(message, runsById.get(message.run_id)));
  const title = goal?.objective ?? firstUser?.content ?? prompt;
  const hasProcess = Boolean(run?.plan?.phases.length) || Boolean(run?.tools?.length);
  const usage = run?.usage;
  const usageText = [
    usage?.input_tokens !== undefined ? `${usage.input_tokens}↑` : null,
    usage?.output_tokens !== undefined ? `${usage.output_tokens}↓` : null,
  ].filter(Boolean).join(" ");

  const meta = (
    <div className="ir-workbench-chat__meta">
      <div className="ir-workbench-chat__status" role="status">
        <span className={`ir-workbench-chat__dot${isRunning ? " ir-workbench-chat__dot--running" : ""}`} />
        <span>{statusText}</span>
        {runId && <span className="ir-workbench-chat__run-id">{runId}</span>}
      </div>
      {(run?.permission_mode || run?.sandbox || usageText) && (
        <div className="ir-workbench-chat__chips">
          {run?.permission_mode === "contained-write" && (
            <span className="ir-workbench-chat__chip ir-workbench-chat__chip--write">可修改工作目录</span>
          )}
          {run?.permission_mode === "readonly" && <span className="ir-workbench-chat__chip">只读</span>}
          {run?.sandbox && (
            <span className="ir-workbench-chat__chip ir-workbench-chat__chip--sandbox" title={run.sandbox.writable_roots.join("\n")}>
              沙箱 · macOS seatbelt · 无网络 · 仅工作目录可写
            </span>
          )}
          {usageText && <span className="ir-workbench-chat__chip ir-workbench-chat__chip--usage">tokens {usageText}</span>}
        </div>
      )}
      {(capabilities.length > 0 || events.some((event) => event.type === "capability.loaded")) && (
        <div className="ir-workbench-chat__capabilities" aria-label="已发现能力">
          <span className="ir-workbench-chat__capabilities-label">能力</span>
          {capabilities.map((capability) => <span key={capability} className="ir-workbench-chat__capability">{capability}</span>)}
        </div>
      )}
      {hasProcess && run && (
        <details className="ir-workbench-chat__process" open={isRunning}>
          <summary className="ir-workbench-chat__process-summary">过程</summary>
          {run.plan && run.plan.phases.length > 0 && <PlanView plan={run.plan} />}
          {run.tools && run.tools.length > 0 && <ToolsView tools={run.tools} />}
        </details>
      )}
    </div>
  );

  const liveBubble = showLive ? (
    <div className="ir-workbench-chat__message ir-workbench-chat__message--assistant ir-workbench-chat__message--live" aria-live="polite">
      <CrewMarkdown source={liveText} />
      <span className="ir-workbench-chat__live-note">
        <span className="ir-workbench-chat__caret" aria-hidden="true" />
        正在生成
      </span>
    </div>
  ) : null;

  const renderCurrent = (userMessages: WorkbenchMessage[], assistantMessages: WorkbenchMessage[], optimistic: string) => (
    <div key={`current-${runId ?? "pending"}`} className="ir-workbench-chat__turn ir-workbench-chat__turn--current">
      {userMessages.map((message, index) => (
        <MessageBubble key={`${message.event_id}-${index}`} message={message} run={run} extraClass=" ir-workbench-chat__message--current" />
      ))}
      {optimistic && (
        <div className="ir-workbench-chat__message ir-workbench-chat__message--user ir-workbench-chat__message--optimistic">{optimistic}</div>
      )}
      {meta}
      {assistantMessages.map((message, index) => (
        <MessageBubble key={`${message.event_id}-${index}`} message={message} run={run} extraClass=" ir-workbench-chat__message--current" />
      ))}
      {liveBubble}
    </div>
  );

  let currentRendered = false;
  const turns = groups.map((group) => {
    if (group.runId === runId) {
      currentRendered = true;
      return renderCurrent(
        group.messages.filter((message) => message.role === "user"),
        group.messages.filter((message) => message.role === "assistant"),
        "",
      );
    }
    const groupRun = runsById.get(group.runId);
    return (
      <div key={`run-${group.runId}`} className="ir-workbench-chat__turn">
        {group.messages.map((message, index) => (
          <MessageBubble key={`${message.event_id}-${index}`} message={message} run={groupRun} />
        ))}
        <button type="button" className="ir-workbench-chat__trace-link" onClick={() => setTraceRunId(group.runId)}>
          执行过程 ›
        </button>
      </div>
    );
  });
  if (!currentRendered && (optimisticPrompt || runId !== null || status !== "not_started" || error)) {
    turns.push(renderCurrent([], [], optimisticPrompt));
  }

  return (
    <div className="ir-home ir-home--session ir-workbench-chat">
      <div className="ir-home__main">
        <div className="ir-home__runhead">
          <span className="ir-home__runhead-title">{title.slice(0, 16) || "对话"}</span>
          {runId && <span className="ir-home__runhead-id">run {runId}</span>}
          {session && <span className="ir-home__runhead-thread">Session {session.session_id.slice(0, 8)}</span>}
          <span className="ir-home__runhead-spacer" />
          {runId && (
            <button
              type="button"
              className={`ir-home__headchip${traceRunId === runId ? " ir-home__headchip--on" : ""}`}
              onClick={() => setTraceRunId(runId)}
            >
              执行过程
            </button>
          )}
        </div>
        <div className="ir-home__scroll">
          <div className="ir-home__col ir-workbench-chat__col">
            <div className="ir-workbench-chat__history" aria-label="会话历史">{turns}</div>
            {error && <div className="ir-workbench-chat__error"><strong>未能完成：</strong>{error}</div>}
            {isRunning && (
              <button type="button" className="ir-home__suspend-stop ir-workbench-chat__stop" onClick={onStop} disabled={runId === null}>
                停止此 Run
              </button>
            )}
            {goal && <GoalCard goal={goal} onAction={onGoalAction} />}
          </div>
        </div>
        <div className="ir-home__dock">
          <div className="ir-home__col">
            {notice && <p className="ir-workbench-chat__notice" role="status">{notice}</p>}
            {composer}
          </div>
        </div>
      </div>
      <TraceDrawer source="workbench" runId={traceRunId ?? ""} open={traceRunId !== null} onClose={() => setTraceRunId(null)} />
    </div>
  );
}

export default WorkbenchChatPanel;
