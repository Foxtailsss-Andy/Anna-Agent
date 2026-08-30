import { createHash } from "node:crypto";

import {
  buildRunContext,
  createChannelMemoryRepository,
  parseJsonValue,
  type AcceptedChannelMemory,
  type ChannelOwnerAuthorization,
  type CanonicalEvent,
  type EventStore,
  type JsonValue,
  type RunContext,
  type StartRun,
  type StreamId,
} from "@anna/harness-v2";

export const HOST_CONTEXT_PROJECTION = "harness-run-context-input";

const HOST_CONTEXT_SCHEMA_VERSION = 1;
const DEFAULT_MEMORY_LIMIT = 8;

export interface HostPreparedRunContext {
  readonly context: RunContext;
  readonly memoryHits: readonly AcceptedChannelMemory[];
  readonly snapshotDigest: string;
  readonly originalExecutionFingerprint: JsonValue;
}

export interface HostMemoryContextLoaderOptions {
  readonly eventStore: EventStore;
  readonly authorization?: ChannelOwnerAuthorization;
  readonly memoryLimit?: number;
}

export type HostMemoryContextLoader = (
  command: StartRun,
  signal: AbortSignal,
) => Promise<HostPreparedRunContext>;

const readOnlyMemoryAuthorization: ChannelOwnerAuthorization = {
  async assertOwner(): Promise<void> {},
};

export function createHostMemoryContextLoader(
  options: HostMemoryContextLoaderOptions,
): HostMemoryContextLoader {
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 1 || memoryLimit > 32) {
    throw new Error("Host Memory limit must be a positive integer no greater than 32");
  }

  return async (command, signal) => {
    if (command.runProfileSnapshot.memoryPolicy.read !== "channel") {
      throw new Error("Host Memory input requires a channel read policy");
    }
    const events = options.eventStore.scope({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
    });
    const storedCommand = await events.getRunCommand(command.runId);
    if (storedCommand === undefined || stableJson(storedCommand) !== stableJson(command)) {
      throw new Error("Host Memory input command does not match the admitted Run");
    }

    const runEvents = await readEvents(events, command.runId as unknown as StreamId);
    const started = runEvents.find((event) => event.type === "run.started");
    if (started === undefined) {
      throw new Error("Host Memory input requires a persisted run.started event");
    }
    const originalExecutionFingerprint = executionFingerprintFrom(started);

    const existing = await events.loadProjection(
      HOST_CONTEXT_PROJECTION,
      command.runId as never,
    );
    if (existing !== undefined) {
      return restoreProjection(
        existing.state,
        command,
        started,
        originalExecutionFingerprint,
      );
    }

    if (runEvents.some((event) => [
      "memory.hit",
      "run.context.ready",
      "run.resumed",
      "pi.transcript.message",
      "run.progress",
      "run.tool.started",
      "run.tool.completed",
      "run.usage.updated",
      "create.artifact.created",
    ].includes(event.type))) {
      throw new Error("Host Memory input projection is missing for consumed Run input");
    }
    if (signal.aborted) {
      throw new Error("Host Memory input loading was cancelled");
    }

    const repository = createChannelMemoryRepository({
      eventStore: options.eventStore,
      scope: {
        workspaceId: command.workspaceId,
        channelId: command.channelId,
      },
      authorization: options.authorization ?? readOnlyMemoryAuthorization,
      runProfileSnapshot: command.runProfileSnapshot,
    });
    const memoryHits = freezeMemoryHits(await repository.retrieve({
      query: memoryQueryForGoal(command.goal),
      limit: memoryLimit,
    }));
    if (signal.aborted) {
      throw new Error("Host Memory input loading was cancelled");
    }

    const context = buildRunContext({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      goal: {
        content: command.goal,
        provenance: {
          source: "run.command",
          sourceEventIds: [command.source.eventId],
        },
      },
      constraints: [],
      transientMessages: [],
      pendingToolCalls: [],
      memoryHits: memoryHits.map((memory) => ({
        memoryId: memory.id,
        content: memory.content,
        provenance: {
          source: "accepted.channel.memory",
          sourceEventIds: uniqueStrings([
            memory.acceptedEventId,
            ...memory.sourceEventIds,
          ]),
        },
      })),
    });
    const stateWithoutDigest = parseJsonValue({
      schemaVersion: HOST_CONTEXT_SCHEMA_VERSION,
      binding: {
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId: command.runProfileSnapshot.workerProfileId,
        profileHash: command.runProfileSnapshot.hash,
      },
      start: { eventId: started.id, seq: started.seq },
      originalExecutionFingerprint,
      context,
      memoryHits,
    });
    const stateWithoutDigestRecord = expectRecord(
      stateWithoutDigest,
      "Host Memory input projection state",
    );
    const state = parseJsonValue({
      ...stateWithoutDigestRecord,
      snapshotDigest: sha256(stableJson(stateWithoutDigest)),
    });
    if (signal.aborted) {
      throw new Error("Host Memory input loading was cancelled");
    }

    let committed;
    try {
      committed = await events.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: command.runId as never,
        eventId: started.id,
        eventSeq: started.seq,
        expectedVersion: 0,
        state,
      });
    } catch (error) {
      const winner = await events.loadProjection(
        HOST_CONTEXT_PROJECTION,
        command.runId as never,
      );
      if (winner === undefined) {
        throw error;
      }
      return restoreProjection(
        winner.state,
        command,
        started,
        originalExecutionFingerprint,
      );
    }

    return restoreProjection(
      committed.state,
      command,
      started,
      originalExecutionFingerprint,
    );
  };
}

function memoryQueryForGoal(goal: string): string {
  return goal.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

async function readEvents(
  events: Pick<ReturnType<EventStore["scope"]>, "read">,
  streamId: StreamId,
): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const event of events.read(streamId)) {
    result.push(event);
  }
  return result;
}

function executionFingerprintFrom(event: CanonicalEvent): JsonValue {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (payload === undefined || payload.executionFingerprint === undefined) {
    throw new Error("Host Memory input requires the original execution fingerprint");
  }
  return parseJsonValue(
    payload.executionFingerprint,
    "run.started.executionFingerprint",
  );
}

function restoreProjection(
  state: JsonValue,
  command: StartRun,
  started: CanonicalEvent,
  originalExecutionFingerprint: JsonValue,
): HostPreparedRunContext {
  const value = isRecord(state) ? state : undefined;
  if (value === undefined) {
    throw new Error("Host Memory input projection is invalid");
  }
  const binding = isRecord(value.binding) ? value.binding : undefined;
  const anchor = isRecord(value.start) ? value.start : undefined;
  if (
    value.schemaVersion !== HOST_CONTEXT_SCHEMA_VERSION
    || binding === undefined
    || anchor === undefined
    || typeof value.snapshotDigest !== "string"
    || value.context === undefined
    || value.memoryHits === undefined
  ) {
    throw new Error("Host Memory input projection is invalid");
  }
  if (
    binding.workspaceId !== command.workspaceId
    || binding.channelId !== command.channelId
    || binding.runId !== command.runId
    || binding.workerProfileId !== command.runProfileSnapshot.workerProfileId
    || binding.profileHash !== command.runProfileSnapshot.hash
  ) {
    throw new Error("Host Memory input projection binding mismatch");
  }
  if (anchor.eventId !== started.id || anchor.seq !== started.seq) {
    throw new Error("Host Memory input projection start anchor mismatch");
  }
  if (stableJson(value.originalExecutionFingerprint) !== stableJson(originalExecutionFingerprint)) {
    throw new Error("Host Memory input projection fingerprint mismatch");
  }
  const { snapshotDigest: _snapshotDigest, ...stateWithoutDigest } = value;
  if (sha256(stableJson(stateWithoutDigest)) !== value.snapshotDigest) {
    throw new Error("Host Memory input projection digest mismatch");
  }

  const context = buildRunContext(value.context);
  const memoryHits = parseAcceptedMemoryHits(value.memoryHits);
  if (!contextMemoryMatches(context, memoryHits)) {
    throw new Error("Host Memory input projection context mismatch");
  }
  return {
    context,
    memoryHits,
    snapshotDigest: value.snapshotDigest,
    originalExecutionFingerprint,
  };
}

function parseAcceptedMemoryHits(input: unknown): readonly AcceptedChannelMemory[] {
  if (!Array.isArray(input)) {
    throw new Error("Host Memory input projection memoryHits must be an array");
  }
  return Object.freeze(input.map((item, index) => {
    const value = expectRecord(item, `Host Memory input projection memoryHits[${index}]`);
    const sourceChannel = expectRecord(
      value.sourceChannel,
      `Host Memory input projection memoryHits[${index}].sourceChannel`,
    );
    const sourceEventIds = expectStringArray(
      value.sourceEventIds,
      `Host Memory input projection memoryHits[${index}].sourceEventIds`,
    );
    const result = {
      id: expectString(value.id, "id"),
      content: expectString(value.content, "content"),
      sourceRunId: expectString(value.sourceRunId, "sourceRunId"),
      sourceEventIds,
      sourceChannel: {
        workspaceId: expectString(sourceChannel.workspaceId, "workspaceId"),
        channelId: expectString(sourceChannel.channelId, "channelId"),
      },
      acceptedBy: expectString(value.acceptedBy, "acceptedBy"),
      acceptedEventId: expectString(value.acceptedEventId, "acceptedEventId"),
      acceptedAt: expectString(value.acceptedAt, "acceptedAt"),
      ...(value.editedBy === undefined ? {} : {
        editedBy: expectString(value.editedBy, "editedBy"),
      }),
      ...(value.editedEventId === undefined ? {} : {
        editedEventId: expectString(value.editedEventId, "editedEventId"),
      }),
      ...(value.editedAt === undefined ? {} : {
        editedAt: expectString(value.editedAt, "editedAt"),
      }),
    } satisfies Omit<AcceptedChannelMemory, "workspaceGrant">;
    if (value.workspaceGrant !== undefined) {
      const grant = expectRecord(value.workspaceGrant, "workspaceGrant");
      return freezeAcceptedMemory({
        ...result,
        workspaceGrant: {
          grantId: expectString(grant.grantId, "grantId"),
          grantedBy: expectString(grant.grantedBy, "grantedBy"),
          grantEventId: expectString(grant.grantEventId, "grantEventId"),
          grantedAt: expectString(grant.grantedAt, "grantedAt"),
        },
      });
    }
    return freezeAcceptedMemory(result);
  }));
}

function freezeMemoryHits(
  memoryHits: readonly AcceptedChannelMemory[],
): readonly AcceptedChannelMemory[] {
  return Object.freeze(memoryHits.map(freezeAcceptedMemory));
}

function freezeAcceptedMemory(memory: AcceptedChannelMemory): AcceptedChannelMemory {
  const sourceEventIds = [...memory.sourceEventIds];
  Object.freeze(sourceEventIds);
  return Object.freeze({
    ...memory,
    sourceEventIds,
    sourceChannel: Object.freeze({ ...memory.sourceChannel }),
    ...(memory.workspaceGrant === undefined ? {} : {
      workspaceGrant: Object.freeze({ ...memory.workspaceGrant }),
    }),
  });
}

function contextMemoryMatches(
  context: RunContext,
  memoryHits: readonly AcceptedChannelMemory[],
): boolean {
  return context.memoryHits.length === memoryHits.length
    && context.memoryHits.every((memory, index) => {
      const accepted = memoryHits[index];
      return accepted !== undefined
        && memory.memoryId === accepted.id
        && memory.content === accepted.content
        && memory.provenance.source === "accepted.channel.memory"
        && memory.provenance.sourceEventIds.includes(accepted.acceptedEventId)
        && accepted.sourceEventIds.every((eventId) =>
          memory.provenance.sourceEventIds.includes(eventId),
        );
    });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value.map((item, index) => expectString(item, `${name}[${index}]`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
