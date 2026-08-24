import { expect, test } from "vitest";

import { ChannelSessionService, InMemoryEventStore, RunManager } from "../src/index";
import {
  parseChannelSession,
  parseStartRun,
  type CanonicalEvent,
  type ChannelScope,
} from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const scope = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
} as ChannelScope;

const command = parseStartRun({
  commandId: "command-1",
  runId: "run-1",
  goal: "Prepare the release brief.",
  workspaceId: scope.workspaceId,
  channelId: scope.channelId,
  source: { eventId: "source-event-1" },
  runProfile: { id: "profile-1", version: "1" },
  runProfileSnapshot: resolvedRunProfileFixture(),
  budget: { turns: 1 },
  permissionScope: "permission-1",
  stopCondition: "artifact_or_terminal",
});

function runEvent(type: string, seq: number) {
  return {
    id: `event-${seq + 1}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: command.runId,
    seq,
    type,
    timestamp: "2026-08-18T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  } as unknown as CanonicalEvent;
}

async function readAll(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

test("rebuilds a queued Run from its claimed command without writing an event", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const manager = new RunManager(store);

  await expect(manager.start(command)).resolves.toMatchObject({
    id: command.runId,
    status: "queued",
  });
  await expect(manager.get(command.runId)).resolves.toMatchObject({
    id: command.runId,
    status: "queued",
  });
});

test("preserves proactive trigger and notification audience in the rebuilt Run", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const manager = new RunManager(store);
  const proactive = parseStartRun({
    ...command,
    commandId: "proactive-command",
    runId: "proactive-run",
    trigger: { kind: "explicit", label: "scheduled follow-up" },
    notificationAudience: ["actor-1"],
  });

  await manager.start(proactive);

  await expect(manager.get(proactive.runId)).resolves.toMatchObject({
    trigger: proactive.trigger,
    notificationAudience: proactive.notificationAudience,
  });
});

test("requires a claimed parent Run before claiming a child Run", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const manager = new RunManager(store);
  const child = parseStartRun({
    ...command,
    commandId: "child-command",
    runId: "child-run",
    parentRunId: "missing-parent",
    parentEventId: "parent-event",
    laneId: "lane-1",
  });

  await expect(manager.start(child)).rejects.toThrow(
    "Parent Run missing-parent is not claimed in this Channel",
  );
  await expect(store.getRunCommand(child.runId)).resolves.toBeUndefined();
});

test("rebuilds a running Run from its started and progress events", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const manager = new RunManager(store);

  await manager.start(command);
  await store.append(runEvent("run.started", 0));
  await store.append(runEvent("run.progress", 1));

  await expect(manager.get(command.runId)).resolves.toMatchObject({
    id: command.runId,
    status: "running",
  });
});

test("rebuilds a terminal Run from its terminal event", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const manager = new RunManager(store);

  await manager.start(command);
  await store.append(runEvent("run.started", 0));
  await store.append(runEvent("run.completed", 1));

  await expect(manager.get(command.runId)).resolves.toMatchObject({
    id: command.runId,
    status: "completed",
    outcome: { status: "completed" },
  });
});

test("reconciles a restarted running Run once with a minimal failure payload", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const manager = new RunManager(store);

  await manager.start(command);
  await store.append(runEvent("run.started", 0));
  await store.append(runEvent("run.progress", 1));

  await manager.reconcile();
  await manager.reconcile();

  await expect(readAll(store.read(command.runId as unknown as CanonicalEvent["streamId"]))).resolves.toMatchObject([
    { type: "run.started", seq: 0 },
    { type: "run.progress", seq: 1 },
    {
      type: "run.failed",
      seq: 2,
      payload: { errorType: "process_restarted" },
    },
  ]);
  await expect(manager.get(command.runId)).resolves.toMatchObject({
    status: "failed",
    outcome: { status: "failed" },
  });
});

test("concurrent reconciliation seals every running Run once with injected clock and ids", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const first = command;
  const second = parseStartRun({
    ...command,
    commandId: "command-2",
    runId: "run-2",
  });
  let firstEventNumber = 0;
  let secondEventNumber = 0;
  const firstManager = new RunManager(store, {
    now: () => "2026-08-18T01:00:00.000Z",
    createEventId: () => `manager-one-event-${++firstEventNumber}` as CanonicalEvent["id"],
  });
  const secondManager = new RunManager(store, {
    now: () => "2026-08-18T01:00:00.000Z",
    createEventId: () => `manager-two-event-${++secondEventNumber}` as CanonicalEvent["id"],
  });

  await firstManager.start(first);
  await firstManager.start(second);
  await store.append(runEvent("run.started", 0));
  await store.append({
    ...runEvent("run.started", 0),
    id: "run-2-started",
    streamId: second.runId,
  } as unknown as CanonicalEvent);

  await expect(Promise.all([
    firstManager.reconcile(),
    secondManager.reconcile(),
  ])).resolves.toEqual([undefined, undefined]);

  for (const run of [first, second]) {
    const events = await readAll(store.read(run.runId as unknown as CanonicalEvent["streamId"]));
    expect(events.filter((event) => event.type === "run.failed")).toEqual([
      expect.objectContaining({
        seq: 1,
        timestamp: "2026-08-18T01:00:00.000Z",
        payload: { errorType: "process_restarted" },
      }),
    ]);
  }
});

test("ChannelSessionService claims a durable session before exposing its bound Run lifecycle", async () => {
  const root = new InMemoryEventStore();
  const session = await ChannelSessionService.open(root, parseChannelSession({
    id: "session-1",
    ...scope,
  }));

  await expect(session.start(command)).resolves.toMatchObject({
    id: command.runId,
    status: "queued",
  });
  await expect(session.get(command.runId)).resolves.toMatchObject({
    id: command.runId,
    status: "queued",
  });
  await expect(root.scope(scope).getChannelSession()).resolves.toEqual({
    id: "session-1",
    ...scope,
  });
});
