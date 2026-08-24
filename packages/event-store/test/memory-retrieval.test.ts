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
  workspaceId: "workspace-memory-hit",
  channelId: "channel-memory-hit",
} as ChannelScope;

const authorization: ChannelOwnerAuthorization = {
  async assertOwner(_scope, actorId): Promise<void> {
    if (actorId !== "actor-memory-owner") {
      throw new Error("Channel Owner authorization denied");
    }
  },
};

const memoryEnabledRunProfileSnapshot = resolvedRunProfileFixture({
  memoryPolicy: { read: "channel", write: "propose" },
});

test("deterministic retrieval records provenance-only memory hits for an active Run", async () => {
  const eventStore = new InMemoryEventStore();
  const events = eventStore.scope(scope);
  const runId = "run-context-memory";
  const timestamp = "2026-08-19T02:00:00.000Z";

  await events.claimStart(parseStartRun({
    commandId: "command-context-memory",
    runId,
    goal: "Retrieve accepted channel memory.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: "event-run-context-memory-started" },
    runProfile: { id: "memory-retrieval", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({
      id: "memory-retrieval",
      memoryPolicy: { read: "channel", write: "propose" },
    }),
    budget: { turns: 1 },
    permissionScope: "permission-memory-retrieval",
    stopCondition: "artifact_or_terminal",
  }));

  await events.append(parseCanonicalEvent({
    id: "event-run-context-memory-started",
    workspaceId: "workspace-memory-hit",
    channelId: "channel-memory-hit",
    streamId: "run-context-memory",
    seq: 0,
    type: "run.started",
    timestamp: "2026-08-19T02:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));

  let nextEventId = 0;
  const repository = createChannelMemoryRepository({
    eventStore,
    scope,
    authorization,
    runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    now: () => timestamp,
    createEventId: () => `event-memory-hit-${++nextEventId}`,
  });

  for (const [id, content] of [
    ["memory-alpha-beta-first", "alpha beta first accepted memory"],
    ["memory-alpha-beta-second", "alpha beta second accepted memory"],
    ["memory-alpha-only-third", "alpha third accepted memory"],
  ] as const) {
    await repository.propose({
      id,
      content,
      sourceRunId: runId,
      sourceEventIds: ["event-run-context-memory-started"],
    });
    await repository.accept({ candidateId: id, actorId: "actor-memory-owner" });
  }

  const fixtureExpected = await repository.retrieve({ query: "alpha beta", limit: 2 });
  expect(fixtureExpected).toEqual([
    {
      id: "memory-alpha-beta-first",
      content: "alpha beta first accepted memory",
      sourceRunId: "run-context-memory",
      sourceEventIds: ["event-run-context-memory-started"],
      sourceChannel: {
        workspaceId: "workspace-memory-hit",
        channelId: "channel-memory-hit",
      },
      acceptedBy: "actor-memory-owner",
      acceptedEventId: "event-memory-hit-2",
      acceptedAt: "2026-08-19T02:00:00.000Z",
    },
    {
      id: "memory-alpha-beta-second",
      content: "alpha beta second accepted memory",
      sourceRunId: "run-context-memory",
      sourceEventIds: ["event-run-context-memory-started"],
      sourceChannel: {
        workspaceId: "workspace-memory-hit",
        channelId: "channel-memory-hit",
      },
      acceptedBy: "actor-memory-owner",
      acceptedEventId: "event-memory-hit-4",
      acceptedAt: "2026-08-19T02:00:00.000Z",
    },
  ]);

  const retrievedForRun = await repository.retrieve({
    query: "alpha beta",
    limit: 2,
    runId,
  });
  expect(retrievedForRun).toEqual(fixtureExpected);

  const runEvents: CanonicalEvent[] = [];
  for await (const event of events.read(runId as never)) {
    runEvents.push(event);
  }

  // T05 is responsible for projection; T04 records only canonical events.
  expect(runEvents).toEqual([
    {
      id: "event-run-context-memory-started",
      workspaceId: "workspace-memory-hit",
      channelId: "channel-memory-hit",
      streamId: "run-context-memory",
      seq: 0,
      type: "run.started",
      timestamp: "2026-08-19T02:00:00.000Z",
      schemaVersion: 1,
      payload: {},
    },
    {
      id: "event-memory-hit-7",
      workspaceId: "workspace-memory-hit",
      channelId: "channel-memory-hit",
      streamId: "run-context-memory",
      seq: 1,
      type: "memory.hit",
      timestamp: "2026-08-19T02:00:00.000Z",
      schemaVersion: 1,
      payload: {
        memoryId: "memory-alpha-beta-first",
        sourceWorkspaceId: "workspace-memory-hit",
        sourceChannelId: "channel-memory-hit",
        sourceRunId: "run-context-memory",
        sourceEventIds: ["event-run-context-memory-started"],
        acceptedEventId: "event-memory-hit-2",
        rank: 1,
      },
    },
    {
      id: "event-memory-hit-8",
      workspaceId: "workspace-memory-hit",
      channelId: "channel-memory-hit",
      streamId: "run-context-memory",
      seq: 2,
      type: "memory.hit",
      timestamp: "2026-08-19T02:00:00.000Z",
      schemaVersion: 1,
      payload: {
        memoryId: "memory-alpha-beta-second",
        sourceWorkspaceId: "workspace-memory-hit",
        sourceChannelId: "channel-memory-hit",
        sourceRunId: "run-context-memory",
        sourceEventIds: ["event-run-context-memory-started"],
        acceptedEventId: "event-memory-hit-4",
        rank: 2,
      },
    },
  ]);
});
