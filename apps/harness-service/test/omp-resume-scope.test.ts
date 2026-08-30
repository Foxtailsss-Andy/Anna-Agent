import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  parseCanonicalEvent,
  parseOmpKernelDescriptor,
  parseStartRun,
  type CanonicalEvent,
  type EventSink,
  type StartRun,
  type StreamId,
} from "@anna/harness-v2";
import { expect, test } from "vitest";

import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import { measureOmpImplementation } from "../../../packages/omp-loop-kernel/src/kernel-source";
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import { createHostMemoryContextLoader } from "../src/host-memory-context";
import { startHarnessService } from "../src/index";
import { createLiveHarnessV2Runtime, createLiveProfile, createProductionToolGateway } from "../src/production";

const root = resolve(import.meta.dirname, "../../..");
const runtimeRoot = join(root, "build/omp-runtime/darwin-arm64");

test("HTTP resume reuses active handles and isolates consumed Runs sharing one ID across Channels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-scope-"));
  const eventStorePath = join(directory, "events.sqlite");
  const configPath = join(directory, "runtime.json");
  const channels = ["channel-a", "channel-b"] as const;
  const firstCalls = new Map<string, number>();
  const resumedCalls = new Map<string, number>();
  const releaseModel = deferred();
  const modelEntered = new Map(channels.map((channel) => [channel, deferred()]));
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;

  try {
    const descriptor = await currentDescriptor();
    const profile = await createLiveProfile("fixture-model", undefined, false, "general", "channel", descriptor);
    const commands = channels.map((channelId) => parseStartRun({
      workspaceId: "workspace-shared-resume",
      channelId,
      runId: "run-shared-resume",
      commandId: "command-shared-resume",
      surfaceId: "cowork",
      goal: `Read ${channelId} notes.`,
      source: { eventId: `source-${channelId}` },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-shared-resume",
      stopCondition: profile.terminalRules.stopCondition,
    }));
    firstStore = new SqliteEventStore(eventStorePath);
    for (const command of commands) {
      await writeFile(join(directory, `${command.channelId}.txt`), `Private output for ${command.channelId}.`, "utf8");
      await seedMemory(firstStore, command);
      const scoped = firstStore.scope(command);
      await scoped.claimStart(command);
      await scoped.append(event(command, 0, "run.queued", { phase: "queued" }));
    }

    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot: directory,
      prepareContext: createHostMemoryContextLoader({ eventStore: firstStore }),
      modelTransport: async function* (context) {
        const command = commands.find((candidate) => context.messages.some((message) =>
          message.role === "user" && message.content === candidate.goal));
        expect(command).toBeDefined();
        const channel = command!.channelId;
        firstCalls.set(channel, (firstCalls.get(channel) ?? 0) + 1);
        expect(context.systemPrompt).toContain(`Original ${channel} notes memory.`);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "toolCall" as const, id: "shared-read-call", name: "read_only", arguments: { path: `${channel}.txt` } }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: (command) => createProductionToolGateway({ eventStore: firstStore!, command, workspaceRoot: directory }),
    });

    for (const command of commands) {
      const scoped = firstStore.scope(command);
      const lossSink: EventSink & { read: (id: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent> } = {
        async append(value) {
          await scoped.append(value);
          if (value.type === "omp.transcript.message" && messageRole(value) === "toolResult") {
            throw new Error("simulated consumed-result ACK loss");
          }
        },
        read: (id, afterSeq) => scoped.read(id, afterSeq),
      };
      await expect(firstKernel.start(command, lossSink, new AbortController().signal))
        .rejects.toThrow("simulated consumed-result ACK loss");
      const before = await readEvents(firstStore, command);
      expect(before.filter((value) => value.type === "omp.transcript.message")).toHaveLength(3);
      expect(before.filter((value) => isTerminal(value.type))).toHaveLength(0);
      expect(firstCalls.get(command.channelId)).toBe(1);
    }
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
      workspaceRoot: directory,
      surfaces: ["cowork"],
      ompModelTransport: async function* (context, signal) {
        const command = commands.find((candidate) => context.messages.some((message) =>
          message.role === "user" && message.content === candidate.goal));
        expect(command).toBeDefined();
        const channel = command!.channelId as typeof channels[number];
        const other = channels.find((candidate) => candidate !== channel)!;
        resumedCalls.set(channel, (resumedCalls.get(channel) ?? 0) + 1);
        expect(context.systemPrompt).toContain(`Original ${channel} notes memory.`);
        expect(context.systemPrompt).not.toContain(`Original ${other} notes memory.`);
        expect(JSON.stringify(context.messages)).toContain(`Private output for ${channel}.`);
        expect(JSON.stringify(context.messages)).not.toContain(`Private output for ${other}.`);
        modelEntered.get(channel)!.resolve();
        await waitForRelease(releaseModel.promise, signal);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `Recovered ${channel}.` }],
            stopReason: "stop" as const,
          },
        };
      },
    });
    service = await startHarnessService({ runtime: live.runtime });
    for (const command of commands) {
      const response = await resume(service.url, command);
      expect(response.status, JSON.stringify(await response.json())).toBe(202);
      await within(modelEntered.get(command.channelId as typeof channels[number])!.promise, 10_000);
      const duplicate = await resume(service.url, command);
      expect(duplicate.status, JSON.stringify(await duplicate.json())).toBe(202);
    }
    expect([...resumedCalls.entries()]).toEqual(channels.map((channel) => [channel, 1]));
    releaseModel.resolve();

    for (const command of commands) {
      const events = await waitForTerminal(live.eventStore as SqliteEventStore, command);
      expect(events.at(-1)?.type, JSON.stringify(events.map((value) => value.type))).toBe("run.completed");
      expect(events.filter((value) => isTerminal(value.type))).toHaveLength(1);
      expect(events.filter((value) => value.type === "run.eval.contract")).toHaveLength(1);
      expect(events.at(-2)?.type).toBe("run.eval.contract");
      expect(events.filter((value) => value.type === "run.started")).toHaveLength(1);
      expect(events.filter((value) => value.type === "run.resumed")).toHaveLength(1);
      expect(events.filter((value) => value.type === "run.context.ready")).toHaveLength(1);
      expect(events.filter((value) => value.type === "memory.hit")).toHaveLength(1);
      expect(events.filter((value) => value.type === "omp.transcript.message" && messageRole(value) === "user")).toHaveLength(1);
      expect(events.map((value) => value.seq)).toEqual(events.map((_value, index) => index));
      expect(events.every((value) => value.channelId === command.channelId && value.workspaceId === command.workspaceId)).toBe(true);
      const toolEvents: CanonicalEvent[] = [];
      for await (const value of live.eventStore.scope(command).read(`tool:${command.runId}:shared-read-call` as StreamId)) toolEvents.push(value);
      expect(toolEvents.filter((value) => value.type === "tool.requested")).toHaveLength(1);
      const priorCount = events.length;
      const finishedResume = await resume(service.url, command);
      expect(finishedResume.status).toBe(202);
      expect(await readEvents(live.eventStore as SqliteEventStore, command)).toHaveLength(priorCount);
    }
    expect([...resumedCalls.entries()]).toEqual(channels.map((channel) => [channel, 1]));
  } finally {
    releaseModel.resolve();
    await service?.close();
    await live?.close();
    await firstKernel?.close();
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

async function seedMemory(store: SqliteEventStore, command: StartRun): Promise<void> {
  const profile = resolvedRunProfileFixture({ memoryPolicy: { read: "channel", write: "propose" } });
  const source = parseStartRun({
    ...command,
    commandId: "memory-source-command",
    runId: "memory-source-run",
    goal: "Record notes guidance.",
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    stopCondition: profile.terminalRules.stopCondition,
  });
  const scoped = store.scope(source);
  await scoped.claimStart(source);
  const completed = event(source, 0, "run.completed", { outcome: "completed" });
  await scoped.append(completed);
  const memory = createChannelMemoryRepository({
    eventStore: store,
    scope: source,
    runProfileSnapshot: profile,
    authorization: { async assertOwner(scope, actor) {
      if (scope.workspaceId !== command.workspaceId || scope.channelId !== command.channelId || actor !== "owner") throw new Error("Owner denied");
    } },
  });
  await memory.propose({ id: "shared-memory", content: `Original ${command.channelId} notes memory. ${command.goal}`, sourceRunId: source.runId, sourceEventIds: [completed.id] });
  await memory.accept({ candidateId: "shared-memory", actorId: "owner" });
  expect((await memory.retrieve({ query: command.goal, limit: 8 })).map((item) => item.id)).toEqual(["shared-memory"]);
}

async function currentDescriptor() {
  const manifest = JSON.parse(await readFile(join(runtimeRoot, "manifest.json"), "utf8")) as { sha256: string };
  const implementation = measureOmpImplementation();
  return parseOmpKernelDescriptor({
    schemaVersion: 1, adapterId: "omp", protocolVersion: "anna-omp/1",
    adapterSource: { packageName: "@anna/omp-loop-kernel", sha256: implementation.sourceSha256 },
    upstream: { packageName: "@oh-my-pi/pi-coding-agent", version: "18.0.11", sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2", integrity: "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==" },
    runtime: {
      platform: "darwin", arch: "arm64", bunVersion: "1.3.14",
      bunSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
      nativeSha256: "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b",
      dependencyLockSha256: implementation.dependencyLockSha256,
      runtimeManifestSha256: manifest.sha256.replace(/^sha256:/, ""),
    },
  });
}

function event(command: StartRun, seq: number, type: string, payload: Record<string, string>): CanonicalEvent {
  return parseCanonicalEvent({
    id: `event:${command.channelId}:${command.runId}:${seq}`,
    workspaceId: command.workspaceId, channelId: command.channelId,
    streamId: command.runId, seq, type, timestamp: new Date().toISOString(), schemaVersion: 1, payload,
  });
}

function messageRole(value: CanonicalEvent): unknown {
  return (value.payload as { message?: { role?: unknown } }).message?.role;
}

function isTerminal(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.timed_out", "run.awaiting_input", "run.awaiting_approval"].includes(type);
}

async function readEvents(store: SqliteEventStore, command: StartRun): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const value of store.scope(command).read(command.runId as unknown as StreamId)) result.push(value);
  return result;
}

async function waitForTerminal(store: SqliteEventStore, command: StartRun): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const events = await readEvents(store, command);
    if (events.some((value) => isTerminal(value.type))) return events;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Scoped OMP resume did not terminate");
}

function resume(url: string, command: StartRun): Promise<Response> {
  return fetch(`${url}/v2/surfaces/cowork/runs/${command.runId}/resume`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: command.workspaceId, channel_id: command.channelId }),
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Scoped model did not start")), milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForRelease(release: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Scoped model cancelled");
  let onAbort!: () => void;
  try {
    await Promise.race([release, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Scoped model cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
