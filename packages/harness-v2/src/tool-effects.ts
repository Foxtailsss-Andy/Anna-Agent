import { createHash } from "node:crypto";

import type { CanonicalEvent, EventId, JsonValue, StreamId } from "./contracts";
import type { ScopedChannelStore, ToolRequest, ToolResult } from "./interfaces";
import {
  deserializeFailedToolResult,
  deserializeToolResult,
  nextSequence,
  readStreamEvents,
  matchesRunAttribution,
  runAttributionPayload,
  serializeFailedToolResult,
  serializeToolResult,
} from "./tool-events";
import { isRecord, type BoundToolGatewayOptions } from "./tool-gateway-types";

type ReplayPolicy = "never" | "safe";

const inFlightEffectsByEvents = new WeakMap<
  object,
  Map<string, Promise<ToolResult>>
>();

function isEffect(
  event: CanonicalEvent,
  request: ToolRequest,
  replayPolicy: ReplayPolicy,
  type:
    | "tool.effect.started"
    | "tool.effect.succeeded"
    | "tool.effect.failed"
    | "tool.effect.unknown"
    | "tool.effect.cancelled",
): event is CanonicalEvent & { payload: Record<string, unknown> } {
  return (
    event.type === type &&
    event.workspaceId === request.workspaceId &&
    event.channelId === request.channelId &&
    isRecord(event.payload) &&
    event.payload.workspaceId === request.workspaceId &&
    event.payload.channelId === request.channelId &&
    event.payload.runId === request.runId &&
    event.payload.workerProfileId === request.workerProfileId &&
    event.payload.tool === request.name &&
    event.payload.effectKey === request.effectKey &&
    matchesRunAttribution(event.payload, request) &&
    event.payload.replayPolicy === replayPolicy
  );
}

function isSucceededEffect(
  event: CanonicalEvent,
  request: ToolRequest,
  replayPolicy: ReplayPolicy,
): event is CanonicalEvent & { payload: Record<string, unknown> } {
  return (
    isEffect(event, request, replayPolicy, "tool.effect.succeeded") &&
    isRecord(event.payload.result) &&
    event.payload.result.status === "succeeded"
  );
}

function isCancelledResult(result: ToolResult, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (isRecord(result.output) && result.output.reason === "cancelled")
  );
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function effectIntentHash(request: ToolRequest, replayPolicy: ReplayPolicy): string {
  return `sha256:${createHash("sha256")
    .update(
      stableJson([
        request.workspaceId,
        request.channelId,
        request.runId,
        request.workerProfileId,
        request.name,
        replayPolicy,
        request.input,
      ]),
    )
    .digest("hex")}`;
}

function matchesEffectIntent(
  event: CanonicalEvent,
  request: ToolRequest,
  replayPolicy: ReplayPolicy,
  intentHash: string,
): boolean {
  return (
    isEffect(event, request, replayPolicy, "tool.effect.started") &&
    event.payload.intentHash === intentHash
  );
}

function unknownEffectResult(effectKey: string): ToolResult {
  return {
    status: "unknown",
    output: { reason: "effect_outcome_unknown", effectKey },
  };
}

async function appendUnknownEffectTerminal(
  options: BoundToolGatewayOptions,
  request: ToolRequest,
  replayPolicy: ReplayPolicy,
  streamId: StreamId,
  effectKey: string,
  startedSeq: number,
): Promise<ToolResult> {
  await options.events.append({
    id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    streamId,
    seq: startedSeq + 1,
    type: "tool.effect.unknown",
    timestamp: options.now?.() ?? new Date().toISOString(),
    schemaVersion: 1,
    payload: {
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      runId: request.runId,
      workerProfileId: request.workerProfileId,
      tool: request.name,
      effectKey,
      replayPolicy,
      ...runAttributionPayload(request),
      reason: "effect_outcome_unknown",
    },
  });

  return unknownEffectResult(effectKey);
}

export function executeEffect(
  options: BoundToolGatewayOptions,
  request: ToolRequest,
  replayPolicy: ReplayPolicy,
  signal: AbortSignal,
): Promise<ToolResult> {
  const effectKey = request.effectKey;
  const events = options.events;
  if (effectKey === undefined) {
    return Promise.resolve({ status: "failed" });
  }

  const intentHash = effectIntentHash(request, replayPolicy);
  const streamId = `effect:${effectKey}` as unknown as StreamId;
  const executionKey = JSON.stringify([
    request.workspaceId,
    request.channelId,
    streamId,
    replayPolicy,
    intentHash,
  ]);
  let inFlight = inFlightEffectsByEvents.get(events);
  if (inFlight === undefined) {
    inFlight = new Map();
    inFlightEffectsByEvents.set(events, inFlight);
  }

  const existingExecution = inFlight.get(executionKey);
  if (existingExecution !== undefined) {
    return existingExecution;
  }

  const execution = executeDurableEffect(
    options,
    request,
    replayPolicy,
    intentHash,
    signal,
  );
  inFlight.set(executionKey, execution);
  void execution.then(
    () => removeInFlightEffect(events, inFlight, executionKey, execution),
    () => removeInFlightEffect(events, inFlight, executionKey, execution),
  );

  return execution;
}

function removeInFlightEffect(
  events: Pick<ScopedChannelStore, "append" | "read">,
  inFlight: Map<string, Promise<ToolResult>>,
  executionKey: string,
  execution: Promise<ToolResult>,
): void {
  if (inFlight.get(executionKey) !== execution) {
    return;
  }

  inFlight.delete(executionKey);
  if (inFlight.size === 0) {
    inFlightEffectsByEvents.delete(events);
  }
}

async function executeDurableEffect(
  options: BoundToolGatewayOptions,
  request: ToolRequest,
  replayPolicy: ReplayPolicy,
  intentHash: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  const effectKey = request.effectKey;
  if (effectKey === undefined) {
    return { status: "failed" };
  }

  const streamId = `effect:${effectKey}` as unknown as StreamId;
  const durableEvents = await readStreamEvents(options.events, streamId);
  const recordedStarted = durableEvents.filter(
    (event) => event.type === "tool.effect.started",
  );
  if (
    recordedStarted.length > 0 &&
    recordedStarted.some((event) =>
      !matchesEffectIntent(event, request, replayPolicy, intentHash),
    )
  ) {
    return { status: "failed", output: { reason: "effect_key_conflict" } };
  }
  const recordedResult = durableEvents.find((event) =>
    isSucceededEffect(event, request, replayPolicy),
  );
  if (recordedResult !== undefined) {
    const result = recordedResult.payload.result;
    if (!isRecord(result) || result.status !== "succeeded") {
      return { status: "failed" };
    }

    return result.output === undefined
      ? { status: "succeeded" }
      : { status: "succeeded", output: result.output as JsonValue };
  }

  const recordedFailed = durableEvents.find((event) =>
    isEffect(event, request, replayPolicy, "tool.effect.failed"),
  );
  if (recordedFailed !== undefined) {
    return deserializeFailedToolResult(recordedFailed.payload.result) ?? {
      status: "failed",
    };
  }

  const recordedCancelled = durableEvents.find((event) =>
    isEffect(event, request, replayPolicy, "tool.effect.cancelled"),
  );
  if (recordedCancelled !== undefined) {
    return deserializeToolResult(recordedCancelled.payload.result) ?? {
      status: "failed",
    };
  }

  const recordedUnknown = durableEvents.some((event) =>
    isEffect(event, request, replayPolicy, "tool.effect.unknown"),
  );
  const orphanedStarted = durableEvents.find((event) =>
    isEffect(event, request, replayPolicy, "tool.effect.started"),
  );
  if (recordedUnknown) {
    return unknownEffectResult(effectKey);
  }

  if (orphanedStarted) {
    return appendUnknownEffectTerminal(
      options,
      request,
      replayPolicy,
      streamId,
      effectKey,
      orphanedStarted.seq,
    );
  }

  const startedSeq = nextSequence(durableEvents);
  await options.events.append({
    id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    streamId,
    seq: startedSeq,
    type: "tool.effect.started",
    timestamp: options.now?.() ?? new Date().toISOString(),
    schemaVersion: 1,
    payload: {
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      runId: request.runId,
      workerProfileId: request.workerProfileId,
      tool: request.name,
      effectKey,
      replayPolicy,
      intentHash,
      ...runAttributionPayload(request),
    },
  });

  let result: ToolResult;
  try {
    result = await options.sandbox.execute(request, signal);
  } catch {
    return appendUnknownEffectTerminal(
      options,
      request,
      replayPolicy,
      streamId,
      effectKey,
      startedSeq,
    );
  }

  if (result.status === "unknown") {
    return appendUnknownEffectTerminal(
      options,
      request,
      replayPolicy,
      streamId,
      effectKey,
      startedSeq,
    );
  }

  if (isCancelledResult(result, signal)) {
    await options.events.append({
      id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      streamId,
      seq: startedSeq + 1,
      type: "tool.effect.cancelled",
      timestamp: options.now?.() ?? new Date().toISOString(),
      schemaVersion: 1,
      payload: {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey,
        replayPolicy,
        ...runAttributionPayload(request),
        result: serializeToolResult(result),
      },
    });
  } else if (result.status === "succeeded") {
    await options.events.append({
      id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      streamId,
      seq: startedSeq + 1,
      type: "tool.effect.succeeded",
      timestamp: options.now?.() ?? new Date().toISOString(),
      schemaVersion: 1,
      payload: {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey,
        replayPolicy,
        ...runAttributionPayload(request),
        result: serializeToolResult(result),
      },
    });
  } else if (result.status === "failed") {
    await options.events.append({
      id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      streamId,
      seq: startedSeq + 1,
      type: "tool.effect.failed",
      timestamp: options.now?.() ?? new Date().toISOString(),
      schemaVersion: 1,
      payload: {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey,
        replayPolicy,
        ...runAttributionPayload(request),
        result: serializeFailedToolResult(result),
      },
    });
  }

  return result;
}
