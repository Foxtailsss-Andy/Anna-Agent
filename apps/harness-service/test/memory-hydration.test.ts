import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { SqliteEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  parseJsonValue,
  parseCanonicalEvent,
  parseStartRun,
  type ChannelOwnerAuthorization,
  type CanonicalEvent,
  type ChannelScope,
  type EventSink,
} from "@anna/harness-v2";
import { PiLoopKernel } from "@anna/pi-loop-kernel";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";

import { createHostMemoryContextLoader } from "../src/host-memory-context";
import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
} from "../src/production";

const scope = {
  workspaceId: "workspace-memory-hydration",
  channelId: "channel-memory-hydration",
} as ChannelScope;

async function readRunEvents(
  store: SqliteEventStore,
  runId: string,
  runScope: ChannelScope = scope,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope(runScope).read(runId as never)) {
    events.push(event);
  }
  return events;
}

async function seedCheckpointMemories(
  eventStore: SqliteEventStore,
  memoryScope: ChannelScope,
  suffix: string,
): Promise<readonly string[]> {
  const sourceProfile = resolvedRunProfileFixture({
    id: `profile-memory-checkpoint-source-${suffix}`,
    memoryPolicy: { read: "channel", write: "propose" },
  });
  const sourceRun = parseStartRun({
    commandId: `command-memory-checkpoint-source-${suffix}`,
    runId: `run-memory-checkpoint-source-${suffix}`,
    goal: "Seed checkpoint Memory.",
    workspaceId: memoryScope.workspaceId,
    channelId: memoryScope.channelId,
    source: { eventId: `event-memory-checkpoint-source-${suffix}` },
    runProfile: { id: sourceProfile.id, version: sourceProfile.version },
    runProfileSnapshot: sourceProfile,
    budget: sourceProfile.budget,
    permissionScope: `permission-memory-checkpoint-source-${suffix}`,
    stopCondition: sourceProfile.terminalRules.stopCondition,
  });
  const sourceEvents = eventStore.scope(memoryScope);
  await sourceEvents.claimStart(sourceRun);
  await sourceEvents.append(parseCanonicalEvent({
    id: `event-memory-checkpoint-source-${suffix}`,
    workspaceId: memoryScope.workspaceId,
    channelId: memoryScope.channelId,
    streamId: sourceRun.runId,
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));
  const authorizer: ChannelOwnerAuthorization = {
    async assertOwner(receivedScope, actorId): Promise<void> {
      if (
        receivedScope.workspaceId !== memoryScope.workspaceId
        || receivedScope.channelId !== memoryScope.channelId
        || actorId !== "actor-checkpoint-owner"
      ) {
        throw new Error("Channel Owner authorization denied");
      }
    },
  };
  let eventNumber = 0;
  const repository = createChannelMemoryRepository({
    eventStore,
    scope: memoryScope,
    authorization: authorizer,
    runProfileSnapshot: sourceProfile,
    createEventId: () => `event-memory-checkpoint-${suffix}-${++eventNumber}`,
  });
  const contents = [
    "Checkpoint memory one remains immutable.",
    "Checkpoint memory two remains immutable.",
  ];
  for (const [index, content] of contents.entries()) {
    const id = `memory-checkpoint-${suffix}-${index + 1}`;
    await repository.propose({
      id,
      content,
      sourceRunId: sourceRun.runId,
      sourceEventIds: [`event-memory-checkpoint-source-${suffix}`],
    });
    await repository.accept({
      candidateId: id,
      actorId: "actor-checkpoint-owner",
    });
  }
  return contents;
}

test("production Host hydrates accepted Memory before the actual Pi model turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-hydration-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");

  const eventStore = new SqliteEventStore(eventStorePath);
  const profile = await createLiveProfile(
    "fixture-model",
    undefined,
    false,
    "general",
    "channel",
  );
  const sourceProfile = resolvedRunProfileFixture({
    memoryPolicy: { read: "channel", write: "propose" },
  });
  const sourceRun = parseStartRun({
    commandId: "command-memory-source",
    runId: "run-memory-source",
    surfaceId: "cowork",
    goal: "Seed accepted channel Memory.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: "event-memory-source-started" },
    runProfile: { id: sourceProfile.id, version: sourceProfile.version },
    runProfileSnapshot: sourceProfile,
    budget: sourceProfile.budget,
    permissionScope: "permission-memory-hydration",
    stopCondition: profile.terminalRules.stopCondition,
  });
  const sourceEvents = eventStore.scope(scope);
  await sourceEvents.claimStart(sourceRun);
  await sourceEvents.append(parseCanonicalEvent({
    id: "event-memory-source-started",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: sourceRun.runId,
    seq: 0,
    type: "run.started",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { phase: "started" },
  }));
  await sourceEvents.append(parseCanonicalEvent({
    id: "event-memory-source-completed",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: sourceRun.runId,
    seq: 1,
    type: "run.completed",
    timestamp: "2026-08-30T00:00:01.000Z",
    schemaVersion: 1,
    payload: { outcome: "completed" },
  }));
  const authorizer: ChannelOwnerAuthorization = {
    async assertOwner(receivedScope, actorId): Promise<void> {
      if (
        receivedScope.workspaceId !== scope.workspaceId
        || receivedScope.channelId !== scope.channelId
        || actorId !== "actor-channel-owner"
      ) {
        throw new Error("Channel Owner authorization denied");
      }
    },
  };
  const memoryRepository = createChannelMemoryRepository({
    eventStore,
    scope,
    authorization: authorizer,
    runProfileSnapshot: sourceProfile,
  });
  await memoryRepository.propose({
    id: "memory-release-policy",
    content: "Release notes require owner review before publication.",
    sourceRunId: sourceRun.runId,
    sourceEventIds: ["event-memory-source-completed"],
  });
  await memoryRepository.accept({
    candidateId: "memory-release-policy",
    actorId: "actor-channel-owner",
  });

  const provider = fauxProvider();
  let modelCalls = 0;
  let observedSystemPrompt = "";
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
      prepareContext,
      workerProfileId,
      getApiKey: () => "fixture-key",
      streamFn: (_model, context) => {
        modelCalls += 1;
        observedSystemPrompt = context.systemPrompt ?? "";
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("Memory-aware answer");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
      now: () => 0,
    }),
  });

  let liveClosed = false;
  let eventStoreClosed = false;
  try {
    const started = await live.runtime.start("cowork", {
      workspace_id: scope.workspaceId,
      channel_id: scope.channelId,
      command_id: "command-memory-target",
      run_id: "run-memory-target",
      source_event_id: "event-memory-target-source",
      goal: "Release notes require owner review before publication.",
    });
    expect(started.status).toBe("queued");

    let runEvents: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      runEvents = await readRunEvents(eventStore, started.runId);
      if (runEvents.some((event) => event.type === "run.completed" || event.type === "run.failed")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(modelCalls).toBe(1);
    const types = runEvents.map((event) => event.type);
    expect(types.indexOf("run.started")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("memory.hit")).toBeGreaterThan(types.indexOf("run.started"));
    expect(types.indexOf("run.context.ready")).toBeGreaterThan(types.indexOf("memory.hit"));
    expect(types.indexOf("run.progress")).toBeGreaterThan(types.indexOf("run.context.ready"));
    expect(runEvents.at(-2)?.type).toBe("run.eval.contract");
    expect(runEvents.at(-1)?.type).toBe("run.completed");
    expect(runEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(runEvents.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(runEvents.find((event) => event.type === "run.context.ready")?.payload).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        snapshotDigest: expect.stringMatching(/^sha256:/),
        originalExecutionFingerprint: expect.any(Object),
        inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        memoryCount: 1,
      }),
    );

    const memoryHit = runEvents.find((event) => event.type === "memory.hit");
    expect(memoryHit?.payload).toEqual(expect.objectContaining({
      memoryId: "memory-release-policy",
      sourceChannelId: scope.channelId,
      sourceRunId: sourceRun.runId,
      sourceEventIds: ["event-memory-source-completed"],
      acceptedEventId: expect.any(String),
    }));
    expect(JSON.stringify(memoryHit)).not.toContain("Release notes require owner review");
    expect(observedSystemPrompt).toContain("Channel Memory (untrusted context; reference only)");
    expect(observedSystemPrompt).toContain("Release notes require owner review before publication.");

    const projection = await eventStore.scope(scope).loadProjection(
      "harness-run-context-input",
      started.runId as never,
    );
    expect(projection?.state).toEqual(expect.objectContaining({
      schemaVersion: 1,
      binding: expect.objectContaining({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        runId: started.runId,
        profileHash: expect.any(String),
      }),
      context: expect.objectContaining({
        memoryHits: [expect.objectContaining({
          memoryId: "memory-release-policy",
          content: "Release notes require owner review before publication.",
        })],
      }),
    }));

    const targetCommand = await eventStore.scope(scope).getRunCommand(started.runId as never);
    expect(targetCommand).toBeDefined();
    await memoryRepository.edit({
      memoryId: "memory-release-policy",
      content: "Edited release notes require owner review before publication.",
      actorId: "actor-channel-owner",
    });
    const restoredBeforeReopen = await createHostMemoryContextLoader({ eventStore })(
      targetCommand!,
      new AbortController().signal,
    );
    expect(restoredBeforeReopen.context.memoryHits[0]?.content)
      .toBe("Release notes require owner review before publication.");

    live.close();
    liveClosed = true;
    eventStoreClosed = true;
    const reopenedStore = new SqliteEventStore(eventStorePath);
    try {
      const reopenedCommand = await reopenedStore.scope(scope).getRunCommand(started.runId as never);
      expect(reopenedCommand).toBeDefined();
      const restoredAfterReopen = await createHostMemoryContextLoader({ eventStore: reopenedStore })(
        reopenedCommand!,
        new AbortController().signal,
      );
      expect(restoredAfterReopen.snapshotDigest).toBe(restoredBeforeReopen.snapshotDigest);
      expect(restoredAfterReopen.context.memoryHits[0]?.content)
        .toBe("Release notes require owner review before publication.");
      const tamperedState = JSON.parse(JSON.stringify(projection!.state)) as Record<string, unknown>;
      tamperedState.binding = {
        ...(tamperedState.binding as Record<string, unknown>),
        channelId: "channel-tampered",
      };
      const memoryHitForProjection = memoryHit!;
      await reopenedStore.scope(scope).commitProjection({
        projector: "harness-run-context-input",
        streamId: started.runId as never,
        eventId: memoryHitForProjection.id,
        eventSeq: memoryHitForProjection.seq,
        expectedVersion: 1,
        state: parseJsonValue(tamperedState),
      });
      await expect(createHostMemoryContextLoader({ eventStore: reopenedStore })(
        reopenedCommand!,
        new AbortController().signal,
      )).rejects.toThrow("binding mismatch");
    } finally {
      reopenedStore.close();
    }

    const reopenedProvider = fauxProvider();
    let newRunModelCalls = 0;
    let newRunPrompt = "";
    const reopenedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot: directory,
      surfaces: ["cowork"],
      createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
        model: {
          ...reopenedProvider.getModel(),
          id: "fixture-model",
          name: "fixture-model",
          provider: "anna-openai-compatible",
        },
        createToolGateway: toolGatewayFor,
        prepareContext,
        workerProfileId,
        getApiKey: () => "fixture-key",
        streamFn: (_model, context) => {
          newRunModelCalls += 1;
          newRunPrompt = context.systemPrompt ?? "";
          const stream = createAssistantMessageEventStream();
          const message = fauxAssistantMessage("New Run saw current Memory.");
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
        now: () => 0,
      }),
    });
    try {
      const newRun = await reopenedLive.runtime.start("cowork", {
        workspace_id: scope.workspaceId,
        channel_id: scope.channelId,
        command_id: "command-memory-new-run",
        run_id: "run-memory-new-run",
        source_event_id: "event-memory-new-run-source",
        goal: "Edited release notes require owner review before publication.",
      });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const events = await readRunEvents(reopenedLive.eventStore as SqliteEventStore, newRun.runId);
        if (events.some((event) => event.type === "run.completed" || event.type === "run.failed")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(newRunModelCalls).toBe(1);
      expect(newRunPrompt).toContain("Edited release notes require owner review before publication.");
    } finally {
      reopenedLive.close();
    }
  } finally {
    if (!liveClosed) {
      live.close();
    }
    if (!eventStoreClosed) {
      eventStore.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host Memory loading aborts or times out before the Pi model can start", async () => {
  for (const scenario of [
    { mode: "cancelled" as const, trigger: "kernel_abort" as const },
    { mode: "cancelled" as const, trigger: "signal_abort" as const },
    { mode: "timed_out" as const, trigger: "wall_timeout" as const },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `anna-memory-${scenario.trigger}-`));
    const eventStorePath = join(directory, "events.sqlite");
    const eventStore = new SqliteEventStore(eventStorePath);
    const profile = resolvedRunProfileFixture({
      id: `profile-memory-${scenario.trigger}`,
      budget: { wallTimeMs: scenario.mode === "timed_out" ? 10 : 1_000, turns: 1 },
      memoryPolicy: { read: "channel", write: "disabled" },
    });
    const command = parseStartRun({
      commandId: `command-memory-${scenario.trigger}`,
      runId: `run-memory-${scenario.trigger}`,
      surfaceId: "cowork",
      goal: "Read release notes Memory.",
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      source: { eventId: `event-memory-${scenario.trigger}-source` },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: `permission-memory-${scenario.trigger}`,
      stopCondition: profile.terminalRules.stopCondition,
    });
    const scoped = eventStore.scope(scope);
    await scoped.claimStart(command);
    await scoped.append(parseCanonicalEvent({
      id: `event-memory-${scenario.trigger}-queued`,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      streamId: command.runId,
      seq: 0,
      type: "run.queued",
      timestamp: "2026-08-30T00:00:00.000Z",
      schemaVersion: 1,
      payload: { phase: "queued" },
    }));

    const hostLoader = createHostMemoryContextLoader({ eventStore });
    const provider = fauxProvider();
    const controller = new AbortController();
    let modelCalls = 0;
    const kernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: { async execute() { return { status: "succeeded", output: "unused" }; } },
      workerProfileId: profile.workerProfileId,
      prepareContext: async (preparedCommand, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return hostLoader(preparedCommand, signal);
      },
      streamFn: () => {
        modelCalls += 1;
        throw new Error("model must not start during Host Memory loading");
      },
      now: () => 0,
    });
    const run = kernel.start(command, scoped, controller.signal);
    if (scenario.trigger === "kernel_abort") {
      setTimeout(() => { void kernel.abort(command.runId, "test_abort"); }, 5);
    } else if (scenario.trigger === "signal_abort") {
      setTimeout(() => controller.abort(), 5);
    }

    await expect(run).resolves.toEqual({ status: scenario.mode });
    await new Promise((resolve) => setTimeout(resolve, 70));
    const events: CanonicalEvent[] = [];
    for await (const event of scoped.read(command.runId as never)) {
      events.push(event);
    }
    expect(modelCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "run.queued",
      "run.started",
      `run.${scenario.mode}`,
    ]);
    expect(events.some((event) => event.type === "run.context.ready")).toBe(false);
    eventStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a required channel Memory loader failure stops the production Pi before model input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-missing-loader-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
  const provider = fauxProvider();
  let modelCalls = 0;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: ({ toolGatewayFor, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
      workerProfileId,
      streamFn: () => {
        modelCalls += 1;
        throw new Error("model must not start without a Host Memory loader");
      },
      now: () => 0,
    }),
  });
  try {
    const started = await live.runtime.start("cowork", {
      workspace_id: "workspace-memory-missing-loader",
      channel_id: "channel-memory-missing-loader",
      command_id: "command-memory-missing-loader",
      run_id: "run-memory-missing-loader",
      source_event_id: "event-memory-missing-loader-source",
      goal: "Read accepted release notes Memory.",
    });
    let runEvents: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      runEvents = await readRunEvents(
        live.eventStore as SqliteEventStore,
        started.runId,
        {
          workspaceId: "workspace-memory-missing-loader",
          channelId: "channel-memory-missing-loader",
        } as ChannelScope,
      );
      if (runEvents.some((event) => event.type === "run.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modelCalls).toBe(0);
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.queued",
      "run.started",
      "run.eval.contract",
      "run.failed",
    ]);
    expect(runEvents.some((event) => event.type === "run.context.ready")).toBe(false);
  } finally {
    live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a legal zero-hit channel lookup records readiness and still reaches the actual Pi model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-zero-hit-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
  const provider = fauxProvider();
  let modelCalls = 0;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
      prepareContext,
      workerProfileId,
      streamFn: () => {
        modelCalls += 1;
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("No Memory was found.");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
      now: () => 0,
    }),
  });
  try {
    const started = await live.runtime.start("cowork", {
      workspace_id: "workspace-memory-zero-hit",
      channel_id: "channel-memory-zero-hit",
      command_id: "command-memory-zero-hit",
      run_id: "run-memory-zero-hit",
      source_event_id: "event-memory-zero-hit-source",
      goal: "Find the unique token with no accepted Memory.",
    });
    let runEvents: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      runEvents = await readRunEvents(
        live.eventStore as SqliteEventStore,
        started.runId,
        {
          workspaceId: "workspace-memory-zero-hit",
          channelId: "channel-memory-zero-hit",
        } as ChannelScope,
      );
      if (runEvents.some((event) => event.type === "run.completed" || event.type === "run.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modelCalls).toBe(1);
    expect(runEvents.filter((event) => event.type === "memory.hit")).toHaveLength(0);
    expect(runEvents.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(runEvents.find((event) => event.type === "run.context.ready")?.payload)
      .toEqual(expect.objectContaining({ memoryCount: 0 }));
    expect(runEvents.at(-2)?.type).toBe("run.eval.contract");
    expect(runEvents.at(-1)?.type).toBe("run.completed");
  } finally {
    live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a start-only preparation failure retries the same SQLite Run without a duplicate start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-start-only-"));
  const eventStorePath = join(directory, "events.sqlite");
  const eventStore = new SqliteEventStore(eventStorePath);
  const profile = resolvedRunProfileFixture({
    id: "profile-memory-start-only",
    budget: { turns: 1 },
    memoryPolicy: { read: "channel", write: "disabled" },
  });
  const command = parseStartRun({
    commandId: "command-memory-start-only",
    runId: "run-memory-start-only",
    surfaceId: "cowork",
    goal: "Recover a Run with no matching Memory.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: "event-memory-start-only-source" },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: "permission-memory-start-only",
    stopCondition: profile.terminalRules.stopCondition,
  });
  const scoped = eventStore.scope(scope);
  await scoped.claimStart(command);
  await scoped.append(parseCanonicalEvent({
    id: "event-memory-start-only-queued",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: command.runId,
    seq: 0,
    type: "run.queued",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { phase: "queued" },
  }));

  const provider = fauxProvider();
  let firstModelCalls = 0;
  const firstKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: { async execute() { return { status: "succeeded", output: "unused" }; } },
    workerProfileId: profile.workerProfileId,
    prepareContext: async () => {
      throw new Error("simulated process loss after run.started");
    },
    streamFn: () => {
      firstModelCalls += 1;
      throw new Error("model must not start after start-only loss");
    },
    now: () => 0,
  });
  await expect(firstKernel.start(command, scoped, new AbortController().signal))
    .rejects.toThrow("simulated process loss after run.started");
  const afterLoss = await readRunEvents(eventStore, command.runId);
  expect(firstModelCalls).toBe(0);
  expect(afterLoss.map((event) => event.type)).toEqual(["run.queued", "run.started"]);

  let secondModelCalls = 0;
  const secondKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: { async execute() { return { status: "succeeded", output: "unused" }; } },
    workerProfileId: profile.workerProfileId,
    prepareContext: createHostMemoryContextLoader({ eventStore }),
    streamFn: () => {
      secondModelCalls += 1;
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("Recovered after start-only loss.");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
    now: () => 0,
  });
  await expect(secondKernel.start(command, scoped, new AbortController().signal))
    .resolves.toEqual({ status: "completed" });
  const recovered = await readRunEvents(eventStore, command.runId);
  expect(secondModelCalls).toBe(1);
  expect(recovered.filter((event) => event.type === "run.started")).toHaveLength(1);
  expect(recovered.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
  expect(recovered.map((event) => event.seq)).toEqual(
    recovered.map((_event, index) => index),
  );

  eventStore.close();
  await rm(directory, { recursive: true, force: true });
});

test("an exhausted wall budget before Host loading makes no loader or projection write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-history-budget-"));
  const eventStore = new SqliteEventStore(join(directory, "events.sqlite"));
  const profile = resolvedRunProfileFixture({
    id: "profile-memory-history-budget",
    budget: { wallTimeMs: 20, turns: 1 },
    memoryPolicy: { read: "channel", write: "disabled" },
  });
  const command = parseStartRun({
    commandId: "command-memory-history-budget",
    runId: "run-memory-history-budget",
    surfaceId: "cowork",
    goal: "Read no Memory after the history budget expires.",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    source: { eventId: "event-memory-history-budget-source" },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: "permission-memory-history-budget",
    stopCondition: profile.terminalRules.stopCondition,
  });
  const scoped = eventStore.scope(scope);
  await scoped.claimStart(command);
  await scoped.append(parseCanonicalEvent({
    id: "event-memory-history-budget-queued",
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: command.runId,
    seq: 0,
    type: "run.queued",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { phase: "queued" },
  }));
  let readCalls = 0;
  const delayedReadSink: EventSink & { read: typeof scoped.read } = {
    async *read(streamId, afterSeq) {
      if (readCalls === 0) {
        readCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for await (const event of scoped.read(streamId, afterSeq)) {
        yield event;
      }
    },
    append: scoped.append.bind(scoped),
  };
  let loaderCalls = 0;
  let modelCalls = 0;
  const hostLoader = createHostMemoryContextLoader({ eventStore });
  const provider = fauxProvider();
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: { async execute() { return { status: "succeeded", output: "unused" }; } },
    workerProfileId: profile.workerProfileId,
    prepareContext: async (preparedCommand, signal) => {
      loaderCalls += 1;
      return hostLoader(preparedCommand, signal);
    },
    streamFn: () => {
      modelCalls += 1;
      throw new Error("model must not start after the history budget expires");
    },
  });

  await expect(kernel.start(command, delayedReadSink, new AbortController().signal))
    .resolves.toEqual({ status: "timed_out" });
  expect(loaderCalls).toBe(0);
  expect(modelCalls).toBe(0);
  const events = await readRunEvents(eventStore, command.runId);
  expect(events.map((event) => event.type)).toEqual([
    "run.queued",
    "run.started",
    "run.timed_out",
  ]);
  await expect(eventStore.scope(scope).loadProjection(
    "harness-run-context-input",
    command.runId as never,
  )).resolves.toBeUndefined();

  eventStore.close();
  await rm(directory, { recursive: true, force: true });
});

test("an abort or timeout during the readiness ACK cannot leak a Pi model call", async () => {
  for (const scenario of [
    { mode: "cancelled" as const, pause: "ready_ack" as const },
    { mode: "timed_out" as const, pause: "ready_ack" as const },
    { mode: "cancelled" as const, pause: "history_read" as const },
    { mode: "timed_out" as const, pause: "history_read" as const },
  ]) {
    const directory = await mkdtemp(join(
      tmpdir(),
      `anna-memory-ready-${scenario.pause}-${scenario.mode}-`,
    ));
    const eventStore = new SqliteEventStore(join(directory, "events.sqlite"));
    const sourceScope = {
      workspaceId: `workspace-memory-ready-ack-${scenario.pause}-${scenario.mode}`,
      channelId: `channel-memory-ready-ack-${scenario.pause}-${scenario.mode}`,
    } as ChannelScope;
    const targetProfile = resolvedRunProfileFixture({
      id: `profile-memory-ready-ack-${scenario.pause}-${scenario.mode}`,
      budget: { wallTimeMs: scenario.mode === "timed_out" ? 100 : 1_000, turns: 1 },
      memoryPolicy: { read: "channel", write: "disabled" },
    });
    const sourceProfile = resolvedRunProfileFixture({
      id: `profile-memory-ready-source-${scenario.pause}-${scenario.mode}`,
      memoryPolicy: { read: "channel", write: "propose" },
    });
    const sourceRun = parseStartRun({
      commandId: `command-memory-ready-source-${scenario.pause}-${scenario.mode}`,
      runId: `run-memory-ready-source-${scenario.pause}-${scenario.mode}`,
      goal: "Seed accepted Memory for the readiness ACK test.",
      workspaceId: sourceScope.workspaceId,
      channelId: sourceScope.channelId,
      source: { eventId: `event-memory-ready-source-${scenario.pause}-${scenario.mode}` },
      runProfile: { id: sourceProfile.id, version: sourceProfile.version },
      runProfileSnapshot: sourceProfile,
      budget: sourceProfile.budget,
      permissionScope: `permission-memory-ready-source-${scenario.pause}-${scenario.mode}`,
      stopCondition: sourceProfile.terminalRules.stopCondition,
    });
    const sourceEvents = eventStore.scope(sourceScope);
    await sourceEvents.claimStart(sourceRun);
    await sourceEvents.append(parseCanonicalEvent({
      id: `event-memory-ready-source-${scenario.pause}-${scenario.mode}`,
      workspaceId: sourceScope.workspaceId,
      channelId: sourceScope.channelId,
      streamId: sourceRun.runId,
      seq: 0,
      type: "run.completed",
      timestamp: "2026-08-30T00:00:00.000Z",
      schemaVersion: 1,
      payload: {},
    }));
    const authorizer: ChannelOwnerAuthorization = {
      async assertOwner(receivedScope, actorId): Promise<void> {
        if (
          receivedScope.workspaceId !== sourceScope.workspaceId
          || receivedScope.channelId !== sourceScope.channelId
          || actorId !== "actor-ready-owner"
        ) {
          throw new Error("Channel Owner authorization denied");
        }
      },
    };
    let memoryEventNumber = 0;
    const sourceRepository = createChannelMemoryRepository({
      eventStore,
      scope: sourceScope,
      authorization: authorizer,
      runProfileSnapshot: sourceProfile,
      createEventId: () => `event-memory-ready-${scenario.pause}-${scenario.mode}-${++memoryEventNumber}`,
    });
    await sourceRepository.propose({
      id: "memory-ready-ack",
      content: "Readiness ACK Memory must remain provenance-only.",
      sourceRunId: sourceRun.runId,
      sourceEventIds: [`event-memory-ready-source-${scenario.pause}-${scenario.mode}`],
    });
    await sourceRepository.accept({
      candidateId: "memory-ready-ack",
      actorId: "actor-ready-owner",
    });

    const targetScope = {
      workspaceId: sourceScope.workspaceId,
      channelId: sourceScope.channelId,
    } as ChannelScope;
    const targetCommand = parseStartRun({
      commandId: `command-memory-ready-target-${scenario.pause}-${scenario.mode}`,
      runId: `run-memory-ready-target-${scenario.pause}-${scenario.mode}`,
      surfaceId: "cowork",
      goal: "Readiness ACK Memory must remain provenance-only.",
      workspaceId: targetScope.workspaceId,
      channelId: targetScope.channelId,
      source: { eventId: `event-memory-ready-target-${scenario.pause}-${scenario.mode}-source` },
      runProfile: { id: targetProfile.id, version: targetProfile.version },
      runProfileSnapshot: targetProfile,
      budget: targetProfile.budget,
      permissionScope: `permission-memory-ready-target-${scenario.pause}-${scenario.mode}`,
      stopCondition: targetProfile.terminalRules.stopCondition,
    });
    const targetEvents = eventStore.scope(targetScope);
    await targetEvents.claimStart(targetCommand);
    await targetEvents.append(parseCanonicalEvent({
      id: `event-memory-ready-target-${scenario.pause}-${scenario.mode}-queued`,
      workspaceId: targetScope.workspaceId,
      channelId: targetScope.channelId,
      streamId: targetCommand.runId,
      seq: 0,
      type: "run.queued",
      timestamp: "2026-08-30T00:00:00.000Z",
      schemaVersion: 1,
      payload: { phase: "queued" },
    }));

    let releasePause: (() => void) | undefined;
    const pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    let resolvePauseEntered: (() => void) | undefined;
    const pauseEntered = new Promise<void>((resolve) => {
      resolvePauseEntered = resolve;
    });
    let paused = false;
    let readyPersisted = false;
    const pausedSink: EventSink & {
      read: typeof targetEvents.read;
    } = {
      async *read(streamId, afterSeq) {
        if (scenario.pause === "history_read" && readyPersisted && !paused) {
          paused = true;
          resolvePauseEntered?.();
          await pauseGate;
        }
        for await (const event of targetEvents.read(streamId, afterSeq)) {
          yield event;
        }
      },
      async append(event) {
        await targetEvents.append(event);
        if (event.type === "run.context.ready") {
          readyPersisted = true;
          if (scenario.pause === "ready_ack" && !paused) {
            paused = true;
            resolvePauseEntered?.();
            await pauseGate;
          }
        }
      },
    };
    const provider = fauxProvider();
    let modelCalls = 0;
    const kernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: { async execute() { return { status: "succeeded", output: "unused" }; } },
      workerProfileId: targetProfile.workerProfileId,
      prepareContext: createHostMemoryContextLoader({ eventStore }),
      streamFn: () => {
        modelCalls += 1;
        throw new Error("model must not start after readiness ACK stop");
      },
    });
    const run = kernel.start(targetCommand, pausedSink, new AbortController().signal);
    await pauseEntered;
    if (scenario.mode === "cancelled") {
      await kernel.abort(targetCommand.runId, "ready_ack_abort");
      releasePause?.();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 150));
      releasePause?.();
    }
    await expect(run).resolves.toEqual({ status: scenario.mode });
    const events = await readRunEvents(eventStore, targetCommand.runId, targetScope);
    expect(modelCalls).toBe(0);
    expect(events.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe(`run.${scenario.mode}`);
    eventStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reopens a consumed Memory Run and continues Pi without duplicate hydration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-memory-consumed-reopen-"));
  const eventStorePath = join(directory, "events.sqlite");
  const eventStore = new SqliteEventStore(eventStorePath);
  await writeFile(join(directory, "notes.txt"), "Consumed tool fixture.\n", "utf8");
  const targetScope = {
    workspaceId: "workspace-memory-consumed-reopen",
    channelId: "channel-memory-consumed-reopen",
  } as ChannelScope;
  const sourceProfile = resolvedRunProfileFixture({
    id: "profile-memory-consumed-source",
    memoryPolicy: { read: "channel", write: "propose" },
  });
  const targetProfile = await createLiveProfile(
    "fixture-model",
    undefined,
    false,
    "general",
    "channel",
  );
  const sourceRun = parseStartRun({
    commandId: "command-memory-consumed-source",
    runId: "run-memory-consumed-source",
    goal: "Seed consumed transcript Memory.",
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    source: { eventId: "event-memory-consumed-source" },
    runProfile: { id: sourceProfile.id, version: sourceProfile.version },
    runProfileSnapshot: sourceProfile,
    budget: sourceProfile.budget,
    permissionScope: "permission-memory-consumed-source",
    stopCondition: sourceProfile.terminalRules.stopCondition,
  });
  const scoped = eventStore.scope(targetScope);
  await scoped.claimStart(sourceRun);
  await scoped.append(parseCanonicalEvent({
    id: "event-memory-consumed-source",
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    streamId: sourceRun.runId,
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: {},
  }));
  const authorizer: ChannelOwnerAuthorization = {
    async assertOwner(receivedScope, actorId): Promise<void> {
      if (
        receivedScope.workspaceId !== targetScope.workspaceId
        || receivedScope.channelId !== targetScope.channelId
        || actorId !== "actor-consumed-owner"
      ) {
        throw new Error("Channel Owner authorization denied");
      }
    },
  };
  const sourceRepository = createChannelMemoryRepository({
    eventStore,
    scope: targetScope,
    authorization: authorizer,
    runProfileSnapshot: sourceProfile,
    createEventId: (() => {
      let index = 0;
      return () => `event-memory-consumed-${++index}`;
    })(),
  });
  const memoryContent = "Consumed transcript Memory remains historical input.";
  await sourceRepository.propose({
    id: "memory-consumed-reopen",
    content: memoryContent,
    sourceRunId: sourceRun.runId,
    sourceEventIds: ["event-memory-consumed-source"],
  });
  await sourceRepository.accept({
    candidateId: "memory-consumed-reopen",
    actorId: "actor-consumed-owner",
  });

  const command = parseStartRun({
    commandId: "command-memory-consumed-target",
    runId: "run-memory-consumed-target",
    surfaceId: "cowork",
    goal: memoryContent,
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    source: { eventId: "event-memory-consumed-target-source" },
    runProfile: { id: targetProfile.id, version: targetProfile.version },
    runProfileSnapshot: targetProfile,
    budget: targetProfile.budget,
    permissionScope: "permission-memory-consumed-target",
    stopCondition: targetProfile.terminalRules.stopCondition,
  });
  await scoped.claimStart(command);
  await scoped.append(parseCanonicalEvent({
    id: "event-memory-consumed-target-queued",
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    streamId: command.runId,
    seq: 0,
    type: "run.queued",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { phase: "queued" },
  }));

  const hostLoader = createHostMemoryContextLoader({ eventStore });
  const provider = fauxProvider();
  let firstModelCalls = 0;
  let resolveTranscriptPersisted: (() => void) | undefined;
  const transcriptPersisted = new Promise<void>((resolve) => {
    resolveTranscriptPersisted = resolve;
  });
  let failureInjected = false;
  let transcriptEvents = 0;
  const firstToolGateway = createProductionToolGateway({
    eventStore,
    command,
    workspaceRoot: directory,
  });
  const failingSink: EventSink & { read: typeof scoped.read } = {
    read: scoped.read.bind(scoped),
    async append(event) {
      await scoped.append(event);
      if (event.type === "pi.transcript.message") {
        transcriptEvents += 1;
      }
      if (event.type === "pi.transcript.message" && transcriptEvents === 3 && !failureInjected) {
        failureInjected = true;
        resolveTranscriptPersisted?.();
        throw new Error("simulated loss after consumed transcript");
      }
    },
  };
  const firstKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: firstToolGateway,
    workerProfileId: targetProfile.workerProfileId,
    prepareContext: hostLoader,
    streamFn: () => {
      firstModelCalls += 1;
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage(
        fauxToolCall("read_only", { path: "notes.txt" }),
        { stopReason: "toolUse" },
      );
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  });
  const firstRun = firstKernel.start(command, failingSink, new AbortController().signal);
  await transcriptPersisted;
  await expect(firstRun).rejects.toThrow("simulated loss after consumed transcript");
  expect(firstModelCalls).toBe(1);
  const consumedBeforeReopen = await readRunEvents(eventStore, command.runId, targetScope);
  expect(consumedBeforeReopen.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
  expect(consumedBeforeReopen.filter((event) => event.type === "memory.hit")).toHaveLength(1);
  expect(consumedBeforeReopen.some((event) => event.type === "run.completed")).toBe(false);
  eventStore.close();

  const reopenedStore = new SqliteEventStore(eventStorePath);
  try {
    let resumedModelCalls = 0;
    let resumedPrompt = "";
    let resumedUserMessages = 0;
    const resumedKernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: createProductionToolGateway({
        eventStore: reopenedStore,
        command,
        workspaceRoot: directory,
      }),
      workerProfileId: targetProfile.workerProfileId,
      prepareContext: createHostMemoryContextLoader({ eventStore: reopenedStore }),
      streamFn: (_model, context) => {
        resumedModelCalls += 1;
        resumedPrompt = context.systemPrompt ?? "";
        resumedUserMessages = context.messages.filter((message) => message.role === "user").length;
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("Consumed Run resumed.");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });
    await expect(resumedKernel.start(
      command,
      reopenedStore.scope(targetScope),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    const resumedEvents = await readRunEvents(reopenedStore, command.runId, targetScope);
    expect(resumedModelCalls).toBe(1);
    expect(resumedPrompt).toContain(memoryContent);
    expect(resumedUserMessages).toBe(1);
    expect(resumedEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "memory.hit")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(resumedEvents.find((event) => event.type === "run.resumed")?.payload)
      .toEqual(expect.objectContaining({
        executionFingerprint: resumedEvents.find((event) => event.type === "run.started")?.payload
          && (resumedEvents.find((event) => event.type === "run.started")?.payload as Record<string, unknown>)
            .executionFingerprint,
      }));
    expect(resumedEvents.map((event) => event.seq)).toEqual(
      resumedEvents.map((_event, index) => index),
    );
    const toolEvents: CanonicalEvent[] = [];
    for (const streamId of await reopenedStore.scope(targetScope).listRunStreamIds(command.runId)) {
      for await (const event of reopenedStore.scope(targetScope).read(streamId)) {
        if (event.type === "tool.requested") {
          toolEvents.push(event);
        }
      }
    }
    expect(toolEvents).toHaveLength(1);
  } finally {
    reopenedStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reopens every preparation checkpoint through the actual Pi and production Gateway", async () => {
  for (const checkpoint of ["started", "projection", "partial-hit", "ready"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `anna-memory-checkpoint-${checkpoint}-`));
    const eventStorePath = join(directory, "events.sqlite");
    const eventStore = new SqliteEventStore(eventStorePath);
    await writeFile(join(directory, "notes.txt"), "Checkpoint tool fixture.\n", "utf8");
    const checkpointScope = {
      workspaceId: `workspace-memory-checkpoint-${checkpoint}`,
      channelId: `channel-memory-checkpoint-${checkpoint}`,
    } as ChannelScope;
    const contents = await seedCheckpointMemories(eventStore, checkpointScope, checkpoint);
    const targetProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "channel",
    );
    const command = parseStartRun({
      commandId: `command-memory-checkpoint-target-${checkpoint}`,
      runId: `run-memory-checkpoint-target-${checkpoint}`,
      surfaceId: "cowork",
      goal: "Checkpoint memory remains immutable.",
      workspaceId: checkpointScope.workspaceId,
      channelId: checkpointScope.channelId,
      source: { eventId: `event-memory-checkpoint-target-${checkpoint}-source` },
      runProfile: { id: targetProfile.id, version: targetProfile.version },
      runProfileSnapshot: targetProfile,
      budget: targetProfile.budget,
      permissionScope: `permission-memory-checkpoint-target-${checkpoint}`,
      stopCondition: targetProfile.terminalRules.stopCondition,
    });
    const targetEvents = eventStore.scope(checkpointScope);
    await targetEvents.claimStart(command);
    await targetEvents.append(parseCanonicalEvent({
      id: `event-memory-checkpoint-target-${checkpoint}-queued`,
      workspaceId: checkpointScope.workspaceId,
      channelId: checkpointScope.channelId,
      streamId: command.runId,
      seq: 0,
      type: "run.queued",
      timestamp: "2026-08-30T00:00:00.000Z",
      schemaVersion: 1,
      payload: { phase: "queued" },
    }));

    const hostLoader = createHostMemoryContextLoader({ eventStore });
    const firstGateway = createProductionToolGateway({
      eventStore,
      command,
      workspaceRoot: directory,
    });
    const firstProvider = fauxProvider();
    let firstModelCalls = 0;
    const firstPreparation = checkpoint === "projection"
      ? async (preparedCommand: typeof command, signal: AbortSignal) => {
        await hostLoader(preparedCommand, signal);
        throw new Error("simulated loss after private projection commit");
      }
      : hostLoader;
    let failureInjected = false;
    const firstSink: EventSink & { read: typeof targetEvents.read } = {
      read: targetEvents.read.bind(targetEvents),
      async append(event) {
        await targetEvents.append(event);
        const shouldFail = checkpoint === "started"
          ? event.type === "run.started"
          : checkpoint === "partial-hit"
            ? event.type === "memory.hit"
            : checkpoint === "ready"
              ? event.type === "run.context.ready"
              : false;
        if (shouldFail && !failureInjected) {
          failureInjected = true;
          throw new Error(`simulated loss after ${checkpoint}`);
        }
      },
    };
    const firstKernel = new PiLoopKernel({
      model: firstProvider.getModel(),
      toolGateway: firstGateway,
      workerProfileId: targetProfile.workerProfileId,
      prepareContext: firstPreparation,
      streamFn: () => {
        firstModelCalls += 1;
        throw new Error("checkpoint model must not start before recovery");
      },
    });
    await expect(firstKernel.start(command, firstSink, new AbortController().signal))
      .rejects.toThrow(checkpoint === "projection"
        ? "simulated loss after private projection commit"
        : `simulated loss after ${checkpoint}`);
    const afterCheckpoint = await readRunEvents(eventStore, command.runId, checkpointScope);
    expect(firstModelCalls).toBe(0);
    expect(afterCheckpoint.some((event) => event.type === "run.failed"
      || event.type === "run.completed")).toBe(false);
    if (checkpoint === "started") {
      await expect(eventStore.scope(checkpointScope).loadProjection(
        "harness-run-context-input",
        command.runId as never,
      )).resolves.toBeUndefined();
    } else {
      await expect(eventStore.scope(checkpointScope).loadProjection(
        "harness-run-context-input",
        command.runId as never,
      )).resolves.toBeDefined();
    }
    eventStore.close();

    const reopenedStore = new SqliteEventStore(eventStorePath);
    try {
      const resumedProvider = fauxProvider();
      let modelCalls = 0;
      let observedPrompt = "";
      let observedUserContent = "";
      let observedUserMessages = 0;
      const resumedKernel = new PiLoopKernel({
        model: resumedProvider.getModel(),
        toolGateway: createProductionToolGateway({
          eventStore: reopenedStore,
          command,
          workspaceRoot: directory,
        }),
        workerProfileId: targetProfile.workerProfileId,
        prepareContext: createHostMemoryContextLoader({ eventStore: reopenedStore }),
        streamFn: (_model, context) => {
          modelCalls += 1;
          observedPrompt = context.systemPrompt ?? "";
          observedUserMessages = context.messages.filter((message) => message.role === "user").length;
          const userMessage = context.messages.find((message) => message.role === "user");
          if (userMessage !== undefined && Array.isArray(userMessage.content)) {
            observedUserContent = userMessage.content
              .map((part) => "text" in part && typeof part.text === "string" ? part.text : "")
              .join("");
          }
          const stream = createAssistantMessageEventStream();
          const message = modelCalls === 1
            ? fauxAssistantMessage(
              fauxToolCall("read_only", { path: "notes.txt" }),
              { stopReason: "toolUse" },
            )
            : fauxAssistantMessage("Checkpoint recovery completed.");
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          return stream;
        },
      });
      await expect(resumedKernel.start(
        command,
        reopenedStore.scope(checkpointScope),
        new AbortController().signal,
      )).resolves.toEqual({ status: "completed" });
      const resumedEvents = await readRunEvents(reopenedStore, command.runId, checkpointScope);
      expect(modelCalls).toBe(2);
      expect(observedUserContent).toBe(command.goal);
      for (const content of contents) {
        expect(observedPrompt).toContain(content);
      }
      expect(observedUserMessages).toBe(1);
      expect(resumedEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
      expect(resumedEvents.filter((event) => event.type === "memory.hit")).toHaveLength(2);
      expect(resumedEvents.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
      expect(resumedEvents.map((event) => event.seq)).toEqual(
        resumedEvents.map((_event, index) => index),
      );
      const toolRequests: CanonicalEvent[] = [];
      for (const streamId of await reopenedStore.scope(checkpointScope).listRunStreamIds(command.runId)) {
        for await (const event of reopenedStore.scope(checkpointScope).read(streamId)) {
          const payload = event.payload;
          if (
            event.type === "tool.requested"
            && typeof payload === "object"
            && payload !== null
            && !Array.isArray(payload)
            && payload.runId === command.runId
          ) {
            toolRequests.push(event);
          }
        }
      }
      expect(toolRequests).toHaveLength(1);
    } finally {
      reopenedStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
