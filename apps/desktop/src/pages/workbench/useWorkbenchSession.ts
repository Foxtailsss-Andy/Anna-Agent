import { useCallback, useEffect, useRef, useState } from "react";

import {
  completeWorkbenchGoal,
  createWorkbenchGoal,
  createWorkbenchSession,
  getWorkbenchRunEvents,
  getWorkbenchSession,
  pauseWorkbenchGoal,
  resumeWorkbenchGoal,
  steerWorkbenchRun,
  stopWorkbenchGoal,
  stopWorkbenchRun,
  submitWorkbenchRun,
  type WorkbenchEvent,
  type WorkbenchGoal,
  type WorkbenchGoalResponse,
  type WorkbenchPermissionMode,
  type WorkbenchRun,
  type WorkbenchSession,
  type WorkbenchSurface,
} from "../../lib/api/workbench";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "awaiting_input", "awaiting_approval"]);
const POLL_MS = 500;

export type WorkbenchResult = { ok: true; queued?: boolean } | { ok: false; error: string };
export type WorkbenchGoalAction = "pause" | "resume" | "stop" | "complete";

function userFacingError(error: unknown): string {
  const text = String(error);
  if (text.includes("model_not_configured")) return "模型尚未配置，当前无法开始回答。请先在设置中配置模型。";
  if (text.includes("business_service_unavailable")) return "业务身份服务暂不可用，无法建立工作台会话。";
  if (text.includes("permission_requires_workdir")) return "可写权限需要先绑定一个工作目录。";
  if (text.includes("goal_already_active")) return "这个会话已有进行中的目标，请先暂停或停止它。";
  if (text.includes("harness_signal_unavailable")) return "这次运行还没准备好接收补充说明，请稍候再试。";
  if (text.includes("goal_budget_exhausted")) return "目标的轮数已用完；可以再给它增加轮数（最多 8 轮）。";
  if (text.includes("goal_not_resumable")) return "这个目标当前不能继续。";
  if (text.includes("goal_not_active")) return "这个目标当前不在进行中。";
  if (text.includes("process_restarted")) return RUN_FAILURE_TEXT.process_restarted;
  if (text.includes("runtime_bridge_failed")) return RUN_FAILURE_TEXT.runtime_bridge_failed;
  return text.replace(/^Error:\s*/, "") || "工作台请求失败，请稍后重试。";
}

/** Readable copy for Run failure codes the Host projects on `run.failed`. */
export const RUN_FAILURE_TEXT: Record<string, string> = {
  process_restarted: "Anna 重启时这次运行被中断了；已有的结果仍保留，可以重新发起或继续目标。",
  runtime_bridge_failed: "运行环境出错，这次运行没有完成。",
};

function isRunTerminal(run: WorkbenchRun | null): boolean {
  return run !== null && (run.admission_status === "failed" || TERMINAL.has(run.status));
}

export interface WorkbenchStartOptions {
  resourceRefs?: string[];
  skillId?: string;
  agentId?: string;
  modelProfileId?: string;
  /** Omitted → Host default (`readonly`). */
  permissionMode?: WorkbenchPermissionMode;
}

export interface WorkbenchGoalOptions {
  /** 1..8; omitted → Host default (4). */
  maxRuns?: number;
  permissionMode?: WorkbenchPermissionMode;
  resourceRefs?: string[];
}

export interface WorkbenchSessionController {
  readonly session: WorkbenchSession | null;
  readonly run: WorkbenchRun | null;
  readonly runId: string | null;
  readonly status: string;
  readonly prompt: string;
  readonly events: WorkbenchEvent[];
  readonly capabilities: string[];
  readonly error: string | null;
  readonly starting: boolean;
  /** The current Run is admitted and not terminal. */
  readonly running: boolean;
  /** Session Goal projection (CONTRACTS §1.5); null when the session has none. */
  readonly goal: WorkbenchGoal | null;
  start(prompt: string, options?: WorkbenchStartOptions): Promise<WorkbenchResult>;
  /** Create the session (if needed) and its Goal; the view follows the Goal's newest Run. */
  startGoal(objective: string, options?: WorkbenchGoalOptions): Promise<WorkbenchResult>;
  controlGoal(action: WorkbenchGoalAction, options?: { maxRuns?: number }): Promise<WorkbenchResult>;
  /** Interject into the running Run; `ok:false` when the Host did not accept the text. */
  steer(text: string): Promise<WorkbenchResult>;
  restore(sessionId: string): Promise<WorkbenchResult>;
  stop(reason?: string): Promise<void>;
  reset(): void;
}

export function useWorkbenchSession(surface: WorkbenchSurface = "chat", projectId?: string): WorkbenchSessionController {
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const projectIdRef = useRef(projectId);
  const scopeKeyRef = useRef(`${surface}:${projectId ?? ""}`);
  const generationRef = useRef(0);
  /* Incremental event cursor for the current Run. `drained` = the terminal projection was
     observed and the events after it were read once; nothing further can arrive. */
  const cursorRef = useRef<{ runId: string | null; seq: number; drained: boolean }>({ runId: null, seq: -1, drained: false });
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const [run, setRun] = useState<WorkbenchRun | null>(null);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<WorkbenchEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const scopeKey = `${surface}:${projectId ?? ""}`;

  const isCurrent = useCallback((generation: number, sessionId: string, runId: string): boolean => (
    generation === generationRef.current
      && sessionIdRef.current === sessionId
      && runIdRef.current === runId
      && scopeKeyRef.current === scopeKey
  ), [scopeKey]);

  const sessionIsCurrent = useCallback((generation: number, sessionId: string): boolean => (
    generation === generationRef.current
      && sessionIdRef.current === sessionId
      && scopeKeyRef.current === scopeKey
  ), [scopeKey]);

  const resetEvents = useCallback((runId: string | null) => {
    cursorRef.current = { runId, seq: -1, drained: false };
    setEvents([]);
  }, []);

  /** Read only the events after the cursor; record a failure the Host projected. */
  const pullEvents = useCallback(async (generation: number, sessionId: string, runId: string, projected: WorkbenchRun | null) => {
    if (cursorRef.current.runId !== runId) resetEvents(runId);
    if (!cursorRef.current.drained) {
      const afterSeq = cursorRef.current.seq;
      const result = await getWorkbenchRunEvents(runId, afterSeq);
      if (!isCurrent(generation, sessionId, runId) || cursorRef.current.runId !== runId) return;
      const fresh = result.events.filter((event) => event.seq > cursorRef.current.seq);
      if (fresh.length > 0) {
        cursorRef.current.seq = Math.max(...fresh.map((event) => event.seq));
        setEvents((current) => [...current, ...fresh]);
        const failure = [...fresh].reverse().find((event) => event.type === "run.failed");
        if (failure) {
          const code = failure.error_code ?? failure.reason;
          setError(code === undefined ? "工作台运行失败，请检查当前能力配置。" : RUN_FAILURE_TEXT[code] ?? code);
        }
      }
      if (isRunTerminal(projected)) cursorRef.current.drained = true;
    }
    if (projected?.admission_status === "failed") setError(userFacingError(projected.admission_error ?? "run_admission_failed"));
  }, [isCurrent, resetEvents]);

  const refresh = useCallback(async (generation: number, sessionId: string) => {
    if (!sessionIsCurrent(generation, sessionId)) return;
    let runId = runIdRef.current;
    const detail = await getWorkbenchSession(sessionId);
    if (!sessionIsCurrent(generation, sessionId) || runIdRef.current !== runId) return;
    /* Goal mode: the Host starts continuation Runs; follow the newest one while the view is on
       one of the Goal's Runs (a plain Run the user started later — or is submitting right now,
       runId === null — is never hijacked). */
    const goal = detail.goal;
    const newest = goal?.run_ids.at(-1);
    if (goal && newest !== undefined && runId !== null && newest !== runId && goal.run_ids.includes(runId)) {
      const followed = detail.runs?.find((candidate) => candidate.run_id === newest);
      if (followed) {
        runId = newest;
        runIdRef.current = newest;
        setPrompt(followed.prompt ?? "");
        setError(null);
        resetEvents(newest);
      }
    }
    setSession(detail);
    if (runId === null) return;
    const projected = detail.runs?.find((item) => item.run_id === runId) ?? null;
    if (projected) setRun(projected);
    await pullEvents(generation, sessionId, runId, projected);
  }, [pullEvents, resetEvents, sessionIsCurrent]);

  /** Shared by start/startGoal: own the view, create the session on first use. */
  const beginSubmission = useCallback((text: string) => {
    const generation = ++generationRef.current;
    scopeKeyRef.current = scopeKey;
    // A new prompt owns the view immediately. Until submit returns, there is
    // no run id that a Stop action can safely target.
    runIdRef.current = null;
    setRun(null);
    resetEvents(null);
    setError(null);
    setPrompt(text);
    setStarting(true);
    return generation;
  }, [resetEvents, scopeKey]);

  const ensureSession = useCallback(async (generation: number): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const created = await createWorkbenchSession({ surface, projectId });
    if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return null;
    sessionIdRef.current = created.session_id;
    setSession(created);
    return created.session_id;
  }, [projectId, scopeKey, surface]);

  const start = useCallback(async (nextPrompt: string, options: WorkbenchStartOptions = {}): Promise<WorkbenchResult> => {
    const cleanPrompt = nextPrompt.trim();
    if (!cleanPrompt) return { ok: false, error: "请输入内容" };
    const generation = beginSubmission(cleanPrompt);
    const ownScope = scopeKey;
    try {
      const sessionId = await ensureSession(generation);
      if (sessionId === null) return { ok: false, error: "会话已切换" };
      const started = await submitWorkbenchRun(sessionId, {
        prompt: cleanPrompt,
        sourceEventId: `desktop:${surface}:${crypto.randomUUID()}`,
        surface,
        resourceRefs: options.resourceRefs,
        skillId: options.skillId,
        agentId: options.agentId,
        modelProfileId: options.modelProfileId,
        permissionMode: options.permissionMode,
      });
      if (generation !== generationRef.current || scopeKeyRef.current !== ownScope) return { ok: false, error: "会话已切换" };
      runIdRef.current = started.run_id;
      setRun(started);
      resetEvents(started.run_id);
      await refresh(generation, sessionId);
      return { ok: true };
    } catch (cause) {
      const message = userFacingError(cause);
      if (generation === generationRef.current && scopeKeyRef.current === ownScope) {
        setError(message);
        setRun(null);
      }
      return { ok: false, error: message };
    } finally {
      if (generation === generationRef.current && scopeKeyRef.current === ownScope) setStarting(false);
    }
  }, [beginSubmission, ensureSession, refresh, resetEvents, scopeKey, surface]);

  const startGoal = useCallback(async (objective: string, options: WorkbenchGoalOptions = {}): Promise<WorkbenchResult> => {
    const cleanObjective = objective.trim();
    if (!cleanObjective) return { ok: false, error: "请输入目标" };
    const generation = beginSubmission(cleanObjective);
    const ownScope = scopeKey;
    try {
      const sessionId = await ensureSession(generation);
      if (sessionId === null) return { ok: false, error: "会话已切换" };
      const created = await createWorkbenchGoal(sessionId, {
        objective: cleanObjective,
        sourceEventId: `desktop:${surface}:goal:${crypto.randomUUID()}`,
        maxRuns: options.maxRuns,
        permissionMode: options.permissionMode,
        resourceRefs: options.resourceRefs,
      });
      if (generation !== generationRef.current || scopeKeyRef.current !== ownScope) return { ok: false, error: "会话已切换" };
      runIdRef.current = created.run_id;
      resetEvents(created.run_id);
      setSession((current) => current && current.session_id === sessionId ? { ...current, goal: created.goal } : current);
      await refresh(generation, sessionId);
      return { ok: true };
    } catch (cause) {
      const message = userFacingError(cause);
      if (generation === generationRef.current && scopeKeyRef.current === ownScope) {
        setError(message);
        setRun(null);
      }
      return { ok: false, error: message };
    } finally {
      if (generation === generationRef.current && scopeKeyRef.current === ownScope) setStarting(false);
    }
  }, [beginSubmission, ensureSession, refresh, resetEvents, scopeKey, surface]);

  const controlGoal = useCallback(async (action: WorkbenchGoalAction, options: { maxRuns?: number } = {}): Promise<WorkbenchResult> => {
    const generation = generationRef.current;
    const sessionId = sessionIdRef.current;
    if (!sessionId) return { ok: false, error: "当前没有会话" };
    const call: (id: string) => Promise<WorkbenchGoalResponse> = {
      pause: pauseWorkbenchGoal,
      resume: (id: string) => resumeWorkbenchGoal(id, options.maxRuns),
      stop: stopWorkbenchGoal,
      complete: completeWorkbenchGoal,
    }[action];
    try {
      const result = await call(sessionId);
      if (!sessionIsCurrent(generation, sessionId)) return { ok: false, error: "会话已切换" };
      setSession((current) => current && current.session_id === sessionId ? { ...current, goal: result.goal } : current);
      if (result.run_id !== undefined && result.run_id !== runIdRef.current) {
        runIdRef.current = result.run_id;
        setRun(null);
        setError(null);
        resetEvents(result.run_id);
      }
      await refresh(generation, sessionId);
      return { ok: true };
    } catch (cause) {
      const message = userFacingError(cause);
      if (sessionIsCurrent(generation, sessionId)) setError(message);
      return { ok: false, error: message };
    }
  }, [refresh, resetEvents, sessionIsCurrent]);

  const steer = useCallback(async (text: string): Promise<WorkbenchResult> => {
    const cleanText = text.trim();
    if (!cleanText) return { ok: false, error: "请输入补充说明" };
    const runId = runIdRef.current;
    if (!runId) return { ok: false, error: "任务通道还在建立，请稍候再补充。" };
    try {
      const result = await steerWorkbenchRun(runId, cleanText);
      if (!result.accepted) return { ok: false, error: "这次运行已经结束，补充说明没能进入。" };
      return result.consumed === false ? { ok: true, queued: true } : { ok: true };
    } catch (cause) {
      return { ok: false, error: userFacingError(cause) };
    }
  }, []);

  const stop = useCallback(async (reason?: string) => {
    const generation = generationRef.current;
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (!runId || !sessionId) return;
    try {
      const stopped = await stopWorkbenchRun(runId, reason);
      if (!isCurrent(generation, sessionId, runId)) return;
      setRun((current) => current?.run_id === runId ? { ...current, status: stopped.status } : current);
      await refresh(generation, sessionId);
    } catch (cause) {
      if (isCurrent(generation, sessionId, runId)) {
        setError(userFacingError(cause));
      }
    }
  }, [isCurrent, refresh]);

  const restore = useCallback(async (sessionId: string): Promise<WorkbenchResult> => {
    const generation = ++generationRef.current;
    scopeKeyRef.current = scopeKey;
    setStarting(false);
    setError(null);
    try {
      const detail = await getWorkbenchSession(sessionId);
      if (generation !== generationRef.current) return { ok: false, error: "会话已切换" };
      const latestRun = detail.runs?.at(-1) ?? null;
      sessionIdRef.current = detail.session_id;
      runIdRef.current = latestRun?.run_id ?? null;
      setSession(detail);
      setRun(latestRun);
      setPrompt(latestRun?.prompt ?? detail.messages?.find((message) => message.role === "user")?.content ?? "");
      resetEvents(latestRun?.run_id ?? null);
      if (latestRun) {
        await pullEvents(generation, detail.session_id, latestRun.run_id, latestRun);
        if (!isCurrent(generation, detail.session_id, latestRun.run_id)) return { ok: false, error: "会话已切换" };
      }
      return { ok: true };
    } catch (cause) {
      const message = userFacingError(cause);
      if (generation === generationRef.current) setError(message);
      return { ok: false, error: message };
    }
  }, [isCurrent, pullEvents, resetEvents, scopeKey]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    sessionIdRef.current = null;
    runIdRef.current = null;
    cursorRef.current = { runId: null, seq: -1, drained: false };
    setSession(null);
    setRun(null);
    setPrompt("");
    setEvents([]);
    setError(null);
    setStarting(false);
  }, []);

  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;
    reset();
  }, [projectId, reset]);

  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    reset();
  }, [reset, scopeKey]);

  /* One interval per (session, run, active-goal). Its key is primitive, so a fresh run
     projection on every tick does not recreate it; nothing active → no polling. The
     generation joins the key so a restore/start in the same session re-arms the guard. */
  const sessionId = session?.session_id ?? null;
  const currentRunId = run?.run_id ?? runIdRef.current;
  const runActive = run !== null && !isRunTerminal(run);
  const goalActive = session?.goal?.status === "active";
  const shouldPoll = sessionId !== null && sessionIdRef.current === sessionId && (runActive || goalActive);
  const pollGeneration = generationRef.current;
  useEffect(() => {
    if (!shouldPoll || sessionId === null) return;
    let active = true;
    let inFlight = false;
    const generation = pollGeneration;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void refresh(generation, sessionId)
        .catch((cause) => {
          if (active && sessionIsCurrent(generation, sessionId)) setError(userFacingError(cause));
        })
        .finally(() => { inFlight = false; });
    }, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [currentRunId, goalActive, pollGeneration, refresh, sessionId, sessionIsCurrent, shouldPoll]);

  const projectedRun = session?.runs?.find((candidate) => candidate.run_id === runIdRef.current);
  const capabilities = Array.from(new Set([
    ...events.flatMap((event) => event.capability_ids ?? []),
    ...(run?.skill_id === undefined ? [] : [run.skill_id]),
    ...(projectedRun?.skill_id === undefined ? [] : [projectedRun.skill_id]),
  ]));
  return {
    session,
    run,
    runId: currentRunId,
    status: run?.admission_status === "failed" ? "failed" : run?.status ?? (error ? "failed" : "not_started"),
    prompt,
    events,
    capabilities,
    error,
    starting,
    running: runActive,
    goal: session?.goal ?? null,
    start,
    startGoal,
    controlGoal,
    steer,
    restore,
    stop,
    reset,
  };
}
