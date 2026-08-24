import type {
  CanonicalEvent,
  EventId,
  JsonValue,
  StreamId,
} from "./contracts";
import type { ScopedChannelStore, ToolRequest, ToolResult } from "./interfaces";
import { isRecord, type BoundToolGatewayOptions } from "./tool-gateway-types";

export async function readStreamEvents(
  events: Pick<ScopedChannelStore, "read">,
  streamId: StreamId,
): Promise<CanonicalEvent[]> {
  const durableEvents: CanonicalEvent[] = [];
  for await (const event of events.read(streamId)) {
    durableEvents.push(event);
  }

  return durableEvents;
}

export function nextSequence(events: readonly CanonicalEvent[]): number {
  return events.reduce((seq, event) => Math.max(seq, event.seq + 1), 0);
}

export function runAttributionPayload(request: ToolRequest): Record<string, JsonValue> {
  return {
    ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
    ...(request.parentEventId === undefined ? {} : { parentEventId: request.parentEventId }),
    ...(request.laneId === undefined ? {} : { laneId: request.laneId }),
  };
}

export function matchesRunAttribution(
  payload: unknown,
  request: Pick<ToolRequest, "parentRunId" | "parentEventId" | "laneId">,
): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return (
    payload.parentRunId === request.parentRunId
    && payload.parentEventId === request.parentEventId
    && payload.laneId === request.laneId
  );
}

export function matchesProvidedRunAttribution(
  payload: unknown,
  request: Pick<ToolRequest, "parentRunId" | "parentEventId" | "laneId">,
): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return (
    (request.parentRunId === undefined || payload.parentRunId === request.parentRunId)
    && (request.parentEventId === undefined || payload.parentEventId === request.parentEventId)
    && (request.laneId === undefined || payload.laneId === request.laneId)
  );
}

export function lifecycleRequestFor(
  options: BoundToolGatewayOptions,
  request: ToolRequest,
): ToolRequest | undefined {
  if (typeof request.toolCallId !== "string" || request.toolCallId.length === 0) {
    return undefined;
  }

  return {
    workspaceId: options.scope.workspaceId,
    channelId: options.scope.channelId,
    runId: request.runId,
    workerProfileId: options.workerProfileId,
    name: request.name,
    input: null,
    toolCallId: request.toolCallId,
    ...(request.effectKey === undefined ? {} : { effectKey: request.effectKey }),
    ...runAttributionPayload(request),
  };
}

function toolLifecycleEventId(request: ToolRequest, seq: number): EventId {
  return `tool-lifecycle:${JSON.stringify([
    request.workspaceId,
    request.channelId,
    request.runId,
    request.toolCallId,
    seq,
  ])}` as EventId;
}

export async function appendToolLifecycleEvent(
  options: BoundToolGatewayOptions,
  request: ToolRequest,
  type: "tool.requested" | "tool.policy.decided" | "tool.result",
  details: Record<string, JsonValue> = {},
): Promise<void> {
  const streamId = `tool:${request.runId}:${request.toolCallId}` as StreamId;
  const seq = nextSequence(await readStreamEvents(options.events, streamId));
  await options.events.append({
    id: toolLifecycleEventId(request, seq),
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    streamId,
    seq,
    type,
    timestamp: options.now?.() ?? new Date().toISOString(),
    schemaVersion: 1,
    payload: {
      runId: request.runId,
      workerProfileId: request.workerProfileId,
      tool: request.name,
      toolCallId: request.toolCallId,
      ...(request.effectKey === undefined ? {} : { effectKey: request.effectKey }),
      ...runAttributionPayload(request),
      ...details,
    },
  });
}

export async function terminalResult(
  options: BoundToolGatewayOptions,
  lifecycleRequest: ToolRequest | undefined,
  result: ToolResult,
  reason?: string,
): Promise<ToolResult> {
  if (lifecycleRequest !== undefined) {
    await appendToolLifecycleEvent(options, lifecycleRequest, "tool.result", {
      ...toolLifecycleResultDetails(result),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  return result;
}

export function serializeToolResult(result: ToolResult): JsonValue {
  if (result.output === undefined) {
    return { status: result.status };
  }

  return { status: result.status, output: result.output };
}

function toolLifecycleResultDetails(result: ToolResult): Record<string, JsonValue> {
  const details: Record<string, JsonValue> = { status: result.status };
  if (
    result.status !== "succeeded" &&
    isRecord(result.output) &&
    typeof result.output.reason === "string"
  ) {
    details.reason = result.output.reason;
  }

  return details;
}

export function serializeFailedToolResult(result: ToolResult): JsonValue {
  const reason =
    isRecord(result.output) && typeof result.output.reason === "string"
      ? result.output.reason
      : undefined;

  return reason === undefined
    ? { status: "failed" }
    : { status: "failed", output: { reason } };
}

export function deserializeFailedToolResult(
  value: unknown,
): ToolResult | undefined {
  if (!isRecord(value) || value.status !== "failed") {
    return undefined;
  }

  const reason =
    isRecord(value.output) && typeof value.output.reason === "string"
      ? value.output.reason
      : undefined;

  return reason === undefined
    ? { status: "failed" }
    : { status: "failed", output: { reason } };
}

export function deserializeToolResult(value: unknown): ToolResult | undefined {
  if (
    !isRecord(value) ||
    (value.status !== "succeeded" &&
      value.status !== "failed" &&
      value.status !== "unknown")
  ) {
    return undefined;
  }

  return value.output === undefined
    ? { status: value.status }
    : { status: value.status, output: value.output as JsonValue };
}
