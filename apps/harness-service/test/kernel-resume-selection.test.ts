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

import {
  parseStartRun,
  createChannelMemoryRepository,
  parseCanonicalEvent,
  type ChannelOwnerAuthorization,
  type ChannelScope,
  type CanonicalEvent,
  type EventSink,
  type ResolvedRunProfile,
} from "@anna/harness-v2";
import { SqliteEventStore } from "@anna/event-store";
import {
  createPiKernelDescriptor,
  PiLoopKernel,
} from "@anna/pi-loop-kernel";

import { startHarnessService } from "../src/index";
import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
} from "../src/production";
import { createHostMemoryContextLoader } from "../src/host-memory-context";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";

const descriptorDrift = "f".repeat(64);

test.each(["legacy", "descriptor"] as const)(
  "SQLite reopen resumes the original %s Pi identity despite an OMP selector",
  async (profileKind) => {
    const directory = await mkdtemp(join(tmpdir(), "anna-kernel-resume-selection-"));
    const configPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const descriptor = await createPiKernelDescriptor();
    const profile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      profileKind === "descriptor" ? descriptor : undefined,
    );
    const command = commandFor(profile, `resume-${profileKind}`);
    const firstStore = new SqliteEventStore(eventStorePath);
    await firstStore.scope(command).claimStart(command);
    await firstStore.scope(command).append(queuedEvent(command));
    firstStore.close();
    await writeConfig(configPath, "omp");

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
        getApiKey: () => "fixture-key",
        streamFn: () => {
          modelCalls += 1;
          const stream = createAssistantMessageEventStream();
          const message = fauxAssistantMessage("resumed after selector change");
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
        now: () => 0,
      }),
    });
    const service = await startHarnessService({ runtime: live.runtime });

    try {
      const response = await fetch(
        `${service.url}/v2/surfaces/cowork/runs/${command.runId}/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspace_id: command.workspaceId,
            channel_id: command.channelId,
          }),
        },
      );
      expect(response.status).toBe(202);

      const events = await waitForTerminal(live, command);
      expect(modelCalls).toBe(1);
      expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(0);
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_event, index) => index),
      );
      expect(events.find((event) => event.type === "run.queued")).toBeDefined();
    } finally {
      await service.close();
      await live.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a validly hashed Pi identity drift rejects resume before new events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-kernel-identity-drift-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const descriptor = await createPiKernelDescriptor();
  const driftedDescriptor = {
    ...descriptor,
    adapterSource: { ...descriptor.adapterSource, sha256: descriptorDrift },
  };
  const profile = await createLiveProfile(
    "fixture-model",
    undefined,
    false,
    "general",
    "none",
    driftedDescriptor,
  );
  const command = commandFor(profile, "identity-drift");
  const firstStore = new SqliteEventStore(eventStorePath);
  await firstStore.scope(command).claimStart(command);
  await firstStore.scope(command).append(queuedEvent(command));
  firstStore.close();
  await writeConfig(configPath, "pi");

  let kernelStarted = false;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: () => ({
      async start() {
        kernelStarted = true;
        throw new Error("identity mismatch must stop before Pi start");
      },
      async steer() {},
      async answer() {},
      async abort() {},
    }),
  });
  const service = await startHarnessService({ runtime: live.runtime });

  try {
    const response = await fetch(
      `${service.url}/v2/surfaces/cowork/runs/${command.runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: command.workspaceId,
          channel_id: command.channelId,
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "kernel_unavailable",
      requested_adapter: "pi",
      reason: "kernel_identity_mismatch",
    });
    expect(kernelStarted).toBe(false);
    const events: CanonicalEvent[] = [];
    for await (const event of live.eventStore.scope(command).read(command.runId)) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["run.queued"]);
  } finally {
    await service.close();
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production HTTP resumes a consumed Pi transcript with its Host snapshot and usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-kernel-consumed-resume-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const targetScope: ChannelScope = {
    workspaceId: "workspace-kernel-consumed",
    channelId: "channel-kernel-consumed",
  };
  await writeFile(join(directory, "notes.txt"), "Consumed transcript fixture.\n", "utf8");
  const descriptor = await createPiKernelDescriptor();
  const eventStore = new SqliteEventStore(eventStorePath);
  const sourceProfile = resolvedRunProfileFixture({
    id: "profile-kernel-consumed-source",
    memoryPolicy: { read: "channel", write: "propose" },
  });
  const sourceRun = parseStartRun({
    commandId: "command-kernel-consumed-source",
    runId: "run-kernel-consumed-source",
    goal: "Seed release notes Memory.",
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    source: { eventId: "event-kernel-consumed-source" },
    runProfile: { id: sourceProfile.id, version: sourceProfile.version },
    runProfileSnapshot: sourceProfile,
    budget: sourceProfile.budget,
    permissionScope: "permission-kernel-consumed-source",
    stopCondition: sourceProfile.terminalRules.stopCondition,
  });
  const scoped = eventStore.scope(targetScope);
  await scoped.claimStart(sourceRun);
  await scoped.append(parseCanonicalEvent({
    id: "event-kernel-consumed-source-completed",
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    streamId: sourceRun.runId,
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { outcome: "completed" },
  }));
  const authorization: ChannelOwnerAuthorization = {
    async assertOwner(scope, actorId): Promise<void> {
      if (
        scope.workspaceId !== targetScope.workspaceId
        || scope.channelId !== targetScope.channelId
        || actorId !== "actor-kernel-consumed-owner"
      ) {
        throw new Error("Channel Owner authorization denied");
      }
    },
  };
  const memoryRepository = createChannelMemoryRepository({
    eventStore,
    scope: targetScope,
    authorization,
    runProfileSnapshot: sourceProfile,
  });
  const memoryContent = "Release notes require owner review before publication.";
  await memoryRepository.propose({
    id: "memory-kernel-consumed",
    content: memoryContent,
    sourceRunId: sourceRun.runId,
    sourceEventIds: ["event-kernel-consumed-source-completed"],
  });
  await memoryRepository.accept({
    candidateId: "memory-kernel-consumed",
    actorId: "actor-kernel-consumed-owner",
  });

  const targetProfile = await createLiveProfile(
    "fixture-model",
    undefined,
    false,
    "general",
    "channel",
    descriptor,
  );
  const command = parseStartRun({
    commandId: "command-kernel-consumed-target",
    runId: "run-kernel-consumed-target",
    surfaceId: "cowork",
    goal: memoryContent,
    workspaceId: targetScope.workspaceId,
    channelId: targetScope.channelId,
    source: { eventId: "event-kernel-consumed-target-source" },
    runProfile: { id: targetProfile.id, version: targetProfile.version },
    runProfileSnapshot: targetProfile,
    budget: targetProfile.budget,
    permissionScope: "permission-kernel-consumed-target",
    stopCondition: targetProfile.terminalRules.stopCondition,
  });
  await scoped.claimStart(command);
  await scoped.append(queuedEvent(command));

  const provider = fauxProvider();
  let firstModelCalls = 0;
  let injectedFailure = false;
  const firstGateway = createProductionToolGateway({
    eventStore,
    command,
    workspaceRoot: directory,
  });
  const failingSink: EventSink & { read: typeof scoped.read } = {
    read: scoped.read.bind(scoped),
    async append(event) {
      await scoped.append(event);
      if (event.type === "run.usage.updated" && !injectedFailure) {
        injectedFailure = true;
        throw new Error("simulated loss after consumed transcript");
      }
    },
  };
  const firstMessage = fauxAssistantMessage(
    fauxToolCall("read_only", { path: "notes.txt" }),
    { stopReason: "toolUse" },
  );
  Object.assign(firstMessage, { usage: { input: 11, output: 7, totalTokens: 18 } });
  const firstKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: firstGateway,
    workerProfileId: targetProfile.workerProfileId,
    prepareContext: createHostMemoryContextLoader({ eventStore }),
    streamFn: () => {
      firstModelCalls += 1;
      if (firstModelCalls > 1) {
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("provider boundary response");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      }
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: firstMessage });
      stream.push({ type: "done", reason: "toolUse", message: firstMessage });
      return stream;
    },
    now: () => 0,
  });
  await expect(firstKernel.start(command, failingSink, new AbortController().signal))
    .rejects.toThrow("simulated loss after consumed transcript");
  expect(firstModelCalls).toBe(1);
  const beforeReopen = await readRunEvents(eventStore, command.runId, targetScope);
  expect(beforeReopen.some((event) => event.type === "memory.hit")).toBe(true);
  expect(beforeReopen.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
  expect(beforeReopen.some((event) => event.type === "run.completed")).toBe(false);
  expect(beforeReopen.filter((event) => event.type === "run.usage.updated")).toHaveLength(1);
  expect(beforeReopen.find((event) => event.type === "run.usage.updated")?.payload)
    .toEqual(expect.objectContaining({
      cumulative: expect.objectContaining({ input: 11, output: 7 }),
    }));
  const storedHash = command.runProfileSnapshot.hash;
  eventStore.close();

  await writeConfig(configPath, "omp");
  const reopenedProvider = fauxProvider();
  let resumedModelCalls = 0;
  let resumedUserMessages = 0;
  let resumedPrompt = "";
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
      model: reopenedProvider.getModel(),
      createToolGateway: toolGatewayFor,
      prepareContext,
      workerProfileId,
      streamFn: (_model, context) => {
        resumedModelCalls += 1;
        resumedUserMessages = context.messages.filter((message) => message.role === "user").length;
        resumedPrompt = context.systemPrompt ?? "";
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("Recovered consumed Pi Run.");
        Object.assign(message, { usage: { input: 13, output: 9, totalTokens: 22 } });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
      now: () => 0,
    }),
  });
  const service = await startHarnessService({ runtime: live.runtime });
  try {
    const response = await fetch(
      `${service.url}/v2/surfaces/cowork/runs/${command.runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: command.workspaceId,
          channel_id: command.channelId,
        }),
      },
    );
    expect(response.status).toBe(202);
    const events = await waitForTerminal(live, command, targetScope);
    const persistedCommand = await live.eventStore.scope(targetScope).getRunCommand(command.runId);
    expect(persistedCommand?.runProfileSnapshot.hash).toBe(storedHash);
    expect(persistedCommand?.runProfileSnapshot).toEqual(command.runProfileSnapshot);
    expect(resumedModelCalls).toBe(1);
    expect(resumedUserMessages).toBe(1);
    expect(resumedPrompt).toContain(memoryContent);
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "memory.hit")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.completed");
    const usage = events.filter((event) => event.type === "run.usage.updated").at(-1);
    expect(usage?.payload).toEqual(expect.objectContaining({
      cumulative: expect.objectContaining({ input: 24, output: 16 }),
    }));
    expect(events.filter((event) => event.type === "pi.transcript.message").filter((event) => {
      const payload = event.payload;
      return typeof payload === "object"
        && payload !== null
        && !Array.isArray(payload)
        && typeof payload.message === "object"
        && payload.message !== null
        && !Array.isArray(payload.message)
        && payload.message.role === "user";
    })).toHaveLength(1);
    expect(await countToolRequests(live.eventStore, command, targetScope)).toBe(1);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_event, index) => index),
    );
  } finally {
    await service.close();
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function commandFor(profile: ResolvedRunProfile, suffix: string) {
  return parseStartRun({
    workspaceId: `workspace-kernel-${suffix}`,
    channelId: `channel-kernel-${suffix}`,
    commandId: `command-kernel-${suffix}`,
    runId: `run-kernel-${suffix}`,
    goal: "Resume the persisted Pi Run.",
    source: { eventId: `event-kernel-${suffix}-source` },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: `permission-kernel-${suffix}`,
    stopCondition: profile.terminalRules.stopCondition,
  });
}

async function writeConfig(path: string, selector: unknown): Promise<void> {
  await writeFile(path, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: selector,
  }), "utf8");
}

function queuedEvent(command: { runId: string; workspaceId: string; channelId: string }): CanonicalEvent {
  return {
    id: `event-${command.runId}-queued` as never,
    workspaceId: command.workspaceId as never,
    channelId: command.channelId as never,
    streamId: command.runId as never,
    seq: 0,
    type: "run.queued",
    timestamp: "2026-08-30T00:00:00.000Z",
    schemaVersion: 1,
    payload: { phase: "queued" },
  };
}

async function readRunEvents(
  eventStore: SqliteEventStore,
  runId: string,
  scope: ChannelScope,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of eventStore.scope(scope).read(runId as never)) {
    events.push(event);
  }
  return events;
}

async function waitForTerminal(
  live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>>,
  command: { runId: string; workspaceId: string; channelId: string },
  scope: ChannelScope = {
    workspaceId: command.workspaceId,
    channelId: command.channelId,
  },
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const events: CanonicalEvent[] = [];
    for await (const event of live.eventStore.scope(scope).read(command.runId as never)) {
      events.push(event);
    }
    if (events.some((event) => event.type === "run.completed" || event.type === "run.failed")) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Pi resume did not reach a terminal event");
}

async function countToolRequests(
  eventStore: SqliteEventStore,
  command: { runId: string; workspaceId: string; channelId: string },
  scope: ChannelScope,
): Promise<number> {
  let count = 0;
  const scoped = eventStore.scope(scope);
  for (const streamId of await scoped.listRunStreamIds(command.runId as never)) {
    for await (const event of scoped.read(streamId)) {
      if (
        event.type === "tool.requested"
        && typeof event.payload === "object"
        && event.payload !== null
        && !Array.isArray(event.payload)
        && event.payload.runId === command.runId
      ) {
        count += 1;
      }
    }
  }
  return count;
}
