import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { SqliteEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  parseCanonicalEvent,
  parseStartRun,
  type CanonicalEvent,
  type ChannelOwnerAuthorization,
  type ChannelScope,
  type EventStore,
  type EventSink,
  type ResolvedRunProfile,
  type StartRun,
} from "@anna/harness-v2";
import { PiLoopKernel } from "@anna/pi-loop-kernel";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";

import { createHostMemoryContextLoader } from "../src/host-memory-context";
import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
} from "../src/production";

const HOST_CONTEXT_PROJECTION = "harness-run-context-input";
const OWNER_ID = "actor-memory-owner";

const corruptions = [
  "missing_snapshot",
  "tampered_snapshot",
  "mismatched_snapshot",
  "inconsistent_receipt",
] as const;

type Corruption = (typeof corruptions)[number];

interface SeededMemory {
  readonly id: string;
  readonly content: string;
}

const authorization: ChannelOwnerAuthorization = {
  async assertOwner(_scope, actorId): Promise<void> {
    if (actorId !== OWNER_ID) {
      throw new Error("Channel Owner authorization denied");
    }
  },
};

async function readRunEvents(
  store: SqliteEventStore,
  scope: ChannelScope,
  runId: string,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope(scope).read(runId as never)) {
    events.push(event);
  }
  return events;
}

async function readRuntimeEvents(
  runtime: {
    readEvents?: (
      workspaceId: string,
      channelId: string,
      runId: string,
      fromSeq?: number,
    ) => Promise<readonly CanonicalEvent[]>;
  },
  scope: ChannelScope,
  runId: string,
): Promise<CanonicalEvent[]> {
  if (runtime.readEvents === undefined) {
    throw new Error("Harness runtime does not expose its event reader");
  }
  return [...await runtime.readEvents(scope.workspaceId, scope.channelId, runId)];
}

async function waitForTerminal(
  runtime: Parameters<typeof readRuntimeEvents>[0],
  scope: ChannelScope,
  runId: string,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const events = await readRuntimeEvents(runtime, scope, runId);
    if (events.some((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach a terminal event`);
}

async function writeRuntimeConfig(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
}

function sourceProfile(suffix: string): ResolvedRunProfile {
  return resolvedRunProfileFixture({
    id: `profile-memory-negative-source-${suffix}`,
    memoryPolicy: { read: "channel", write: "propose" },
  });
}

function targetFixtureProfile(suffix: string): ResolvedRunProfile {
  return resolvedRunProfileFixture({
    id: `profile-memory-negative-target-${suffix}`,
    memoryPolicy: { read: "channel", write: "disabled" },
  });
}

function makeSourceRun(
  scope: ChannelScope,
  profile: ResolvedRunProfile,
  suffix: string,
): StartRun {
  const sourceEventId = `event-memory-negative-source-${suffix}`;
  return parseStartRun({
    commandId: `command-memory-negative-source-${suffix}`,
    runId: `run-memory-negative-source-${suffix}`,
    surfaceId: "cowork",
    goal: "Seed accepted Memory for a negative hydration test.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: sourceEventId },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: `permission-memory-negative-source-${suffix}`,
    stopCondition: profile.terminalRules.stopCondition,
  });
}

async function seedAcceptedMemories(
  eventStore: SqliteEventStore,
  scope: ChannelScope,
  suffix: string,
  memories: readonly SeededMemory[],
): Promise<void> {
  const profile = sourceProfile(suffix);
  const sourceRun = makeSourceRun(scope, profile, suffix);
  const sourceEventId = sourceRun.source.eventId;
  const events = eventStore.scope(scope);
  await events.claimStart(sourceRun);
  await events.append(parseCanonicalEvent({
    id: sourceEventId,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: sourceRun.runId,
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { outcome: "completed" },
  }));

  const repository = createChannelMemoryRepository({
    eventStore,
    scope,
    authorization,
    runProfileSnapshot: profile,
  });
  for (const memory of memories) {
    await repository.propose({
      id: memory.id,
      content: memory.content,
      sourceRunId: sourceRun.runId,
      sourceEventIds: [sourceEventId],
    });
    await repository.accept({
      candidateId: memory.id,
      actorId: OWNER_ID,
    });
  }
}

function makeTargetCommand(
  scope: ChannelScope,
  profile: ResolvedRunProfile,
  suffix: string,
  goal: string,
): StartRun {
  return parseStartRun({
    commandId: `command-memory-negative-target-${suffix}`,
    runId: `run-memory-negative-target-${suffix}`,
    surfaceId: "cowork",
    goal,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: `event-memory-negative-target-source-${suffix}` },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: `permission-memory-negative-target-${suffix}`,
    stopCondition: profile.terminalRules.stopCondition,
  });
}

async function queueRun(
  eventStore: SqliteEventStore,
  scope: ChannelScope,
  command: StartRun,
): Promise<void> {
  const events = eventStore.scope(scope);
  await events.claimStart(command);
  await events.append(parseCanonicalEvent({
    id: `event-memory-negative-queued-${command.runId}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: command.runId,
    seq: 0,
    type: "run.queued",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { phase: "queued" },
  }));
}

function fixtureModel() {
  const provider = fauxProvider();
  return {
    ...provider.getModel(),
    id: "fixture-model",
    name: "fixture-model",
    provider: "anna-openai-compatible",
  };
}

function delayedCommitEventStore(
  eventStore: EventStore,
  entered: () => void,
  release: Promise<void>,
): EventStore {
  return {
    scope(scope) {
      const scoped = eventStore.scope(scope);
      return new Proxy(scoped, {
        get(target, property) {
          if (property === "commitProjection") {
            return async (commit: Parameters<typeof target.commitProjection>[0]) => {
              entered();
              await release;
              return target.commitProjection(commit);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof scoped;
    },
  };
}

async function seedPreparedSnapshot(
  eventStore: SqliteEventStore,
  workspaceRoot: string,
  command: StartRun,
): Promise<void> {
  const hostLoader = createHostMemoryContextLoader({ eventStore });
  const scoped = eventStore.scope(command);
  const seedSink: EventSink & { read: typeof scoped.read } = {
    async append(event): Promise<void> {
      if ([
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type)) {
        return;
      }
      await scoped.append(event);
    },
    read: scoped.read.bind(scoped),
  };
  const kernel = new PiLoopKernel({
    model: fixtureModel(),
    createToolGateway: (admittedCommand) => createProductionToolGateway({
      eventStore,
      command: admittedCommand,
      workspaceRoot,
    }),
    workerProfileId: command.runProfileSnapshot.workerProfileId,
    prepareContext: hostLoader,
    streamFn: () => {
      throw new Error("stop after test snapshot preparation");
    },
  });

  await expect(kernel.start(
    command,
    seedSink,
    new AbortController().signal,
  )).resolves.toEqual({ status: "failed" });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function snapshotDigest(state: Record<string, unknown>): string {
  const { snapshotDigest: _ignored, ...withoutDigest } = state;
  return `sha256:${createHash("sha256").update(stableJson(withoutDigest), "utf8").digest("hex")}`;
}

function nativeProjectionState(
  databasePath: string,
  scope: ChannelScope,
  runId: string,
): Record<string, unknown> {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(`
      SELECT state_json FROM projections
      WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
    `).get(scope.workspaceId, scope.channelId, HOST_CONTEXT_PROJECTION, runId) as {
      state_json?: unknown;
    } | undefined;
    if (typeof row?.state_json !== "string") {
      throw new Error("negative test projection fixture was not committed");
    }
    return JSON.parse(row.state_json) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

function corruptPrivateSnapshot(
  databasePath: string,
  scope: ChannelScope,
  runId: string,
  corruption: Corruption,
  memoryHitEventId: string,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    if (corruption === "missing_snapshot") {
      database.prepare(`
        DELETE FROM projection_receipts
        WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
      `).run(scope.workspaceId, scope.channelId, HOST_CONTEXT_PROJECTION, runId);
      database.prepare(`
        DELETE FROM projections
        WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
      `).run(scope.workspaceId, scope.channelId, HOST_CONTEXT_PROJECTION, runId);
      return;
    }

    if (corruption === "inconsistent_receipt") {
      const row = database.prepare(`
        SELECT event_json FROM events
        WHERE workspace_id = ? AND channel_id = ? AND event_id = ?
      `).get(scope.workspaceId, scope.channelId, memoryHitEventId) as {
        event_json?: unknown;
      } | undefined;
      if (typeof row?.event_json !== "string") {
        throw new Error("negative test memory receipt fixture was not persisted");
      }
      const event = JSON.parse(row.event_json) as {
        payload?: Record<string, unknown>;
      };
      event.payload = {
        ...(event.payload ?? {}),
        acceptedEventId: "receipt-inconsistent-accepted-event",
      };
      database.prepare(`
        UPDATE events SET payload_json = ?, event_json = ?
        WHERE workspace_id = ? AND channel_id = ? AND event_id = ?
      `).run(
        JSON.stringify(event.payload),
        JSON.stringify(event),
        scope.workspaceId,
        scope.channelId,
        memoryHitEventId,
      );
      return;
    }

    const state = nativeProjectionState(databasePath, scope, runId);
    if (corruption === "tampered_snapshot") {
      const context = state.context as Record<string, unknown>;
      const memoryHits = context.memoryHits as Array<Record<string, unknown>>;
      if (memoryHits[0] === undefined) {
        throw new Error("negative test requires a persisted Memory hit");
      }
      memoryHits[0].content = "tampered private snapshot content";
    } else {
      const binding = state.binding as Record<string, unknown>;
      binding.channelId = "channel-mismatched-private-snapshot";
      state.snapshotDigest = snapshotDigest(state);
    }
    database.prepare(`
      UPDATE projections SET state_json = ?
      WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
    `).run(
      JSON.stringify(state),
      scope.workspaceId,
      scope.channelId,
      HOST_CONTEXT_PROJECTION,
      runId,
    );
  } finally {
    database.close();
  }
}

test("production Pi fails closed with zero model calls for corrupt prepared Memory input", async () => {
  const goal = "Release notes require owner review before publication";
  for (const corruption of corruptions) {
    const suffix = corruption;
    const scope = {
      workspaceId: `workspace-memory-negative-${suffix}`,
      channelId: `channel-memory-negative-${suffix}`,
    } as ChannelScope;
    const directory = await mkdtemp(join(tmpdir(), `anna-memory-negative-${suffix}-`));
    const configPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const seededStore = new SqliteEventStore(eventStorePath);
    let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
    try {
      await writeRuntimeConfig(configPath);
      await seedAcceptedMemories(seededStore, scope, suffix, [{
        id: `memory-negative-${suffix}`,
        content: `${goal}. ${suffix} fixture remains provenance-only.`,
      }]);
      const targetProfile = await createLiveProfile(
        "fixture-model",
        undefined,
        false,
        "general",
        "channel",
      );
      const targetCommand = makeTargetCommand(scope, targetProfile, suffix, goal);
      await queueRun(seededStore, scope, targetCommand);
      await seedPreparedSnapshot(seededStore, directory, targetCommand);
      const seededEvents = await readRunEvents(seededStore, scope, targetCommand.runId);
      const memoryHit = seededEvents.find((event) => event.type === "memory.hit");
      expect(memoryHit).toBeDefined();
      expect(seededEvents.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))).toBe(false);
      seededStore.close();
      corruptPrivateSnapshot(
        eventStorePath,
        scope,
        targetCommand.runId,
        corruption,
        memoryHit!.id,
      );

      let modelCalls = 0;
      live = await createLiveHarnessV2Runtime({
        runtimeConfigPath: configPath,
        eventStorePath,
        workspaceRoot: directory,
        surfaces: ["cowork"],
        createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
          model: fixtureModel(),
          createToolGateway: toolGatewayFor,
          prepareContext,
          workerProfileId,
          getApiKey: () => "fixture-key",
          streamFn: (_model, context) => {
            modelCalls += 1;
            const stream = createAssistantMessageEventStream();
            const message = fauxAssistantMessage("must never be generated");
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            void context;
            return stream;
          },
          now: () => 0,
        }),
      });
      const resumed = await live.runtime.resume!("cowork", targetCommand.runId, {
        workspace_id: scope.workspaceId,
        channel_id: scope.channelId,
      });
      expect(resumed.runId).toBe(targetCommand.runId);
      const events = await waitForTerminal(live.runtime, scope, targetCommand.runId);
      expect(modelCalls).toBe(0);
      expect(events.at(-1)?.type).toBe("run.failed");
      expect(events.filter((event) => event.type === "run.eval.contract")).toHaveLength(1);
      expect(events.some((event) => event.type === "run.context.ready")).toBe(true);
      const finalMemoryHit = events.find((event) => event.type === "memory.hit");
      expect(finalMemoryHit?.payload).toEqual(expect.objectContaining({
        memoryId: `memory-negative-${suffix}`,
        sourceChannelId: scope.channelId,
        sourceEventIds: [expect.any(String)],
        acceptedEventId: expect.any(String),
      }));
      expect(JSON.stringify(finalMemoryHit)).not.toContain("fixture remains provenance-only");
      expect(events.filter((event) => event.type === "memory.hit")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    } finally {
      live?.close();
      try {
        seededStore.close();
      } catch {
        // The seed Store is already closed on the normal path.
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);

test("concurrent Host preparation returns the SQLite CAS winner to both callers", async () => {
  const suffix = "cas-winner";
  const scope = {
    workspaceId: "workspace-memory-negative-cas",
    channelId: "channel-memory-negative-cas",
  } as ChannelScope;
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-negative-cas-"));
  const eventStorePath = join(directory, "events.sqlite");
  const firstStore = new SqliteEventStore(eventStorePath);
  const secondStore = new SqliteEventStore(eventStorePath);
  try {
    const goal = "Release notes require owner review before publication";
    const memories = [
      {
        id: "memory-cas-first",
        content: `${goal}. first Host candidate.`,
      },
      {
        id: "memory-cas-second",
        content: `${goal}. second Host candidate.`,
      },
    ] as const;
    await seedAcceptedMemories(firstStore, scope, suffix, memories);
    const profile = targetFixtureProfile(suffix);
    const command = makeTargetCommand(scope, profile, suffix, goal);
    await queueRun(firstStore, scope, command);

    const startedOnlyKernel = new PiLoopKernel({
      model: fixtureModel(),
      createToolGateway: (admittedCommand) => createProductionToolGateway({
        eventStore: firstStore,
        command: admittedCommand,
        workspaceRoot: directory,
      }),
      workerProfileId: profile.workerProfileId,
      prepareContext: async () => {
        throw new Error("stop after persisted run.started for CAS race");
      },
      streamFn: () => {
        throw new Error("CAS setup must not call the model");
      },
    });
    await expect(startedOnlyKernel.start(
      command,
      firstStore.scope(scope),
      new AbortController().signal,
    )).rejects.toThrow("stop after persisted run.started for CAS race");

    let resolveNarrowCommitEntered: (() => void) | undefined;
    const narrowCommitEntered = new Promise<void>((resolve) => {
      resolveNarrowCommitEntered = resolve;
    });
    let releaseNarrowCommit: (() => void) | undefined;
    const narrowCommitRelease = new Promise<void>((resolve) => {
      releaseNarrowCommit = resolve;
    });
    const narrowLoader = createHostMemoryContextLoader({
      eventStore: delayedCommitEventStore(
        firstStore,
        () => resolveNarrowCommitEntered?.(),
        narrowCommitRelease,
      ),
      memoryLimit: 1,
    });
    const wideLoader = createHostMemoryContextLoader({
      eventStore: secondStore,
      memoryLimit: 2,
    });
    const narrowPending = narrowLoader(command, new AbortController().signal);
    await narrowCommitEntered;
    const wide = await wideLoader(command, new AbortController().signal);
    releaseNarrowCommit?.();
    const narrow = await narrowPending;

    expect(wide.memoryHits).toHaveLength(2);
    expect(narrow.memoryHits).toHaveLength(2);
    expect(narrow.snapshotDigest).toBe(wide.snapshotDigest);
    expect(narrow.context).toEqual(wide.context);
    expect(narrow.memoryHits).toEqual(wide.memoryHits);
    expect(narrow.memoryHits.length).toBeGreaterThanOrEqual(1);
    expect(narrow.memoryHits.length).toBeLessThanOrEqual(2);
    for (const memory of narrow.memoryHits) {
      expect(memory.sourceChannel).toEqual(scope);
      expect(memory.sourceEventIds.length).toBeGreaterThan(0);
      expect(memory.acceptedEventId).toEqual(expect.any(String));
    }

    const persisted = await firstStore.scope(scope).loadProjection(
      HOST_CONTEXT_PROJECTION,
      command.runId as never,
    );
    expect(persisted?.version).toBe(1);
    expect(persisted?.state).toEqual(expect.objectContaining({
      snapshotDigest: narrow.snapshotDigest,
      context: narrow.context,
      memoryHits: narrow.memoryHits,
    }));
  } finally {
    firstStore.close();
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
