import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  projectNext,
  RunManager,
  SqliteEventStore,
} from "../src/index";
import {
  parseChannelSession,
  parseSchedule,
  parseStartRun,
  type CanonicalEvent,
  type ChannelScope,
  type ScheduleNotification,
  type ScheduleOccurrence,
} from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const scope = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
} as ChannelScope;

function command(runId: string, commandId = `command-${runId}`) {
  return parseStartRun({
    commandId,
    runId,
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
}

function event(runId: string, seq: number, type: string): CanonicalEvent {
  return {
    id: `${runId}-event-${seq}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: runId,
    seq,
    type,
    timestamp: "2026-08-18T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  } as CanonicalEvent;
}

async function readAll(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const item of events) {
    result.push(item);
  }
  return result;
}

function withDatabase(testBody: (path: string, stores: SqliteEventStore[]) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "anna-event-store-"));
  const stores: SqliteEventStore[] = [];
  return testBody(join(directory, "events.sqlite"), stores).finally(() => {
    for (const store of stores.reverse()) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });
}

test("persists events, commands, projection state, and a rebuilt Run across close and reopen", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const current = first.scope(scope);
    const run = command("run-1");
    const started = event(run.runId, 0, "run.started");
    const progress = event(run.runId, 1, "run.progress");

    await current.claimStart(run);
    await current.append(started);
    await current.append(progress);
    await current.commitProjection({
      projector: "run-view",
      streamId: started.streamId,
      eventId: started.id,
      eventSeq: started.seq,
      expectedVersion: 0,
      state: { status: "running" },
    });
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const restored = reopened.scope(scope);

    await expect(restored.getCommand(run.commandId)).resolves.toEqual(run);
    await expect(readAll(restored.read(run.runId as unknown as CanonicalEvent["streamId"]))).resolves.toEqual([
      started,
      progress,
    ]);
    await expect(restored.loadProjection("run-view", started.streamId)).resolves.toEqual({
      state: { status: "running" },
      version: 1,
      lastSeq: 0,
    });
    await expect(new RunManager(restored).get(run.runId)).resolves.toMatchObject({
      id: run.runId,
      status: "running",
    });
  });
});

test("reconciles only reopened running Runs and appends their failure once", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const current = first.scope(scope);
    const queued = command("run-queued");
    const running = command("run-running");
    const waiting = command("run-waiting");
    const terminal = command("run-terminal");

    await current.claimStart(queued);
    await current.claimStart(running);
    await current.claimStart(waiting);
    await current.claimStart(terminal);
    await current.append(event(running.runId, 0, "run.started"));
    await current.append(event(waiting.runId, 0, "run.awaiting_input"));
    await current.append(event(terminal.runId, 0, "run.completed"));
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const manager = new RunManager(reopened.scope(scope));

    await manager.reconcile();
    await manager.reconcile();

    await expect(readAll(reopened.scope(scope).read(running.runId as unknown as CanonicalEvent["streamId"]))).resolves.toMatchObject([
      { type: "run.started", seq: 0 },
      { type: "run.failed", seq: 1, payload: { errorType: "process_restarted" } },
    ]);
    await expect(readAll(reopened.scope(scope).read(queued.runId as unknown as CanonicalEvent["streamId"]))).resolves.toEqual([]);
    await expect(readAll(reopened.scope(scope).read(waiting.runId as unknown as CanonicalEvent["streamId"]))).resolves.toMatchObject([
      { type: "run.awaiting_input", seq: 0 },
    ]);
    await expect(readAll(reopened.scope(scope).read(terminal.runId as unknown as CanonicalEvent["streamId"]))).resolves.toMatchObject([
      { type: "run.completed", seq: 0 },
    ]);
  });
});

test("migrates an empty file to the current schema once and restores WAL on reopen", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);

    expect(first.diagnosticSchemaVersion()).toBe(5);
    expect(first.diagnosticJournalMode()).toBe("wal");
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);

    expect(reopened.diagnosticSchemaVersion()).toBe(5);
    expect(reopened.diagnosticJournalMode()).toBe("wal");
  });
});

test("adds recovery lease ownership when migrating schema v4", async () => {
  await withDatabase(async (path, stores) => {
    const previous = new DatabaseSync(path);
    previous.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations (version) VALUES (4);
      CREATE TABLE schedule_occurrence_recovery_leases (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, channel_id, occurrence_id)
      );
      INSERT INTO schedule_occurrence_recovery_leases (
        workspace_id, channel_id, occurrence_id, claimed_at
      ) VALUES ('workspace-1', 'channel-1', 'occurrence-1', '2099-01-01T00:00:00.000Z');
    `);
    previous.close();

    const migrated = new SqliteEventStore(path);
    stores.push(migrated);

    expect(migrated.diagnosticSchemaVersion()).toBe(5);
    const inspected = new DatabaseSync(path);
    try {
      expect(inspected.prepare(
        "SELECT name FROM pragma_table_info('schedule_occurrence_recovery_leases') WHERE name = 'owner_id'",
      ).get()).toEqual({ name: "owner_id" });
      expect(inspected.prepare(`
        SELECT owner_id, claimed_at < '2099-01-01T00:00:00.000Z' AS timestamp_reset
        FROM schedule_occurrence_recovery_leases
        WHERE occurrence_id = 'occurrence-1'
      `).get()).toEqual({ owner_id: "", timestamp_reset: 1 });
    } finally {
      inspected.close();
    }
  });
});

test("rejects a future schema version without applying v1 SQL", async () => {
  await withDatabase(async (path) => {
    const future = new DatabaseSync(path);
    future.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations (version) VALUES (6);
    `);
    future.close();

    expect(() => new SqliteEventStore(path)).toThrow("Unsupported schema version 6");

    const inspected = new DatabaseSync(path);
    try {
      expect(inspected.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      ).get()).toBeUndefined();
    } finally {
      inspected.close();
    }
  });
});

test("restores a durable ChannelSession after reopening its file", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const current = first.scope(scope);

    await current.claimChannelSession(parseChannelSession({ id: "session-1", ...scope }));
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    await expect(reopened.scope(scope).getChannelSession()).resolves.toEqual({
      id: "session-1",
      ...scope,
    });
  });
});

test("restores schedules, occurrence claims, and notifications after reopening its file", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const current = first.scope(scope);
    const schedule = parseSchedule({
      id: "schedule-reopen",
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      kind: "explicit",
      trigger: { kind: "explicit", label: "reopen" },
      dueAt: "2026-08-20T09:00:00.000Z",
      catchUpPolicy: "run_latest",
      status: "active",
      run: {
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        goal: "Restore the scheduled run.",
        source: { eventId: "source-event-schedule-reopen" },
        runProfile: { id: "profile-1", version: "1" },
        runProfileSnapshot: resolvedRunProfileFixture(),
        budget: { turns: 1 },
        permissionScope: "permission-1",
        stopCondition: "artifact_or_terminal",
        trigger: { kind: "explicit", label: "reopen" },
        notificationAudience: ["actor-1"],
      },
    });
    const occurrence = {
      id: "occurrence-reopen",
      scheduleId: schedule.id,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      dueAt: schedule.dueAt,
      runId: "scheduled-run-reopen",
      commandId: "scheduled-command-reopen",
      claimedAt: "2026-08-20T09:00:00.000Z",
    } as ScheduleOccurrence;
    const notification = {
      id: "notification-reopen",
      scheduleId: schedule.id,
      occurrenceId: occurrence.id,
      runId: occurrence.runId,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      trigger: schedule.trigger,
      audience: schedule.run.notificationAudience,
      createdAt: "2026-08-20T09:00:01.000Z",
    } as ScheduleNotification;

    await current.createSchedule(schedule);
    const registration = {
      kind: "connector_event" as const,
      connector: "fixture",
      eventType: "invoice.changed",
      registrationId: "registration-reopen",
    };
    await current.registerScheduleTrigger(registration);
    await expect(current.claimScheduleOccurrence(occurrence)).resolves.toEqual({
      claimed: true,
      occurrence,
    });
    await current.recordScheduleNotification(notification);
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const restored = reopened.scope(scope);
    await expect(restored.listSchedules()).resolves.toEqual([schedule]);
    await expect(restored.hasScheduleTriggerRegistration(registration)).resolves.toBe(true);
    await expect(restored.listScheduleOccurrences(schedule.id)).resolves.toEqual([occurrence]);
    await expect(restored.listScheduleNotifications(schedule.id)).resolves.toEqual([notification]);
    await expect(restored.claimScheduleOccurrence({
      ...occurrence,
      id: "occurrence-reopen-competing" as ScheduleOccurrence["id"],
      runId: "scheduled-run-reopen-competing" as ScheduleOccurrence["runId"],
      commandId: "scheduled-command-reopen-competing" as ScheduleOccurrence["commandId"],
    })).resolves.toMatchObject({ claimed: false, reason: "already_claimed", occurrence });
  });
});

test("rebuilds a projection and Run after a child crashes without closing SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anna-event-store-crash-"));
  const path = join(directory, "events.sqlite");
  const fixture = fileURLToPath(new URL("./fixtures/crash-writer.mjs", import.meta.url));

  try {
    const child = spawnSync(process.execPath, [fixture], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        ANNA_EVENT_STORE_CRASH_DATABASE: path,
      },
    });

    expect(child.status, child.stderr.toString()).toBe(73);

    const reopened = new SqliteEventStore(path);
    try {
      const store = reopened.scope({
        workspaceId: "workspace-crash",
        channelId: "channel-crash",
      } as ChannelScope);
      const streamId = "run-crash" as CanonicalEvent["streamId"];

      await expect(new RunManager(store).get(streamId as unknown as ReturnType<typeof command>["runId"])).resolves.toMatchObject({
        id: streamId,
        status: "running",
      });
      await expect(projectNext(store, "run-view", streamId, 0 as number, (state) => state + 1))
        .resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
      await expect(projectNext(store, "run-view", streamId, 0 as number, (state) => state + 1))
        .resolves.toEqual({ applied: true, state: 2, version: 2, lastSeq: 1 });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rolls back a projection reducer failure and commits the later retry", async () => {
  await withDatabase(async (path, stores) => {
    const root = new SqliteEventStore(path);
    stores.push(root);
    const store = root.scope(scope);
    const started = event("run-1", 0, "run.started");

    await store.append(started);
    await expect(
      projectNext(store, "run-view", started.streamId, 0, () => {
        throw new Error("reducer failed");
      }),
    ).rejects.toThrow("reducer failed");
    await expect(store.loadProjection("run-view", started.streamId)).resolves.toBeUndefined();
    await expect(
      projectNext(store, "run-view", started.streamId, 0 as number, (state) => state + 1),
    ).resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
  });
});

test("fences stale event sequences and stale projection versions across connections", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    const second = new SqliteEventStore(path);
    stores.push(first, second);
    const firstStore = first.scope(scope);
    const secondStore = second.scope(scope);
    const started = event("run-1", 0, "run.started");
    const progress = event("run-1", 1, "run.progress");

    await firstStore.append(started);
    await expect(secondStore.append({
      ...started,
      id: "run-1-event-conflict" as CanonicalEvent["id"],
    })).rejects.toMatchObject({
      name: "EventSequenceConflictError",
    });
    await firstStore.append(progress);
    await firstStore.commitProjection({
      projector: "run-view",
      streamId: started.streamId,
      eventId: started.id,
      eventSeq: started.seq,
      expectedVersion: 0,
      state: 1,
    });
    await expect(
      secondStore.commitProjection({
        projector: "run-view",
        streamId: progress.streamId,
        eventId: progress.id,
        eventSeq: progress.seq,
        expectedVersion: 0,
        state: 2,
      }),
    ).rejects.toMatchObject({ name: "ProjectionVersionConflictError" });
  });
});

test("claimStart atomically preserves the resolved RunProfile snapshot across configuration change and reopen", async () => {
  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const current = first.scope(scope);
    const runConfiguration = {
      runProfileSnapshot: structuredClone(resolvedRunProfileFixture({
        id: "release-review-run",
        version: "7",
        budget: { turns: 4, toolCalls: 2 },
      })) as unknown as {
        model: { name: string };
        skills: { content: string }[];
      },
    };
    const expectedSnapshot = structuredClone(runConfiguration.runProfileSnapshot);
    const run = parseStartRun({
      commandId: "command-run-profile-snapshot",
      runId: "run-profile-snapshot",
      goal: "Prepare the release brief.",
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      source: { eventId: "source-event-1" },
      runProfile: { id: "release-review-run", version: "7" },
      runProfileSnapshot: runConfiguration.runProfileSnapshot,
      budget: { turns: 4, toolCalls: 2 },
      permissionScope: "permission-release-review",
      stopCondition: "artifact_or_terminal",
    });

    await current.claimStart(run);
    runConfiguration.runProfileSnapshot.model.name = "current-config-model";
    runConfiguration.runProfileSnapshot.skills[0].content = "Use the current configuration.";
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const restored = reopened.scope(scope);
    const expectedCommand = {
      commandId: run.commandId,
      runId: run.runId,
      goal: run.goal,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      source: { eventId: "source-event-1" },
      runProfile: { id: "release-review-run", version: "7" },
      runProfileSnapshot: expectedSnapshot,
      budget: { turns: 4, toolCalls: 2 },
      permissionScope: "permission-release-review",
      stopCondition: "artifact_or_terminal",
    };

    await expect(restored.getRunCommand(run.runId)).resolves.toEqual(expectedCommand);
    await expect(new RunManager(restored).get(run.runId)).resolves.toEqual({
      id: run.runId,
      goal: run.goal,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      source: { eventId: "source-event-1" },
      runProfile: { id: "release-review-run", version: "7" },
      runProfileSnapshot: expectedSnapshot,
      budget: { turns: 4, toolCalls: 2 },
      permissionScope: "permission-release-review",
      stopCondition: "artifact_or_terminal",
      status: "queued",
    });
  });
});
