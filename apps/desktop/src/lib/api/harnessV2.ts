import { v2ApiBase, v2ApiUrl } from "../runtime";
import { ApiError } from "./client";
import { getIdentity, identityHeaders } from "./identity";

export const HARNESS_V2_SURFACE_IDS = ["create", "cowork", "hub"] as const;
export type HarnessV2SurfaceId = typeof HARNESS_V2_SURFACE_IDS[number];

export interface HarnessV2Capabilities {
  api_version?: string;
  status?: string;
  surfaces?: readonly {
    id: string;
    status: string;
    reason?: string;
  }[];
  [key: string]: unknown;
}

export interface StartHarnessV2RunInput {
  channelId: string;
  commandId: string;
  sourceEventId: string;
  goal: string;
  runId?: string;
  parentRunId?: string;
  parentEventId?: string;
  laneId?: string;
}

export interface StartHarnessV2RunResponse {
  surface_id: HarnessV2SurfaceId;
  run_id: string;
  status: string;
}

export interface HarnessV2RunEvents {
  run_id: string;
  events: readonly HarnessV2CanonicalEvent[];
}

export interface HarnessV2CanonicalEvent {
  seq: number;
  type: string;
  timestamp?: string;
  payload?: unknown;
}

export interface HarnessV2CreateRunProjection {
  runId: string;
  status: string;
  artifact?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  activation: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface HarnessV2CreateRunRecord extends HarnessV2CreateRunProjection {
  prompt: string;
  commandId: string;
  sourceEventId: string;
}

export interface HarnessV2CreateRuns {
  runs: readonly HarnessV2CreateRunRecord[];
}

export interface HarnessV2CreateActivationResponse {
  status: string;
  code?: string;
  [key: string]: unknown;
}

async function v2Json<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  if (v2ApiBase() === "") {
    throw new Error("Harness v2 API base is not configured");
  }
  const identity = await getIdentity();
  const headers: Record<string, string> = {
    ...identityHeaders(identity),
    ...(init?.json === undefined ? {} : { "Content-Type": "application/json" }),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const response = await fetch(v2ApiUrl(path), {
    ...init,
    headers,
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ""));
  }
  return (await response.json()) as T;
}

export function getHarnessV2Capabilities(): Promise<HarnessV2Capabilities> {
  return v2Json<HarnessV2Capabilities>("/capabilities");
}

export async function listHarnessV2CreateRuns(input: { channelId: string }): Promise<HarnessV2CreateRuns> {
  const identity = await getIdentity();
  const query = new URLSearchParams({
    workspace_id: identity.workspaceId,
    channel_id: input.channelId,
  });
  return v2Json<HarnessV2CreateRuns>(`/v2/create/runs?${query.toString()}`, { method: "GET" });
}

export async function startHarnessV2Run(
  surfaceId: HarnessV2SurfaceId,
  input: StartHarnessV2RunInput,
): Promise<StartHarnessV2RunResponse> {
  return v2Json<StartHarnessV2RunResponse>(
    `/v2/surfaces/${surfaceId}/runs`,
    {
      method: "POST",
      json: {
        workspace_id: (await getIdentity()).workspaceId,
        channel_id: input.channelId,
        command_id: input.commandId,
        source_event_id: input.sourceEventId,
        goal: input.goal,
        ...(input.runId === undefined ? {} : { run_id: input.runId }),
        ...(input.parentRunId === undefined ? {} : { parent_run_id: input.parentRunId }),
        ...(input.parentEventId === undefined ? {} : { parent_event_id: input.parentEventId }),
        ...(input.laneId === undefined ? {} : { lane_id: input.laneId }),
      },
    },
  );
}

export function resumeHarnessV2Run(
  surfaceId: HarnessV2SurfaceId,
  runId: string,
  input: { channelId: string },
): Promise<StartHarnessV2RunResponse> {
  return getIdentity().then((identity) => v2Json<StartHarnessV2RunResponse>(
    `/v2/surfaces/${surfaceId}/runs/${encodeURIComponent(runId)}/resume`,
    {
      method: "POST",
      json: {
        workspace_id: identity.workspaceId,
        channel_id: input.channelId,
      },
    },
  ));
}

export async function readHarnessV2RunEvents(
  runId: string,
  input: { channelId: string; fromSeq?: number },
): Promise<HarnessV2RunEvents> {
  const identity = await getIdentity();
  const query = new URLSearchParams({
    workspace_id: identity.workspaceId,
    channel_id: input.channelId,
    from_seq: String(input.fromSeq ?? -1),
  });
  return v2Json<HarnessV2RunEvents>(
    `/v2/runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
    { method: "GET" },
  );
}

export async function readHarnessV2CreateRun(
  runId: string,
  input: { channelId: string },
): Promise<HarnessV2CreateRunProjection> {
  const identity = await getIdentity();
  const query = new URLSearchParams({
    workspace_id: identity.workspaceId,
    channel_id: input.channelId,
  });
  return v2Json<HarnessV2CreateRunProjection>(
    `/v2/runs/${encodeURIComponent(runId)}/create?${query.toString()}`,
    { method: "GET" },
  );
}

export async function activateHarnessV2CreateRun(
  runId: string,
  input: { channelId: string },
): Promise<HarnessV2CreateActivationResponse> {
  const identity = await getIdentity();
  const query = new URLSearchParams({
    workspace_id: identity.workspaceId,
    channel_id: input.channelId,
  });
  return v2Json<HarnessV2CreateActivationResponse>(
    `/v2/runs/${encodeURIComponent(runId)}/create/activate?${query.toString()}`,
    { method: "POST" },
  );
}

export interface SubscribeHarnessV2CreateRunOptions {
  channelId: string;
  fromSeq?: number;
  onFrame: (frame: Record<string, unknown>) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

const V2_TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
]);

/**
 * Attach to the durable v2 Event Store with the Desktop stream cursor.
 * Event Store sequences start at 0; the existing UI stream contract starts at 1,
 * so the adapter translates at the boundary and never drops seq 0 on first attach.
 */
export async function subscribeHarnessV2CreateRun(
  runId: string,
  options: SubscribeHarnessV2CreateRunOptions,
): Promise<void> {
  const fromSeq = options.fromSeq ?? 0;
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new Error("Harness v2 Desktop cursor must be a non-negative UI sequence");
  }
  let afterCanonicalSeq = fromSeq === 0 ? -1 : fromSeq - 1;
  const pollMs = options.pollMs ?? 250;

  for (;;) {
    if (options.signal?.aborted) return;
    const response = await readHarnessV2RunEvents(runId, {
      channelId: options.channelId,
      fromSeq: afterCanonicalSeq,
    });
    for (const event of response.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new Error("Harness v2 Event Store returned an invalid sequence");
      }
      if (event.seq <= afterCanonicalSeq) continue;
      if (options.signal?.aborted) return;

      const uiSeq = event.seq + 1;
      if (!V2_TERMINAL_EVENT_TYPES.has(event.type)) {
        options.onFrame({
          type: "event",
          seq: uiSeq,
          event: {
            type: event.type,
            ...(event.timestamp === undefined ? {} : { created_at: event.timestamp }),
            ...(event.payload === undefined ? {} : { payload: event.payload }),
          },
        });
        afterCanonicalSeq = event.seq;
        continue;
      }

      if (event.type === "run.completed") {
        const projection = await readHarnessV2CreateRun(runId, {
          channelId: options.channelId,
        });
        if (projection.status === "failed") {
          options.onFrame({
            type: "error",
            seq: uiSeq,
            run: {
              status: "failed",
              error_message: projection.error?.message ?? projection.error?.code ?? "create_run_failed",
            },
          });
        } else {
          options.onFrame({
            type: "done",
            seq: uiSeq,
            run: createRunSummary(projection),
          });
        }
      } else {
        options.onFrame({
          type: "error",
          seq: uiSeq,
          run: {
            status: "failed",
            error_message: terminalErrorMessage(event),
          },
        });
      }
      return;
    }

    if (pollMs > 0) {
      await waitForHarnessV2Poll(pollMs, options.signal);
    }
  }
}

function createRunSummary(projection: HarnessV2CreateRunProjection): Record<string, unknown> {
  const artifact = projection.artifact;
  return {
    runId: projection.runId,
    artifacts: artifact === undefined
      ? []
      : [{
          id: artifact.hash,
          title: artifact.skill_id ?? artifact.prompt_id ?? artifact.tool_id ?? artifact.kind,
          kind: artifact.kind,
        }],
    plan: [],
  };
}

function terminalErrorMessage(event: HarnessV2CanonicalEvent): string {
  if (event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const payload = event.payload as Record<string, unknown>;
    for (const key of ["message", "reason", "errorCode", "errorType"]) {
      if (typeof payload[key] === "string" && payload[key].trim() !== "") {
        return payload[key];
      }
    }
  }
  return event.type;
}

async function waitForHarnessV2Poll(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
