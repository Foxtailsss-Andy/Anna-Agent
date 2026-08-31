import { apiUrl } from "../runtime";
import { readSse } from "./sse";

export type PreviewRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface PreviewSettings {
  model_name: string;
  model_endpoint: string;
  workspace_root: string;
  has_api_key: boolean;
}

export interface PreviewStatus {
  protocol: "anna-harness-preview/1";
  kernel: "omp";
  configured: boolean;
  ready: boolean;
  reason?: string;
}

export interface PreviewRunSummary {
  run_id: string;
  goal: string;
  status: PreviewRunStatus;
  created_at: string;
  updated_at: string;
}

export interface PreviewCanonicalEvent {
  seq: number;
  type: string;
  timestamp?: string;
  payload?: unknown;
  [key: string]: unknown;
}

export interface PreviewRunDetails {
  run: PreviewRunSummary;
  events: PreviewCanonicalEvent[];
}

export interface PreviewStartResult {
  run_id: string;
  status: PreviewRunStatus;
}

export interface PreviewStopResult {
  run_id: string;
  status: PreviewRunStatus | "cancelling";
}

export class PreviewApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
    this.name = "PreviewApiError";
  }
}

async function previewFetch(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init?.json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : `http_${response.status}`;
    const message = typeof body.message === "string" ? body.message : undefined;
    throw new PreviewApiError(response.status, code, message);
  }
  return response;
}

async function previewJson<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  return (await (await previewFetch(path, init)).json()) as T;
}

export const getPreviewStatus = () => previewJson<PreviewStatus>("/api/preview/status");

export const getPreviewSettings = () => previewJson<PreviewSettings>("/api/preview/settings");

export function putPreviewSettings(input: {
  model_name: string;
  model_endpoint: string;
  workspace_root: string;
  model_api_key?: string;
}): Promise<PreviewSettings> {
  const model_api_key = input.model_api_key?.trim();
  return previewJson<PreviewSettings>("/api/preview/settings", {
    method: "PUT",
    json: {
      model_name: input.model_name.trim(),
      model_endpoint: input.model_endpoint.trim(),
      workspace_root: input.workspace_root.trim(),
      ...(model_api_key ? { model_api_key } : {}),
    },
  });
}

export async function listPreviewRuns(): Promise<PreviewRunSummary[]> {
  const body = await previewJson<{ runs: PreviewRunSummary[] }>("/api/preview/runs");
  return Array.isArray(body.runs) ? body.runs : [];
}

export const getPreviewRun = (runId: string) =>
  previewJson<PreviewRunDetails>(`/api/preview/runs/${encodeURIComponent(runId)}`);

export const startPreviewRun = (
  goal: string,
  runId: string,
  commandId: string,
) => previewJson<PreviewStartResult>("/api/preview/runs", {
  method: "POST",
  json: { run_id: runId, command_id: commandId, goal: goal.trim() },
});

export const stopPreviewRun = (runId: string) =>
  previewJson<PreviewStopResult>(`/api/preview/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    json: {},
  });

export async function subscribePreviewRun(
  runId: string,
  afterSeq: number,
  onEvent: (event: PreviewCanonicalEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await previewFetch(
    `/api/preview/runs/${encodeURIComponent(runId)}/events?after_seq=${encodeURIComponent(String(afterSeq))}`,
    { headers: { Accept: "text/event-stream" }, signal },
  );
  await readSse(response, (raw) => {
    const candidate = isRecord(raw.event) ? raw.event : raw;
    if (typeof candidate.type !== "string" || !Number.isSafeInteger(candidate.seq)) return;
    onEvent(candidate as PreviewCanonicalEvent);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function previewEventIsTerminal(event: PreviewCanonicalEvent): boolean {
  return [
    "run.completed",
    "run.failed",
    "run.timed_out",
    "run.cancelled",
  ].includes(event.type);
}

export function previewStatusFromEvent(
  event: PreviewCanonicalEvent,
): PreviewRunStatus | undefined {
  if (event.type === "run.queued") return "queued";
  if (event.type === "run.started") return "running";
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.failed") return "failed";
  if (event.type === "run.timed_out") return "timed_out";
  if (event.type === "run.cancelled") return "cancelled";
  return undefined;
}

export function createPreviewId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
