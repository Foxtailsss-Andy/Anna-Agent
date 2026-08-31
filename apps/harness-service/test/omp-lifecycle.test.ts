import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import { parseJsonValue, type CanonicalEvent, type ChannelScope, type EventId, type JsonValue, type StreamId } from "@anna/harness-v2";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  runManagedOmpWorker,
  type HostModelResponse,
} from "../../../packages/omp-loop-kernel/src/worker-client";
import type { Observation } from "../../../packages/omp-loop-kernel/runtime/protocol";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

interface RuntimeFixture {
  readonly container: string;
  readonly root: string;
}

let runtime!: RuntimeFixture;

beforeAll(async () => {
  runtime = await materializeRuntime();
}, 60_000);

afterAll(async () => {
  if (runtime !== undefined) await rm(runtime.container, { recursive: true, force: true });
});

test("cancels an actual SDK model request and leaves SQLite usable", async () => {
  const directory = await mkdtemp(join(runtime.container, "model-cancel-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const scope = lifecycleScope("model-cancel");
  const binding = lifecycleBinding("model-cancel");
  const controller = new AbortController();
  let modelCalls = 0;
  let toolCalls = 0;
  let resolveModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolveStarted) => { resolveModelStarted = resolveStarted; });
  let transportCancelled = false;
  try {
    const run = runManagedOmpWorker({
      runtimeRoot: runtime.root,
      entryPath: join(runtime.root, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      signal: controller.signal,
      binding,
      input: lifecycleInput("Wait for the Host transport to cancel."),
      modelTransport: async function* (_context, signal) {
        modelCalls += 1;
        resolveModelStarted();
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            transportCancelled = true;
            reject(new Error("model transport cancelled"));
            return;
          }
          signal.addEventListener("abort", () => {
            transportCancelled = true;
            reject(new Error("model transport cancelled"));
          }, { once: true });
        });
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "succeeded", output: "must not run" };
      },
      persistObservation: (observation) => appendObservation(store, scope, binding.runId, observation),
    });

    await modelStarted;
    controller.abort("fixture model cancellation");
    await expect(run).rejects.toThrow();
    await new Promise((resolveSettled) => setTimeout(resolveSettled, 50));
    expect(transportCancelled).toBe(true);
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect(await attemptDirectories(directory)).toEqual([]);

    await appendCheckEvent(store, scope, binding.runId, "after-model-cancel");
    const events = await readScope(store, scope, binding.runId);
    expect(events.some((event) => event.type === "run.progress")).toBe(true);
    expect(events.some((event) => event.id === "after-model-cancel")).toBe(true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("rejects an actual SDK run when the Host yields a legal late response after abort", async () => {
  const directory = await mkdtemp(join(runtime.container, "late-response-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const scope = lifecycleScope("late-response");
  const binding = lifecycleBinding("late-response");
  const controller = new AbortController();
  let modelCalls = 0;
  let toolCalls = 0;
  let resolveModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolveStarted) => { resolveModelStarted = resolveStarted; });
  let lateResponseYielded = false;
  try {
    const run = runManagedOmpWorker({
      runtimeRoot: runtime.root,
      entryPath: join(runtime.root, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      signal: controller.signal,
      binding,
      input: lifecycleInput("Reject any response that arrives after abort."),
      modelTransport: async function* (_context, signal) {
        modelCalls += 1;
        resolveModelStarted();
        await waitForAbort(signal);
        lateResponseYielded = true;
        yield textResponse("late answer");
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "succeeded" as const, output: "must not run" };
      },
      persistObservation: (observation) => appendObservation(store, scope, binding.runId, observation),
    });

    await modelStarted;
    controller.abort("fixture abort before late response");
    await expect(run).rejects.toThrow();
    await new Promise((resolveSettled) => setTimeout(resolveSettled, 50));
    expect(lateResponseYielded).toBe(true);
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect(await attemptDirectories(directory)).toEqual([]);

    await appendCheckEvent(store, scope, binding.runId, "after-late-response");
    const events = await readScope(store, scope, binding.runId);
    expect(events.some((event) => event.id === "after-late-response")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("does not dispatch the model when the initial user observation cannot be persisted", async () => {
  const directory = await mkdtemp(join(runtime.container, "observation-failure-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const scope = lifecycleScope("observation-failure");
  const binding = lifecycleBinding("observation-failure");
  let modelCalls = 0;
  let toolCalls = 0;
  let failedUserObservation = false;
  try {
    const run = runManagedOmpWorker({
      runtimeRoot: runtime.root,
      entryPath: join(runtime.root, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding,
      input: lifecycleInput("Return one bounded answer."),
      modelTransport: async function* () {
        modelCalls += 1;
        yield textResponse("bounded answer");
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "succeeded" as const, output: "must not run" };
      },
      persistObservation: async (observation) => {
        await appendObservation(store, scope, binding.runId, observation);
        if (observation.type === "message_end" && observation.message.role === "user") {
          failedUserObservation = true;
          throw new Error("fixture user observation persistence failed");
        }
      },
    });

    await expect(run).rejects.toThrow("fixture user observation persistence failed");
    await new Promise((resolveSettled) => setTimeout(resolveSettled, 50));
    expect(failedUserObservation).toBe(true);
    expect(modelCalls).toBe(0);
    expect(toolCalls).toBe(0);
    expect(await attemptDirectories(directory)).toEqual([]);

    await appendCheckEvent(store, scope, binding.runId, "after-user-observation-failure");
    const events = await readScope(store, scope, binding.runId);
    expect(events.some((event) => event.type === "omp.transcript.message" && event.payload !== null)).toBe(true);
    expect(events.some((event) => event.id === "after-user-observation-failure")).toBe(true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("cancels while the initial user observation ACK is paused", async () => {
  const directory = await mkdtemp(join(runtime.container, "user-ack-cancel-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const scope = lifecycleScope("user-ack-cancel");
  const binding = lifecycleBinding("user-ack-cancel");
  const controller = new AbortController();
  let modelCalls = 0;
  let toolCalls = 0;
  let resolveAckPaused!: () => void;
  const ackPaused = new Promise<void>((resolvePaused) => { resolveAckPaused = resolvePaused; });
  try {
    const run = runManagedOmpWorker({
      runtimeRoot: runtime.root,
      entryPath: join(runtime.root, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      signal: controller.signal,
      binding,
      input: lifecycleInput("Cancel while the user observation is awaiting ACK."),
      modelTransport: async function* () {
        modelCalls += 1;
        yield textResponse("must not run");
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "succeeded" as const, output: "must not run" };
      },
      persistObservation: async (observation) => {
        await appendObservation(store, scope, binding.runId, observation);
        if (observation.type === "message_end" && observation.message.role === "user") {
          resolveAckPaused();
          await waitForAbort(controller.signal);
        }
      },
    });

    await ackPaused;
    controller.abort("fixture user ACK cancellation");
    await expect(run).rejects.toThrow();
    await new Promise((resolveSettled) => setTimeout(resolveSettled, 50));
    expect(modelCalls).toBe(0);
    expect(toolCalls).toBe(0);
    expect(await attemptDirectories(directory)).toEqual([]);

    await appendCheckEvent(store, scope, binding.runId, "after-user-ack-cancel");
    const events = await readScope(store, scope, binding.runId);
    expect(events.some((event) => event.id === "after-user-ack-cancel")).toBe(true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("keeps concurrent workers with one Run ID isolated by channel scope", async () => {
  const directory = await mkdtemp(join(runtime.container, "same-run-scopes-"));
  const workspaceA = join(directory, "workspace-a");
  const workspaceB = join(directory, "workspace-b");
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const scopeA = lifecycleScope("same-run-a");
  const scopeB = lifecycleScope("same-run-b");
  const bindingA = lifecycleBinding("same-run-a", "run:omp-lifecycle-shared");
  const bindingB = lifecycleBinding("same-run-b", "run:omp-lifecycle-shared");
  const toolA = {
    name: "read_a",
    description: "Read channel A fixture.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  };
  const toolB = {
    name: "read_b",
    description: "Read channel B fixture.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  };
  let modelCallsA = 0;
  let modelCallsB = 0;
  const toolCallsA: string[] = [];
  const toolCallsB: string[] = [];
  const inputA = {
    ...lifecycleInput("Goal for channel A."),
    systemPrompt: "context-for-channel-a",
    allowedTools: [toolA],
    snapshotDigest: "sha256:omp-scope-a",
    originalExecutionFingerprint: { algorithm: "sha256", hash: "omp-scope-a" } as JsonValue,
  };
  const inputB = {
    ...lifecycleInput("Goal for channel B."),
    systemPrompt: "context-for-channel-b",
    allowedTools: [toolB],
    snapshotDigest: "sha256:omp-scope-b",
    originalExecutionFingerprint: { algorithm: "sha256", hash: "omp-scope-b" } as JsonValue,
  };
  const makeResponse = (name: string, callId: string): HostModelResponse => ({
    deltas: [],
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: {} }],
      stopReason: "toolUse",
    },
  });
  const runs: Promise<unknown>[] = [];
  try {
    runs.push(runManagedOmpWorker({
      runtimeRoot: runtime.root,
      entryPath: join(runtime.root, "worker.ts"),
      attemptParent: directory,
      workspaceRoot: workspaceA,
      binding: bindingA,
      input: inputA,
      modelTransport: async function* (context) {
        modelCallsA += 1;
        expect(context.systemPrompt).toBe(inputA.systemPrompt);
        if (modelCallsA === 1) {
          expect(context.messages.at(-1)).toEqual({ role: "user", content: inputA.goal });
          yield makeResponse("read_a", "scope-a-tool");
          return;
        }
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", content: "scope-a-output" });
        yield textResponse("channel A complete");
      },
      toolGateway: async (name) => {
        toolCallsA.push(name);
        return { status: "succeeded" as const, output: "scope-a-output" };
      },
      persistObservation: (observation) => appendObservation(store, scopeA, bindingA.runId, observation),
    }));
    runs.push(runManagedOmpWorker({
      runtimeRoot: runtime.root,
      entryPath: join(runtime.root, "worker.ts"),
      attemptParent: directory,
      workspaceRoot: workspaceB,
      binding: bindingB,
      input: inputB,
      modelTransport: async function* (context) {
        modelCallsB += 1;
        expect(context.systemPrompt).toBe(inputB.systemPrompt);
        if (modelCallsB === 1) {
          expect(context.messages.at(-1)).toEqual({ role: "user", content: inputB.goal });
          yield makeResponse("read_b", "scope-b-tool");
          return;
        }
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", content: "scope-b-output" });
        yield textResponse("channel B complete");
      },
      toolGateway: async (name) => {
        toolCallsB.push(name);
        return { status: "succeeded" as const, output: "scope-b-output" };
      },
      persistObservation: (observation) => appendObservation(store, scopeB, bindingB.runId, observation),
    }));

    const results = await Promise.all(runs);
    expect(results.map((result) => (result as { terminal: { outcome: string } }).terminal.outcome)).toEqual([
      "completed",
      "completed",
    ]);
    expect(modelCallsA).toBe(2);
    expect(modelCallsB).toBe(2);
    expect(toolCallsA).toEqual(["read_a"]);
    expect(toolCallsB).toEqual(["read_b"]);
    expect(await attemptDirectories(directory)).toEqual([]);

    await appendCheckEvent(store, scopeA, bindingA.runId, "after-scope-a");
    await appendCheckEvent(store, scopeB, bindingB.runId, "after-scope-b");
    const eventsA = await readScope(store, scopeA, bindingA.runId);
    const eventsB = await readScope(store, scopeB, bindingB.runId);
    expect(eventsA.some((event) => event.id === "after-scope-a")).toBe(true);
    expect(eventsB.some((event) => event.id === "after-scope-b")).toBe(true);
    expect(eventsA.map((event) => event.seq)).toEqual(eventsA.map((_event, index) => index));
    expect(eventsB.map((event) => event.seq)).toEqual(eventsB.map((_event, index) => index));
  } finally {
    await Promise.allSettled(runs);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);

function lifecycleScope(suffix: string): ChannelScope {
  return {
    workspaceId: `workspace:omp-lifecycle-${suffix}` as never,
    channelId: `channel:omp-lifecycle-${suffix}` as never,
  };
}

function lifecycleBinding(suffix: string, runId = `run:omp-lifecycle-${suffix}`) {
  return {
    workspaceId: `workspace:omp-lifecycle-${suffix}`,
    channelId: `channel:omp-lifecycle-${suffix}`,
    runId,
    attemptId: `attempt:omp-lifecycle-${suffix}`,
    commandId: `command:omp-lifecycle-${suffix}`,
    profileHash: "sha256:omp-lifecycle-fixture",
  };
}

function lifecycleInput(goal: string) {
  return {
    systemPrompt: "Use only the Host model transport.",
    goal,
    modelId: "fixture-model",
    allowedTools: [],
    snapshotDigest: "sha256:omp-lifecycle-snapshot",
    originalExecutionFingerprint: { algorithm: "sha256", hash: "omp-lifecycle-input" } as JsonValue,
  };
}

function textResponse(text: string): HostModelResponse {
  return {
    deltas: [],
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

async function appendObservation(
  store: SqliteEventStore,
  scope: ChannelScope,
  runId: string,
  observation: Observation,
): Promise<void> {
  const streamId = runId as never as StreamId;
  const events = await readStream(store, scope, streamId);
  const payload: JsonValue = observation.type === "message_end"
    ? { message: parseJsonValue(observation.message, "OMP lifecycle observation") }
    : observation.type === "turn_end"
      ? { phase: "turn_end", modelRequestId: observation.modelRequestId }
      : { phase: observation.phase };
  await store.scope(scope).append({
    id: randomUUID() as EventId,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId,
    seq: nextSequence(events),
    type: observation.type === "message_end" ? "omp.transcript.message" : "run.progress",
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    payload,
  });
}

async function appendCheckEvent(store: SqliteEventStore, scope: ChannelScope, runId: string, id: string): Promise<void> {
  const streamId = runId as never as StreamId;
  const events = await readStream(store, scope, streamId);
  await store.scope(scope).append({
    id: id as EventId,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId,
    seq: nextSequence(events),
    type: "run.progress",
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    payload: { phase: "lifecycle_store_check" },
  });
}

async function readScope(store: SqliteEventStore, scope: ChannelScope, runId: string): Promise<CanonicalEvent[]> {
  const streamId = runId as never as StreamId;
  return readStream(store, scope, streamId);
}

async function readStream(
  store: SqliteEventStore,
  scope: ChannelScope,
  streamId: StreamId,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope(scope).read(streamId)) events.push(event);
  return events;
}

function nextSequence(events: readonly CanonicalEvent[]): number {
  return events.reduce((next, event) => Math.max(next, event.seq + 1), 0);
}

async function attemptDirectories(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith("anna-omp-attempt-"));
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

async function materializeRuntime(): Promise<RuntimeFixture> {
  const container = await mkdtemp(join(tmpdir(), "anna-omp-lifecycle-"));
  const root = join(container, "runtime");
  await cp(materializedRoot, root, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(root, name));
  }
  await rm(join(root, "manifest.json"));
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) await visit(path);
      else files.push({
        path: relative(root, path).split(sep).join("/"),
        bytes: metadata.size,
        sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, files, sha256: `sha256:${digest}` }), "utf8");
  return { container, root };
}
