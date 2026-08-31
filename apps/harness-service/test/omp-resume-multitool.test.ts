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

import { afterAll, beforeAll, expect, test } from "vitest";
import { SqliteEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  parseCanonicalEvent,
  parseStartRun,
  type CanonicalEvent,
  type EventSink,
  type StreamId,
} from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import { withAmpleRunBudget } from "./omp-resume-profile-fixture";

import { startHarnessService } from "../src/index";
import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
} from "../src/production";
import { createHostMemoryContextLoader } from "../src/host-memory-context";
import { measureOmpImplementation } from "../../../packages/omp-loop-kernel/src/kernel-source";
import {
  OmpLoopKernel,
  type OmpHostModelTransport,
} from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import type {
  AssistantMessage,
  ModelContext,
} from "../../../packages/omp-loop-kernel/runtime/protocol";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

type RuntimeDescriptor = Awaited<ReturnType<typeof materializeRuntime>>;
type LossPoint =
  | "first-result-consumed-second-dispatch-lost"
  | "second-delivery-durable-observation-lost";

let fixtureDirectory: string | undefined;
let runtimeRoot: string | undefined;
let descriptor: RuntimeDescriptor | undefined;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "anna-omp-multitool-fixture-"));
  runtimeRoot = join(fixtureDirectory, "runtime");
  descriptor = await materializeRuntime(runtimeRoot);
}, 120_000);

afterAll(async () => {
  if (fixtureDirectory !== undefined) await rm(fixtureDirectory, { recursive: true, force: true });
}, 120_000);

for (const lossPoint of [
  "first-result-consumed-second-dispatch-lost",
  "second-delivery-durable-observation-lost",
] as const) {
  test(`restores one multi-tool OMP response at ${lossPoint}`, async () => {
    await runMultiToolRecovery(lossPoint);
  }, 300_000);
}

async function runMultiToolRecovery(lossPoint: LossPoint): Promise<void> {
  if (runtimeRoot === undefined || descriptor === undefined) {
    throw new Error("OMP runtime fixture was not materialized");
  }

  const directory = await mkdtemp(join(tmpdir(), "anna-omp-multitool-"));
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  const configPath = join(directory, "runtime.json");
  const workspaceId = `workspace-omp-multitool-${lossPoint}`;
  const channelId = `channel-omp-multitool-${lossPoint}`;
  const commandId = `command-omp-multitool-${lossPoint}`;
  const runId = `run-omp-multitool-${lossPoint}`;
  const firstToolCallId = "multitool-read-first";
  const secondToolCallId = "multitool-read-second";
  const firstPath = "first-read.txt";
  const secondPath = "second-read.txt";
  const firstContent = "first source file, unmodified";
  const secondContent = "second source file, unmodified";
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let injectedLoss = false;

  const firstAssistant: AssistantMessage = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: firstToolCallId,
        name: "read_only",
        arguments: { path: firstPath },
      },
      {
        type: "toolCall",
        id: secondToolCallId,
        name: "read_only",
        arguments: { path: secondPath },
      },
    ],
    stopReason: "toolUse",
    usage: { input: 0, output: 2 },
  };
  const resumedAssistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Both source files were recovered." }],
    stopReason: "stop",
  };
  const firstContexts: ModelContext[] = [];
  const resumedContexts: ModelContext[] = [];

  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, firstPath), firstContent, "utf8");
    await writeFile(join(workspaceRoot, secondPath), secondContent, "utf8");

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
      goal: "Original multi-tool recovery memory. Read both source files.",
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
    await seedMemory(firstStore, command, workspaceId, channelId);

    const prepareContext = createHostMemoryContextLoader({ eventStore: firstStore });
    const firstModelTransport: OmpHostModelTransport = async function* (context) {
      firstContexts.push(context);
      expect(context.systemPrompt).toContain("Original multi-tool recovery memory for both source files read.");
      yield { deltas: [], message: firstAssistant };
    };
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${descriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      prepareContext,
      modelTransport: firstModelTransport,
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
        const payload = record(event.payload);
        const message = record(payload?.message);
        const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
        const messageRole = typeof message?.role === "string" ? message.role : undefined;
        if (
          lossPoint === "first-result-consumed-second-dispatch-lost"
          && event.type === "omp.tool.dispatch"
          && toolCallId === secondToolCallId
        ) {
          injectedLoss = true;
          throw new Error("simulated loss before second tool dispatch");
        }
        if (
          lossPoint === "second-delivery-durable-observation-lost"
          && event.type === "omp.transcript.message"
          && messageRole === "toolResult"
          && message?.toolCallId === secondToolCallId
        ) {
          injectedLoss = true;
          throw new Error("simulated loss after second tool delivery");
        }
        await durable.append(event);
      },
      read(streamId, afterSeq) {
        return durable.read(streamId, afterSeq);
      },
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow(lossPoint === "first-result-consumed-second-dispatch-lost"
        ? "simulated loss before second tool dispatch"
        : "simulated loss after second tool delivery");
    expect(injectedLoss).toBe(true);
    const beforeLoss = await readRunEvents(firstStore, command);
    expect(beforeLoss.some((event) => isTerminalEvent(event.type))).toBe(false);
    expect(firstContexts).toHaveLength(1);
    expect(beforeLoss.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(beforeLoss.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(beforeLoss.filter((event) => event.type === "memory.hit")).toHaveLength(1);
    expect(beforeLoss.filter((event) => event.type === "omp.transcript.message")).toHaveLength(3);
    expect(beforeLoss.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(
      lossPoint === "first-result-consumed-second-dispatch-lost" ? 1 : 2,
    );
    expect(beforeLoss.filter((event) => event.type === "omp.tool.response")).toHaveLength(
      lossPoint === "first-result-consumed-second-dispatch-lost" ? 1 : 2,
    );
    expect(beforeLoss
      .filter((event) => event.type === "omp.transcript.message")
      .map((event) => record(record(event.payload)?.message)?.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === "string"))
      .toEqual([firstToolCallId]);
    const firstToolStream = await readToolEvents(firstStore, command, firstToolCallId);
    expect(firstToolStream.filter((event) => event.type === "tool.requested")).toHaveLength(1);
    expect(firstToolStream.filter((event) => event.type === "tool.result")).toHaveLength(1);
    const secondToolStreamBeforeLoss = await readToolEvents(firstStore, command, secondToolCallId);
    expect(secondToolStreamBeforeLoss.filter((event) => event.type === "tool.requested")).toHaveLength(
      lossPoint === "first-result-consumed-second-dispatch-lost" ? 0 : 1,
    );
    expect(secondToolStreamBeforeLoss.filter((event) => event.type === "tool.result")).toHaveLength(
      lossPoint === "first-result-consumed-second-dispatch-lost" ? 0 : 1,
    );

    const firstResponse = beforeLoss.find((event) => event.type === "omp.model.response");
    expect(record(record(firstResponse?.payload)?.message)?.usage).toEqual({ input: 0, output: 2 });
    expect(record(record(firstResponse?.payload)?.message)?.usage).not.toHaveProperty("cost");
    const firstRequested = beforeLoss.find((event) => event.type === "run.model.requested");
    expect(record(firstRequested?.payload)?.inputDigest).toBe(canonicalDigest(firstContexts[0]));

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
        resumedContexts.push(context);
        expect(context.systemPrompt).toContain("Original multi-tool recovery memory for both source files read.");
        yield { deltas: [], message: resumedAssistant };
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

    let resumedEvents: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      resumedEvents = await readRunEvents(live.eventStore as SqliteEventStore, command);
      if (resumedEvents.some((event) => isTerminalEvent(event.type))) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }

    expect(resumedContexts, "production resume did not issue the expected model request").toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.context.ready")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "memory.hit")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.model.requested")).toHaveLength(2);
    expect(resumedEvents.filter((event) => event.type === "omp.model.response")).toHaveLength(2);
    const modelResponses = resumedEvents.filter((event) => event.type === "omp.model.response");
    expect(modelResponses.map((event) => record(event.payload)?.transcriptIndex)).toEqual([1, 4]);
    expect(record(record(modelResponses[1]?.payload)?.message)?.usage).toBeUndefined();
    expect(resumedEvents.filter((event) => event.type === "run.usage.updated")).toHaveLength(1);
    expect(resumedEvents.filter((event) => event.type === "run.usage.updated")[0]?.payload)
      .toMatchObject({ cumulative: { input: 0, output: 2 } });
    expect(record(resumedEvents.filter((event) => event.type === "run.usage.updated")[0]?.payload)?.cumulative)
      .not.toHaveProperty("cost");

    const transcript = resumedEvents
      .filter((event) => event.type === "omp.transcript.message")
      .map((event) => record(event.payload)?.message)
      .filter((message): message is Record<string, unknown> => message !== undefined);
    expect(transcript.filter((message) => message.role === "user")).toHaveLength(1);
    const assistantMessages = transcript.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
    expect(record(assistantMessages[0])?.content).toEqual(firstAssistant.content);
    expect(record(assistantMessages[1])?.content).toEqual(resumedAssistant.content);
    const toolResults = transcript.filter((message) => message.role === "toolResult");
    expect(toolResults.map((message) => message.toolCallId)).toEqual([firstToolCallId, secondToolCallId]);
    expect(toolResults.map((message) => message.toolName)).toEqual(["read_only", "read_only"]);
    expect(JSON.parse(String(toolResults[0]?.content))).toEqual({ path: firstPath, content: firstContent });
    expect(JSON.parse(String(toolResults[1]?.content))).toEqual({ path: secondPath, content: secondContent });

    const dispatches = resumedEvents.filter((event) => event.type === "omp.tool.dispatch");
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((event) => record(event.payload)?.toolCallId))
      .toEqual([firstToolCallId, secondToolCallId]);
    expect(dispatches.map((event) => record(event.payload)?.transcriptIndex)).toEqual([1, 1]);
    const deliveries = resumedEvents.filter((event) => event.type === "omp.tool.response");
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((event) => record(event.payload)?.transcriptIndex)).toEqual([2, 3]);
    expect(deliveries.map((event) => record(event.payload)?.toolCallId))
      .toEqual([firstToolCallId, secondToolCallId]);
    if (lossPoint === "second-delivery-durable-observation-lost") {
      const repaired = resumedEvents
        .filter((event) => event.type === "omp.transcript.message")
        .find((event) => record(record(event.payload)?.repair)?.transcriptIndex === 3);
      expect(repaired).toBeDefined();
      expect(record(record(repaired?.payload)?.repair)?.sourceEventId).toBe(deliveries[1]?.id);
    }

    const requested = resumedEvents.filter((event) => event.type === "run.model.requested");
    expect(requested.map((event) => record(event.payload)?.inputDigest)).toEqual([
      canonicalDigest(firstContexts[0]),
      canonicalDigest(resumedContexts[0]),
    ]);
    expect(record(requested[1]?.payload)?.inputDigest).toBe(canonicalDigest(resumedContexts[0]));
    expect(resumedContexts[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(resumedContexts[0]?.messages).toEqual(transcript.slice(0, 4));

    const toolStreams = await Promise.all([
      readToolEvents(live.eventStore as SqliteEventStore, command, firstToolCallId),
      readToolEvents(live.eventStore as SqliteEventStore, command, secondToolCallId),
    ]);
    for (const events of toolStreams) {
      expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool.result")).toHaveLength(1);
    }

    const evalEvents = resumedEvents.filter((event) => event.type === "run.eval.contract");
    const terminalEvents = resumedEvents.filter((event) => isTerminalEvent(event.type));
    expect(evalEvents).toHaveLength(1);
    expect(terminalEvents).toHaveLength(1);
    expect(resumedEvents.at(-2)?.type).toBe("run.eval.contract");
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");
    expect(resumedEvents.map((event) => event.seq)).toEqual(
      resumedEvents.map((_event, index) => index),
    );
  } finally {
    await service?.close().catch(() => undefined);
    await live?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedMemory(
  store: SqliteEventStore,
  command: ReturnType<typeof parseStartRun>,
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const sourceProfile = withAmpleRunBudget(resolvedRunProfileFixture({
    memoryPolicy: { read: "channel", write: "propose" },
  }));
  const source = parseStartRun({
    workspaceId,
    channelId,
    commandId: `${command.commandId}-memory-source`,
    runId: `${command.runId}-memory-source`,
    goal: "Remember the original multi-tool recovery memory.",
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
    eventStore: store,
    scope: source,
    runProfileSnapshot: sourceProfile,
    authorization: {
      async assertOwner(scope, actorId) {
        if (
          scope.workspaceId !== workspaceId
          || scope.channelId !== channelId
          || actorId !== "owner"
        ) {
          throw new Error("Memory owner denied");
        }
      },
    },
  });
  await memories.propose({
    id: `${command.runId}-memory`,
    content: "Original multi-tool recovery memory for both source files read.",
    sourceRunId: source.runId,
    sourceEventIds: [`${command.runId}-memory-source-completed`],
  });
  await memories.accept({ candidateId: `${command.runId}-memory`, actorId: "owner" });
}

function isTerminalEvent(type: string): boolean {
  return [
    "run.completed",
    "run.failed",
    "run.timed_out",
    "run.cancelled",
  ].includes(type);
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
      );
    }
    return item;
  });
}

function canonicalDigest(context: ModelContext | undefined): string {
  if (context === undefined) throw new Error("model context was not captured");
  return createHash("sha256").update(stableJson({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
  })).digest("hex");
}

async function readRunEvents(
  store: SqliteEventStore,
  command: ReturnType<typeof parseStartRun>,
): Promise<CanonicalEvent[]> {
  return readStreamEvents(store, command, command.runId as unknown as StreamId);
}

async function readToolEvents(
  store: SqliteEventStore,
  command: ReturnType<typeof parseStartRun>,
  toolCallId: string,
): Promise<CanonicalEvent[]> {
  return readStreamEvents(store, command, `tool:${command.runId}:${toolCallId}` as unknown as StreamId);
}

async function readStreamEvents(
  store: SqliteEventStore,
  command: ReturnType<typeof parseStartRun>,
  streamId: StreamId,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope(command).read(streamId)) events.push(event);
  return events;
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
