import type { CanonicalEvent, EventId, StreamId } from "./contracts";
import type { ToolApprovalAnswer, ToolRequest } from "./interfaces";
import {
  matchesRunAttribution,
  matchesProvidedRunAttribution,
  nextSequence,
  readStreamEvents,
  runAttributionPayload,
} from "./tool-events";
import { isRecord, type BoundToolGatewayOptions } from "./tool-gateway-types";

function matchesScope(
  event: CanonicalEvent,
  request: Pick<ToolRequest, "workspaceId" | "channelId" | "runId">,
): boolean {
  return (
    event.workspaceId === request.workspaceId &&
    event.channelId === request.channelId &&
    event.streamId === (request.runId as unknown as StreamId)
  );
}

function isApprovalRequest(
  event: CanonicalEvent,
  request: ToolRequest,
  approvalId: string,
): boolean {
  if (
    event.type !== "tool.approval.requested" ||
    !matchesScope(event, request) ||
    !isRecord(event.payload)
  ) {
    return false;
  }

  return (
    event.payload.workspaceId === request.workspaceId &&
    event.payload.channelId === request.channelId &&
    event.payload.runId === request.runId &&
    event.payload.workerProfileId === request.workerProfileId &&
    event.payload.tool === request.name &&
    event.payload.effectKey === request.effectKey &&
    event.payload.approvalId === approvalId &&
    matchesRunAttribution(event.payload, request)
  );
}

function isApprovalRequestForAnswer(
  event: CanonicalEvent,
  answer: ToolApprovalAnswer,
): boolean {
  if (
    event.type !== "tool.approval.requested" ||
    !matchesScope(event, answer) ||
    !isRecord(event.payload)
  ) {
    return false;
  }

  return (
    event.payload.workspaceId === answer.workspaceId &&
    event.payload.channelId === answer.channelId &&
    event.payload.runId === answer.runId &&
    event.payload.effectKey === answer.effectKey &&
    event.payload.approvalId === answer.approvalId &&
    matchesProvidedRunAttribution(event.payload, answer)
  );
}

function getApprovalDecision(
  event: CanonicalEvent,
  request: ToolRequest,
  approvalId: string,
): "approved" | "denied" | undefined {
  if (
    event.type !== "tool.approval.answered" ||
    !matchesScope(event, request) ||
    !isRecord(event.payload)
  ) {
    return undefined;
  }

  if (
    event.payload.workspaceId === request.workspaceId &&
    event.payload.channelId === request.channelId &&
    event.payload.runId === request.runId &&
    event.payload.effectKey === request.effectKey &&
    event.payload.approvalId === approvalId
  ) {
    const decision = event.payload.decision;
    if (!matchesProvidedRunAttribution(event.payload, request)) {
      return undefined;
    }
    return decision === "approved" || decision === "denied" ? decision : undefined;
  }

  return undefined;
}

export function approvalFor(
  durableEvents: readonly CanonicalEvent[],
  request: ToolRequest,
  approvalId: string,
): {
  request: CanonicalEvent | undefined;
  decision: "approved" | "denied" | undefined;
} {
  const approvalRequest = durableEvents.find((event) =>
    isApprovalRequest(event, request, approvalId),
  );
  let approvalDecision: "approved" | "denied" | undefined;
  if (approvalRequest !== undefined) {
    for (const event of durableEvents) {
      if (event.seq <= approvalRequest.seq) {
        continue;
      }

      approvalDecision = getApprovalDecision(event, request, approvalId);
      if (approvalDecision !== undefined) {
        break;
      }
    }
  }

  return { request: approvalRequest, decision: approvalDecision };
}

export async function appendApprovalRequest(
  options: BoundToolGatewayOptions,
  request: ToolRequest,
  approvalId: string,
  durableEvents: readonly CanonicalEvent[],
): Promise<void> {
  await options.events.append({
    id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    streamId: request.runId as unknown as StreamId,
    seq: nextSequence(durableEvents),
    type: "tool.approval.requested",
    timestamp: options.now?.() ?? new Date().toISOString(),
    schemaVersion: 1,
    payload: {
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      runId: request.runId,
      workerProfileId: request.workerProfileId,
      tool: request.name,
      effectKey: request.effectKey!,
      approvalId,
      ...runAttributionPayload(request),
    },
  });
}

export async function appendApprovalAnswer(
  options: BoundToolGatewayOptions,
  answer: ToolApprovalAnswer,
): Promise<void> {
  const durableEvents = await readStreamEvents(
    options.events,
    answer.runId as unknown as StreamId,
  );
  const approvalRequest = durableEvents.find((event) =>
    isApprovalRequestForAnswer(event, answer),
  );
  if (approvalRequest === undefined) {
    throw new Error("Tool approval request was not found in the Run stream");
  }
  const requestPayload = isRecord(approvalRequest.payload)
    ? approvalRequest.payload
    : {};
  const parentRunId = answer.parentRunId
    ?? (typeof requestPayload.parentRunId === "string" ? requestPayload.parentRunId : undefined);
  const parentEventId = answer.parentEventId
    ?? (typeof requestPayload.parentEventId === "string" ? requestPayload.parentEventId : undefined);
  const laneId = answer.laneId
    ?? (typeof requestPayload.laneId === "string" ? requestPayload.laneId : undefined);

  await options.events.append({
    id: (options.createEventId?.() ?? crypto.randomUUID()) as EventId,
    workspaceId: options.scope.workspaceId,
    channelId: options.scope.channelId,
    streamId: answer.runId as unknown as StreamId,
    seq: nextSequence(durableEvents),
    type: "tool.approval.answered",
    timestamp: options.now?.() ?? new Date().toISOString(),
    schemaVersion: 1,
    payload: {
      workspaceId: options.scope.workspaceId,
      channelId: options.scope.channelId,
      runId: answer.runId,
      effectKey: answer.effectKey,
      approvalId: answer.approvalId,
      actorId: answer.actorId,
      decision: answer.decision,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(parentEventId === undefined ? {} : { parentEventId }),
      ...(laneId === undefined ? {} : { laneId }),
    },
  });
}
