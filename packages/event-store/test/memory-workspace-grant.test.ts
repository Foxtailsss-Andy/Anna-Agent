import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  createChannelMemoryRepository,
  parseCanonicalEvent,
  parseStartRun,
  type CanonicalEvent,
  type ChannelOwnerAuthorization,
  type ChannelScope,
  type StreamId,
} from "@anna/harness-v2";
import { SqliteEventStore } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const sourceScope = {
  workspaceId: "workspace-memory-grant",
  channelId: "channel-memory-source",
} as ChannelScope;

const targetScope = {
  workspaceId: "workspace-memory-grant",
  channelId: "channel-memory-target",
} as ChannelScope;

const sourceOwnerId = "actor-memory-source-owner";
const targetOwnerId = "actor-memory-target-owner";
const sourceRunId = "run-memory-source-release";
const sourceEventId = "event-memory-source-release-completed";
const candidateId = "memory-source-release-control";
const grantId = "workspace-grant-source-release-control";
const content = "Deep literal r5c-77 release control belongs to the source channel.";
const query = "r5c-77 release control";
const memoryStreamId = "channel-memory" as StreamId;
const memoryEnabledRunProfileSnapshot = resolvedRunProfileFixture({
  memoryPolicy: { read: "channel", write: "propose" },
});

const authorization: ChannelOwnerAuthorization = {
  async assertOwner(scope, actorId): Promise<void> {
    const ownerByChannelId = new Map([
      [sourceScope.channelId, sourceOwnerId],
      [targetScope.channelId, targetOwnerId],
    ]);
    if (ownerByChannelId.get(scope.channelId) !== actorId) {
      throw new Error("Channel Owner authorization denied");
    }
  },
};

function withDatabase(
  testBody: (path: string, stores: SqliteEventStore[]) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "anna-memory-workspace-grant-"));
  const stores: SqliteEventStore[] = [];
  return testBody(join(directory, "memory-workspace-grant.sqlite"), stores).finally(() => {
    for (const store of stores.reverse()) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });
}

async function readMemoryEvents(
  eventStore: SqliteEventStore,
  scope: ChannelScope,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of eventStore.scope(scope).read(memoryStreamId)) {
    events.push(event);
  }
  return events;
}

test("Channel isolation and source-authorized Workspace Memory grants survive restart", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const sourceEvents = first.scope(sourceScope);
    await sourceEvents.claimStart(parseStartRun({
      commandId: "command-memory-source-release",
      runId: sourceRunId,
      goal: "Prepare a release-control memory candidate.",
      workspaceId: sourceScope.workspaceId,
      channelId: sourceScope.channelId,
      source: { eventId: sourceEventId },
      runProfile: { id: "memory-workspace-grant", version: "1" },
      runProfileSnapshot: resolvedRunProfileFixture({
        id: "memory-workspace-grant",
        memoryPolicy: { read: "channel", write: "propose" },
      }),
      budget: { turns: 1 },
      permissionScope: "permission-memory-workspace-grant",
      stopCondition: "artifact_or_terminal",
    }));
    await sourceEvents.append(parseCanonicalEvent({
      id: sourceEventId,
      workspaceId: sourceScope.workspaceId,
      channelId: sourceScope.channelId,
      streamId: sourceRunId,
      seq: 0,
      type: "run.completed",
      timestamp: "2026-08-19T00:00:00.000Z",
      schemaVersion: 1,
      payload: {},
    }));

    const sourceRepository = createChannelMemoryRepository({
      eventStore: first,
      scope: sourceScope,
      authorization,
      runProfileSnapshot: memoryEnabledRunProfileSnapshot,
      now: () => "2026-08-19T00:00:01.000Z",
      createEventId: (() => {
        const ids = [
          "event-memory-source-proposed",
          "event-memory-source-accepted",
          "event-memory-source-workspace-granted",
        ];
        return () => ids.shift() ?? "event-memory-source-unexpected";
      })(),
    });
    const targetRepository = createChannelMemoryRepository({
      eventStore: first,
      scope: targetScope,
      authorization,
      runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    });

    await sourceRepository.propose({
      id: candidateId,
      content,
      sourceRunId,
      sourceEventIds: [sourceEventId],
    });
    await sourceRepository.accept({ candidateId, actorId: sourceOwnerId });

    const expectedSourceMemory = {
      id: candidateId,
      content,
      sourceRunId,
      sourceEventIds: [sourceEventId],
      sourceChannel: sourceScope,
      acceptedBy: sourceOwnerId,
      acceptedEventId: "event-memory-source-accepted",
      acceptedAt: "2026-08-19T00:00:01.000Z",
    };
    await expect(sourceRepository.retrieve({ query, limit: 10 })).resolves.toEqual([
      expectedSourceMemory,
    ]);
    await expect(targetRepository.retrieve({ query, limit: 10 })).resolves.toEqual([]);

    await expect(sourceRepository.grantWorkspaceRead({
      grantId,
      targetChannelId: targetScope.channelId,
      actorId: targetOwnerId,
    })).rejects.toThrow("Channel Owner authorization denied");
    await sourceRepository.grantWorkspaceRead({
      grantId,
      targetChannelId: targetScope.channelId,
      actorId: sourceOwnerId,
    });
    await expect(readMemoryEvents(first, sourceScope)).resolves.toContainEqual({
      id: "event-memory-source-workspace-granted",
      workspaceId: sourceScope.workspaceId,
      channelId: sourceScope.channelId,
      streamId: memoryStreamId,
      seq: 2,
      type: "memory.workspace_read.granted",
      timestamp: "2026-08-19T00:00:01.000Z",
      schemaVersion: 1,
      payload: {
        grantId,
        targetChannelId: targetScope.channelId,
        actorId: sourceOwnerId,
      },
    });

    const workspaceGrantRefs = [{ grantId, sourceChannelId: sourceScope.channelId }];
    const expectedGrantedMemory = [{
      ...expectedSourceMemory,
      workspaceGrant: {
        grantId,
        grantedBy: sourceOwnerId,
        grantEventId: "event-memory-source-workspace-granted",
        grantedAt: "2026-08-19T00:00:01.000Z",
      },
    }];
    await expect(targetRepository.retrieve({ query, limit: 10 })).resolves.toEqual([]);
    await expect(targetRepository.retrieve({
      query,
      limit: 10,
      workspaceGrantRefs,
    })).resolves.toEqual(expectedGrantedMemory);

    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const reopenedSourceRepository = createChannelMemoryRepository({
      eventStore: reopened,
      scope: sourceScope,
      authorization,
      runProfileSnapshot: memoryEnabledRunProfileSnapshot,
      now: () => "2026-08-19T00:00:03.000Z",
      createEventId: () => "event-memory-source-workspace-revoked",
    });
    const reopenedTargetRepository = createChannelMemoryRepository({
      eventStore: reopened,
      scope: targetScope,
      authorization,
      runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    });
    await expect(reopenedTargetRepository.retrieve({
      query,
      limit: 10,
      workspaceGrantRefs,
    })).resolves.toEqual(expectedGrantedMemory);

    await reopenedSourceRepository.revokeWorkspaceRead({
      grantId,
      actorId: sourceOwnerId,
    });
    reopened.close();
    stores.pop();

    const reopenedAfterRevocation = new SqliteEventStore(path);
    stores.push(reopenedAfterRevocation);
    const revokedTargetRepository = createChannelMemoryRepository({
      eventStore: reopenedAfterRevocation,
      scope: targetScope,
      authorization,
      runProfileSnapshot: memoryEnabledRunProfileSnapshot,
    });
    await expect(revokedTargetRepository.retrieve({
      query,
      limit: 10,
      workspaceGrantRefs,
    })).resolves.toEqual([]);
  });
});
