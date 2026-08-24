import { expect, test } from "vitest";

import {
  InMemoryEventStore,
  projectHarnessState,
  projectRunFamilyHarnessState,
  SqliteEventStore,
} from "../src/index";
import type { CanonicalEvent, ChannelScope } from "@anna/harness-v2";
import { parseStartRun } from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const scope = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
} as ChannelScope;

function event(
  streamId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): CanonicalEvent {
  return {
    id: `${streamId}-${seq}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId,
    seq,
    type,
    timestamp: `2026-08-22T00:00:0${seq}.000Z`,
    schemaVersion: 1,
    payload,
  } as CanonicalEvent;
}

function command(runId: string, parentRunId?: string) {
  return parseStartRun({
    commandId: `command-${runId}`,
    runId,
    goal: `Run ${runId}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: `source-${runId}` },
    runProfile: { id: "profile-1", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture(),
    budget: { turns: 1 },
    permissionScope: "permission-1",
    stopCondition: "artifact_or_terminal",
    ...(parentRunId === undefined
      ? {}
      : { parentRunId, parentEventId: `${parentRunId}-0` }),
  });
}

async function assertProjection(storeRoot: { scope(scope: ChannelScope): any }) {
  const store = storeRoot.scope(scope);
  await store.claimStart(command("parent-run"));
  await store.claimStart(command("child-run", "parent-run"));
  await store.append(event("parent-run", 0, "run.started"));
  await store.append(event("child-run", 0, "run.started", {
    parentRunId: "parent-run",
    parentEventId: "parent-run-0",
  }));
  await store.append(event("child-run", 1, "run.completed", { outcome: "completed" }));

  await expect(projectRunFamilyHarnessState(store, "parent-run")).resolves.toEqual([
    {
      runId: "child-run",
      parentRunId: "parent-run",
      parentEventId: "parent-run-0",
      status: "completed",
      lastSeq: 1,
      lastEventType: "run.completed",
    },
    {
      runId: "parent-run",
      status: "running",
      lastSeq: 0,
      lastEventType: "run.started",
    },
  ]);

  await expect(projectHarnessState(store, "child-run")).resolves.toMatchObject({
    runId: "child-run",
    parentRunId: "parent-run",
    status: "completed",
    lastSeq: 1,
  });
  await expect(store.loadProjection("harness-state", "child-run")).resolves.toMatchObject({
    lastSeq: 1,
  });
}

test("family projection includes a claimed child before its first event", async () => {
  const store = new InMemoryEventStore().scope(scope);
  await store.claimStart(command("parent-run"));
  await store.claimStart(command("child-run", "parent-run"));
  await store.append(event("parent-run", 0, "run.started"));

  await expect(projectRunFamilyHarnessState(store, "parent-run")).resolves.toEqual([
    {
      runId: "child-run",
      parentRunId: "parent-run",
      parentEventId: "parent-run-0",
      status: "queued",
      lastSeq: -1,
    },
    {
      runId: "parent-run",
      status: "running",
      lastSeq: 0,
      lastEventType: "run.started",
    },
  ]);
});

test("SQLite family projection includes a claimed child before its first event", async () => {
  const path = `/tmp/anna-harness-state-command-only-${Date.now()}-${Math.random()}.sqlite`;
  const root = new SqliteEventStore(path);
  try {
    const store = root.scope(scope);
    await store.claimStart(command("parent-run"));
    await store.claimStart(command("child-run", "parent-run"));
    await store.append(event("parent-run", 0, "run.started"));

    await expect(projectRunFamilyHarnessState(store, "parent-run")).resolves.toEqual([
      expect.objectContaining({ runId: "child-run", status: "queued", lastSeq: -1 }),
      expect.objectContaining({ runId: "parent-run", status: "running", lastSeq: 0 }),
    ]);
  } finally {
    root.close();
  }
});

test("rebuilds parent and child Harness state from an InMemory Event Store", async () => {
  await assertProjection(new InMemoryEventStore());
});

test("rebuilds parent and child Harness state after SQLite reopen", async () => {
  const path = `/tmp/anna-harness-state-${Date.now()}-${Math.random()}.sqlite`;
  const first = new SqliteEventStore(path);
  try {
    await assertProjection(first);
  } finally {
    first.close();
  }

  const reopened = new SqliteEventStore(path);
  try {
    const store = reopened.scope(scope);
    await expect(store.loadProjection("harness-state", "child-run" as never)).resolves.toMatchObject({
      lastSeq: 1,
    });
  } finally {
    reopened.close();
  }
});
