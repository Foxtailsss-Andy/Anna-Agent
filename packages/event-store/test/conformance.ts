import { describe, expect, test } from "vitest";

import type {
  CanonicalEvent,
  ChannelScope,
  EventStore,
  EventId,
  ScheduleOccurrence,
  ScheduleNotification,
  ScheduleRecord,
  RunId,
  StreamId,
} from "@anna/harness-v2";
import { parseChannelSession, parseSchedule, parseStartRun } from "@anna/harness-v2";
import { projectNext } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

export type EventStoreFactory = () => EventStore;

export const scope = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
} as ChannelScope;

const otherScope = {
  workspaceId: "workspace-1",
  channelId: "channel-2",
} as ChannelScope;

const foreignEvent = {
  id: "event-1",
  workspaceId: "workspace-2",
  channelId: "channel-1",
  streamId: "run-1",
  seq: 0,
  type: "run.started",
  timestamp: "2026-08-18T00:00:00.000Z",
  schemaVersion: 1,
  payload: {},
} as CanonicalEvent;

function event(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: "event-1",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: "run-1",
    seq: 0,
    type: "run.started",
    timestamp: "2026-08-18T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
    ...overrides,
  } as CanonicalEvent;
}

function startRun() {
  return parseStartRun({
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
}

function scheduleRecord(): ScheduleRecord {
  const trigger = { kind: "explicit" as const, label: "scheduled follow-up" };
  return parseSchedule({
    id: "schedule-1",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    kind: trigger.kind,
    trigger,
    dueAt: "2026-08-20T09:00:00.000Z",
    catchUpPolicy: "run_latest",
    status: "active",
    recurrence: { kind: "fixed_interval", intervalMs: 60_000 },
    run: {
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      goal: "Prepare the scheduled follow-up.",
      source: { eventId: "source-event-1" },
      runProfile: { id: "profile-1", version: "1" },
      runProfileSnapshot: resolvedRunProfileFixture(),
      budget: { turns: 1 },
      permissionScope: "permission-1",
      stopCondition: "artifact_or_terminal",
      trigger,
      notificationAudience: ["actor-1"],
    },
  });
}

async function readAll(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const item of events) {
    result.push(item);
  }
  return result;
}

if (false) {
  const rootStore = null as unknown as EventStore;

  // @ts-expect-error Root EventStore must not expose an unscoped read.
  rootStore.read;
  // @ts-expect-error Root EventStore must not accept unscoped events.
  rootStore.append;
}

export function eventStoreConformance(createStore: EventStoreFactory): void {
  describe("EventStore scope boundary", () => {
    test("root store only creates a channel-bound store", () => {
      const store = createStore();

      expect("read" in store).toBe(false);
      expect("append" in store).toBe(false);
      expect(store.scope(scope)).toBeDefined();
    });

    test("bound store rejects an event from another scope", async () => {
      const store = createStore().scope(scope);

      await expect(store.append(foreignEvent)).rejects.toMatchObject({
        name: "EventScopeMismatchError",
      });
    });

    test("clones and validates the scope when it binds a channel", async () => {
      const root = createStore();
      const mutableScope = {
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
      } as ChannelScope;
      const store = root.scope(mutableScope);
      mutableScope.channelId = "caller-mutated" as ChannelScope["channelId"];

      await expect(store.append(event())).resolves.toBeUndefined();
      await expect(readAll(store.read(event().streamId))).resolves.toEqual([event()]);
    });
  });

  describe("EventStore event stream", () => {
    test("lists command metadata in the scoped channel", async () => {
      const store = createStore().scope(scope);
      const first = startRun();
      const second = parseStartRun({
        ...first,
        commandId: "command-2",
        runId: "run-2",
        goal: "Prepare the second release brief.",
      });
      await store.claimStart(first);
      await store.claimStart(second);

      await expect(store.listRunCommands()).resolves.toEqual([first, second]);
    });

    test("lists the Run and scoped Tool streams belonging to one Run", async () => {
      const store = createStore().scope(scope);
      await store.append(event({
        id: "run-stream-event" as EventId,
        streamId: "run-1" as StreamId,
        seq: 0,
      }));
      await store.append(event({
        id: "tool-stream-event" as EventId,
        streamId: "tool:run-1:call-1" as StreamId,
        seq: 0,
        type: "tool.requested",
        payload: { runId: "run-1", toolCallId: "call-1" },
      }));

      await expect(store.listRunStreamIds("run-1" as RunId)).resolves.toEqual([
        "run-1",
        "tool:run-1:call-1",
      ]);
    });

    test("reads a live event before its Run reaches a terminal state", async () => {
      const store = createStore().scope(scope);
      const started = event();

      await store.append(started);

      await expect(readAll(store.read(started.streamId))).resolves.toEqual([
        started,
      ]);
    });

    test("reads only events after a cursor from a contiguous stream", async () => {
      const store = createStore().scope(scope);
      const started = event();
      const progress = {
        ...started,
        id: "event-2",
        seq: 1,
        type: "run.progress",
      } as CanonicalEvent;

      await store.append(started);
      await store.append(progress);

      await expect(readAll(store.read(started.streamId, 0))).resolves.toEqual([
        progress,
      ]);
    });

    test("parses and clones appended and returned events", async () => {
      const store = createStore().scope(scope);
      const started = event({ payload: { phase: "original" } });

      await store.append(started);
      (started.payload as { phase: string }).phase = "caller-mutated";

      const [firstRead] = await readAll(store.read(started.streamId));
      expect(firstRead.payload).toEqual({ phase: "original" });
      (firstRead.payload as { phase: string }).phase = "reader-mutated";

      await expect(readAll(store.read(started.streamId))).resolves.toEqual([
        event({ payload: { phase: "original" } }),
      ]);
    });

    test("rejects an append whose sequence is not the stream version", async () => {
      const store = createStore().scope(scope);
      const started = event();

      await store.append(started);

      await expect(
        store.append({
          ...started,
          id: "event-2",
          seq: 3,
          type: "run.progress",
        } as CanonicalEvent),
      ).rejects.toMatchObject({ name: "EventSequenceConflictError" });
    });

    test("rejects a second terminal event for the same Run stream", async () => {
      const store = createStore().scope(scope);
      const started = event();

      await store.append(started);
      await store.append({
        ...started,
        id: "event-2",
        seq: 1,
        type: "run.completed",
      } as CanonicalEvent);

      await expect(
        store.append({
          ...started,
          id: "event-3",
          seq: 2,
          type: "run.failed",
        } as CanonicalEvent),
      ).rejects.toMatchObject({ name: "TerminalEventConflictError" });
    });

    test("seals a terminal stream against every new event while accepting its exact retry", async () => {
      const store = createStore().scope(scope);
      const started = event();
      const terminal = {
        ...started,
        id: "event-2",
        seq: 1,
        type: "run.completed",
      } as CanonicalEvent;

      await store.append(started);
      await store.append(terminal);
      await expect(store.append({ ...terminal })).resolves.toBeUndefined();
      await expect(store.append({
        ...terminal,
        id: "event-3",
        seq: 2,
        type: "run.progress",
      } as CanonicalEvent)).rejects.toMatchObject({
        name: "TerminalEventConflictError",
      });
    });

    test("accepts an identical event retry without advancing the stream", async () => {
      const store = createStore().scope(scope);
      const started = event();

      await store.append(started);
      await store.append({ ...started });

      await expect(readAll(store.read(started.streamId))).resolves.toEqual([
        started,
      ]);
    });

    test("rejects a conflicting retry with an existing event id", async () => {
      const store = createStore().scope(scope);
      const started = event();

      await store.append(started);

      await expect(
        store.append({
          ...started,
          payload: { phase: "different" },
        } as CanonicalEvent),
      ).rejects.toMatchObject({ name: "EventConflictError" });
    });

    test("rejects an event id already used by another stream in the Channel", async () => {
      const store = createStore().scope(scope);
      const started = event();

      await store.append(started);

      await expect(
        store.append({
          ...started,
          streamId: "run-2",
        } as CanonicalEvent),
      ).rejects.toMatchObject({ name: "EventConflictError" });
    });
  });

  describe("EventStore schedule occurrence fencing", () => {
    test("claims one Run per occurrence and links its notification", async () => {
      const store = createStore().scope(scope);
      const schedule = scheduleRecord();
      const occurrence = {
        id: "occurrence-1",
        scheduleId: schedule.id,
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        dueAt: schedule.dueAt,
        runId: "scheduled-run-1",
        commandId: "scheduled-command-1",
        claimedAt: "2026-08-20T09:00:00.000Z",
      } as ScheduleOccurrence;

      await expect(store.createSchedule(schedule)).resolves.toEqual(schedule);
      await expect(store.listSchedules()).resolves.toEqual([schedule]);
      await expect(store.claimScheduleOccurrence(occurrence)).resolves.toEqual({
        claimed: true,
        occurrence,
      });
      await expect(store.claimScheduleOccurrence({
        ...occurrence,
        id: "occurrence-competing" as ScheduleOccurrence["id"],
        runId: "scheduled-run-competing" as ScheduleOccurrence["runId"],
        commandId: "scheduled-command-competing" as ScheduleOccurrence["commandId"],
      })).resolves.toEqual({
        claimed: false,
        reason: "already_claimed",
        occurrence,
      });

      const notification = {
        id: "notification-1",
        scheduleId: schedule.id,
        occurrenceId: occurrence.id,
        runId: occurrence.runId,
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        trigger: schedule.trigger,
        audience: schedule.run.notificationAudience,
        createdAt: "2026-08-20T09:00:01.000Z",
      } as ScheduleNotification;
      await expect(store.recordScheduleNotification(notification)).resolves.toEqual(notification);
      await expect(store.listScheduleOccurrences(schedule.id)).resolves.toEqual([occurrence]);
      await expect(store.listScheduleNotifications(schedule.id)).resolves.toEqual([notification]);

      await expect(store.cancelSchedule(schedule.id, "2026-08-20T09:01:00.000Z"))
        .resolves.toMatchObject({ status: "cancelled" });
      await expect(store.claimScheduleOccurrence({
        ...occurrence,
        id: "occurrence-after-cancel" as ScheduleOccurrence["id"],
        dueAt: "2026-08-20T09:01:00.000Z",
      })).resolves.toEqual({ claimed: false, reason: "schedule_inactive" });
    });
  });

  describe("EventStore commands", () => {
    test("claims the same StartRun command as one Run", async () => {
      const store = createStore().scope(scope);
      const command = startRun();

      await expect(store.claimStart(command)).resolves.toEqual(command);
      await expect(store.claimStart(command)).resolves.toEqual(command);
      await expect(store.getCommand(command.commandId)).resolves.toEqual(command);
    });

    test("looks up a claimed command separately by command and Run id", async () => {
      const store = createStore().scope(scope);
      const command = startRun();

      await store.claimStart(command);

      await expect(store.getCommand(command.commandId)).resolves.toEqual(command);
      await expect(
        (store as unknown as {
          getRunCommand(runId: typeof command.runId): Promise<typeof command | undefined>;
        }).getRunCommand(command.runId),
      ).resolves.toEqual(command);
    });

    test("parses and clones claimed and returned commands", async () => {
      const store = createStore().scope(scope);
      const command = startRun();

      await store.claimStart(command);
      (command.budget as { turns: number }).turns = 2;

      const stored = await store.getCommand(command.commandId);
      expect(stored?.budget).toEqual({ turns: 1 });
      (stored?.budget as { turns: number }).turns = 3;

      await expect(store.getRunCommand(command.runId)).resolves.toMatchObject({
        budget: { turns: 1 },
      });
    });

    test("rejects execution policy drift at the public claimStart boundary", async () => {
      const store = createStore().scope(scope);
      const command = startRun();

      await expect(store.claimStart({
        ...command,
        budget: { turns: 2 },
      })).rejects.toThrow("StartRun.budget must match RunProfileSnapshot.budget");
      await expect(store.claimStart({
        ...command,
        stopCondition: "different-stop-condition",
      })).rejects.toThrow(
        "StartRun.stopCondition must match RunProfileSnapshot.terminalRules.stopCondition",
      );
    });

    test("rejects a duplicate command id whose content changed", async () => {
      const store = createStore().scope(scope);
      const command = startRun();

      await store.claimStart(command);

      await expect(
        store.claimStart(parseStartRun({ ...command, goal: "Changed goal." })),
      ).rejects.toMatchObject({ name: "CommandConflictError" });
    });

    test("rejects a second command id that targets an already claimed Run", async () => {
      const store = createStore().scope(scope);
      const command = startRun();

      await store.claimStart(command);

      await expect(
        store.claimStart(parseStartRun({ ...command, commandId: "command-2" })),
      ).rejects.toMatchObject({ name: "CommandConflictError" });
    });
  });

  describe("EventStore channel isolation", () => {
    test("does not expose another channel's events or commands", async () => {
      const root = createStore();
      const current = root.scope(scope);
      const other = root.scope(otherScope);
      const started = event();
      const command = startRun();

      await current.append(started);
      await current.claimStart(command);

      await expect(readAll(other.read(started.streamId))).resolves.toEqual([]);
      await expect(other.getCommand(command.commandId)).resolves.toBeUndefined();
    });

    test("keeps ids containing separators in their distinct channel scopes", async () => {
      const root = createStore();
      const firstScope = {
        workspaceId: "workspace:one",
        channelId: "channel",
      } as ChannelScope;
      const secondScope = {
        workspaceId: "workspace",
        channelId: "one:channel",
      } as ChannelScope;
      const first = root.scope(firstScope);
      const second = root.scope(secondScope);
      const firstEvent = event({
        workspaceId: firstScope.workspaceId,
        channelId: firstScope.channelId,
      });

      await first.append(firstEvent);

      await expect(readAll(second.read(firstEvent.streamId))).resolves.toEqual([]);
    });
  });

  describe("EventStore projections", () => {
    test("keeps projector progress separate for streams that both start at sequence zero", async () => {
      const store = createStore().scope(scope);
      const streamA = event({
        streamId: "run-a" as StreamId,
        id: "event-a" as EventId,
      });
      const streamB = event({
        streamId: "run-b" as StreamId,
        id: "event-b" as EventId,
      });

      await store.append(streamA);
      await store.append(streamB);

      await expect(projectNext(store, "run-view", streamA.streamId, 0 as number, (state) => state + 1))
        .resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
      await expect(projectNext(store, "run-view", streamB.streamId, 0 as number, (state) => state + 1))
        .resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
      await expect(store.loadProjection("run-view", streamA.streamId)).resolves.toEqual({
        state: 1,
        version: 1,
        lastSeq: 0,
      });
      await expect(store.loadProjection("run-view", streamB.streamId)).resolves.toEqual({
        state: 1,
        version: 1,
        lastSeq: 0,
      });
    });

    test("does not acknowledge a projection source from another stream", async () => {
      const store = createStore().scope(scope);
      const streamA = event({
        streamId: "run-a" as StreamId,
        id: "event-a" as EventId,
      });
      const streamB = event({
        streamId: "run-b" as StreamId,
        id: "event-b" as EventId,
      });

      await store.append(streamA);
      await store.append(streamB);

      await expect(store.commitProjection({
        projector: "run-view",
        streamId: streamA.streamId,
        eventId: streamB.id,
        eventSeq: streamB.seq,
        expectedVersion: 0,
        state: 1,
      })).rejects.toMatchObject({ name: "ProjectionSourceEventNotFoundError" });
    });

    test("retries a failed reducer without a receipt and makes receipt retries idempotent", async () => {
      const store = createStore().scope(scope);
      const started = event();
      await store.append(started);

      await expect(projectNext(store, "run-view", started.streamId, 0, () => {
        throw new Error("reducer failed");
      })).rejects.toThrow("reducer failed");
      await expect(store.loadProjection("run-view", started.streamId)).resolves.toBeUndefined();

      await expect(projectNext(store, "run-view", started.streamId, 0 as number, (state) => state + 1))
        .resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
      await expect(store.commitProjection({
        projector: "run-view",
        streamId: started.streamId,
        eventId: started.id,
        eventSeq: started.seq,
        expectedVersion: 0,
        state: 1,
      })).resolves.toEqual({ applied: false, state: 1, version: 1, lastSeq: 0 });
    });
  });

  describe("EventStore durable ChannelSession and active Runs", () => {
    test("claims one durable ChannelSession per scope and clones it", async () => {
      const store = createStore().scope(scope);
      const session = parseChannelSession({ id: "session-1", ...scope });

      await expect(store.claimChannelSession(session)).resolves.toEqual(session);
      await expect(store.claimChannelSession(session)).resolves.toEqual(session);
      await expect(store.claimChannelSession(parseChannelSession({
        id: "session-2",
        ...scope,
      }))).rejects.toMatchObject({ name: "ChannelSessionConflictError" });
      await expect(store.getChannelSession()).resolves.toEqual(session);
    });

    test("returns unsealed Run ids and removes a terminal Run", async () => {
      const store = createStore().scope(scope);
      const command = startRun();
      const started = event({
        streamId: command.runId as unknown as StreamId,
        id: "run-event" as EventId,
      });
      const terminal = event({
        streamId: command.runId as unknown as StreamId,
        id: "run-terminal" as EventId,
        seq: 1,
        type: "run.completed",
      });

      await store.claimStart(command);
      await expect(store.activeRunIds()).resolves.toEqual([command.runId]);
      await store.append(started);
      await expect(store.activeRunIds()).resolves.toEqual([command.runId]);
      await store.append(terminal);
      await expect(store.activeRunIds()).resolves.toEqual([]);
    });
  });
}
