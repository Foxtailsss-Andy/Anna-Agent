import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createPreviewId,
  getPreviewRun,
  getPreviewSettings,
  getPreviewStatus,
  listPreviewRuns,
  previewEventIsTerminal,
  previewStatusFromEvent,
  putPreviewSettings,
  startPreviewRun,
  stopPreviewRun,
  subscribePreviewRun,
  type PreviewCanonicalEvent,
  type PreviewRunStatus,
  type PreviewRunSummary,
  type PreviewSettings,
  type PreviewStatus,
} from "../../lib/api/preview";
import annaLogo from "../../../../../build/icon.iconset/icon_128x128.png";
import "./PreviewPage.css";

const EMPTY_SETTINGS: PreviewSettings = {
  model_name: "",
  model_endpoint: "",
  workspace_root: "",
  has_api_key: false,
};

const EMPTY_STATUS: PreviewStatus = {
  protocol: "anna-harness-preview/1",
  kernel: "omp",
  configured: false,
  ready: false,
};

const TERMINAL_STATUSES = new Set<PreviewRunStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);

const EVENT_LABELS: Record<string, string> = {
  "run.created": "任务已创建",
  "run.queued": "已排队",
  "run.started": "开始执行",
  "skill.loaded": "Skill 已加载",
  "run.progress": "执行中",
  "tool.requested": "工具请求",
  "tool.policy.decided": "工具权限已判定",
  "tool.effect.started": "工具开始执行",
  "tool.effect.succeeded": "工具执行完成",
  "tool.effect.failed": "工具执行失败",
  "tool.result": "工具返回结果",
  "run.eval.contract": "终局校验",
  "run.completed": "任务已完成",
  "run.failed": "任务失败",
  "run.timed_out": "任务超时",
  "run.cancelled": "任务已停止",
};

function statusLabel(status: PreviewRunStatus | "cancelling"): string {
  return {
    queued: "排队中",
    running: "执行中",
    cancelling: "停止中",
    completed: "已完成",
    failed: "失败",
    timed_out: "超时",
    cancelled: "已停止",
  }[status];
}

function statusTone(status: PreviewRunStatus | "cancelling"): string {
  if (status === "completed") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  if (status === "cancelled") return "muted";
  return "active";
}

function hostStatusLabel(status: PreviewStatus): string {
  if (status.ready) return "OMP 已就绪";
  if (!status.configured) return "需要配置模型";
  if (status.reason === "omp_runtime_unavailable") return "OMP 不可用";
  if (status.reason === "runtime_unavailable") return "Host 不可用";
  return "等待运行";
}

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

function eventPayload(event: PreviewCanonicalEvent): Record<string, unknown> | null {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : null;
}

export function finalMessageFromEvent(event: PreviewCanonicalEvent): string | null {
  const payload = eventPayload(event);
  if (!payload) return null;
  if (event.type === "omp.transcript.message") {
    const message = payload.message;
    if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
    const assistantMessage = message as { role?: unknown; content?: unknown };
    if (assistantMessage.role !== "assistant" || !Array.isArray(assistantMessage.content)) return null;
    const text = assistantMessage.content
      .filter((block): block is { type?: unknown; text?: unknown } =>
        typeof block === "object" && block !== null && !Array.isArray(block),
      )
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    return text.trim() === "" ? null : text;
  }
  if (!previewEventIsTerminal(event)) return null;
  for (const key of ["final_message", "message", "text", "content", "response"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function formatEventTime(timestamp?: string): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Preview Host 请求失败";
}

function PreviewIcon({ name }: { name: "refresh" | "chevron" | "stop" | "close" }) {
  if (name === "refresh") {
    return (
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path d="M20 11a8 8 0 0 0-14.7-3.8L4 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 5v4h4M4 13a8 8 0 0 0 14.7 3.8L20 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20 19v-4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "stop") {
    return <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" /></svg>;
  }
  if (name === "close") {
    return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
  }
  return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function mergeEvent(events: PreviewCanonicalEvent[], next: PreviewCanonicalEvent): PreviewCanonicalEvent[] {
  if (events.some((event) => event.seq === next.seq)) return events;
  return [...events, next].sort((left, right) => left.seq - right.seq);
}

export function PreviewPage() {
  const [status, setStatus] = useState<PreviewStatus>(EMPTY_STATUS);
  const [settings, setSettings] = useState<PreviewSettings>(EMPTY_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState(EMPTY_SETTINGS);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [runs, setRuns] = useState<PreviewRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<PreviewRunSummary | null>(null);
  const [events, setEvents] = useState<PreviewCanonicalEvent[]>([]);
  const [goal, setGoal] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const running = selectedRun !== null
    && (selectedRun.status === "queued" || selectedRun.status === "running" || stopping);
  const finalMessage = useMemo(() => {
    for (const event of [...events].reverse()) {
      const message = finalMessageFromEvent(event);
      if (message) return message;
    }
    return null;
  }, [events]);

  const refreshRuns = useCallback(async () => {
    const nextRuns = await listPreviewRuns();
    setRuns(nextRuns);
    setSelectedRun((current) => {
      if (!current) return current;
      return nextRuns.find((run) => run.run_id === current.run_id) ?? current;
    });
  }, []);

  const applyEvent = useCallback((event: PreviewCanonicalEvent) => {
    setEvents((current) => mergeEvent(current, event));
    const nextStatus = previewStatusFromEvent(event);
    if (nextStatus) {
      setSelectedRun((current) => current
        ? { ...current, status: nextStatus, updated_at: event.timestamp ?? current.updated_at }
        : current);
      if (TERMINAL_STATUSES.has(nextStatus)) {
        setStopping(false);
        void refreshRuns().catch(() => undefined);
      }
    }
  }, [refreshRuns]);

  const streamRun = useCallback(async (
    run: PreviewRunSummary,
    seedEvents: PreviewCanonicalEvent[] = [],
  ) => {
    streamAbortRef.current?.abort();
    setEvents(seedEvents);
    const lastSeq = seedEvents.reduce((max, event) => Math.max(max, event.seq), -1);
    if (TERMINAL_STATUSES.has(run.status)) return;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    try {
      await subscribePreviewRun(run.run_id, lastSeq, applyEvent, controller.signal);
    } catch (streamError) {
      if (!controller.signal.aborted) setError(formatError(streamError));
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    }
  }, [applyEvent]);

  const openRun = useCallback(async (run: PreviewRunSummary) => {
    setError(null);
    setSelectedRun(run);
    try {
      const details = await getPreviewRun(run.run_id);
      setSelectedRun(details.run);
      await streamRun(details.run, details.events);
    } catch (loadError) {
      setError(formatError(loadError));
    }
  }, [streamRun]);

  useEffect(() => {
    let mounted = true;
    Promise.all([getPreviewStatus(), getPreviewSettings(), listPreviewRuns()])
      .then(([nextStatus, nextSettings, nextRuns]) => {
        if (!mounted) return;
        setStatus(nextStatus);
        setSettings(nextSettings);
        setSettingsDraft(nextSettings);
        setSettingsOpen(!nextStatus.configured);
        setRuns(nextRuns);
      })
      .catch((bootError) => {
        if (mounted) setError(formatError(bootError));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      streamAbortRef.current?.abort();
    };
  }, []);

  const saveSettings = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsDraft.model_name.trim() || !settingsDraft.model_endpoint.trim() || !settingsDraft.workspace_root.trim()) {
      setError("请填写模型、接口地址和工作区");
      return;
    }
    setSavingSettings(true);
    setError(null);
    try {
      const nextSettings = await putPreviewSettings({
        model_name: settingsDraft.model_name,
        model_endpoint: settingsDraft.model_endpoint,
        workspace_root: settingsDraft.workspace_root,
        ...(apiKeyDraft.trim() ? { model_api_key: apiKeyDraft } : {}),
      });
      const nextStatus = await getPreviewStatus();
      setSettings(nextSettings);
      setSettingsDraft(nextSettings);
      setApiKeyDraft("");
      setStatus(nextStatus);
      setSettingsOpen(false);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSavingSettings(false);
    }
  }, [apiKeyDraft, settingsDraft]);

  const submitGoal = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) return;
    if (!status.configured) {
      setSettingsOpen(true);
      setError("请先配置模型");
      return;
    }
    const runId = createPreviewId("run");
    const commandId = createPreviewId("command");
    setStarting(true);
    setError(null);
    try {
      const result = await startPreviewRun(trimmedGoal, runId, commandId);
      const now = new Date().toISOString();
      const run: PreviewRunSummary = {
        run_id: result.run_id,
        goal: trimmedGoal,
        status: result.status,
        created_at: now,
        updated_at: now,
      };
      setSelectedRun(run);
      setGoal("");
      setRuns((current) => [run, ...current.filter((item) => item.run_id !== run.run_id)]);
      await streamRun(run);
    } catch (startError) {
      setError(formatError(startError));
    } finally {
      setStarting(false);
    }
  }, [goal, status.configured, streamRun]);

  const stopCurrentRun = useCallback(async () => {
    if (!selectedRun || stopping || TERMINAL_STATUSES.has(selectedRun.status)) return;
    setStopping(true);
    setError(null);
    try {
      await stopPreviewRun(selectedRun.run_id);
    } catch (stopError) {
      setStopping(false);
      setError(formatError(stopError));
    }
  }, [selectedRun, stopping]);

  const currentStatus = stopping ? "cancelling" : selectedRun?.status;

  return (
    <div className="preview-page">
      <header className="preview-header">
        <div className="preview-brand">
          <img className="preview-brand__mark" src={annaLogo} alt="Anna" />
          <span className="preview-brand__name">Anna</span>
          <span className="preview-brand__context">Harness Preview</span>
        </div>
        <div className="preview-header__status" aria-live="polite">
          <span className={`preview-status-dot preview-status-dot--${status.ready ? "ready" : status.configured ? "configured" : "idle"}`} aria-hidden="true" />
          <span>{hostStatusLabel(status)}</span>
        </div>
      </header>

      <div className="preview-layout">
        <aside className="preview-history" aria-label="运行历史">
          <div className="preview-section-heading">
            <h2>运行历史</h2>
            <button type="button" className="preview-icon-button" onClick={() => void refreshRuns()} title="刷新运行历史" aria-label="刷新运行历史">
              <PreviewIcon name="refresh" />
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="preview-empty">暂无历史</p>
          ) : (
            <div className="preview-run-list">
              {runs.map((run) => (
                <button
                  key={run.run_id}
                  type="button"
                  className={`preview-run-item${selectedRun?.run_id === run.run_id ? " preview-run-item--selected" : ""}`}
                  onClick={() => void openRun(run)}
                >
                  <span className="preview-run-item__goal">{run.goal}</span>
                  <span className="preview-run-item__meta">
                    <span className={`preview-pill preview-pill--${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                    <time dateTime={run.updated_at}>{formatEventTime(run.updated_at)}</time>
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="preview-main">
          <section className="preview-composer" aria-labelledby="preview-task-title">
            <div className="preview-eyebrow">任务入口</div>
            <h1 id="preview-task-title">Anna Preview</h1>
            <div className="preview-new-task-label">新建任务</div>
            <p className="preview-subtitle">OMP kernel · 只读工作区</p>
            <form className="preview-goal-form" onSubmit={submitGoal}>
              <label htmlFor="preview-goal">任务目标</label>
              <textarea
                id="preview-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="例如：读取工作区中的 README.md，并概括它的启动步骤"
                rows={4}
                disabled={starting || running}
              />
              <div className="preview-form-actions">
                <span className="preview-form-hint">只读工具</span>
                <div className="preview-action-buttons">
                  <button type="button" className="preview-stop-button preview-stop-button--inline" onClick={() => void stopCurrentRun()} disabled={!selectedRun || !running || stopping} title={stopping ? "停止中" : "停止任务"} aria-label={stopping ? "停止中" : "停止任务"}>
                    <PreviewIcon name="stop" />
                    <span>{stopping ? "停止中" : "停止"}</span>
                  </button>
                  <button type="submit" className="preview-primary-button" disabled={starting || running || goal.trim() === ""}>
                    {starting ? "正在提交" : "提交任务"}
                  </button>
                </div>
              </div>
            </form>
          </section>

          <section className="preview-activity" aria-labelledby="preview-activity-title">
            <div className="preview-section-heading">
              <div>
                <div className="preview-eyebrow">Canonical events</div>
                <h2 id="preview-activity-title">运行过程</h2>
              </div>
              {currentStatus && <span className={`preview-pill preview-pill--${statusTone(currentStatus)}`}>{statusLabel(currentStatus)}</span>}
            </div>
            {!selectedRun ? (
              <p className="preview-empty">暂无运行</p>
            ) : events.length === 0 ? (
              <p className="preview-empty">正在等待首个事件……</p>
            ) : (
              <ol className="preview-event-list">
                {events.map((event) => (
                  <li key={`${event.seq}-${event.type}`} className={`preview-event preview-event--${previewEventIsTerminal(event) ? "terminal" : "default"}`}>
                    <span className="preview-event__marker" aria-hidden="true" />
                    <div className="preview-event__body">
                      <div className="preview-event__heading">
                        <strong>{eventLabel(event.type)}</strong>
                        <span className="preview-event__seq">#{event.seq}</span>
                        <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                      </div>
                      {eventPayload(event) && (
                        <details className="preview-event__details">
                          <summary>查看事件数据</summary>
                          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {finalMessage && (
              <div className="preview-final" aria-live="polite">
                <div className="preview-eyebrow">Final response</div>
                <p>{finalMessage}</p>
              </div>
            )}
          </section>
        </main>

        <aside className="preview-settings" aria-label="Preview 设置">
          <div className="preview-section-heading">
            <h2>设置</h2>
            <button
              type="button"
              className="preview-icon-button"
              aria-expanded={settingsOpen}
              aria-label={settingsOpen ? "收起设置" : "展开设置"}
              title={settingsOpen ? "收起设置" : "展开设置"}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <PreviewIcon name="chevron" />
            </button>
          </div>
          {settingsOpen && (
            <form className="preview-settings-form" onSubmit={saveSettings}>
              <label htmlFor="preview-model">模型</label>
              <input
                id="preview-model"
                value={settingsDraft.model_name}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, model_name: event.target.value }))}
                placeholder="模型名称"
                autoComplete="off"
              />
              <label htmlFor="preview-endpoint">接口地址</label>
              <input
                id="preview-endpoint"
                type="url"
                value={settingsDraft.model_endpoint}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, model_endpoint: event.target.value }))}
                placeholder="https://host/v1/chat/completions"
                autoComplete="off"
              />
              <label htmlFor="preview-api-key">API key</label>
              <input
                id="preview-api-key"
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder={settings.has_api_key ? "已保存，留空保持不变" : "只在本地保存"}
                autoComplete="new-password"
              />
              <label htmlFor="preview-workspace">工作区</label>
              <input
                id="preview-workspace"
                value={settingsDraft.workspace_root}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, workspace_root: event.target.value }))}
                placeholder="/path/to/workspace"
                autoComplete="off"
              />
              <button type="submit" className="preview-secondary-button" disabled={savingSettings}>
                {savingSettings ? "正在保存" : "保存设置"}
              </button>
              <p className="preview-settings-note">密钥只用于本地请求，界面不会回显。</p>
            </form>
          )}
          {loading && <p className="preview-loading" role="status">正在连接 Preview Host……</p>}
        </aside>
      </div>

      {error && (
        <div className="preview-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示" title="关闭错误提示"><PreviewIcon name="close" /></button>
        </div>
      )}
    </div>
  );
}

export default PreviewPage;
