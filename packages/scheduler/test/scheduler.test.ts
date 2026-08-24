import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryEventStore, SqliteEventStore } from "@anna/event-store";
import {
  parseSchedule,
  resolveRunProfile,
  type ChannelScope,
  type RunProfileId,
  type ScheduleRun,
  type ScheduleRecord,
  type ScheduleTrigger,
  type SkillCatalogEntry,
  type WorkerProfile,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { expect, test, vi } from "vitest";

import {
  ManualClock,
  SchedulerService,
  schedulerStreamId,
} from "../src/index";

const scope = {
  workspaceId: "workspace-scheduler",
  channelId: "channel-scheduler",
} as ChannelScope;

const catalog: SkillCatalogEntry[] = [{
  id: "scheduler-skill",
  name: "Scheduler skill",
  version: "1.0.0",
  hash: "sha256:scheduler-skill",
  provenance: { source: "test", uri: "fixture://scheduler-skill" },
  content: "Prepare the registered follow-up only.",
  allowedTools: ["read_workspace"],
  forbiddenTools: ["shell"],
}];
const workerProfile: WorkerProfile = {
  id: "scheduler-worker" as WorkerProfileId,
  version: "1.0.0",
  instructions: "Use only the registered schedule input.",
  allowedSkillIds: ["scheduler-skill"],
  allowedTools: ["read_workspace"],
  modelPolicy: { allowedModels: [{ provider: "test", name: "fixture-model", reasoning: "low" }] },
  budgetDefaults: { turns: 1 },
  artifactContract: { kind: "schedule_artifact", requiredFor: ["completed"], verification: "tests" },
};
const runProfileSnapshot = resolveRunProfile({
  catalog,
  workerProfile,
  channelPolicy: {
    toolPolicy: { allowedTools: ["read_workspace"] },
    allowedSkillIds: ["scheduler-skill"],
    allowedModels: workerProfile.modelPolicy.allowedModels,
    budgetLimits: { turns: 1 },
    memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
  },
  runProfile: {
    id: "profile-1" as RunProfileId,
    version: "1",
    model: workerProfile.modelPolicy.allowedModels[0]!,
    skillIds: ["scheduler-skill"],
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
    toolPolicy: { allowedTools: ["read_workspace"] },
    budget: { turns: 1 },
    memoryPolicy: { read: "none", write: "disabled" },
    evalPolicy: { contract: "required", quality: "disabled" },
    artifactContract: workerProfile.artifactContract,
    terminalRules: { allowedOutcomes: ["completed", "failed"], stopCondition: "artifact_or_terminal" },
  },
});

const schedulerPolicy = {
  permissionScopes: ["permission-1" as never],
  allowedTools: ["read_workspace"],
};

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const trigger = overrides.trigger ?? { kind: "explicit", label: "scheduled follow-up" };
  return parseSchedule({
    id: "schedule-1",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    kind: trigger.kind,
    trigger,
    dueAt: "2026-08-20T09:00:00.000Z",
    catchUpPolicy: "run_latest",
    status: "active",
    run: {
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      goal: "Prepare the follow-up brief.",
      source: { eventId: "source-event-1" },
      runProfile: { id: "profile-1", version: "1" },
      runProfileSnapshot,
      budget: { turns: 1 },
      permissionScope: "permission-1",
      stopCondition: "artifact_or_terminal",
      trigger,
      notificationAudience: ["actor-1"],
    },
    ...overrides,
  });
}

test("ManualClock advances deterministically without wall-clock sleeps", () => {
  const clock = new ManualClock("2026-08-20T08:00:00.000Z");

  expect(clock.now()).toBe("2026-08-20T08:00:00.000Z");
  expect(clock.advanceBy(60 * 60 * 1000)).toBe("2026-08-20T09:00:00.000Z");
  expect(clock.set("2026-08-20T10:30:00.000Z")).toBe("2026-08-20T10:30:00.000Z");
});

test("exposes the local-runtime and explicit-recovery boundary", () => {
  const scheduler = new SchedulerService(new InMemoryEventStore().scope(scope), {
    createRun: async () => undefined,
    policy: schedulerPolicy,
  });

  expect(scheduler.runtimeStatus()).toEqual({
    executionMode: "local",
    runsWhileAppClosed: false,
    recoveryMode: "explicit",
  });
});

test("persists a scoped schedule record in the scheduler stream and rebuilds it", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const scheduler = new SchedulerService(store, {
    now: () => "2026-08-20T08:00:00.000Z",
    createRun: async () => { throw new Error("not due"); },
    policy: schedulerPolicy,
  });

  await scheduler.schedule(schedule());

  await expect(scheduler.list()).resolves.toEqual([schedule()]);
  const events = [];
  for await (const event of store.read(schedulerStreamId)) {
    events.push(event);
  }
  expect(events).toMatchObject([{
    streamId: schedulerStreamId,
    seq: 0,
    type: "schedule.created",
  }]);
});

test("retries fixed lifecycle IDs idempotently across clock changes", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const clock = new ManualClock("2026-08-20T08:00:00.000Z");
  const scheduler = new SchedulerService(store, {
    now: () => clock.now(),
    createRun: async () => undefined,
    policy: schedulerPolicy,
  });
  const record = schedule({ id: "schedule-idempotent" as never });

  await scheduler.schedule(record);
  clock.advanceBy(1_000);
  await scheduler.schedule(record);
  await scheduler.cancel(record.id);
  clock.advanceBy(1_000);
  await scheduler.cancel(record.id);

  const events = [];
  for await (const event of store.read(schedulerStreamId)) events.push(event);
  expect(events.map((event) => event.type)).toEqual([
    "schedule.created",
    "schedule.cancelled",
  ]);
});

test("registers SLA, waiting-node, connector and monitor triggers as explicit schedule kinds", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const scheduler = new SchedulerService(store, {
    createRun: async () => { throw new Error("not due"); },
    policy: schedulerPolicy,
  });

  const triggers: ScheduleTrigger[] = [
    { kind: "unresolved_thread_sla", threadId: "thread-1", deadlineAt: "2026-08-20T09:00:00.000Z" },
    { kind: "waiting_node_deadline", nodeId: "node-1", deadlineAt: "2026-08-20T09:00:00.000Z" },
    { kind: "connector_event", connector: "fixture", eventType: "invoice.changed", registrationId: "registration-1" },
    { kind: "monitor", monitorId: "monitor-1", label: "registered monitor" },
  ];
  for (const [index, trigger] of triggers.entries()) {
    if (trigger.kind === "connector_event" || trigger.kind === "monitor") {
      await store.registerScheduleTrigger(trigger);
    }
    await scheduler.schedule(schedule({ id: `schedule-${index + 1}` as never, kind: trigger.kind, trigger }));
  }

  await expect(scheduler.list()).resolves.toHaveLength(4);
});

test("rejects connector and monitor schedules until their registrations are durable", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const scheduler = new SchedulerService(store, {
    createRun: async () => undefined,
    policy: schedulerPolicy,
  });
  const trigger: ScheduleTrigger = {
    kind: "connector_event",
    connector: "fixture",
    eventType: "invoice.changed",
    registrationId: "registration-missing",
  };

  await expect(scheduler.schedule(schedule({ trigger, kind: trigger.kind })))
    .rejects.toThrow("not registered");
  await store.registerScheduleTrigger(trigger);
  await expect(scheduler.schedule(schedule({ trigger, kind: trigger.kind }))).resolves.toMatchObject({
    trigger,
  });
});

test("claims one due occurrence across concurrent ticks and links its proactive notification", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const clock = new ManualClock("2026-08-20T08:59:59.000Z");
  const runs: ScheduleRun[] = [];
  const scheduler = new SchedulerService(store, {
    now: () => clock.now(),
    createRun: async (run) => { runs.push(run); },
    policy: schedulerPolicy,
  });
  const record = schedule();
  await scheduler.schedule(record);

  await scheduler.tick();
  expect(runs).toHaveLength(0);

  clock.advanceBy(1_000);
  await Promise.all([scheduler.tick(), scheduler.tick()]);

  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    trigger: record.trigger,
    budget: record.run.budget,
    permissionScope: record.run.permissionScope,
    notificationAudience: record.run.notificationAudience,
  });
  const occurrences = await store.listScheduleOccurrences(record.id);
  const notifications = await store.listScheduleNotifications(record.id);
  expect(occurrences).toHaveLength(1);
  expect(notifications).toEqual([expect.objectContaining({
    scheduleId: record.id,
    occurrenceId: occurrences[0]!.id,
    runId: occurrences[0]!.runId,
    trigger: record.trigger,
    audience: record.run.notificationAudience,
  })]);
});

test("does not replay an already-claimed occurrence across scheduler instances", async () => {
  const store = new InMemoryEventStore();
  const clock = new ManualClock("2026-08-20T09:00:00.000Z");
  const runs: ScheduleRun[] = [];
  const options = {
    now: () => clock.now(),
    createRun: async (run: ScheduleRun) => { runs.push(run); },
    policy: schedulerPolicy,
  };
  const first = new SchedulerService(store.scope(scope), options);
  const second = new SchedulerService(store.scope(scope), options);
  await first.schedule(schedule({ id: "schedule-cross-instance" as never }));

  await Promise.all([first.tick(), second.tick()]);

  expect(runs).toHaveLength(1);
});

test("serializes concurrent recovery of one occurrence with a durable lease", async () => {
  const store = new InMemoryEventStore();
  const clock = new ManualClock("2026-08-20T09:00:00.000Z");
  const runs: ScheduleRun[] = [];
  const options = {
    now: () => clock.now(),
    createRun: async (run: ScheduleRun) => { runs.push(run); },
    policy: schedulerPolicy,
  };
  const first = new SchedulerService(store.scope(scope), options);
  const second = new SchedulerService(store.scope(scope), options);
  await first.schedule(schedule({ id: "schedule-recovery-cross-instance" as never }));

  await Promise.all([first.recover(), second.recover()]);

  expect(runs).toHaveLength(1);
});

test("serializes a tick against recovery before createRun starts", async () => {
  const store = new InMemoryEventStore();
  let releaseRun: (() => void) | undefined;
  let markRunStarted: (() => void) | undefined;
  let firstTick: Promise<void> | undefined;
  try {
    const runs: ScheduleRun[] = [];
    const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
    const runReleased = new Promise<void>((resolve) => { releaseRun = resolve; });
    const options = {
      now: () => "2026-08-20T09:00:00.000Z",
      createRun: async (run: ScheduleRun) => {
        runs.push(run);
        markRunStarted?.();
        await runReleased;
      },
      policy: schedulerPolicy,
    };
    const first = new SchedulerService(store.scope(scope), options);
    const second = new SchedulerService(store.scope(scope), options);
    await first.schedule(schedule({ id: "schedule-tick-recovery" as never }));

    firstTick = first.tick();
    await runStarted;
    await second.recover();

    expect(runs).toHaveLength(1);
    releaseRun?.();
    await firstTick;
  } finally {
    releaseRun?.();
    await firstTick?.catch(() => undefined);
  }
});

test("does not immediately retry a failed recovery under the same owner", async () => {
  const store = new InMemoryEventStore();
  let attempts = 0;
  const scheduler = new SchedulerService(store.scope(scope), {
    now: () => "2026-08-20T09:00:00.000Z",
    createRun: async () => {
      attempts += 1;
      throw new Error("createRun failed");
    },
    policy: schedulerPolicy,
  });
  await scheduler.schedule(schedule({ id: "schedule-recovery-retry" as never }));

  await expect(scheduler.recover()).rejects.toThrow("createRun failed");
  await scheduler.recover();

  expect(attempts).toBe(1);
});

test("uses store time for a SQLite recovery lease despite scheduler clock skew", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anna-scheduler-renewal-"));
  const databasePath = join(directory, "events.sqlite");
  const firstRoot = new SqliteEventStore(databasePath);
  const secondRoot = new SqliteEventStore(databasePath);
  let releaseRun: (() => void) | undefined;
  let markRunStarted: (() => void) | undefined;
  let firstRecovery: Promise<void> | undefined;
  try {
    const clock = new ManualClock("2026-08-20T09:00:00.000Z");
    const runs: ScheduleRun[] = [];
    const runReleased = new Promise<void>((resolve) => { releaseRun = resolve; });
    const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
    const options = {
      now: () => clock.now(),
      createRun: async (run: ScheduleRun) => {
        runs.push(run);
        markRunStarted?.();
        await runReleased;
      },
      policy: schedulerPolicy,
    };
    const first = new SchedulerService(firstRoot.scope(scope), options);
    const second = new SchedulerService(secondRoot.scope(scope), options);
    await first.schedule(schedule({ id: "schedule-recovery-renewal" as never }));

    firstRecovery = first.recover();
    await runStarted;
    clock.advanceBy(60_000);
    await second.recover();

    expect(runs).toHaveLength(1);
    releaseRun?.();
    await firstRecovery;
  } finally {
    releaseRun?.();
    await firstRecovery?.catch(() => undefined);
    firstRoot.close();
    secondRoot.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("renews an in-memory recovery lease while createRun is still executing", async () => {
  vi.useFakeTimers({ now: new Date("2026-08-20T09:00:00.000Z") });
  let releaseRun: (() => void) | undefined;
  let markRunStarted: (() => void) | undefined;
  let firstRecovery: Promise<void> | undefined;
  try {
    const store = new InMemoryEventStore();
    const runs: ScheduleRun[] = [];
    const runReleased = new Promise<void>((resolve) => { releaseRun = resolve; });
    const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
    const options = {
      createRun: async (run: ScheduleRun) => {
        runs.push(run);
        markRunStarted?.();
        await runReleased;
      },
      policy: schedulerPolicy,
    };
    const first = new SchedulerService(store.scope(scope), options);
    const second = new SchedulerService(store.scope(scope), options);
    await first.schedule(schedule({ id: "schedule-recovery-renewal" as never }));

    firstRecovery = first.recover();
    await runStarted;
    await vi.advanceTimersByTimeAsync(60_000);
    await second.recover();

    expect(runs).toHaveLength(1);
    releaseRun?.();
    await firstRecovery;
  } finally {
    releaseRun?.();
    await firstRecovery?.catch(() => undefined);
    vi.useRealTimers();
  }
});

test("does not replay an occurrence after its execution lease is lost", async () => {
  vi.useFakeTimers({ now: new Date("2026-08-20T09:00:00.000Z") });
  let releaseRun: (() => void) | undefined;
  let markRunStarted: (() => void) | undefined;
  let firstRecovery: Promise<void> | undefined;
  try {
    const root = new InMemoryEventStore();
    const baseStore = root.scope(scope);
    const store = Object.create(baseStore) as typeof baseStore;
    store.renewScheduleOccurrenceRecovery = async () => false;
    const runs: ScheduleRun[] = [];
    const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
    const runReleased = new Promise<void>((resolve) => { releaseRun = resolve; });
    const options = {
      createRun: async (run: ScheduleRun) => {
        runs.push(run);
        markRunStarted?.();
        await runReleased;
      },
      policy: schedulerPolicy,
    };
    const first = new SchedulerService(store, options);
    const second = new SchedulerService(root.scope(scope), options);
    await first.schedule(schedule({ id: "schedule-lost-lease" as never }));

    firstRecovery = first.recover();
    await runStarted;
    await vi.advanceTimersByTimeAsync(15_000);
    releaseRun?.();
    await expect(firstRecovery).rejects.toThrow("lease lost");
    await second.recover();

    expect(runs).toHaveLength(1);
  } finally {
    releaseRun?.();
    await firstRecovery?.catch(() => undefined);
    vi.useRealTimers();
  }
});

test("recover applies skip and run_latest explicitly", async () => {
  const clock = new ManualClock("2026-08-20T10:00:00.000Z");
  const skippedStore = new InMemoryEventStore().scope(scope);
  const skippedRuns: ScheduleRun[] = [];
  const skippedScheduler = new SchedulerService(skippedStore, {
    now: () => clock.now(),
    createRun: async (run) => { skippedRuns.push(run); },
    policy: schedulerPolicy,
  });
  const skipped = schedule({
    id: "schedule-skip" as never,
    dueAt: "2026-08-20T09:00:00.000Z",
    catchUpPolicy: "skip",
  });
  await skippedScheduler.schedule(skipped);
  await skippedScheduler.recover();
  await skippedScheduler.tick();
  await skippedScheduler.recover();
  expect(skippedRuns).toHaveLength(0);
  const skippedEvents = [];
  for await (const event of skippedStore.read(schedulerStreamId)) skippedEvents.push(event);
  expect(skippedEvents.filter((event) => event.type === "schedule.occurrence.skipped")).toHaveLength(1);

  const latestStore = new InMemoryEventStore().scope(scope);
  const latestRuns: ScheduleRun[] = [];
  const latestScheduler = new SchedulerService(latestStore, {
    now: () => clock.now(),
    createRun: async (run) => { latestRuns.push(run); },
    policy: schedulerPolicy,
  });
  const latest = schedule({
    id: "schedule-latest" as never,
    dueAt: "2026-08-20T09:00:00.000Z",
    catchUpPolicy: "run_latest",
    recurrence: { kind: "fixed_interval", intervalMs: 30 * 60 * 1000 },
  });
  await latestScheduler.schedule(latest);
  await latestScheduler.recover();
  expect(latestRuns).toHaveLength(1);
  expect(latestRuns[0]!.runId).toContain("2026-08-20T10:00:00.000Z");
});

test("cancelled schedules do not trigger after cancellation", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const clock = new ManualClock("2026-08-20T08:00:00.000Z");
  const runs: ScheduleRun[] = [];
  const scheduler = new SchedulerService(store, {
    now: () => clock.now(),
    createRun: async (run) => { runs.push(run); },
    policy: schedulerPolicy,
  });
  const record = schedule({ id: "schedule-cancelled" as never });
  await scheduler.schedule(record);
  await scheduler.cancel(record.id);
  clock.advanceBy(60 * 60 * 1000);
  await scheduler.tick();
  expect(runs).toHaveLength(0);
  await expect(store.listScheduleOccurrences(record.id)).resolves.toEqual([]);
});

test("rejects a proactive schedule outside the registered permission and tool policy", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const scheduler = new SchedulerService(store, {
    createRun: async () => undefined,
    policy: {
      permissionScopes: ["permission-allowed" as never],
      allowedTools: ["read_workspace"],
    },
  });
  await expect(scheduler.schedule(schedule())).rejects.toThrow("permission scope");
  await expect(store.listSchedules()).resolves.toEqual([]);
});

test("requires the outer trigger and run trigger to match exactly", () => {
  const record = schedule();
  expect(() => parseSchedule({
    ...record,
    run: {
      ...record.run,
      trigger: { kind: "explicit", label: "different" },
    },
  })).toThrow("must match");
  expect(() => parseSchedule({
    ...record,
    kind: "monitor",
  })).toThrow("kind");
});
