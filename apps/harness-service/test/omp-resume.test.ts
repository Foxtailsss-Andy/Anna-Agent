import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { expect, test, vi } from "vitest";
import { SqliteEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  loadSkillCatalogEntry,
  parseStartRun,
  parseCanonicalEvent,
  resolveRunProfile,
  type CanonicalEvent,
  type EventSink,
  type RunProfileId,
  type StreamId,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import {
  OMP_RESUME_FIXTURE_WALL_TIME_MS,
  withAmpleRunBudget,
} from "./omp-resume-profile-fixture";

import { startHarnessService } from "../src/index";
import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
} from "../src/production";
import { createHostMemoryContextLoader } from "../src/host-memory-context";
import { measureOmpImplementation } from "../../../packages/omp-loop-kernel/src/kernel-source";
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("restores a consumed OMP transcript after tool-result checkpoint loss and SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume";
  const runId = "run-omp-resume";
  const workspaceId = "workspace-omp-resume";
  const channelId = "channel-omp-resume";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "release notes content", "utf8");
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "channel",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const durable = firstStore.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));

    const sourceProfile = withAmpleRunBudget(resolvedRunProfileFixture({
      memoryPolicy: { read: "channel", write: "propose" },
    }));
    const source = parseStartRun({
      workspaceId,
      channelId,
      commandId: "memory-source-command",
      runId: "memory-source-run",
      goal: "Record release notes guidance.",
      source: { eventId: "memory-source-event" },
      runProfile: { id: sourceProfile.id, version: sourceProfile.version },
      runProfileSnapshot: sourceProfile,
      budget: sourceProfile.budget,
      permissionScope: "permission-memory-source",
      stopCondition: sourceProfile.terminalRules.stopCondition,
    });
    await firstStore.scope(source).claimStart(source);
    await firstStore.scope(source).append(parseCanonicalEvent({
      id: "memory-source-completed",
      workspaceId,
      channelId,
      streamId: source.runId,
      seq: 0,
      type: "run.completed",
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      payload: { outcome: "completed" },
    }));
    const memories = createChannelMemoryRepository({
      eventStore: firstStore,
      scope: source,
      runProfileSnapshot: sourceProfile,
      authorization: {
        async assertOwner(scope, actorId) {
          if (scope.workspaceId !== workspaceId || scope.channelId !== channelId || actorId !== "owner") {
            throw new Error("Memory owner denied");
          }
        },
      },
    });
    await memories.propose({
      id: "resume-memory",
      content: "Original release notes memory.",
      sourceRunId: source.runId,
      sourceEventIds: ["memory-source-completed"],
    });
    await memories.accept({ candidateId: "resume-memory", actorId: "owner" });

    const prepareContext = createHostMemoryContextLoader({ eventStore: firstStore });
    let modelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      prepareContext,
      modelTransport: async function* (context) {
        modelCalls += 1;
        expect(context.systemPrompt).toContain("Original release notes memory.");
        if (modelCalls === 1) {
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [{
                type: "toolCall" as const,
                id: "resume-read-call",
                name: "read_only",
                arguments: { path: "release-notes.md" },
              }],
              stopReason: "toolUse" as const,
            },
          };
          return;
        }
        expect(JSON.stringify(context.messages)).toContain("release notes content");
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Release notes summarized." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });

    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        await durable.append(event);
        const payload = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as { readonly message?: unknown }
          : undefined;
        const message = payload?.message;
        if (
          event.type === "omp.transcript.message"
          && message !== null
          && typeof message === "object"
          && !Array.isArray(message)
          && (message as { readonly role?: unknown }).role === "toolResult"
        ) {
          throw new Error("simulated persistence loss after tool result ACK");
        }
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated persistence loss after tool result ACK");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(beforeLoss.some((event) => event.type === "omp.transcript.message")).toBe(true);
    expect(beforeLoss.some((event) => event.type === "run.completed")).toBe(false);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(3);
    expect(modelCalls).toBe(1);
    await memories.edit({
      memoryId: "resume-memory",
      content: "Edited current memory must not replace the original snapshot.",
      actorId: "owner",
    });

    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    const configPath = join(directory, "runtime.json");
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
      harness_v2_omp_runtime_root: runtimeRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    let resumedModelCalls = 0;
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      ompModelTransport: async function* (context) {
        resumedModelCalls += 1;
        expect(context.systemPrompt).toContain("Original release notes memory.");
        expect(context.systemPrompt).not.toContain("Edited current memory");
        expect(JSON.stringify(context.messages)).toContain("release notes content");
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Recovered release notes." }],
            stopReason: "stop" as const,
          },
        };
      },
    });
    service = await startHarnessService({ runtime: live.runtime });

    const response = await fetch(
      `${service.url}/v2/surfaces/cowork/runs/${runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, channel_id: channelId }),
      },
    );
    const responseBody = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(responseBody)).toBe(202);
    let resumedEvents: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      resumedEvents = await readRunEvents(live.eventStore as SqliteEventStore, command);
      if (resumedEvents.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(resumedEvents.at(-1)?.type, JSON.stringify(resumedEvents.map((event) => event.type)))
      .toBe("run.completed");
    expect(resumedModelCalls).toBe(1);
    const transcriptEvents = resumedEvents.filter((event) => event.type === "omp.transcript.message");
    expect(transcriptEvents.filter((event) => {
      const payload = event.payload as { readonly message?: { readonly role?: unknown } };
      return payload.message?.role === "user";
    })).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "memory.hit")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.model.requested")).toHaveLength(2);
    expect(resumedEvents.filter((event) => event.type === "omp.model.response")).toHaveLength(2);
    expect(resumedEvents.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "omp.tool.response")).toHaveLength(1);
    expect(transcriptEvents).toHaveLength(4);
    const evalEvents = resumedEvents.filter((event) => event.type === "run.eval.contract");
    const terminalEvents = resumedEvents.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type));
    expect(evalEvents).toHaveLength(1);
    expect(terminalEvents).toHaveLength(1);
    expect(resumedEvents.at(-2)?.type).toBe("run.eval.contract");
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
    expect(resumedEvents.map((event) => event.seq)).toEqual(
      resumedEvents.map((_event, index) => index),
    );
    expect(resumedEvents.find((event) => event.type === "run.started")?.payload)
      .toEqual(beforeLoss.find((event) => event.type === "run.started")?.payload);
    const toolEvents: CanonicalEvent[] = [];
    for await (const event of (live.eventStore as SqliteEventStore).scope(command).read(
      `tool:${runId}:resume-read-call` as unknown as StreamId,
    )) {
      toolEvents.push(event);
    }
    expect(toolEvents.filter((event) => event.type === "tool.requested")).toHaveLength(1);
  } finally {
    await service?.close().catch(() => undefined);
    await live?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test("finalizes a durable completed assistant tail without another OMP model call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-tail-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-tail";
  const runId = "run-omp-resume-tail";
  const workspaceId = "workspace-omp-resume-tail";
  const channelId = "channel-omp-resume-tail";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-tail" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-tail",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Release notes are summarized." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.completed") throw new Error("simulated terminal persistence loss");
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated terminal persistence loss");
    expect(firstModelCalls).toBe(1);
    expect((await readRunEvents(firstStore, command)).filter((event) => event.type === "omp.transcript.message"))
      .toHaveLength(2);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("completed assistant restore must not call the model");
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: resumedStore!,
        command,
        workspaceRoot,
      }),
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    expect(resumedModelCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test("fails closed when a durable tool dispatch has no response checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-fence-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-fence";
  const runId = "run-omp-resume-fence";
  const workspaceId = "workspace-omp-resume-fence";
  const channelId = "channel-omp-resume-fence";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "release notes fence content", "utf8");
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-fence" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-fence",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstToolCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "fence-read-call",
              name: "read_only",
              arguments: { path: "release-notes.md" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: firstStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            firstToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.tool.response") {
          throw new Error("simulated tool response checkpoint loss");
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated tool response checkpoint loss");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(firstToolCalls).toBe(1);
    expect(beforeLoss.some((event) => event.type === "omp.tool.dispatch")).toBe(true);
    expect(beforeLoss.some((event) => event.type === "omp.tool.response")).toBe(false);
    expect(beforeLoss.some((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))).toBe(false);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("indeterminate restore must not call the model");
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: resumedStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            resumedToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "failed" });
    expect(resumedModelCalls).toBe(0);
    expect(resumedToolCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.at(-1)?.type).toBe("run.failed");
    expect((resumedEvents.at(-1)?.payload as { readonly reason?: unknown }).reason)
      .toBe("indeterminate_recovery");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("does not enter Gateway when cancellation wins after the dispatch fence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-dispatch-cancel-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-dispatch-cancel";
  const runId = "run-omp-dispatch-cancel";
  const workspaceId = "workspace-omp-dispatch-cancel";
  const channelId = "channel-omp-dispatch-cancel";
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;
  let releaseFence!: () => void;
  let fenceEntered = false;
  const fencePaused = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  let resolveFenceEntered!: () => void;
  const fenceEnteredPromise = new Promise<void>((resolve) => {
    resolveFenceEntered = resolve;
  });
  const controller = new AbortController();
  let completion: Promise<unknown> | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "dispatch-cancel.txt"), "cancel after fence", "utf8");
    const profile = withAmpleRunBudget(
      await createLiveProfile("fixture-model", undefined, false, "general", "none", descriptor),
    );
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Read the dispatch cancellation fixture.",
      source: { eventId: "source-omp-dispatch-cancel" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-dispatch-cancel",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let gatewayCalls = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "dispatch-cancel-call",
              name: "read_only",
              arguments: { path: "dispatch-cancel.txt" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => ({
        execute: async () => {
          gatewayCalls += 1;
          return { status: "succeeded" as const, output: { unexpected: true } };
        },
      }),
    });
    const sink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.tool.dispatch") {
          fenceEntered = true;
          resolveFenceEntered();
          await fencePaused;
        }
        await durable.append(event);
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };
    completion = kernel.start(command, sink, controller.signal);
    await waitForGateEntry(
      fenceEnteredPromise,
      completion,
      "dispatch cancellation",
      () => ({ fenceEntered }),
    );
    expect(fenceEntered).toBe(true);
    controller.abort("cancelled");
    releaseFence();

    await expect(completion).resolves.toEqual({ status: "cancelled" });
    expect(gatewayCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  } finally {
    controller.abort("test-cleanup");
    releaseFence();
    await completion?.catch(() => undefined);
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("does not enter Gateway when the wall budget expires after the dispatch fence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-dispatch-timeout-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-dispatch-timeout";
  const runId = "run-omp-dispatch-timeout";
  const workspaceId = "workspace-omp-dispatch-timeout";
  const channelId = "channel-omp-dispatch-timeout";
  const realDateNow = Date.now.bind(Date);
  const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(realDateNow);
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;
  let releaseFence!: () => void;
  let fenceEntered = false;
  const fencePaused = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  let resolveFenceEntered!: () => void;
  const fenceEnteredPromise = new Promise<void>((resolve) => {
    resolveFenceEntered = resolve;
  });
  const controller = new AbortController();
  let completion: Promise<unknown> | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "dispatch-timeout.txt"), "timeout after fence", "utf8");
    const profile = await createLiveProfile("fixture-model", undefined, false, "general", "none", descriptor);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Read the dispatch timeout fixture.",
      source: { eventId: "source-omp-dispatch-timeout" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-dispatch-timeout",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let gatewayCalls = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "dispatch-timeout-call",
              name: "read_only",
              arguments: { path: "dispatch-timeout.txt" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => ({
        execute: async () => {
          gatewayCalls += 1;
          return { status: "succeeded" as const, output: { unexpected: true } };
        },
      }),
    });
    const sink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.tool.dispatch") {
          fenceEntered = true;
          resolveFenceEntered();
          await fencePaused;
        }
        await durable.append(event);
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };
    completion = kernel.start(command, sink, controller.signal);
    await waitForGateEntry(
      fenceEnteredPromise,
      completion,
      "dispatch wall expiry",
      () => ({ fenceEntered }),
    );
    expect(fenceEntered).toBe(true);
    dateNowSpy.mockImplementation(() => realDateNow() + (command.budget.wallTimeMs ?? 0) + 1);
    releaseFence();

    await expect(completion).resolves.toEqual({ status: "timed_out" });
    expect(gatewayCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.timed_out");
    expect(events.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
  } finally {
    controller.abort("test-cleanup");
    releaseFence();
    await completion?.catch(() => undefined);
    dateNowSpy.mockRestore();
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("rejects a malformed Host model reply before persisting its response checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-invalid-model-response-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-invalid-model-response";
  const runId = "run-omp-invalid-model-response";
  const workspaceId = "workspace-omp-invalid-model-response";
  const channelId = "channel-omp-invalid-model-response";
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;
  let toolCalls = 0;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const profile = withAmpleRunBudget(
      await createLiveProfile("fixture-model", undefined, false, "general", "none", descriptor),
    );
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Reject the malformed model fixture.",
      source: { eventId: "source-omp-invalid-model-response" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-invalid-model-response",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let modelCalls = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        modelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant",
            content: [],
            stopReason: "malformed-stop-reason",
          } as never,
        };
      },
      createToolGateway: () => ({
        execute: async () => {
          toolCalls += 1;
          throw new Error("malformed model reply must stop before tool I/O");
        },
      }),
    });
    await expect(kernel.start(command, durable, new AbortController().signal)).rejects.toThrow();
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.filter((event) => event.type === "run.model.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "omp.model.response")).toHaveLength(0);
    expect(events.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(0);
    expect(events.filter((event) => event.type === "omp.transcript.message")).toHaveLength(1);
  } finally {
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("restores prepared Host Memory input through production HTTP without duplicate preparation", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "anna-omp-prepared-matrix-"));
  const runtimeRoot = join(fixtureDirectory, "runtime");
  const descriptor = await materializeRuntime(runtimeRoot);

  try {
    for (const state of ["started-only", "projection-only", "partial-hit", "ready-before-user"] as const) {
      const result = await runPreparedRestoreCase(state, runtimeRoot, descriptor);
      expect(result.modelCalls, state).toBe(1);
      expect(result.prepareCalls, state).toBe(state === "started-only" ? 0 : 1);
      expect(result.events.filter((event) => event.type === "run.started"), state).toHaveLength(1);
      expect(result.events.filter((event) => event.type === "run.context.ready"), state).toHaveLength(1);
      expect(result.events.filter((event) => event.type === "memory.hit"), state).toHaveLength(2);
      expect(result.events.filter((event) => event.type === "run.resumed"), state).toHaveLength(0);
      expect(result.events.filter((event) => event.type === "run.model.requested"), state).toHaveLength(1);
      expect(result.events.filter((event) => event.type === "omp.model.response"), state).toHaveLength(1);
      expect(result.events.filter((event) => event.type === "omp.transcript.message"), state).toHaveLength(2);
      expect(result.events.filter((event) => {
        const payload = event.payload as { readonly message?: { readonly role?: unknown } };
        return payload.message?.role === "user";
      }), state).toHaveLength(1);
      const evalEvents = result.events.filter((event) => event.type === "run.eval.contract");
      const terminals = result.events.filter((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type));
      expect(evalEvents, state).toHaveLength(1);
      expect(terminals, state).toHaveLength(1);
      expect(result.events.at(-2)?.type, state).toBe("run.eval.contract");
      expect(result.events.at(-1)?.type, state).toBe("run.completed");
      expect(result.events.map((event) => event.seq), state).toEqual(
        result.events.map((_event, index) => index),
      );
      const startedPayload = result.events.find((event) => event.type === "run.started")?.payload;
      expect(startedPayload, state).toEqual(result.originalStartedPayload);
      expect((startedPayload as { readonly budgetStartedAt?: unknown }).budgetStartedAt, state)
        .toEqual(result.originalBudgetStartedAt);

      const expectedMemory = state === "started-only"
        ? `Edited current prepare restore matrix release guidance memory one.`
        : `Original prepared restore matrix release guidance memory one.`;
      expect(result.modelContextSystemPrompt, state).toContain(expectedMemory);
      if (state === "partial-hit" || state === "ready-before-user") {
        const missingProjection = await runMissingProjectionResume(
          state,
          result.historyBeforeResume,
          result.command,
          runtimeRoot,
          descriptor,
        );
        expect(missingProjection.modelCalls, `${state} missing projection`).toBe(0);
        expect(missingProjection.events.filter((event) => event.type === "omp.transcript.message"), state)
          .toHaveLength(0);
        expect(missingProjection.events.at(-1)?.type, state).toBe("run.failed");
      }
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}, 300_000);

test("fails closed on a tampered started fingerprint for a read-none HTTP resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-started-fingerprint-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const configPath = join(directory, "runtime.json");
  const descriptor = await materializeRuntime(runtimeRoot);
  const commandId = "command-omp-started-fingerprint";
  const runId = "run-omp-started-fingerprint";
  const workspaceId = "workspace-omp-started-fingerprint";
  const channelId = "channel-omp-started-fingerprint";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;

  try {
    await mkdir(workspaceRoot, { recursive: true });
    const profile = withAmpleRunBudget(
      await createLiveProfile("fixture-model", undefined, false, "general", "none", descriptor),
    );
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      surfaceId: "cowork",
      goal: "Recover the fingerprint fixture.",
      source: { eventId: "source-omp-started-fingerprint" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-started-fingerprint",
      stopCondition: profile.terminalRules.stopCondition,
    });
    firstStore = new SqliteEventStore(eventStorePath);
    const durable = firstStore.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        throw new Error("tampered started fingerprint must stop before model I/O");
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("tampered started fingerprint must stop before tool I/O");
        },
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.started") {
          const payload = event.payload as Record<string, unknown>;
          await durable.append({
            ...event,
            payload: { ...payload, executionFingerprint: "tampered-started-fingerprint" },
          } as CanonicalEvent);
          throw new Error("simulated started fingerprint persistence loss");
        }
        await durable.append(event);
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated started fingerprint persistence loss");
    const beforeResume = await readRunEvents(firstStore, command);
    expect(beforeResume.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(beforeResume.filter((event) => event.type === "omp.transcript.message")).toHaveLength(0);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
      harness_v2_omp_runtime_root: runtimeRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    let modelCalls = 0;
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      ompModelTransport: async function* () {
        modelCalls += 1;
        throw new Error("tampered started fingerprint must stop before model I/O");
      },
    });
    service = await startHarnessService({ runtime: live.runtime });
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, channel_id: channelId }),
    });
    expect(response.status).toBe(202);
    let resumedEvents: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      resumedEvents = await readRunEvents(live.eventStore as SqliteEventStore, command);
      if (resumedEvents.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    expect(modelCalls).toBe(0);
    expect(resumedEvents.filter((event) => event.type === "omp.transcript.message")).toHaveLength(0);
    expect(resumedEvents.at(-1)?.type).toBe("run.failed");
    expect(resumedEvents.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
  } finally {
    await service?.close().catch(() => undefined);
    await live?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("expires a queued-only OMP resume from the original queued wall origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-queued-expired-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const configPath = join(directory, "runtime.json");
  const descriptor = await materializeRuntime(runtimeRoot);
  const commandId = "command-omp-queued-expired";
  const runId = "run-omp-queued-expired";
  const workspaceId = "workspace-omp-queued-expired";
  const channelId = "channel-omp-queued-expired";
  let store: SqliteEventStore | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;

  try {
    await mkdir(workspaceRoot, { recursive: true });
    const profile = createToolBudgetProfile(descriptor, { wallTimeMs: 1 });
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      surfaceId: "cowork",
      goal: "Recover the expired queued fixture.",
      source: { eventId: "source-omp-queued-expired" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-queued-expired",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    const queuedAt = new Date(Date.now() - 60_000).toISOString();
    await durable.append({
      ...canonicalEvent(command, 0, "run.queued", { phase: "queued" }),
      timestamp: queuedAt,
    });
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
      harness_v2_omp_runtime_root: runtimeRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    let modelCalls = 0;
    let toolCalls = 0;
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      ompModelTransport: async function* () {
        modelCalls += 1;
        throw new Error("expired queued resume must stop before model I/O");
      },
    });
    service = await startHarnessService({ runtime: live.runtime });
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, channel_id: channelId }),
    });
    expect(response.status).toBe(202);
    let events: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      events = await readRunEvents(live.eventStore as SqliteEventStore, command);
      if (events.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    expect(modelCalls).toBe(0);
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.timed_out")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.model.requested")).toHaveLength(0);
    expect(events.filter((event) => event.type === "omp.transcript.message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("run.timed_out");
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
    const started = events.find((event) => event.type === "run.started");
    expect((started?.payload as { readonly budgetStartedAt?: unknown }).budgetStartedAt).toBe(queuedAt);
  } finally {
    await service?.close().catch(() => undefined);
    await live?.close();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("rechecks the wall budget after the model-request checkpoint ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-model-request-timeout-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-model-request-timeout";
  const runId = "run-omp-model-request-timeout";
  const workspaceId = "workspace-omp-model-request-timeout";
  const channelId = "channel-omp-model-request-timeout";
  const realDateNow = Date.now.bind(Date);
  const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(realDateNow);
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;
  let releaseRequest!: () => void;
  let requestEntered = false;
  const requestPaused = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let resolveRequestEntered!: () => void;
  const requestEnteredPromise = new Promise<void>((resolve) => {
    resolveRequestEntered = resolve;
  });
  const controller = new AbortController();
  let completion: Promise<unknown> | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const profile = await createLiveProfile("fixture-model", undefined, false, "general", "none", descriptor);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Read the model request timeout fixture.",
      source: { eventId: "source-omp-model-request-timeout" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-model-request-timeout",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let modelCalls = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        modelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "must not run after expired request" }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("expired model request must stop before tool I/O");
        },
      }),
    });
    const sink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.model.requested") {
          requestEntered = true;
          resolveRequestEntered();
          await requestPaused;
        }
        await durable.append(event);
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };
    completion = kernel.start(command, sink, controller.signal);
    await waitForGateEntry(
      requestEnteredPromise,
      completion,
      "model request wall expiry",
      () => ({ requestEntered }),
    );
    expect(requestEntered).toBe(true);
    dateNowSpy.mockImplementation(() => realDateNow() + (command.budget.wallTimeMs ?? 0) + 1);
    releaseRequest();

    await expect(completion).resolves.toEqual({ status: "timed_out" });
    expect(modelCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.filter((event) => event.type === "run.model.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "omp.model.response")).toHaveLength(0);
    expect(events.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.timed_out");
  } finally {
    controller.abort("test-cleanup");
    releaseRequest();
    await completion?.catch(() => undefined);
    dateNowSpy.mockRestore();
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

type PreparedRestoreState = "started-only" | "projection-only" | "partial-hit" | "ready-before-user";
type OmpTestDescriptor = Awaited<ReturnType<typeof materializeRuntime>>;

interface PreparedRestoreCaseResult {
  readonly command: ReturnType<typeof parseStartRun>;
  readonly events: CanonicalEvent[];
  readonly historyBeforeResume: CanonicalEvent[];
  readonly originalStartedPayload: CanonicalEvent["payload"];
  readonly originalBudgetStartedAt: unknown;
  readonly modelCalls: number;
  readonly prepareCalls: number;
  readonly modelContextSystemPrompt: string;
}

async function runPreparedRestoreCase(
  state: PreparedRestoreState,
  runtimeRoot: string,
  descriptor: OmpTestDescriptor,
): Promise<PreparedRestoreCaseResult> {
  const directory = await mkdtemp(join(tmpdir(), `anna-omp-prepared-${state}-`));
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const configPath = join(directory, "runtime.json");
  const workspaceId = `workspace-omp-prepared-${state}`;
  const channelId = `channel-omp-prepared-${state}`;
  const commandId = `command-omp-prepared-${state}`;
  const runId = `run-omp-prepared-${state}`;
  const goal = "Prepare restore matrix release guidance.";
  const originalMemory = "Original prepared restore matrix release guidance memory one.";
  const editedMemory = "Edited current prepare restore matrix release guidance memory one.";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let firstPrepareCalls = 0;
  let modelCalls = 0;
  let modelContextSystemPrompt = "";

  try {
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "channel",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      surfaceId: "cowork",
      goal,
      source: { eventId: `source-${runId}` },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: `permission-${runId}`,
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const durable = firstStore.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    const memories = await seedPreparedMemories(firstStore, command, originalMemory);
    const hostLoader = createHostMemoryContextLoader({ eventStore: firstStore });
    const prepareContext = async (input: typeof command, signal: AbortSignal) => {
      firstPrepareCalls += 1;
      return hostLoader(input, signal);
    };
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      prepareContext,
      modelTransport: async function* () {
        modelCalls += 1;
        throw new Error("prepared restore interruption must occur before model I/O");
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("prepared restore interruption must occur before tool I/O");
        },
      }),
    });

    let memoryHitCount = 0;
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (state === "started-only" && event.type === "run.started") {
          await durable.append(event);
          throw new Error("prepared started-only interruption");
        }
        if (state === "projection-only" && event.type === "memory.hit") {
          throw new Error("prepared projection-only interruption");
        }
        if (state === "partial-hit" && event.type === "memory.hit") {
          memoryHitCount += 1;
          if (memoryHitCount === 2) throw new Error("prepared partial-hit interruption");
        }
        if (state === "ready-before-user" && event.type === "omp.transcript.message") {
          const payload = event.payload as { readonly message?: { readonly role?: unknown } };
          if (payload.message?.role === "user") throw new Error("prepared ready-before-user interruption");
        }
        await durable.append(event);
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal)).rejects.toThrow(
      `prepared ${state} interruption`,
    );
    expect(modelCalls, state).toBe(0);
    const historyBeforeResume = await readRunEvents(firstStore, command);
    expect(historyBeforeResume.some((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type)), state).toBe(false);
    const originalStarted = historyBeforeResume.find((event) => event.type === "run.started");
    if (originalStarted === undefined) throw new Error(`missing started event for ${state}`);
    const originalBudgetStartedAt = (originalStarted.payload as { readonly budgetStartedAt?: unknown }).budgetStartedAt;
    if (state === "started-only" || state === "projection-only") {
      expect(historyBeforeResume.filter((event) => event.type === "memory.hit"), state).toHaveLength(0);
      expect(historyBeforeResume.filter((event) => event.type === "run.context.ready"), state).toHaveLength(0);
    }
    if (state === "partial-hit") {
      expect(historyBeforeResume.filter((event) => event.type === "memory.hit"), state).toHaveLength(1);
      expect(historyBeforeResume.filter((event) => event.type === "run.context.ready"), state).toHaveLength(0);
    }
    if (state === "ready-before-user") {
      expect(historyBeforeResume.filter((event) => event.type === "memory.hit"), state).toHaveLength(2);
      expect(historyBeforeResume.filter((event) => event.type === "run.context.ready"), state).toHaveLength(1);
      expect(historyBeforeResume.filter((event) => event.type === "omp.transcript.message"), state).toHaveLength(0);
    }
    expect(firstPrepareCalls, state).toBe(state === "started-only" ? 0 : 1);
    await memories.edit(editedMemory);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
      harness_v2_omp_runtime_root: runtimeRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      ompModelTransport: async function* (context) {
        modelCalls += 1;
        modelContextSystemPrompt = context.systemPrompt;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Prepared restore completed." }],
            stopReason: "stop" as const,
          },
        };
      },
    });
    service = await startHarnessService({ runtime: live.runtime });
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, channel_id: channelId }),
    });
    const responseBody = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(responseBody)).toBe(202);

    let events: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      events = await readRunEvents(live.eventStore as SqliteEventStore, command);
      if (events.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    return {
      command,
      events,
      historyBeforeResume,
      originalStartedPayload: originalStarted.payload,
      originalBudgetStartedAt,
      modelCalls,
      prepareCalls: firstPrepareCalls,
      modelContextSystemPrompt,
    };
  } finally {
    await service?.close().catch(() => undefined);
    await live?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedPreparedMemories(
  store: SqliteEventStore,
  command: ReturnType<typeof parseStartRun>,
  originalMemory: string,
): Promise<{ memoryId: string; edit: (content: string) => Promise<void> }> {
  const sourceProfile = withAmpleRunBudget(resolvedRunProfileFixture({
    memoryPolicy: { read: "channel", write: "propose" },
  }));
  const source = parseStartRun({
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    commandId: `${command.commandId}-memory-source`,
    runId: `${command.runId}-memory-source`,
    goal: command.goal,
    source: { eventId: `${command.runId}-memory-source-event` },
    runProfile: { id: sourceProfile.id, version: sourceProfile.version },
    runProfileSnapshot: sourceProfile,
    budget: sourceProfile.budget,
    permissionScope: `${command.permissionScope}-memory-source`,
    stopCondition: sourceProfile.terminalRules.stopCondition,
  });
  const sourceStore = store.scope(source);
  await sourceStore.claimStart(source);
  await sourceStore.append(parseCanonicalEvent({
    id: `${command.runId}-memory-source-completed`,
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    streamId: source.runId,
    seq: 0,
    type: "run.completed",
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    payload: { outcome: "completed" },
  }));
  const memories = createChannelMemoryRepository({
    eventStore: store,
    scope: source,
    runProfileSnapshot: sourceProfile,
    authorization: {
      async assertOwner(scope, actorId) {
        if (scope.workspaceId !== command.workspaceId || scope.channelId !== command.channelId || actorId !== "owner") {
          throw new Error("Memory owner denied");
        }
      },
    },
  });
  const memoryId = `${command.runId}-memory-one`;
  await memories.propose({
    id: memoryId,
    content: originalMemory,
    sourceRunId: source.runId,
    sourceEventIds: [`${command.runId}-memory-source-completed`],
  });
  await memories.accept({ candidateId: memoryId, actorId: "owner" });
  await memories.propose({
    id: `${command.runId}-memory-two`,
    content: originalMemory,
    sourceRunId: source.runId,
    sourceEventIds: [`${command.runId}-memory-source-completed`],
  });
  await memories.accept({ candidateId: `${command.runId}-memory-two`, actorId: "owner" });
  return {
    memoryId,
    edit: async (content: string) => memories.edit({ memoryId, content, actorId: "owner" }).then(() => undefined),
  };
}

async function runMissingProjectionResume(
  state: PreparedRestoreState,
  history: readonly CanonicalEvent[],
  command: ReturnType<typeof parseStartRun>,
  runtimeRoot: string,
  descriptor: OmpTestDescriptor,
): Promise<{ events: CanonicalEvent[]; modelCalls: number }> {
  const directory = await mkdtemp(join(tmpdir(), `anna-omp-missing-projection-${state}-`));
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const configPath = join(directory, "runtime.json");
  let store: SqliteEventStore | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let modelCalls = 0;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    for (const event of history) await durable.append(event);
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
      harness_v2_omp_runtime_root: runtimeRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      ompModelTransport: async function* () {
        modelCalls += 1;
        throw new Error("missing projection must fail before model I/O");
      },
    });
    service = await startHarnessService({ runtime: live.runtime });
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs/${command.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: command.workspaceId, channel_id: command.channelId }),
    });
    expect(response.status).toBe(202);
    let events: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      events = await readRunEvents(live.eventStore as SqliteEventStore, command);
      if (events.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    return { events, modelCalls };
  } finally {
    await service?.close().catch(() => undefined);
    await live?.close();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("repairs a missing tool observation from its durable response checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-repair-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-repair";
  const runId = "run-omp-resume-repair";
  const workspaceId = "workspace-omp-resume-repair";
  const channelId = "channel-omp-resume-repair";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "repairable release notes", "utf8");
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-repair" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-repair",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "repair-read-call",
              name: "read_only",
              arguments: { path: "release-notes.md" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.transcript.message") {
          const payload = event.payload as { readonly message?: { readonly role?: unknown } };
          if (payload.message?.role === "toolResult") {
            throw new Error("simulated tool observation ACK loss");
          }
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated tool observation ACK loss");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(beforeLoss.some((event) => event.type === "omp.tool.dispatch")).toBe(true);
    expect(beforeLoss.some((event) => event.type === "omp.tool.response")).toBe(true);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(2);
    expect(beforeLoss.some((event) => event.type === "run.completed")).toBe(false);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* (context) {
        resumedModelCalls += 1;
        expect(JSON.stringify(context.messages)).toContain("repairable release notes");
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Repaired release notes." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: resumedStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            resumedToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    expect(resumedModelCalls).toBe(1);
    expect(resumedToolCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.filter((event) => event.type === "omp.transcript.message")).toHaveLength(4);
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test("repairs a missing assistant observation from its durable model checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-model-repair-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-model-repair";
  const runId = "run-omp-resume-model-repair";
  const workspaceId = "workspace-omp-resume-model-repair";
  const channelId = "channel-omp-resume-model-repair";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-model-repair" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-model-repair",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Checkpointed release notes." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.transcript.message") {
          const payload = event.payload as { readonly message?: { readonly role?: unknown } };
          if (payload.message?.role === "assistant") {
            throw new Error("simulated assistant observation ACK loss");
          }
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated assistant observation ACK loss");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeLoss.some((event) => event.type === "omp.model.response")).toBe(true);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(1);
    expect(beforeLoss.some((event) => event.type === "run.completed")).toBe(false);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("durable model checkpoint must prevent another model call");
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: resumedStore!,
        command,
        workspaceRoot,
      }),
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    expect(resumedModelCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(
      resumedEvents.filter((event) => event.type === "omp.transcript.message"),
      JSON.stringify(resumedEvents.map((event) => ({ type: event.type, seq: event.seq, payload: event.payload }))),
    ).toHaveLength(2);
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test("repairs a missing usage projection from a durable model checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-usage-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-usage";
  const runId = "run-omp-resume-usage";
  const workspaceId = "workspace-omp-resume-usage";
  const channelId = "channel-omp-resume-usage";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-usage" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-usage",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Usage is checkpointed." }],
            stopReason: "stop" as const,
            usage: { input: 4, output: 2 },
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.usage.updated") {
          throw new Error("simulated usage projection ACK loss");
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated usage projection ACK loss");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeLoss.some((event) => event.type === "omp.model.response")).toBe(true);
    expect(beforeLoss.some((event) => event.type === "run.usage.updated")).toBe(false);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(1);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("durable usage checkpoint must prevent another model call");
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: resumedStore!,
        command,
        workspaceRoot,
      }),
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    expect(resumedModelCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    const usageEvents = resumedEvents.filter((event) => event.type === "run.usage.updated");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.payload).toMatchObject({ cumulative: { input: 4, output: 2 } });
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test("records a new resume attempt after a second reopen of the same Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-repeat-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-repeat";
  const runId = "run-omp-resume-repeat";
  const workspaceId = "workspace-omp-resume-repeat";
  const channelId = "channel-omp-resume-repeat";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let secondStore: SqliteEventStore | undefined;
  let secondKernel: OmpLoopKernel | undefined;
  let thirdStore: SqliteEventStore | undefined;
  let thirdKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "repeatable release notes", "utf8");
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-repeat" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-repeat",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "repeat-read-call",
              name: "read_only",
              arguments: { path: "release-notes.md" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const firstLossSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        await firstDurable.append(event);
        const payload = event.payload as { readonly message?: { readonly role?: unknown } };
        if (event.type === "omp.transcript.message" && payload.message?.role === "toolResult") {
          throw new Error("simulated first resume observation loss");
        }
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, firstLossSink, new AbortController().signal))
      .rejects.toThrow("simulated first resume observation loss");
    expect(firstModelCalls).toBe(1);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    secondStore = new SqliteEventStore(eventStorePath);
    let secondModelCalls = 0;
    secondKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* (context) {
        secondModelCalls += 1;
        expect(JSON.stringify(context.messages)).toContain("repeatable release notes");
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Repeatable summary." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: secondStore!,
        command,
        workspaceRoot,
      }),
    });
    const secondDurable = secondStore.scope(command);
    const secondLossSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.completed") throw new Error("simulated second resume terminal loss");
        await secondDurable.append(event);
      },
      read(streamId, afterSeq) {
        return secondDurable.read(streamId, afterSeq);
      },
    };
    await expect(secondKernel.start(command, secondLossSink, new AbortController().signal))
      .rejects.toThrow("simulated second resume terminal loss");
    expect(secondModelCalls).toBe(1);
    await secondKernel.close();
    secondKernel = undefined;
    secondStore.close();
    secondStore = undefined;

    thirdStore = new SqliteEventStore(eventStorePath);
    let thirdModelCalls = 0;
    thirdKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        thirdModelCalls += 1;
        throw new Error("completed tail must not call a third model");
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: thirdStore!,
        command,
        workspaceRoot,
      }),
    });
    await expect(thirdKernel.start(
      command,
      thirdStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    expect(thirdModelCalls).toBe(0);
    const events = await readRunEvents(thirdStore, command);
    const resumed = events.filter((event) => event.type === "run.resumed");
    expect(resumed).toHaveLength(2);
    const attemptIds = resumed.map((event) => (event.payload as { readonly attemptId?: unknown }).attemptId);
    expect(typeof attemptIds[0]).toBe("string");
    expect(typeof attemptIds[1]).toBe("string");
    expect(new Set(attemptIds).size).toBe(2);
    expect(resumed[0]?.payload).toMatchObject({ startedEventId: expect.any(String), transcriptLength: 3 });
    expect(events.filter((event) => event.type === "omp.transcript.message")).toHaveLength(4);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  } finally {
    await thirdKernel?.close().catch(() => undefined);
    thirdStore?.close();
    await secondKernel?.close().catch(() => undefined);
    secondStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test("fails closed before worker startup when a persisted context-ready digest is tampered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-ready-tamper-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-ready-tamper";
  const runId = "run-omp-resume-ready-tamper";
  const workspaceId = "workspace-omp-resume-ready-tamper";
  const channelId = "channel-omp-resume-ready-tamper";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-ready-tamper" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-ready-tamper",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Tampered context must not resume." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.completed") {
          throw new Error("simulated terminal persistence loss after ready tamper");
        }
        if (event.type === "run.context.ready") {
          const payload = event.payload as Record<string, unknown>;
          await firstDurable.append({
            ...event,
            payload: { ...payload, snapshotDigest: "0".repeat(64) },
          } as CanonicalEvent);
          return;
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated terminal persistence loss after ready tamper");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(beforeLoss.find((event) => event.type === "run.context.ready")?.payload)
      .toMatchObject({ snapshotDigest: "0".repeat(64) });
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(2);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("tampered ready must not dispatch model");
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: resumedStore!,
        command,
        workspaceRoot,
      }),
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "failed" });
    expect(resumedModelCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.at(-1)?.type).toBe("run.failed");
    expect((resumedEvents.at(-1)?.payload as { readonly reason?: unknown }).reason)
      .toBe("context_ready_mismatch");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("restores the tool budget from durable OMP dispatch fences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-tool-budget-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-tool-budget";
  const runId = "run-omp-resume-tool-budget";
  const workspaceId = "workspace-omp-resume-tool-budget";
  const channelId = "channel-omp-resume-tool-budget";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "budgeted release notes", "utf8");
    const profile = withAmpleRunBudget(createToolBudgetProfile(descriptor));
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-tool-budget" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-tool-budget",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    let firstToolCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "tool-budget-first-read",
              name: "read_only",
              arguments: { path: "release-notes.md" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: firstStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            firstToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    const firstLossSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        await firstDurable.append(event);
        const payload = event.payload as { readonly message?: { readonly role?: unknown } };
        if (event.type === "omp.transcript.message" && payload.message?.role === "toolResult") {
          throw new Error("simulated tool budget observation loss");
        }
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, firstLossSink, new AbortController().signal))
      .rejects.toThrow("simulated tool budget observation loss");
    expect(firstModelCalls).toBe(1);
    expect(firstToolCalls).toBe(1);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        if (resumedModelCalls === 1) {
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [{
                type: "toolCall" as const,
                id: "tool-budget-second-read",
                name: "read_only",
                arguments: { path: "release-notes.md" },
              }],
              stopReason: "toolUse" as const,
            },
          };
          return;
        }
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Budget should have stopped before this turn." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: resumedStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            resumedToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "timed_out" });
    expect(resumedModelCalls).toBe(1);
    expect(resumedToolCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(resumedEvents.at(-1)?.type).toBe("run.timed_out");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("applies an exhausted input-token cap before restoring a completed tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-input-cap-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-input-cap";
  const runId = "run-omp-resume-input-cap";
  const workspaceId = "workspace-omp-resume-input-cap";
  const channelId = "channel-omp-resume-input-cap";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const profile = withAmpleRunBudget(createToolBudgetProfile(descriptor, { inputTokens: 3 }));
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-input-cap" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-input-cap",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const queuedAt = new Date().toISOString();
    const queuedEvent = { ...canonicalEvent(command, 0, "run.queued", { phase: "queued" }), timestamp: queuedAt };
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(queuedEvent);
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Input cap must stop this answer." }],
            stopReason: "stop" as const,
            usage: { input: 4, output: 2 },
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.timed_out") {
          throw new Error("simulated timeout terminal loss after input cap");
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated timeout terminal loss after input cap");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeLoss.some((event) => event.type === "omp.model.response")).toBe(true);
    expect(beforeLoss.some((event) => event.type === "run.usage.updated")).toBe(true);
    expect(beforeLoss.some((event) => event.type === "run.timed_out")).toBe(false);
    const originalBudgetStartedAt = (beforeLoss.find((event) => event.type === "run.started")?.payload as {
      readonly budgetStartedAt?: unknown;
    } | undefined)?.budgetStartedAt;
    expect(originalBudgetStartedAt).toBe(queuedAt);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("exhausted input cap must not call model");
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: resumedStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            resumedToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "timed_out" });
    const observedAt = Date.now();
    expect(resumedModelCalls).toBe(0);
    expect(resumedToolCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.at(-1)?.type).toBe("run.timed_out");
    expect(resumedEvents.some((event) => event.type === "run.completed")).toBe(false);
    const resumedStartedAt = (resumedEvents.find((event) => event.type === "run.started")?.payload as {
      readonly budgetStartedAt?: unknown;
    } | undefined)?.budgetStartedAt;
    expect(resumedStartedAt).toBe(queuedAt);
    const wallBudget = profile.budget.wallTimeMs;
    expect(wallBudget).toBe(OMP_RESUME_FIXTURE_WALL_TIME_MS);
    if (wallBudget === undefined) throw new Error("input cap fixture must admit a wall budget");
    expect(typeof originalBudgetStartedAt).toBe("string");
    if (typeof originalBudgetStartedAt !== "string") {
      throw new Error("input cap fixture must persist budgetStartedAt");
    }
    const budgetStartedAtMs = Date.parse(originalBudgetStartedAt);
    expect(Number.isFinite(budgetStartedAtMs)).toBe(true);
    const elapsed = observedAt - budgetStartedAtMs;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(wallBudget);
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("rejects a changed tool response checkpoint instead of trusting its observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-tool-conflict-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-tool-conflict";
  const runId = "run-omp-resume-tool-conflict";
  const workspaceId = "workspace-omp-resume-tool-conflict";
  const channelId = "channel-omp-resume-tool-conflict";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "checkpoint conflict notes", "utf8");
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-tool-conflict" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-tool-conflict",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "tool-conflict-read",
              name: "read_only" as const,
              arguments: { path: "release-notes.md" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.tool.response") {
          const payload = event.payload as Record<string, unknown>;
          const result = payload.result as Record<string, unknown>;
          await firstDurable.append({
            ...event,
            payload: {
              ...payload,
              result: { ...result, status: "failed", output: "forged checkpoint output" },
            },
          } as CanonicalEvent);
          return;
        }
        await firstDurable.append(event);
        const payload = event.payload as { readonly message?: { readonly role?: unknown } };
        if (event.type === "omp.transcript.message" && payload.message?.role === "toolResult") {
          throw new Error("simulated observation loss after changed tool checkpoint");
        }
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated observation loss after changed tool checkpoint");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(3);
    expect(beforeLoss.some((event) => event.type === "omp.tool.response")).toBe(true);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("changed checkpoint must not call model");
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: resumedStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            resumedToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "failed" });
    expect(resumedModelCalls).toBe(0);
    expect(resumedToolCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.at(-1)?.type).toBe("run.failed");
    expect((resumedEvents.at(-1)?.payload as { readonly reason?: unknown }).reason)
      .toBe("tool_checkpoint_mismatch");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("rejects a model response checkpoint whose request input digest changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-model-conflict-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-model-conflict";
  const runId = "run-omp-resume-model-conflict";
  const workspaceId = "workspace-omp-resume-model-conflict";
  const channelId = "channel-omp-resume-model-conflict";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-model-conflict" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-model-conflict",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Model request must remain bound." }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "run.model.requested") {
          const payload = event.payload as Record<string, unknown>;
          await firstDurable.append({
            ...event,
            payload: { ...payload, inputDigest: "sha256:changed-request-input" },
          } as CanonicalEvent);
          return;
        }
        if (event.type === "run.completed") {
          throw new Error("simulated terminal persistence loss after model mismatch");
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated terminal persistence loss after model mismatch");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(beforeLoss.some((event) => event.type === "omp.model.response")).toBe(true);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(2);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("changed model input must not call model");
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: resumedStore!,
        command,
        workspaceRoot,
      }),
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "failed" });
    expect(resumedModelCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.at(-1)?.type).toBe("run.failed");
    expect((resumedEvents.at(-1)?.payload as { readonly reason?: unknown }).reason)
      .toBe("model_checkpoint_mismatch");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("continues a pending tool call when no dispatch fence was persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-pending-tool-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-pending-tool";
  const runId = "run-omp-resume-pending-tool";
  const workspaceId = "workspace-omp-resume-pending-tool";
  const channelId = "channel-omp-resume-pending-tool";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const descriptor = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "release-notes.md"), "pending tool notes", "utf8");
    const baseProfile = await createLiveProfile(
      "fixture-model",
      undefined,
      false,
      "general",
      "none",
      descriptor,
    );
    const profile = withAmpleRunBudget(baseProfile);
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-pending-tool" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-pending-tool",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "pending-read-call",
              name: "read_only" as const,
              arguments: { path: "release-notes.md" },
            }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => createProductionToolGateway({
        eventStore: firstStore!,
        command,
        workspaceRoot,
      }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(event) {
        if (event.type === "omp.tool.dispatch") {
          throw new Error("simulated loss before tool dispatch fence");
        }
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated loss before tool dispatch fence");
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeLoss.some((event) => event.type === "omp.tool.dispatch")).toBe(false);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(2);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* (context) {
        resumedModelCalls += 1;
        if (resumedModelCalls === 1) {
          expect(JSON.stringify(context.messages)).toContain("pending tool notes");
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "Pending tool completed." }],
              stopReason: "stop" as const,
            },
          };
        }
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({ eventStore: resumedStore!, command, workspaceRoot });
        return {
          execute: async (request: Parameters<typeof gateway.execute>[0], signal: AbortSignal) => {
            resumedToolCalls += 1;
            return gateway.execute(request, signal);
          },
        };
      },
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });
    expect(resumedModelCalls).toBe(1);
    expect(resumedToolCalls).toBe(1);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "omp.transcript.message")).toHaveLength(4);
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

function createToolBudgetProfile(
  descriptor: Awaited<ReturnType<typeof materializeRuntime>>,
  overrides: Partial<{
    wallTimeMs: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    toolCalls: number;
  }> = {},
) {
  const budget = { wallTimeMs: 30_000, turns: 3, toolCalls: 1, ...overrides };
  const model = {
    provider: "anna-openai-compatible",
    name: "fixture-model",
    reasoning: "low" as const,
  };
  const skill = loadSkillCatalogEntry({
    id: "skill:omp-tool-budget",
    document: [
      "---",
      "name: OMP tool budget",
      "version: 1.0.0",
      "allowed_tools:",
      "  - read_only",
      "forbidden_tools:",
      "  - shell",
      "---",
      "Use only the admitted read_only tool.",
      "",
    ].join("\n"),
    provenance: { source: "test", uri: "test://omp-tool-budget" },
  });
  const artifactContract = {
    kind: "omp-tool-budget",
    requiredFor: ["completed"] as const,
    verification: "tests" as const,
  };
  return resolveRunProfile({
    catalog: [skill],
    channelPolicy: {
      toolPolicy: { allowedTools: ["read_only"] },
      allowedSkillIds: [skill.id],
      allowedModels: [model],
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
    },
    workerProfile: {
      id: "worker:omp-tool-budget" as WorkerProfileId,
      version: "1.0.0",
      instructions: "Use only the admitted read_only tool.",
      allowedSkillIds: [skill.id],
      allowedTools: ["read_only"],
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: budget,
      artifactContract,
    },
    runProfile: {
      id: "profile:omp-tool-budget" as RunProfileId,
      version: "1.0.0",
      model,
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
      toolPolicy: { allowedTools: ["read_only"] },
      budget,
      memoryPolicy: { read: "none", write: "disabled" },
      evalPolicy: { contract: "disabled", quality: "disabled" },
      artifactContract,
      terminalRules: {
        allowedOutcomes: ["completed", "failed", "timed_out", "cancelled"] as const,
        stopCondition: "artifact_or_terminal",
      },
      kernel: descriptor,
    },
  });
}

async function materializeRuntime(runtimeRoot: string): Promise<{
  schemaVersion: 1;
  adapterId: "omp";
  protocolVersion: "anna-omp/1";
  adapterSource: { packageName: "@anna/omp-loop-kernel"; sha256: string };
  upstream: {
    packageName: "@oh-my-pi/pi-coding-agent";
    version: "18.0.11";
    sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2";
    integrity: string;
  };
  runtime: {
    platform: "darwin";
    arch: "arm64";
    bunVersion: "1.3.14";
    bunSha256: string;
    nativeSha256: string;
    dependencyLockSha256: string;
    runtimeManifestSha256: string;
  };
}> {
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  await rm(join(runtimeRoot, "manifest.json"));
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        await visit(path);
      } else {
        files.push({
          path: relative(runtimeRoot, path).split(sep).join("/"),
          bytes: metadata.size,
          sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
        });
      }
    }
  }
  await visit(runtimeRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const runtimeManifestSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await writeFile(
    join(runtimeRoot, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, files, sha256: `sha256:${runtimeManifestSha256}` }),
    "utf8",
  );
  const implementation = measureOmpImplementation();
  return {
    schemaVersion: 1,
    adapterId: "omp",
    protocolVersion: "anna-omp/1",
    adapterSource: {
      packageName: "@anna/omp-loop-kernel",
      sha256: implementation.sourceSha256,
    },
    upstream: {
      packageName: "@oh-my-pi/pi-coding-agent",
      version: "18.0.11",
      sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2",
      integrity: "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==",
    },
    runtime: {
      platform: "darwin",
      arch: "arm64",
      bunVersion: "1.3.14",
      bunSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
      nativeSha256: "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b",
      dependencyLockSha256: implementation.dependencyLockSha256,
      runtimeManifestSha256,
    },
  };
}

function canonicalEvent(
  command: ReturnType<typeof parseStartRun>,
  seq: number,
  type: string,
  payload: Record<string, string>,
): CanonicalEvent {
  return {
    id: `event:${command.runId}:${seq}`,
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    streamId: command.runId as unknown as StreamId,
    seq,
    type,
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    payload,
  } as CanonicalEvent;
}

async function readRunEvents(
  store: SqliteEventStore,
  command: ReturnType<typeof parseStartRun>,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope(command).read(command.runId as unknown as StreamId)) {
    events.push(event);
  }
  return events;
}

async function waitForGateEntry(
  entered: Promise<void>,
  completion: Promise<unknown>,
  label: string,
  details: () => unknown,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      entered.then(() => ({ kind: "entered" as const })),
      completion.then(
        (outcome) => ({ kind: "settled" as const, outcome }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "deadline" }>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline({ kind: "deadline" }), 120_000);
      }),
    ]);
    if (result.kind === "entered") return;
    if (result.kind === "rejected") throw result.error;
    if (result.kind === "settled") {
      throw new Error(`${label} Run settled before entry: ${JSON.stringify({
        outcome: result.outcome,
        details: details(),
      })}`);
    }
    throw new Error(`${label} did not enter within 120000ms: ${JSON.stringify(details())}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
