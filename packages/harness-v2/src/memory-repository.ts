import {
  parseChannelScope,
  parseMemoryCandidate,
  type CanonicalEvent,
  type EventId,
  type RunId,
  type StartRun,
  type StreamId,
} from "./contracts";
import {
  isNonEmptyString,
  MEMORY_EVENT_TYPE,
  MEMORY_STREAM_ID,
  nextSequence,
  readEvents,
  readMemoryEvents,
} from "./memory-events";
import {
  acceptedMemory,
  activeWorkspaceReadGrants,
  candidateById,
  decisionForCandidate,
  deletedChannelMemory,
  deletedMemory,
  deletedMemoryCandidate,
  retrieveAcceptedMemories,
  workspaceReadGrantById,
} from "./memory-projection";
import type {
  AcceptedChannelMemory,
  ChannelMemoryRepository,
  CreateChannelMemoryRepositoryOptions,
  DeletedChannelMemory,
  DeletedMemoryCandidate,
  MemoryAcceptance,
  MemoryCandidateDeletion,
  MemoryCandidateEdit,
  MemoryCandidateProposal,
  MemoryDeletion,
  MemoryEdit,
  MemoryRejection,
  MemoryRetrieval,
  WorkspaceReadGrant,
  WorkspaceReadRevocation,
} from "./memory-types";
import type { ScopedChannelStore } from "./interfaces";
import { parseResolvedRunProfileSnapshot } from "./run-profile";

export type {
  AcceptedChannelMemory,
  ChannelMemoryRepository,
  ChannelOwnerAuthorization,
  CreateChannelMemoryRepositoryOptions,
  DeletedChannelMemory,
  DeletedMemoryCandidate,
  MemoryAcceptance,
  MemoryCandidateDeletion,
  MemoryCandidateEdit,
  MemoryCandidateProposal,
  MemoryDeletion,
  MemoryEdit,
  MemoryRejection,
  MemoryRetrieval,
  WorkspaceMemoryGrantProvenance,
  WorkspaceMemoryGrantReference,
  WorkspaceReadGrant,
  WorkspaceReadRevocation,
} from "./memory-types";

const MEMORY_CANDIDATE_PROVENANCE_UNAVAILABLE = "Memory candidate provenance is unavailable";

export function createChannelMemoryRepository(
  options: CreateChannelMemoryRepositoryOptions,
): ChannelMemoryRepository {
  const scope = parseChannelScope(options.scope);
  const authorization = options.authorization;
  const memoryPolicy = parseResolvedRunProfileSnapshot(
    options.runProfileSnapshot,
  ).memoryPolicy;
  const store = options.eventStore.scope(scope);
  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? (() => crypto.randomUUID());
  const appendMemoryEvent = async (
    events: readonly CanonicalEvent[],
    type: string,
    payload: CanonicalEvent["payload"],
  ): Promise<void> => {
    await store.append({
      id: createEventId() as EventId,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      streamId: MEMORY_STREAM_ID,
      seq: nextSequence(events),
      type,
      timestamp: now(),
      schemaVersion: 1,
      payload,
    });
  };

  return {
    async propose(proposal: MemoryCandidateProposal): Promise<void> {
      if (memoryPolicy.write !== "propose") {
        throw new Error("Memory writes are disabled by the RunProfile");
      }
      const sourceRunId = proposal.sourceRunId;
      const sourceEventIds = [...new Set(proposal.sourceEventIds)];
      const sourceRun = await assertMemoryCandidateProvenance(
        store,
        sourceRunId,
        sourceEventIds,
      );
      if (sourceRun.runProfileSnapshot.memoryPolicy.write !== "propose") {
        throw new Error("Memory writes are disabled by the source RunProfile");
      }

      const candidate = parseMemoryCandidate({
        id: proposal.id,
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        content: proposal.content,
        sourceEventIds,
      });
      const events = await readMemoryEvents(store);
      if (candidateById(events, candidate.id) !== undefined) {
        throw new Error("Memory candidate already exists");
      }

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.candidateProposed, {
        candidateId: candidate.id,
        content: candidate.content,
        sourceRunId,
        sourceEventIds: [...candidate.sourceEventIds],
      });
    },

    async editCandidate(edit: MemoryCandidateEdit): Promise<void> {
      const actorId = nonEmptyString(edit.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const candidateId = nonEmptyString(edit.candidateId, "candidateId");
      const content = nonEmptyString(edit.content, "content");
      const events = await readMemoryEvents(store);
      assertUndecidedCandidate(events, candidateId);

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.candidateEdited, { candidateId, content, actorId });
    },

    async deleteCandidate(deletion: MemoryCandidateDeletion): Promise<void> {
      const actorId = nonEmptyString(deletion.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const candidateId = nonEmptyString(deletion.candidateId, "candidateId");
      const events = await readMemoryEvents(store);
      assertUndecidedCandidate(events, candidateId);

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.candidateDeleted, { candidateId, actorId });
    },

    async accept(acceptance: MemoryAcceptance): Promise<void> {
      const actorId = nonEmptyString(acceptance.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const candidateId = nonEmptyString(acceptance.candidateId, "candidateId");
      const events = await readMemoryEvents(store);
      assertUndecidedCandidate(events, candidateId);

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.accepted, { candidateId, actorId });
    },

    async reject(rejection: MemoryRejection): Promise<void> {
      const actorId = nonEmptyString(rejection.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const candidateId = nonEmptyString(rejection.candidateId, "candidateId");
      const events = await readMemoryEvents(store);
      assertUndecidedCandidate(events, candidateId);

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.rejected, { candidateId, actorId });
    },

    async edit(edit: MemoryEdit): Promise<void> {
      const actorId = nonEmptyString(edit.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const memoryId = nonEmptyString(edit.memoryId, "memoryId");
      const content = nonEmptyString(edit.content, "content");
      const events = await readMemoryEvents(store);
      assertActiveMemory(events, memoryId);

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.edited, { memoryId, content, actorId });
    },

    async delete(deletion: MemoryDeletion): Promise<void> {
      const actorId = nonEmptyString(deletion.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const memoryId = nonEmptyString(deletion.memoryId, "memoryId");
      const events = await readMemoryEvents(store);
      assertActiveMemory(events, memoryId);

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.deleted, { memoryId, actorId });
    },

    async grantWorkspaceRead(grant: WorkspaceReadGrant): Promise<void> {
      const actorId = nonEmptyString(grant.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const grantId = nonEmptyString(grant.grantId, "grantId");
      const targetChannelId = nonEmptyString(grant.targetChannelId, "targetChannelId");
      if (targetChannelId === scope.channelId) {
        throw new Error("Workspace Memory grants must target another Channel");
      }

      const events = await readMemoryEvents(store);
      if (workspaceReadGrantById(events, grantId) !== undefined) {
        throw new Error("Workspace Memory grant already exists");
      }

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.workspaceReadGranted, {
        grantId,
        targetChannelId,
        actorId,
      });
    },

    async revokeWorkspaceRead(revocation: WorkspaceReadRevocation): Promise<void> {
      const actorId = nonEmptyString(revocation.actorId, "actorId");
      await authorization.assertOwner(scope, actorId);

      const grantId = nonEmptyString(revocation.grantId, "grantId");
      const events = await readMemoryEvents(store);
      const grant = activeWorkspaceReadGrants(events).find((candidate) => candidate.grantId === grantId);
      if (grant === undefined) {
        throw new Error("Workspace Memory grant was not found");
      }

      await appendMemoryEvent(events, MEMORY_EVENT_TYPE.workspaceReadRevoked, {
        grantId,
        targetChannelId: grant.targetChannelId,
        actorId,
      });
    },

    async inspect(memoryId: string): Promise<DeletedChannelMemory | undefined> {
      const id = nonEmptyString(memoryId, "memoryId");
      return deletedChannelMemory(await readMemoryEvents(store), scope, id);
    },

    async inspectCandidate(candidateId: string): Promise<DeletedMemoryCandidate | undefined> {
      const id = nonEmptyString(candidateId, "candidateId");
      return deletedMemoryCandidate(await readMemoryEvents(store), scope, id);
    },

    async retrieve(retrieval: MemoryRetrieval): Promise<AcceptedChannelMemory[]> {
      if (memoryPolicy.read === "none") {
        throw new Error("Memory reads are disabled by the RunProfile");
      }
      const retrievalRunId = retrieval.runId === undefined
        ? undefined
        : nonEmptyString(retrieval.runId, "runId") as RunId;
      const runCommand = retrievalRunId === undefined
        ? undefined
        : await store.getRunCommand(retrievalRunId);
      if (retrievalRunId !== undefined && runCommand === undefined) {
        throw new Error("Run was not claimed");
      }
      if (
        runCommand !== undefined
        && runCommand.runProfileSnapshot.memoryPolicy.read === "none"
      ) {
        throw new Error("Memory reads are disabled by the RunProfile");
      }
      const events = await readMemoryEvents(store);
      const queryTokens = retrieval.query.toLowerCase().split(/\s+/).filter(Boolean);
      const localMemories = retrieveAcceptedMemories(events, scope, queryTokens);
      const grantedMemories: AcceptedChannelMemory[] = [];

      for (const reference of retrieval.workspaceGrantRefs ?? []) {
        if (
          !isNonEmptyString(reference.grantId)
          || !isNonEmptyString(reference.sourceChannelId)
          || reference.sourceChannelId === scope.channelId
        ) {
          continue;
        }

        const sourceScope = parseChannelScope({
          workspaceId: scope.workspaceId,
          channelId: reference.sourceChannelId,
        });
        const sourceEvents = await readMemoryEvents(options.eventStore.scope(sourceScope));
        const grant = activeWorkspaceReadGrants(sourceEvents).find(
          (candidate) => candidate.grantId === reference.grantId
            && candidate.targetChannelId === scope.channelId,
        );
        if (grant === undefined) {
          continue;
        }

        for (const memory of retrieveAcceptedMemories(sourceEvents, sourceScope, queryTokens)) {
          grantedMemories.push({
            ...memory,
            workspaceGrant: {
              grantId: grant.grantId,
              grantedBy: grant.actorId,
              grantEventId: grant.eventId,
              grantedAt: grant.timestamp,
            },
          });
        }
      }

      const memories = [...localMemories, ...grantedMemories].slice(0, retrieval.limit);
      if (retrievalRunId === undefined) {
        return memories;
      }

      const runId = retrievalRunId as unknown as StreamId;
      const runEvents = await readEvents(store, runId);
      if (!runEvents.some((event) => event.type === "run.started")) {
        throw new Error("Run has not started");
      }

      let seq = nextSequence(runEvents);
      for (const [index, memory] of memories.entries()) {
        await store.append({
          id: createEventId() as EventId,
          workspaceId: scope.workspaceId,
          channelId: scope.channelId,
          streamId: runId,
          seq: seq++,
          type: "memory.hit",
          timestamp: now(),
          schemaVersion: 1,
          payload: {
            memoryId: memory.id,
            sourceWorkspaceId: memory.sourceChannel.workspaceId,
            sourceChannelId: memory.sourceChannel.channelId,
            sourceRunId: memory.sourceRunId,
            sourceEventIds: [...memory.sourceEventIds],
            acceptedEventId: memory.acceptedEventId,
            rank: index + 1,
            ...(memory.workspaceGrant === undefined ? {} : {
              workspaceGrantId: memory.workspaceGrant.grantId,
              grantEventId: memory.workspaceGrant.grantEventId,
            }),
          },
        });
      }

      return memories;
    },
  };
}

async function assertMemoryCandidateProvenance(
  store: Pick<ScopedChannelStore, "getRunCommand" | "read">,
  sourceRunId: string,
  sourceEventIds: readonly string[],
): Promise<StartRun> {
  if (
    !isNonEmptyString(sourceRunId)
    || sourceEventIds.length === 0
    || sourceEventIds.some((eventId) => !isNonEmptyString(eventId))
  ) {
    throw new Error(MEMORY_CANDIDATE_PROVENANCE_UNAVAILABLE);
  }
  const sourceRun = await store.getRunCommand(sourceRunId as RunId);
  if (sourceRun === undefined) {
    throw new Error(MEMORY_CANDIDATE_PROVENANCE_UNAVAILABLE);
  }

  const sourceEventIdsInRun = new Set<string>((await readEvents(store, sourceRunId as StreamId)).map(
    (event) => event.id,
  ));
  if (!sourceEventIds.every((eventId) => sourceEventIdsInRun.has(eventId))) {
    throw new Error(MEMORY_CANDIDATE_PROVENANCE_UNAVAILABLE);
  }

  return sourceRun;
}

function assertUndecidedCandidate(events: readonly CanonicalEvent[], candidateId: string): void {
  if (candidateById(events, candidateId) === undefined) {
    throw new Error("Memory candidate was not found");
  }
  if (decisionForCandidate(events, candidateId) !== undefined) {
    throw new Error("Memory candidate has already been decided");
  }
}

function assertActiveMemory(events: readonly CanonicalEvent[], memoryId: string): void {
  if (acceptedMemory(events, memoryId) === undefined) {
    throw new Error("Channel Memory was not found");
  }
  if (deletedMemory(events, memoryId) !== undefined) {
    throw new Error("Channel Memory has been deleted");
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
