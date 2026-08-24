import type { CanonicalEvent, StreamId } from "./contracts";
import type { ScopedChannelStore } from "./interfaces";

export const MEMORY_STREAM_ID = "channel-memory" as StreamId;
export const MEMORY_EVENT_TYPE = {
  candidateProposed: "memory.candidate.proposed",
  candidateEdited: "memory.candidate.edited",
  candidateDeleted: "memory.candidate.deleted",
  accepted: "memory.accepted",
  rejected: "memory.rejected",
  edited: "memory.edited",
  deleted: "memory.deleted",
  workspaceReadGranted: "memory.workspace_read.granted",
  workspaceReadRevoked: "memory.workspace_read.revoked",
} as const;

export interface StoredCandidate {
  readonly id: string;
  readonly content: string;
  readonly sourceRunId: string;
  readonly sourceEventIds: string[];
}

export interface StoredAcceptance {
  readonly candidateId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface StoredEdit {
  readonly memoryId: string;
  readonly content: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface StoredCandidateEdit {
  readonly candidateId: string;
  readonly content: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface StoredDeletion {
  readonly memoryId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface StoredCandidateDeletion {
  readonly candidateId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface StoredWorkspaceReadGrant {
  readonly grantId: string;
  readonly targetChannelId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface StoredWorkspaceReadRevocation {
  readonly grantId: string;
  readonly targetChannelId: string;
  readonly actorId: string;
}

export async function readEvents(
  store: Pick<ScopedChannelStore, "read">,
  streamId: StreamId,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.read(streamId)) {
    events.push(event);
  }
  return events;
}

export function readMemoryEvents(
  store: Pick<ScopedChannelStore, "read">,
): Promise<CanonicalEvent[]> {
  return readEvents(store, MEMORY_STREAM_ID);
}

export function nextSequence(events: readonly CanonicalEvent[]): number {
  return events.reduce((next, event) => Math.max(next, event.seq + 1), 0);
}

export function proposedCandidate(event: CanonicalEvent): StoredCandidate | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.candidateProposed || !isRecord(event.payload)) {
    return undefined;
  }

  const { candidateId, content, sourceRunId, sourceEventIds } = event.payload;
  if (
    typeof candidateId !== "string"
    || typeof content !== "string"
    || typeof sourceRunId !== "string"
    || !isStringArray(sourceEventIds)
  ) {
    return undefined;
  }

  return {
    id: candidateId,
    content,
    sourceRunId,
    sourceEventIds: [...sourceEventIds],
  };
}

export function acceptedCandidate(event: CanonicalEvent): StoredAcceptance | undefined {
  return candidateDecision(event, MEMORY_EVENT_TYPE.accepted);
}

export function rejectedCandidate(event: CanonicalEvent): StoredAcceptance | undefined {
  return candidateDecision(event, MEMORY_EVENT_TYPE.rejected);
}

export function editedMemory(event: CanonicalEvent): StoredEdit | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.edited || !isRecord(event.payload)) {
    return undefined;
  }

  const { memoryId, content, actorId } = event.payload;
  if (
    typeof memoryId !== "string"
    || typeof content !== "string"
    || typeof actorId !== "string"
  ) {
    return undefined;
  }

  return {
    memoryId,
    content,
    actorId,
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

export function editedCandidate(event: CanonicalEvent): StoredCandidateEdit | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.candidateEdited || !isRecord(event.payload)) {
    return undefined;
  }

  const { candidateId, content, actorId } = event.payload;
  if (
    typeof candidateId !== "string"
    || typeof content !== "string"
    || typeof actorId !== "string"
  ) {
    return undefined;
  }

  return {
    candidateId,
    content,
    actorId,
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

export function deletedMemory(event: CanonicalEvent): StoredDeletion | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.deleted || !isRecord(event.payload)) {
    return undefined;
  }

  const { memoryId, actorId } = event.payload;
  if (typeof memoryId !== "string" || typeof actorId !== "string") {
    return undefined;
  }

  return {
    memoryId,
    actorId,
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

export function deletedCandidate(event: CanonicalEvent): StoredCandidateDeletion | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.candidateDeleted || !isRecord(event.payload)) {
    return undefined;
  }

  const { candidateId, actorId } = event.payload;
  if (typeof candidateId !== "string" || typeof actorId !== "string") {
    return undefined;
  }

  return {
    candidateId,
    actorId,
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

export function workspaceReadGranted(
  event: CanonicalEvent,
): StoredWorkspaceReadGrant | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.workspaceReadGranted || !isRecord(event.payload)) {
    return undefined;
  }

  const { grantId, targetChannelId, actorId } = event.payload;
  if (
    !isNonEmptyString(grantId)
    || !isNonEmptyString(targetChannelId)
    || !isNonEmptyString(actorId)
  ) {
    return undefined;
  }

  return {
    grantId,
    targetChannelId,
    actorId,
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

export function workspaceReadRevoked(
  event: CanonicalEvent,
): StoredWorkspaceReadRevocation | undefined {
  if (event.type !== MEMORY_EVENT_TYPE.workspaceReadRevoked || !isRecord(event.payload)) {
    return undefined;
  }

  const { grantId, targetChannelId, actorId } = event.payload;
  if (
    !isNonEmptyString(grantId)
    || !isNonEmptyString(targetChannelId)
    || !isNonEmptyString(actorId)
  ) {
    return undefined;
  }

  return { grantId, targetChannelId, actorId };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function candidateDecision(
  event: CanonicalEvent,
  type: typeof MEMORY_EVENT_TYPE.accepted | typeof MEMORY_EVENT_TYPE.rejected,
): StoredAcceptance | undefined {
  if (event.type !== type || !isRecord(event.payload)) {
    return undefined;
  }

  const { candidateId, actorId } = event.payload;
  if (typeof candidateId !== "string" || typeof actorId !== "string") {
    return undefined;
  }

  return {
    candidateId,
    actorId,
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
