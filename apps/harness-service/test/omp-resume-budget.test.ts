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

import { SqliteEventStore } from "@anna/event-store";
import {
  buildRunContext,
  parseStartRun,
  resolveRunProfile,
  type CanonicalEvent,
  type EventSink,
  type ResolvedRunProfile,
  type StreamId,
} from "@anna/harness-v2";
import { afterEach, expect, test, vi } from "vitest";

import {
  createLiveProfile,
  createProductionToolGateway,
} from "../src/production";
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

let restoreDateNow: (() => void) | undefined;

afterEach(() => {
  restoreDateNow?.();
  restoreDateNow = undefined;
});

test("times out a completed-answer restore after the original wall budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-budget-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-budget";
  const runId = "run-omp-resume-budget";
  const workspaceId = "workspace-omp-resume-budget";
  const channelId = "channel-omp-resume-budget";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  const realDateNow = Date.now.bind(Date);
  const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(realDateNow);
  restoreDateNow = () => dateNowSpy.mockRestore();

  try {
    const runtimeManifestSha256 = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const profile = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Release notes.",
      source: { eventId: "source-omp-resume-budget" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-budget",
      stopCondition: profile.terminalRules.stopCondition,
    });

    firstStore = new SqliteEventStore(eventStorePath);
    const firstDurable = firstStore.scope(command);
    await firstDurable.claimStart(command);
    await firstDurable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${runtimeManifestSha256}`,
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
    const beforeReopen = await readRunEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeReopen.filter((event) => event.type === "omp.transcript.message")).toHaveLength(2);
    expect(beforeReopen.some((event) => event.type === "run.completed")).toBe(false);

    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    const expiredHostClock = realDateNow() + (command.budget.wallTimeMs ?? 0) + 1;
    dateNowSpy.mockImplementation(() => expiredHostClock);
    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("expired restore must not call the model");
      },
      createToolGateway: () => {
        const gateway = createProductionToolGateway({
          eventStore: resumedStore!,
          command,
          workspaceRoot,
        });
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
    expect(resumedModelCalls).toBe(0);
    expect(resumedToolCalls).toBe(0);
    const afterReopen = await readRunEvents(resumedStore, command);
    expect(afterReopen.at(-1)?.type).toBe("run.timed_out");
    expect(afterReopen.some((event) => event.type === "run.completed")).toBe(false);
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test.each([
  { field: "input", budget: { inputTokens: 10 }, usage: { output: 1 } },
  { field: "output", budget: { outputTokens: 10 }, usage: { input: 1 } },
  { field: "cost", budget: { cost: 1 }, usage: { input: 1, output: 1 } },
] as const)("fails closed when a restored $field usage field is missing", async ({ field, budget, usage }) => {
  const directory = await mkdtemp(join(tmpdir(), `anna-omp-resume-missing-${field}-`));
  const eventStorePath = join(directory, "events.sqlite");
  const runtimeManifest = JSON.parse(await readFile(join(materializedRoot, "manifest.json"), "utf8")) as { sha256: string };
  let store: SqliteEventStore | undefined;

  try {
    const base = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const constrained = constrainedProfile(base, budget);
    const command = parseStartRun({
      workspaceId: "workspace-omp-resume-missing",
      channelId: "channel-omp-resume-missing",
      commandId: "command-omp-resume-missing",
      runId: "run-omp-resume-missing",
      goal: "Recover the usage fixture.",
      source: { eventId: "source-omp-resume-missing" },
      runProfile: { id: constrained.id, version: constrained.version },
      runProfileSnapshot: constrained,
      budget: constrained.budget,
      permissionScope: "permission-omp-resume-missing",
      stopCondition: constrained.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    const requestEvent = canonicalEvent(command, 3, "run.model.requested", {
      phase: "model_requested",
      model: constrained.model.name,
      requestIndex: 1,
      inputDigest: "fixture-input-digest",
    });
    await durable.append(canonicalEvent(command, 1, "run.started", {
      phase: "started",
      executionFingerprint: executionFingerprintFor(constrained),
      budgetStartedAt: new Date().toISOString(),
    }));
    await durable.append(canonicalEvent(command, 2, "omp.transcript.message", {
      message: { role: "user", content: command.goal },
    }));
    await durable.append(requestEvent);
    await durable.append(canonicalEvent(command, 4, "omp.model.response", {
      schemaVersion: 1,
      requestIndex: 1,
      requestEventId: requestEvent.id,
      transcriptIndex: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered usage fixture." }],
        stopReason: "stop",
        usage,
      },
    }));

    let modelCalls = 0;
    const kernel = new OmpLoopKernel({
      runtimeRoot: materializedRoot,
      expectedManifestDigest: runtimeManifest.sha256,
      workspaceRoot: directory,
      modelTransport: async function* () {
        modelCalls += 1;
        throw new Error("missing restored usage must stop before model I/O");
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("missing restored usage must stop before tool I/O");
        },
      }),
    });
    try {
      await expect(kernel.start(command, durable, new AbortController().signal))
        .resolves.toEqual({ status: "failed" });
    } finally {
      await kernel.close();
    }
    expect(modelCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.at(-1)?.type).toBe("run.failed");
    expect((events.at(-1)?.payload as { readonly reason?: unknown }).reason).toContain("requires Host");
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when a restored model attempt has no response usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-unanswered-"));
  const eventStorePath = join(directory, "events.sqlite");
  const runtimeManifest = JSON.parse(await readFile(join(materializedRoot, "manifest.json"), "utf8")) as { sha256: string };
  let store: SqliteEventStore | undefined;

  try {
    const base = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const constrained = constrainedProfile(base, { outputTokens: 10 });
    const command = parseStartRun({
      workspaceId: "workspace-omp-resume-unanswered",
      channelId: "channel-omp-resume-unanswered",
      commandId: "command-omp-resume-unanswered",
      runId: "run-omp-resume-unanswered",
      goal: "Recover the unanswered fixture.",
      source: { eventId: "source-omp-resume-unanswered" },
      runProfile: { id: constrained.id, version: constrained.version },
      runProfileSnapshot: constrained,
      budget: constrained.budget,
      permissionScope: "permission-omp-resume-unanswered",
      stopCondition: constrained.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    await durable.append(canonicalEvent(command, 1, "run.started", {
      phase: "started",
      executionFingerprint: executionFingerprintFor(constrained),
      budgetStartedAt: new Date().toISOString(),
    }));
    await durable.append(canonicalEvent(command, 2, "omp.transcript.message", {
      message: { role: "user", content: command.goal },
    }));
    await durable.append(canonicalEvent(command, 3, "run.model.requested", {
      phase: "model_requested",
      model: constrained.model.name,
      requestIndex: 1,
      inputDigest: "fixture-input-digest",
    }));

    let modelCalls = 0;
    const kernel = new OmpLoopKernel({
      runtimeRoot: materializedRoot,
      expectedManifestDigest: runtimeManifest.sha256,
      workspaceRoot: directory,
      modelTransport: async function* () {
        modelCalls += 1;
        throw new Error("unanswered restored usage must stop before model I/O");
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("unanswered restored usage must stop before tool I/O");
        },
      }),
    });
    try {
      await expect(kernel.start(command, durable, new AbortController().signal))
        .resolves.toEqual({ status: "failed" });
    } finally {
      await kernel.close();
    }
    expect(modelCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.at(-1)?.type).toBe("run.failed");
    expect((events.at(-1)?.payload as { readonly reason?: unknown }).reason).toContain("unanswered");
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows required-budget restore with a user observation but no model attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-no-attempt-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;

  try {
    const runtimeManifestSha256 = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const base = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const profile = constrainedProfile(base, { outputTokens: 10 });
    const command = parseStartRun({
      workspaceId: "workspace-omp-resume-no-attempt",
      channelId: "channel-omp-resume-no-attempt",
      commandId: "command-omp-resume-no-attempt",
      runId: "run-omp-resume-no-attempt",
      goal: "Recover the no-attempt fixture.",
      source: { eventId: "source-omp-resume-no-attempt" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-no-attempt",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    await durable.append(canonicalEvent(command, 1, "run.started", {
      phase: "started",
      executionFingerprint: executionFingerprintFor(profile),
      budgetStartedAt: new Date().toISOString(),
    }));
    const context = buildRunContext({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: profile.workerProfileId,
      goal: {
        content: command.goal,
        provenance: { source: "run.command", sourceEventIds: [command.source.eventId] },
      },
      constraints: [],
      transientMessages: [],
      pendingToolCalls: [],
      memoryHits: [],
    });
    const executionFingerprint = executionFingerprintFor(profile);
    await durable.append(canonicalEvent(command, 2, "run.context.ready", {
      schemaVersion: 1,
      snapshotDigest: sha256(stableJson({ runId: command.runId, profileHash: profile.hash })),
      originalExecutionFingerprint: executionFingerprint,
      inputFingerprint: sha256(stableJson({
        systemPrompt: systemPromptFor(profile),
        context,
      })),
      memoryCount: 0,
    }));
    await durable.append(canonicalEvent(command, 3, "omp.transcript.message", {
      message: { role: "user", content: command.goal },
    }));

    let modelCalls = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* (context) {
        modelCalls += 1;
        expect(context.messages).toEqual([{ role: "user", content: command.goal }]);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "No-attempt recovery completed." }],
            stopReason: "stop" as const,
            usage: { output: 0 },
          },
        };
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("no-attempt recovery must not invoke a tool");
        },
      }),
    });
    const outcome = await kernel.start(command, durable, new AbortController().signal);
    const outcomeEvents = await readRunEvents(store, command);
    expect(outcome, JSON.stringify(outcomeEvents.map((event) => ({ type: event.type, payload: event.payload })))).toEqual({ status: "completed" });
    expect(modelCalls).toBe(1);
    const events = await readRunEvents(store, command);
    expect(events.filter((event) => event.type === "run.model.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.usage.updated")).toHaveLength(1);
    expect((events.find((event) => event.type === "run.usage.updated")?.payload as { readonly cumulative?: unknown }).cumulative)
      .toEqual({ output: 0 });
    const users = events.filter((event) => {
      if (event.type !== "omp.transcript.message") return false;
      const payload = event.payload as { readonly message?: { readonly role?: unknown } };
      return payload.message?.role === "user";
    });
    expect(users).toHaveLength(1);
  } finally {
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test.each([
  { field: "output", budget: { outputTokens: 1 }, usage: { output: 2 } },
  { field: "cost", budget: { cost: 1 }, usage: { cost: 2 } },
] as const)("times out a completed tail when cumulative $field usage exceeds its cap", async ({ budget, usage }) => {
  const directory = await mkdtemp(join(tmpdir(), `anna-omp-resume-completed-${budget.outputTokens === undefined ? "cost" : "output"}-`));
  const eventStorePath = join(directory, "events.sqlite");
  const runtimeManifest = JSON.parse(await readFile(join(materializedRoot, "manifest.json"), "utf8")) as { sha256: string };
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;

  try {
    const base = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const profile = constrainedProfile(base, budget);
    const command = parseStartRun({
      workspaceId: "workspace-omp-resume-completed-cap",
      channelId: "channel-omp-resume-completed-cap",
      commandId: "command-omp-resume-completed-cap",
      runId: "run-omp-resume-completed-cap",
      goal: "Recover the completed usage cap fixture.",
      source: { eventId: "source-omp-resume-completed-cap" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-completed-cap",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    await durable.append(canonicalEvent(command, 1, "run.started", {
      phase: "started",
      executionFingerprint: executionFingerprintFor(profile),
      budgetStartedAt: new Date().toISOString(),
    }));
    await durable.append(canonicalEvent(command, 2, "omp.transcript.message", {
      message: { role: "user", content: command.goal },
    }));
    await durable.append(canonicalEvent(command, 3, "omp.transcript.message", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Completed usage cap answer." }],
        stopReason: "stop",
        usage,
      },
    }));
    const requestEvent = canonicalEvent(command, 4, "run.model.requested", {
      phase: "model_requested",
      model: profile.model.name,
      requestIndex: 1,
      inputDigest: "fixture-input-digest",
    });
    await durable.append(requestEvent);
    await durable.append(canonicalEvent(command, 5, "omp.model.response", {
      schemaVersion: 1,
      requestIndex: 1,
      requestEventId: requestEvent.id,
      transcriptIndex: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Completed usage cap answer." }],
        stopReason: "stop",
        usage,
      },
    }));
    await durable.append(canonicalEvent(command, 6, "run.usage.updated", {
      phase: "usage_updated",
      requestIndex: 1,
      cumulative: usage,
    }));
    store.close();
    store = new SqliteEventStore(eventStorePath);
    let modelCalls = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot: materializedRoot,
      expectedManifestDigest: runtimeManifest.sha256,
      workspaceRoot: directory,
      modelTransport: async function* () {
        modelCalls += 1;
        throw new Error("completed cap restore must stop before model I/O");
      },
      createToolGateway: () => ({
        execute: async () => {
          throw new Error("completed cap restore must stop before tool I/O");
        },
      }),
    });
    await expect(kernel.start(command, store.scope(command), new AbortController().signal))
      .resolves.toEqual({ status: "timed_out" });
    expect(modelCalls).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.at(-1)?.type).toBe("run.timed_out");
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(0);
  } finally {
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("counts a durable model attempt against the turn cap across SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-turns-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const commandId = "command-omp-resume-turns";
  const runId = "run-omp-resume-turns";
  const workspaceId = "workspace-omp-resume-turns";
  const channelId = "channel-omp-resume-turns";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;

  try {
    const runtimeManifestSha256 = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "turns.txt"), "turn budget fixture", "utf8");
    const base = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const profile = constrainedProfile(base, { turns: 1, toolCalls: 1 });
    const command = parseStartRun({
      workspaceId,
      channelId,
      commandId,
      runId,
      goal: "Read the turn budget fixture.",
      source: { eventId: "source-omp-resume-turns" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-turns",
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
      expectedManifestDigest: `sha256:${runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{
              type: "toolCall" as const,
              id: "turn-budget-call",
              name: "read_only",
              arguments: { path: "turns.txt" },
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
        if (event.type === "run.timed_out") throw new Error("simulated turn terminal persistence loss");
        await firstDurable.append(event);
      },
      read(streamId, afterSeq) {
        return firstDurable.read(streamId, afterSeq);
      },
    };
    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated turn terminal persistence loss");
    expect(firstModelCalls).toBe(1);
    expect(firstToolCalls).toBe(1);
    const beforeReopen = await readRunEvents(firstStore, command);
    expect(beforeReopen.filter((event) => event.type === "run.model.requested")).toHaveLength(1);
    expect(beforeReopen.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(beforeReopen.filter((event) => event.type === "omp.tool.response")).toHaveLength(1);
    expect(beforeReopen.some((event) => event.type === "run.timed_out")).toBe(false);
    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    let resumedToolCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${runtimeManifestSha256}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("turn cap restore must stop before model I/O");
      },
      createToolGateway: () => ({
        execute: async () => {
          resumedToolCalls += 1;
          throw new Error("turn cap restore must stop before tool I/O");
        },
      }),
    });
    await expect(resumedKernel.start(
      command,
      resumedStore.scope(command),
      new AbortController().signal,
    )).resolves.toEqual({ status: "timed_out" });
    expect(resumedModelCalls).toBe(0);
    expect(resumedToolCalls).toBe(0);
    const resumedEvents = await readRunEvents(resumedStore, command);
    expect(resumedEvents.filter((event) => event.type === "run.model.requested")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.timed_out")).toHaveLength(1);
    expect(resumedEvents.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);
    expect(resumedEvents.map((event) => event.seq)).toEqual(
      resumedEvents.map((_event, index) => index),
    );
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("fails closed on an unpaired assistant and checkpoint-free tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-corrupt-transcript-"));
  const eventStorePath = join(directory, "events.sqlite");
  const runtimeManifest = JSON.parse(await readFile(join(materializedRoot, "manifest.json"), "utf8")) as { sha256: string };
  let store: SqliteEventStore | undefined;
  let kernel: OmpLoopKernel | undefined;

  try {
    const base = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const profile = constrainedProfile(base, { wallTimeMs: 30_000 });
    const command = parseStartRun({
      workspaceId: "workspace-omp-resume-corrupt-transcript",
      channelId: "channel-omp-resume-corrupt-transcript",
      commandId: "command-omp-resume-corrupt-transcript",
      runId: "run-omp-resume-corrupt-transcript",
      goal: "Recover the corrupt transcript fixture.",
      source: { eventId: "source-omp-resume-corrupt-transcript" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-corrupt-transcript",
      stopCondition: profile.terminalRules.stopCondition,
    });
    store = new SqliteEventStore(eventStorePath);
    const durable = store.scope(command);
    await durable.claimStart(command);
    const executionFingerprint = executionFingerprintFor(profile);
    await durable.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    await durable.append(canonicalEvent(command, 1, "run.started", {
      phase: "started",
      executionFingerprint,
      budgetStartedAt: new Date().toISOString(),
    }));
    const context = buildRunContext({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: profile.workerProfileId,
      goal: {
        content: command.goal,
        provenance: { source: "run.command", sourceEventIds: [command.source.eventId] },
      },
      constraints: [],
      transientMessages: [],
      pendingToolCalls: [],
      memoryHits: [],
    });
    await durable.append(canonicalEvent(command, 2, "run.context.ready", {
      schemaVersion: 1,
      snapshotDigest: sha256(stableJson({ runId: command.runId, profileHash: profile.hash })),
      originalExecutionFingerprint: executionFingerprint,
      inputFingerprint: sha256(stableJson({ systemPrompt: systemPromptFor(profile), context })),
      memoryCount: 0,
    }));
    await durable.append(canonicalEvent(command, 3, "omp.transcript.message", {
      message: { role: "user", content: command.goal },
    }));
    await durable.append(canonicalEvent(command, 4, "omp.transcript.message", {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "corrupt-call", name: "read_only", arguments: { path: "notes.txt" } }],
        stopReason: "toolUse",
      },
    }));
    await durable.append(canonicalEvent(command, 5, "omp.transcript.message", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Unpaired assistant." }],
        stopReason: "stop",
      },
    }));
    await durable.append(canonicalEvent(command, 6, "omp.transcript.message", {
      message: {
        role: "toolResult",
        toolCallId: "corrupt-call",
        toolName: "read_only",
        content: "unproven result",
        status: "succeeded",
      },
    }));
    let modelCalls = 0;
    let gatewayFactories = 0;
    kernel = new OmpLoopKernel({
      runtimeRoot: materializedRoot,
      expectedManifestDigest: runtimeManifest.sha256,
      workspaceRoot: directory,
      modelTransport: async function* () {
        modelCalls += 1;
        throw new Error("corrupt transcript must stop before model I/O");
      },
      createToolGateway: () => {
        gatewayFactories += 1;
        throw new Error("corrupt transcript must stop before Gateway admission");
      },
    });
    await expect(kernel.start(command, durable, new AbortController().signal))
      .resolves.toEqual({ status: "failed" });
    expect(modelCalls).toBe(0);
    expect(gatewayFactories).toBe(0);
    const events = await readRunEvents(store, command);
    expect(events.at(-1)?.type).toBe("run.failed");
    expect((events.at(-1)?.payload as { readonly reason?: unknown }).reason)
      .toBe("tool_checkpoint_mismatch");
  } finally {
    await kernel?.close().catch(() => undefined);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function constrainedProfile(
  profile: ResolvedRunProfile,
  overrides: { wallTimeMs?: number; turns?: number; inputTokens?: number; outputTokens?: number; cost?: number; toolCalls?: number },
): ResolvedRunProfile {
  const budget = { wallTimeMs: 30_000, turns: 3, ...overrides };
  return resolveRunProfile({
    catalog: profile.skills,
    channelPolicy: {
      toolPolicy: { allowedTools: profile.allowedTools },
      allowedSkillIds: profile.skills.map((skill) => skill.id),
      allowedModels: [profile.model],
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: [profile.memoryPolicy.read], allowedWriteModes: [profile.memoryPolicy.write] },
    },
    workerProfile: {
      ...profile.workerProfile,
      allowedSkillIds: profile.skills.map((skill) => skill.id),
      allowedTools: profile.allowedTools,
      modelPolicy: { allowedModels: [profile.model] },
      budgetDefaults: budget,
      artifactContract: profile.artifactContract,
    },
    runProfile: {
      id: profile.id,
      version: profile.version,
      model: profile.model,
      skillIds: profile.skills.map((skill) => skill.id),
      contextTransforms: profile.contextTransforms,
      toolPolicy: { allowedTools: profile.allowedTools },
      budget,
      memoryPolicy: profile.memoryPolicy,
      evalPolicy: profile.evalPolicy,
      artifactContract: profile.artifactContract,
      terminalRules: profile.terminalRules,
      ...(profile.kernel === undefined ? {} : { kernel: profile.kernel }),
    },
  });
}

function executionFingerprintFor(profile: ResolvedRunProfile): Record<string, string> {
  const systemPrompt = systemPromptFor(profile);
  const material = {
    algorithm: "sha256",
    provider: profile.model.provider,
    model: profile.model.name,
    runProfileHash: profile.hash,
    systemPromptHash: createHash("sha256").update(systemPrompt, "utf8").digest("hex"),
  };
  return {
    ...material,
    hash: createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex"),
  };
}

function systemPromptFor(profile: ResolvedRunProfile): string {
  return [
    "You are Anna. Complete the stated goal.",
    `Worker instructions:\n${profile.workerProfile.instructions}`,
    ...profile.skills.map((skill) => `Approved Skill ${skill.id} ${skill.version}:\n${skill.content}`),
  ].join("\n\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function materializeRuntime(runtimeRoot: string): Promise<string> {
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  await rm(join(runtimeRoot, "manifest.json"));
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        await visit(absolute);
      } else {
        files.push({
          path: relative(runtimeRoot, absolute).split(sep).join("/"),
          bytes: metadata.size,
          sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
        });
      }
    }
  }
  await visit(runtimeRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await writeFile(
    join(runtimeRoot, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, files, sha256: `sha256:${digest}` }),
    "utf8",
  );
  return digest;
}

function canonicalEvent(
  command: ReturnType<typeof parseStartRun>,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
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
