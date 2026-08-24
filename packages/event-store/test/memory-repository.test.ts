import { expect, test } from "vitest";

import {
  createChannelMemoryRepository,
  parseCanonicalEvent,
  parseStartRun,
  type CanonicalEvent,
  type ChannelOwnerAuthorization,
  type ChannelScope,
} from "@anna/harness-v2";
import { InMemoryEventStore } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const scope = {
  workspaceId: "workspace-memory-promotion",
  channelId: "channel-memory-promotion",
} as ChannelScope;

const memoryEnabledRunProfileSnapshot = resolvedRunProfileFixture({
  memoryPolicy: { read: "channel", write: "propose" },
});

function command(scope: ChannelScope, runId: string, sourceEventId: string) {
  return parseStartRun({
    commandId: `command-${runId}`,
    runId,
    goal: "Prepare a memory candidate.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: sourceEventId },
    runProfile: { id: "memory-test", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({
      id: "memory-test",
      memoryPolicy: { read: "channel", write: "propose" },
    }),
    budget: { turns: 1 },
    permissionScope: "permission-memory-test",
    stopCondition: "artifact_or_terminal",
  });
}

function ownerAuthorization(ownerActorId: string): ChannelOwnerAuthorization {
  return {
    async assertOwner(_scope, actorId): Promise<void> {
      if (actorId !== ownerActorId) {
        throw new Error("Channel Owner authorization denied");
      }
    },
  };
}

test("only explicit Channel Owner acceptance promotes a MemoryCandidate into future context", async () => {
  const eventStore = new InMemoryEventStore();
  const events = eventStore.scope(scope);

  await events.claimStart(command(
    scope,
    "run-failed-memory-source",
    "event-run-failed",
  ));
  await events.claimStart(command(
    scope,
    "run-ordinary-memory-source",
    "event-run-completed",
  ));

  await events.append(parseCanonicalEvent({
    id: "event-run-failed",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: "run-failed-memory-source",
    seq: 0,
    type: "run.failed",
    timestamp: "2026-08-19T00:00:00.000Z",
    schemaVersion: 1,
    payload: { errorType: "model_unavailable" },
  }));
  await events.append(parseCanonicalEvent({
    id: "event-run-completed",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: "run-ordinary-memory-source",
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-19T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));

  let nextEventId = 0;
  const repository = createChannelMemoryRepository({
    eventStore,
    scope,
    authorization: ownerAuthorization("actor-channel-owner"),
    runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    now: () => "2026-08-19T00:00:00.000Z",
    createEventId: () => `event-memory-${++nextEventId}`,
  });

  await repository.propose({
    id: "candidate-release-approval",
    content: "Release notes require Channel Owner approval before publication.",
    sourceEventIds: ["event-run-completed"],
    sourceRunId: "run-ordinary-memory-source",
  });
  await repository.propose({
    id: "candidate-failed-run-output",
    content: "Publish the unverified model claim.",
    sourceEventIds: ["event-run-failed"],
    sourceRunId: "run-failed-memory-source",
  });

  await expect(
    repository.retrieve({ query: "release approval", limit: 10 }),
  ).resolves.toEqual([]);

  await repository.accept({
    candidateId: "candidate-release-approval",
    actorId: "actor-channel-owner",
  });

  await expect(
    repository.retrieve({ query: "release approval", limit: 10 }),
  ).resolves.toEqual([
    {
      id: "candidate-release-approval",
      content: "Release notes require Channel Owner approval before publication.",
      sourceRunId: "run-ordinary-memory-source",
      sourceEventIds: ["event-run-completed"],
      sourceChannel: {
        workspaceId: "workspace-memory-promotion",
        channelId: "channel-memory-promotion",
      },
      acceptedBy: "actor-channel-owner",
      acceptedEventId: "event-memory-3",
      acceptedAt: "2026-08-19T00:00:00.000Z",
    },
  ]);
});

test("the claimed RunProfile cannot be bypassed for Memory writes or retrieval", async () => {
  const eventStore = new InMemoryEventStore();
  const events = eventStore.scope(scope);
  const disabledRun = parseStartRun({
    commandId: "command-memory-policy-disabled",
    runId: "run-memory-policy-disabled",
    goal: "Do not read or write Memory.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: "event-memory-policy-disabled" },
    runProfile: { id: "memory-policy-disabled", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({ id: "memory-policy-disabled" }),
    budget: { turns: 1 },
    permissionScope: "permission-memory-policy-disabled",
    stopCondition: "artifact_or_terminal",
  });
  await events.claimStart(disabledRun);
  await events.append(parseCanonicalEvent({
    id: "event-memory-policy-disabled",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: disabledRun.runId,
    seq: 0,
    type: "run.started",
    timestamp: "2026-08-19T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));
  const repository = createChannelMemoryRepository({
    eventStore,
    scope,
    authorization: ownerAuthorization("actor-channel-owner"),
    runProfileSnapshot: memoryEnabledRunProfileSnapshot,
  });

  await expect(repository.propose({
    id: "candidate-policy-disabled",
    content: "This must not be written.",
    sourceRunId: disabledRun.runId,
    sourceEventIds: ["event-memory-policy-disabled"],
  })).rejects.toThrow("Memory writes are disabled by the source RunProfile");
  await expect(repository.retrieve({
    query: "anything",
    limit: 10,
    runId: disabledRun.runId,
  }))
    .rejects.toThrow("Memory reads are disabled by the RunProfile");
});

test("Owner reject/edit/delete are explicit and deletion keeps an audit tombstone", async () => {
  const lifecycleScope = {
    workspaceId: "workspace-memory-lifecycle",
    channelId: "channel-memory-lifecycle",
  } as ChannelScope;
  const eventStore = new InMemoryEventStore();
  const events = eventStore.scope(lifecycleScope);
  await events.claimStart(command(
    lifecycleScope,
    "run-memory-rejected",
    "event-run-memory-rejected",
  ));
  await events.claimStart(command(
    lifecycleScope,
    "run-memory-lifecycle",
    "event-run-memory-lifecycle-1",
  ));
  await events.append(parseCanonicalEvent({
    id: "event-run-memory-rejected",
    workspaceId: lifecycleScope.workspaceId,
    channelId: lifecycleScope.channelId,
    streamId: "run-memory-rejected",
    seq: 0,
    type: "run.failed",
    timestamp: "2026-08-19T01:00:00.000Z",
    schemaVersion: 1,
    payload: { errorType: "test" },
  }));
  await events.append(parseCanonicalEvent({
    id: "event-run-memory-lifecycle-1",
    workspaceId: lifecycleScope.workspaceId,
    channelId: lifecycleScope.channelId,
    streamId: "run-memory-lifecycle",
    seq: 0,
    type: "run.started",
    timestamp: "2026-08-19T01:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));
  await events.append(parseCanonicalEvent({
    id: "event-run-memory-lifecycle-2",
    workspaceId: lifecycleScope.workspaceId,
    channelId: lifecycleScope.channelId,
    streamId: "run-memory-lifecycle",
    seq: 1,
    type: "run.progress",
    timestamp: "2026-08-19T01:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));
  let nextEventId = 0;
  const repository = createChannelMemoryRepository({
    eventStore,
    scope: lifecycleScope,
    authorization: ownerAuthorization("actor-memory-owner"),
    runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    now: () => "2026-08-19T01:00:00.000Z",
    createEventId: () => `event-memory-lifecycle-${++nextEventId}`,
  });

  await repository.propose({
    id: "candidate-memory-rejected",
    content: "This candidate must remain out of future memory.",
    sourceRunId: "run-memory-rejected",
    sourceEventIds: ["event-run-memory-rejected"],
  });
  await repository.reject({
    candidateId: "candidate-memory-rejected",
    actorId: "actor-memory-owner",
  });
  await expect(
    repository.accept({
      candidateId: "candidate-memory-rejected",
      actorId: "actor-memory-owner",
    }),
  ).rejects.toThrow("Memory candidate has already been decided");
  await expect(
    repository.retrieve({ query: "candidate future", limit: 10 }),
  ).resolves.toEqual([]);

  await repository.propose({
    id: "memory-lifecycle-edit-delete",
    content: "Original lifecycle memory retains source provenance.",
    sourceRunId: "run-memory-lifecycle",
    sourceEventIds: ["event-run-memory-lifecycle-1", "event-run-memory-lifecycle-2"],
  });
  await repository.accept({
    candidateId: "memory-lifecycle-edit-delete",
    actorId: "actor-memory-owner",
  });
  await repository.edit({
    memoryId: "memory-lifecycle-edit-delete",
    content: "Edited lifecycle memory retains original source provenance.",
    actorId: "actor-memory-owner",
  });

  await expect(
    repository.retrieve({ query: "edited lifecycle", limit: 10 }),
  ).resolves.toEqual([
    {
      id: "memory-lifecycle-edit-delete",
      content: "Edited lifecycle memory retains original source provenance.",
      sourceRunId: "run-memory-lifecycle",
      sourceEventIds: ["event-run-memory-lifecycle-1", "event-run-memory-lifecycle-2"],
      sourceChannel: {
        workspaceId: "workspace-memory-lifecycle",
        channelId: "channel-memory-lifecycle",
      },
      acceptedBy: "actor-memory-owner",
      acceptedEventId: "event-memory-lifecycle-4",
      acceptedAt: "2026-08-19T01:00:00.000Z",
      editedBy: "actor-memory-owner",
      editedEventId: "event-memory-lifecycle-5",
      editedAt: "2026-08-19T01:00:00.000Z",
    },
  ]);

  await repository.delete({
    memoryId: "memory-lifecycle-edit-delete",
    actorId: "actor-memory-owner",
  });
  await expect(
    repository.retrieve({ query: "edited lifecycle", limit: 10 }),
  ).resolves.toEqual([]);

  const tombstone = await repository.inspect("memory-lifecycle-edit-delete");
  expect(tombstone).toEqual({
    status: "deleted",
    id: "memory-lifecycle-edit-delete",
    sourceRunId: "run-memory-lifecycle",
    sourceEventIds: ["event-run-memory-lifecycle-1", "event-run-memory-lifecycle-2"],
    sourceChannel: {
      workspaceId: "workspace-memory-lifecycle",
      channelId: "channel-memory-lifecycle",
    },
    acceptedBy: "actor-memory-owner",
    acceptedEventId: "event-memory-lifecycle-4",
    acceptedAt: "2026-08-19T01:00:00.000Z",
    deletedBy: "actor-memory-owner",
    deletedEventId: "event-memory-lifecycle-6",
    deletedAt: "2026-08-19T01:00:00.000Z",
  });
  expect(tombstone).not.toHaveProperty("content");
});

test("validates a candidate's source Run and source events before recording provenance", async () => {
  const eventStore = new InMemoryEventStore();
  const events = eventStore.scope(scope);
  const command = (runId: string) => parseStartRun({
    commandId: `command-${runId}`,
    runId,
    goal: "Prepare a provenance-backed memory candidate.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: `source-${runId}` },
    runProfile: { id: "memory-provenance", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({
      id: "memory-provenance",
      memoryPolicy: { read: "channel", write: "propose" },
    }),
    budget: { turns: 1 },
    permissionScope: "permission-memory-provenance",
    stopCondition: "artifact_or_terminal",
  });
  const sourceEvent = (id: string, streamId: string, type: string) => parseCanonicalEvent({
    id,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId,
    seq: 0,
    type,
    timestamp: "2026-08-19T02:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  });

  const completedRun = command("run-valid-completed");
  const failedRun = command("run-valid-failed");
  const otherRun = command("run-other");
  await events.claimStart(completedRun);
  await events.claimStart(failedRun);
  await events.claimStart(otherRun);
  await events.append(sourceEvent("event-run-valid-completed", completedRun.runId, "run.completed"));
  await events.append(sourceEvent("event-run-valid-failed", failedRun.runId, "run.failed"));
  await events.append(sourceEvent("event-run-other-progress", otherRun.runId, "run.progress"));

  let nextEventId = 0;
  const repository = createChannelMemoryRepository({
    eventStore,
    scope,
    authorization: ownerAuthorization("actor-channel-owner"),
    runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    now: () => "2026-08-19T02:00:00.000Z",
    createEventId: () => `event-memory-provenance-${++nextEventId}`,
  });
  const safeProvenanceError = "Memory candidate provenance is unavailable";

  await expect(repository.propose({
    id: "candidate-missing-run",
    content: "This candidate has no source Run.",
    sourceRunId: "run-does-not-exist",
    sourceEventIds: ["event-run-valid-completed"],
  })).rejects.toThrow(safeProvenanceError);
  await expect(repository.propose({
    id: "candidate-wrong-run-event",
    content: "This candidate points at another Run's event.",
    sourceRunId: completedRun.runId,
    sourceEventIds: ["event-run-other-progress"],
  })).rejects.toThrow(safeProvenanceError);
  await expect(repository.propose({
    id: "candidate-missing-event",
    content: "This candidate contains a missing source event.",
    sourceRunId: completedRun.runId,
    sourceEventIds: ["event-run-valid-completed", "event-does-not-exist"],
  })).rejects.toThrow(safeProvenanceError);

  await expect(repository.propose({
    id: "candidate-valid-completed",
    content: "Completed Run provenance is ready for Owner review.",
    sourceRunId: completedRun.runId,
    sourceEventIds: ["event-run-valid-completed"],
  })).resolves.toBeUndefined();
  await expect(repository.propose({
    id: "candidate-valid-failed",
    content: "Failed Run provenance remains a proposal until Owner review.",
    sourceRunId: failedRun.runId,
    sourceEventIds: ["event-run-valid-failed"],
  })).resolves.toBeUndefined();
  await expect(
    repository.retrieve({ query: "Owner review", limit: 10 }),
  ).resolves.toEqual([]);

  const memoryEvents: CanonicalEvent[] = [];
  for await (const event of events.read("channel-memory" as CanonicalEvent["streamId"])) {
    memoryEvents.push(event);
  }
  expect(memoryEvents).toHaveLength(2);
  expect(memoryEvents).toEqual([
    expect.objectContaining({
      id: expect.any(String),
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      streamId: "channel-memory",
      seq: 0,
      type: "memory.candidate.proposed",
      timestamp: "2026-08-19T02:00:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-valid-completed",
        content: "Completed Run provenance is ready for Owner review.",
        sourceRunId: "run-valid-completed",
        sourceEventIds: ["event-run-valid-completed"],
      },
    }),
    expect.objectContaining({
      id: expect.any(String),
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      streamId: "channel-memory",
      seq: 1,
      type: "memory.candidate.proposed",
      timestamp: "2026-08-19T02:00:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-valid-failed",
        content: "Failed Run provenance remains a proposal until Owner review.",
        sourceRunId: "run-valid-failed",
        sourceEventIds: ["event-run-valid-failed"],
      },
    }),
  ]);
});

test("Owner can edit or delete a pending MemoryCandidate before acceptance", async () => {
  const candidateScope = {
    workspaceId: "workspace-memory-candidate-mutation",
    channelId: "channel-memory-candidate-mutation",
  } as ChannelScope;
  const eventStore = new InMemoryEventStore();
  const events = eventStore.scope(candidateScope);
  const sourceRun = command(
    candidateScope,
    "run-memory-candidate-mutation",
    "event-run-memory-candidate-mutation-completed",
  );
  await events.claimStart(sourceRun);
  await events.append(parseCanonicalEvent({
    id: "event-run-memory-candidate-mutation-completed",
    workspaceId: candidateScope.workspaceId,
    channelId: candidateScope.channelId,
    streamId: "run-memory-candidate-mutation",
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-19T03:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));

  const timestamps = [
    "2026-08-19T03:01:00.000Z",
    "2026-08-19T03:02:00.000Z",
    "2026-08-19T03:03:00.000Z",
    "2026-08-19T03:04:00.000Z",
    "2026-08-19T03:05:00.000Z",
  ] as const;
  let nextEventId = 0;
  let nextTimestamp = 0;
  const repository = createChannelMemoryRepository({
    eventStore,
    scope: candidateScope,
    authorization: ownerAuthorization("actor-candidate-owner"),
    runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    now: () => timestamps[nextTimestamp++]!,
    createEventId: () => `event-memory-candidate-mutation-${++nextEventId}`,
  });

  await repository.propose({
    id: "candidate-edit-before-acceptance",
    content: "Original pending candidate content.",
    sourceRunId: "run-memory-candidate-mutation",
    sourceEventIds: ["event-run-memory-candidate-mutation-completed"],
  });
  await repository.editCandidate({
    candidateId: "candidate-edit-before-acceptance",
    content: "Edited pending candidate content retains its source provenance.",
    actorId: "actor-candidate-owner",
  });
  await repository.accept({
    candidateId: "candidate-edit-before-acceptance",
    actorId: "actor-candidate-owner",
  });

  await expect(
    repository.retrieve({ query: "Edited pending candidate", limit: 10 }),
  ).resolves.toEqual([
    {
      id: "candidate-edit-before-acceptance",
      content: "Edited pending candidate content retains its source provenance.",
      sourceRunId: "run-memory-candidate-mutation",
      sourceEventIds: ["event-run-memory-candidate-mutation-completed"],
      sourceChannel: {
        workspaceId: "workspace-memory-candidate-mutation",
        channelId: "channel-memory-candidate-mutation",
      },
      acceptedBy: "actor-candidate-owner",
      acceptedEventId: "event-memory-candidate-mutation-3",
      acceptedAt: "2026-08-19T03:03:00.000Z",
      editedBy: "actor-candidate-owner",
      editedEventId: "event-memory-candidate-mutation-2",
      editedAt: "2026-08-19T03:02:00.000Z",
    },
  ]);

  await repository.propose({
    id: "candidate-delete-before-acceptance",
    content: "Deleted pending candidate content must not enter future memory.",
    sourceRunId: "run-memory-candidate-mutation",
    sourceEventIds: ["event-run-memory-candidate-mutation-completed"],
  });
  await repository.deleteCandidate({
    candidateId: "candidate-delete-before-acceptance",
    actorId: "actor-candidate-owner",
  });
  await expect(
    repository.accept({
      candidateId: "candidate-delete-before-acceptance",
      actorId: "actor-candidate-owner",
    }),
  ).rejects.toThrow("Memory candidate has already been decided");
  await expect(
    repository.reject({
      candidateId: "candidate-delete-before-acceptance",
      actorId: "actor-candidate-owner",
    }),
  ).rejects.toThrow("Memory candidate has already been decided");
  await expect(
    repository.editCandidate({
      candidateId: "candidate-delete-before-acceptance",
      content: "A deleted candidate cannot be edited.",
      actorId: "actor-candidate-owner",
    }),
  ).rejects.toThrow("Memory candidate has already been decided");
  await expect(
    repository.retrieve({ query: "Deleted pending candidate", limit: 10 }),
  ).resolves.toEqual([]);

  await expect(
    repository.inspectCandidate("candidate-delete-before-acceptance"),
  ).resolves.toEqual({
    status: "candidate_deleted",
    id: "candidate-delete-before-acceptance",
    sourceRunId: "run-memory-candidate-mutation",
    sourceEventIds: ["event-run-memory-candidate-mutation-completed"],
    sourceChannel: {
      workspaceId: "workspace-memory-candidate-mutation",
      channelId: "channel-memory-candidate-mutation",
    },
    deletedBy: "actor-candidate-owner",
    deletedEventId: "event-memory-candidate-mutation-5",
    deletedAt: "2026-08-19T03:05:00.000Z",
  });

  const memoryEvents: CanonicalEvent[] = [];
  for await (const event of events.read("channel-memory" as CanonicalEvent["streamId"])) {
    memoryEvents.push(event);
  }
  expect(memoryEvents).toEqual([
    {
      id: "event-memory-candidate-mutation-1",
      workspaceId: "workspace-memory-candidate-mutation",
      channelId: "channel-memory-candidate-mutation",
      streamId: "channel-memory",
      seq: 0,
      type: "memory.candidate.proposed",
      timestamp: "2026-08-19T03:01:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-edit-before-acceptance",
        content: "Original pending candidate content.",
        sourceRunId: "run-memory-candidate-mutation",
        sourceEventIds: ["event-run-memory-candidate-mutation-completed"],
      },
    },
    {
      id: "event-memory-candidate-mutation-2",
      workspaceId: "workspace-memory-candidate-mutation",
      channelId: "channel-memory-candidate-mutation",
      streamId: "channel-memory",
      seq: 1,
      type: "memory.candidate.edited",
      timestamp: "2026-08-19T03:02:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-edit-before-acceptance",
        content: "Edited pending candidate content retains its source provenance.",
        actorId: "actor-candidate-owner",
      },
    },
    {
      id: "event-memory-candidate-mutation-3",
      workspaceId: "workspace-memory-candidate-mutation",
      channelId: "channel-memory-candidate-mutation",
      streamId: "channel-memory",
      seq: 2,
      type: "memory.accepted",
      timestamp: "2026-08-19T03:03:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-edit-before-acceptance",
        actorId: "actor-candidate-owner",
      },
    },
    {
      id: "event-memory-candidate-mutation-4",
      workspaceId: "workspace-memory-candidate-mutation",
      channelId: "channel-memory-candidate-mutation",
      streamId: "channel-memory",
      seq: 3,
      type: "memory.candidate.proposed",
      timestamp: "2026-08-19T03:04:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-delete-before-acceptance",
        content: "Deleted pending candidate content must not enter future memory.",
        sourceRunId: "run-memory-candidate-mutation",
        sourceEventIds: ["event-run-memory-candidate-mutation-completed"],
      },
    },
    {
      id: "event-memory-candidate-mutation-5",
      workspaceId: "workspace-memory-candidate-mutation",
      channelId: "channel-memory-candidate-mutation",
      streamId: "channel-memory",
      seq: 4,
      type: "memory.candidate.deleted",
      timestamp: "2026-08-19T03:05:00.000Z",
      schemaVersion: 1,
      payload: {
        candidateId: "candidate-delete-before-acceptance",
        actorId: "actor-candidate-owner",
      },
    },
  ]);
});
