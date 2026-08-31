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
  parseStartRun,
  resolveRunProfile,
  type CanonicalEvent,
  type EventSink,
  type ResolvedRunProfile,
  type StartRun,
  type StreamId,
} from "@anna/harness-v2";
import { expect, test } from "vitest";

import { createLiveProfile } from "../src/production";
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("reopen validates native Todo phases and counts the consumed Todo against budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-native-todo-reopen-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;
  try {
    const manifestDigest = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile("fixture-model", undefined, false, "chat", "none");
    const profile = withBudget(baseProfile, { wallTimeMs: 30_000, turns: 3, toolCalls: 1 });
    const command = commandFor(profile, "native-todo-reopen");

    firstStore = new SqliteEventStore(eventStorePath);
    const durable = firstStore.scope(command);
    await durable.claimStart(command);
    await durable.append(event(command, 0, "run.queued", { phase: "queued" }));
    let firstModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${manifestDigest}`,
      workspaceRoot,
      toolDefinitionsFor: () => [todoDefinition()],
      modelTransport: async function* () {
        firstModelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "toolCall" as const, id: "todo-first", name: "todo", arguments: {
              op: "init",
              list: [{ phase: "Delivery", items: ["Ship the parity slice"] }],
            } }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => ({ execute: async () => { throw new Error("native Todo must not use Gateway"); } }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(value) {
        await durable.append(value);
        if (value.type === "omp.transcript.message" && messageRole(value) === "toolResult") {
          throw new Error("simulated native Todo observation loss");
        }
      },
      read: (streamId, afterSeq) => durable.read(streamId, afterSeq),
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated native Todo observation loss");
    const beforeReopen = await readEvents(firstStore, command);
    expect(firstModelCalls).toBe(1);
    expect(beforeReopen.filter((value) => value.type === "omp.tool.dispatch")).toHaveLength(0);
    expect(beforeReopen.filter((value) => value.type === "omp.tool.response")).toHaveLength(0);
    expect(beforeReopen.filter((value) => value.type === "omp.transcript.message")).toHaveLength(3);

    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${manifestDigest}`,
      workspaceRoot,
      toolDefinitionsFor: () => [todoDefinition()],
      modelTransport: async function* (context) {
        resumedModelCalls += 1;
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "todo" });
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "toolCall" as const, id: "todo-second", name: "todo", arguments: { op: "view" } }],
            stopReason: "toolUse" as const,
          },
        };
      },
      createToolGateway: () => ({ execute: async () => { throw new Error("native Todo must not use Gateway"); } }),
    });

    await expect(resumedKernel.start(command, resumedStore.scope(command), new AbortController().signal))
      .resolves.toEqual({ status: "timed_out" });
    expect(resumedModelCalls).toBe(1);
    const afterReopen = await readEvents(resumedStore, command);
    const todoMessages = afterReopen
      .filter((value) => value.type === "omp.transcript.message")
      .filter((value) => messageRole(value) === "toolResult");
    expect(todoMessages).toHaveLength(1);
    expect(messagePayload(todoMessages[0]!)?.details).toMatchObject({
      phases: [{ name: "Delivery", tasks: [{ content: "Ship the parity slice" }] }],
    });
    expect(afterReopen.at(-1)?.type).toBe("run.timed_out");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("reopen accepts a consumed steer before the next model checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-steer-reopen-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  const eventStorePath = join(directory, "events.sqlite");
  let firstStore: SqliteEventStore | undefined;
  let firstKernel: OmpLoopKernel | undefined;
  let resumedStore: SqliteEventStore | undefined;
  let resumedKernel: OmpLoopKernel | undefined;
  let steerPromise: Promise<void> | undefined;
  try {
    const manifestDigest = await materializeRuntime(runtimeRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const baseProfile = await createLiveProfile("fixture-model", undefined, false, "general", "none");
    const profile = withBudget(baseProfile, { wallTimeMs: 30_000, turns: 3 });
    const command = commandFor(profile, "steer-reopen");

    firstStore = new SqliteEventStore(eventStorePath);
    const durable = firstStore.scope(command);
    await durable.claimStart(command);
    await durable.append(event(command, 0, "run.queued", { phase: "queued" }));
    let modelCalls = 0;
    let beforeModelCalls = 0;
    firstKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${manifestDigest}`,
      workspaceRoot,
      beforeModel: (_command, context) => {
        beforeModelCalls += 1;
        if (beforeModelCalls === 1) {
          expect(context.messages).toEqual([{ role: "user", content: command.goal }]);
          steerPromise = firstKernel!.steer(command.runId, {
            workspaceId: command.workspaceId,
            channelId: command.channelId,
            content: "switch to the checked path",
          });
        }
      },
      modelTransport: async function* (context) {
        modelCalls += 1;
        if (modelCalls === 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "first answer" }],
              stopReason: "stop" as const,
            },
          };
          return;
        }
        expect(context.messages.at(-1)?.role).toBe("user");
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "steered answer" }],
            stopReason: "stop" as const,
          },
        };
      },
      createToolGateway: () => ({ execute: async () => { throw new Error("steer fixture must not use a tool"); } }),
    });
    const failingSink: EventSink & {
      read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
    } = {
      async append(value) {
        if (value.type === "run.completed") throw new Error("simulated terminal persistence loss after steer");
        await durable.append(value);
      },
      read: (streamId, afterSeq) => durable.read(streamId, afterSeq),
    };

    await expect(firstKernel.start(command, failingSink, new AbortController().signal))
      .rejects.toThrow("simulated terminal persistence loss after steer");
    await expect(steerPromise).resolves.toBeUndefined();
    const beforeReopen = await readEvents(firstStore, command);
    expect(modelCalls).toBe(2);
    expect(beforeReopen.filter((value) => value.type === "omp.transcript.message")).toHaveLength(4);
    expect(beforeReopen.filter((value) => messageRole(value) === "user")).toHaveLength(2);
    expect(beforeReopen.filter((value) => value.type === "omp.model.response")).toHaveLength(2);
    expect(beforeReopen.some((value) => value.type === "run.completed")).toBe(false);

    await firstKernel.close();
    firstKernel = undefined;
    firstStore.close();
    firstStore = undefined;

    resumedStore = new SqliteEventStore(eventStorePath);
    let resumedModelCalls = 0;
    resumedKernel = new OmpLoopKernel({
      runtimeRoot,
      expectedManifestDigest: `sha256:${manifestDigest}`,
      workspaceRoot,
      modelTransport: async function* () {
        resumedModelCalls += 1;
        throw new Error("completed steered tail must not call model on reopen");
      },
      createToolGateway: () => ({ execute: async () => { throw new Error("completed steered tail must not use tool"); } }),
    });
    await expect(resumedKernel.start(command, resumedStore.scope(command), new AbortController().signal))
      .resolves.toEqual({ status: "completed" });
    expect(resumedModelCalls).toBe(0);
    const afterReopen = await readEvents(resumedStore, command);
    expect(afterReopen.filter((value) => value.type === "run.model.requested")).toHaveLength(2);
    expect(afterReopen.filter((value) => value.type === "omp.model.response")).toHaveLength(2);
    expect(afterReopen.filter((value) => value.type === "run.resumed")).toHaveLength(1);
    expect(afterReopen.at(-1)?.type).toBe("run.completed");
  } finally {
    await resumedKernel?.close().catch(() => undefined);
    resumedStore?.close();
    await firstKernel?.close().catch(() => undefined);
    firstStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

function withBudget(profile: ResolvedRunProfile, budget: ResolvedRunProfile["budget"]): ResolvedRunProfile {
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

function commandFor(profile: ResolvedRunProfile, suffix: string): StartRun {
  return parseStartRun({
    workspaceId: `workspace-${suffix}`,
    channelId: `channel-${suffix}`,
    commandId: `command-${suffix}`,
    runId: `run-${suffix}`,
    goal: "Complete the bounded parity task.",
    source: { eventId: `source-${suffix}` },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: `permission-${suffix}`,
    stopCondition: profile.terminalRules.stopCondition,
  });
}

function todoDefinition() {
  return {
    name: "todo",
    description: "Maintain the durable Todo plan for this Anna task.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string" },
        list: { type: "array" },
        task: { type: "string" },
        phase: { type: "string" },
        items: { type: "array" },
      },
      additionalProperties: true,
    },
  } as const;
}

function event(command: StartRun, seq: number, type: string, payload: Record<string, unknown>): CanonicalEvent {
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
  };
}

function messagePayload(eventValue: CanonicalEvent): Record<string, unknown> | undefined {
  if (eventValue.payload === null || typeof eventValue.payload !== "object" || Array.isArray(eventValue.payload)) return undefined;
  const message = (eventValue.payload as Record<string, unknown>).message;
  return message !== null && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : undefined;
}

function messageRole(eventValue: CanonicalEvent): unknown {
  return messagePayload(eventValue)?.role;
}

async function readEvents(store: SqliteEventStore, command: StartRun): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const value of store.scope(command).read(command.runId as unknown as StreamId)) events.push(value);
  return events;
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
      if (metadata.isDirectory()) await visit(absolute);
      else files.push({
        path: relative(runtimeRoot, absolute).split(sep).join("/"),
        bytes: metadata.size,
        sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
      });
    }
  }
  await visit(runtimeRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, files, sha256: `sha256:${digest}` }), "utf8");
  return digest;
}
