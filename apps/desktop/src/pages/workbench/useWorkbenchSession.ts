import { useCallback, useEffect, useRef, useState } from "react";

import {
  createWorkbenchSession,
  getWorkbenchRunEvents,
  getWorkbenchSession,
  stopWorkbenchRun,
  submitWorkbenchRun,
  type WorkbenchEvent,
  type WorkbenchRun,
  type WorkbenchSession,
  type WorkbenchSurface,
} from "../../lib/api/workbench";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "awaiting_input", "awaiting_approval"]);

function userFacingError(error: unknown): string {
  const text = String(error);
  if (text.includes("model_not_configured")) return "模型尚未配置，当前无法开始回答。请先在设置中配置模型。";
  if (text.includes("business_service_unavailable")) return "业务身份服务暂不可用，无法建立工作台会话。";
  return text.replace(/^Error:\s*/, "") || "工作台请求失败，请稍后重试。";
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
  readonly running: boolean;
  start(prompt: string, options?: {
    resourceRefs?: string[];
    skillId?: string;
    agentId?: string;
    modelProfileId?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  restore(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(reason?: string): Promise<void>;
  reset(): void;
}

export function useWorkbenchSession(surface: WorkbenchSurface = "chat", projectId?: string): WorkbenchSessionController {
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const projectIdRef = useRef(projectId);
  const scopeKeyRef = useRef(`${surface}:${projectId ?? ""}`);
  const generationRef = useRef(0);
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const [run, setRun] = useState<WorkbenchRun | null>(null);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<WorkbenchEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const isCurrent = useCallback((generation: number, sessionId: string, runId: string): boolean => (
    generation === generationRef.current
      && sessionIdRef.current === sessionId
      && runIdRef.current === runId
      && scopeKeyRef.current === `${surface}:${projectId ?? ""}`
  ), [projectId, surface]);

  const refresh = useCallback(async (generation: number, sessionId: string, runId: string) => {
    if (!isCurrent(generation, sessionId, runId)) return;
    const detail = await getWorkbenchSession(sessionId);
    if (!isCurrent(generation, sessionId, runId)) return;
    setSession(detail);
    const nextRun = detail.runs?.find((item) => item.run_id === runId) ?? null;
    if (nextRun) setRun(nextRun);
    const eventResult = await getWorkbenchRunEvents(runId);
    if (!isCurrent(generation, sessionId, runId)) return;
    setEvents(eventResult.events);
    const failure = [...eventResult.events].reverse().find((event) => event.type === "run.failed");
    if (failure) setError(failure.error_code ?? failure.reason ?? "工作台运行失败，请检查当前能力配置。");
    else if (nextRun?.admission_status === "failed") setError(userFacingError(nextRun.admission_error ?? "run_admission_failed"));
  }, [isCurrent]);

  const start = useCallback(async (nextPrompt: string, options: {
    resourceRefs?: string[];
    skillId?: string;
    agentId?: string;
    modelProfileId?: string;
  } = {}): Promise<{ ok: true } | { ok: false; error: string }> => {
    const cleanPrompt = nextPrompt.trim();
    if (!cleanPrompt) return { ok: false, error: "请输入内容" };
    const generation = ++generationRef.current;
    const scopeKey = `${surface}:${projectId ?? ""}`;
    scopeKeyRef.current = scopeKey;
    // A new prompt owns the view immediately. Until submit returns, there is
    // no run id that a Stop action can safely target.
    runIdRef.current = null;
    setRun(null);
    setEvents([]);
    setError(null);
    setPrompt(cleanPrompt);
    setStarting(true);
    try {
      let sessionId = sessionIdRef.current;
      if (!sessionId) {
        const created = await createWorkbenchSession({ surface, projectId });
        if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return { ok: false, error: "会话已切换" };
        sessionId = created.session_id;
        sessionIdRef.current = sessionId;
        setSession(created);
      }
      const started = await submitWorkbenchRun(sessionId, {
        prompt: cleanPrompt,
        sourceEventId: `desktop:${surface}:${crypto.randomUUID()}`,
        surface,
        resourceRefs: options.resourceRefs,
        skillId: options.skillId,
        agentId: options.agentId,
        modelProfileId: options.modelProfileId,
      });
      if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return { ok: false, error: "会话已切换" };
      runIdRef.current = started.run_id;
      setRun(started);
      setEvents([]);
      await refresh(generation, sessionId, started.run_id);
      return { ok: true };
    } catch (cause) {
      const message = userFacingError(cause);
      if (generation === generationRef.current && scopeKeyRef.current === scopeKey) {
        setError(message);
        setRun(null);
      }
      return { ok: false, error: message };
    } finally {
      if (generation === generationRef.current && scopeKeyRef.current === scopeKey) setStarting(false);
    }
  }, [projectId, refresh, surface]);

  const stop = useCallback(async (reason?: string) => {
    const generation = generationRef.current;
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (!runId || !sessionId) return;
    try {
      const stopped = await stopWorkbenchRun(runId, reason);
      if (!isCurrent(generation, sessionId, runId)) return;
      setRun((current) => current?.run_id === runId ? { ...current, status: stopped.status } : current);
      await refresh(generation, sessionId, runId);
    } catch (cause) {
      if (isCurrent(generation, sessionId, runId)) {
        setError(userFacingError(cause));
      }
    }
  }, [isCurrent, refresh]);

  const restore = useCallback(async (sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const generation = ++generationRef.current;
    scopeKeyRef.current = `${surface}:${projectId ?? ""}`;
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
      if (latestRun) {
        const eventResult = await getWorkbenchRunEvents(latestRun.run_id);
        if (generation !== generationRef.current || sessionIdRef.current !== sessionId || runIdRef.current !== latestRun.run_id) return { ok: false, error: "会话已切换" };
        setEvents(eventResult.events);
        const failure = [...eventResult.events].reverse().find((event) => event.type === "run.failed");
        if (failure) setError(failure.error_code ?? failure.reason ?? "工作台运行失败，请检查当前能力配置。");
        else if (latestRun.admission_status === "failed") setError(userFacingError(latestRun.admission_error ?? "run_admission_failed"));
      } else {
        setEvents([]);
      }
      return { ok: true };
    } catch (cause) {
      const message = userFacingError(cause);
      if (generation === generationRef.current) setError(message);
      return { ok: false, error: message };
    }
  }, [projectId, surface]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    sessionIdRef.current = null;
    runIdRef.current = null;
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
    const scopeKey = `${surface}:${projectId ?? ""}`;
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    reset();
  }, [projectId, reset, surface]);

  useEffect(() => {
    if (!runIdRef.current || !sessionIdRef.current || !run || TERMINAL.has(run.status)) return;
    let active = true;
    const generation = generationRef.current;
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (!sessionId || !runId) return;
    const timer = window.setInterval(() => {
      void refresh(generation, sessionId, runId).catch((cause) => {
        if (active && isCurrent(generation, sessionId, runId)) setError(userFacingError(cause));
      });
    }, 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isCurrent, refresh, run]);

  const projectedRun = session?.runs?.find((candidate) => candidate.run_id === runIdRef.current);
  const capabilities = Array.from(new Set([
    ...events.flatMap((event) => event.capability_ids ?? []),
    ...(run?.skill_id === undefined ? [] : [run.skill_id]),
    ...(projectedRun?.skill_id === undefined ? [] : [projectedRun.skill_id]),
  ]));
  return {
    session,
    run,
    runId: run?.run_id ?? runIdRef.current,
    status: run?.admission_status === "failed" ? "failed" : run?.status ?? (error ? "failed" : "not_started"),
    prompt,
    events,
    capabilities,
    error,
    starting,
    running: run !== null && run.admission_status !== "failed" && !TERMINAL.has(run.status),
    start,
    restore,
    stop,
    reset,
  };
}
