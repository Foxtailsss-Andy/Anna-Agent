import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { beforeAll, afterAll, expect, test } from "vitest";
import {
  parseStartRun,
  resolveRunProfile,
  type Budget,
  type CanonicalEvent,
  type EventSink,
  type ResolvedRunProfile,
  type StartRun,
  type StreamId,
  type ToolGateway,
  type WorkerProfileId,
  type RunProfileId,
} from "@anna/harness-v2";
import {
  OmpLoopKernel,
  type OmpHostModelTransport,
} from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import type { HostModelResponse } from "../../../packages/omp-loop-kernel/src/worker-client";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

interface RuntimeFixture {
  readonly container: string;
  readonly root: string;
  readonly workspace: string;
  readonly manifestDigest: string;
}

class RecordingSink implements EventSink {
  readonly events: CanonicalEvent[] = [];

  async append(event: CanonicalEvent): Promise<void> {
    this.events.push(event);
  }

  async *read(streamId: StreamId): AsyncIterable<CanonicalEvent> {
    for (const event of this.events) {
      if (event.streamId === streamId) yield event;
    }
  }
}

let runtime!: RuntimeFixture;

beforeAll(async () => {
  runtime = await materializeWorkerRuntime();
}, 60_000);

afterAll(async () => {
  if (runtime !== undefined) await rm(runtime.container, { recursive: true, force: true });
});

test("expires before model startup without invoking the Host transport", async () => {
  const profile = fixtureProfile({ wallTimeMs: 1 });
  const command = fixtureCommand(profile, "wall-expired");
  const sink = new RecordingSink();
  let modelCalls = 0;
  const kernel = createKernel(command, async function* () {
    modelCalls += 1;
    yield textResponse("must not run");
  });

  await expect(kernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "timed_out" });
  expect(modelCalls).toBe(0);
  expect(sink.events.map((event) => event.type)).toEqual(["run.started", "run.timed_out"]);
  await kernel.close();
}, 30_000);

test("cancels a blocked Host preparation without invoking the worker", async () => {
  const profile = fixtureProfile({ wallTimeMs: 180_000 }, "channel");
  const command = fixtureCommand(profile, "preparation-cancelled");
  const sink = new RecordingSink();
  const controller = new AbortController();
  let preparationCalls = 0;
  let modelCalls = 0;
  let preparationStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { preparationStarted = resolveStarted; });
  const kernel = createKernel(command, async function* () {
    modelCalls += 1;
    yield textResponse("must not run");
  }, async (_command, signal) => {
    preparationCalls += 1;
    preparationStarted();
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Host preparation cancelled")), { once: true });
    });
    throw new Error("unreachable");
  });

  const completion = kernel.start(command, sink, controller.signal);
  let entryTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entry = await Promise.race([
      started.then(() => ({ kind: "started" as const })),
      completion.then(
        (outcome) => ({ kind: "settled" as const, outcome }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "deadline" }>((resolveDeadline) => {
        entryTimer = setTimeout(() => resolveDeadline({ kind: "deadline" }), 120_000);
      }),
    ]);
    if (entry.kind === "rejected") throw entry.error;
    if (entry.kind === "settled") {
      throw new Error(`Host preparation Run settled before entry: ${JSON.stringify({
        outcome: entry.outcome,
        events: sink.events.map((event) => event.type),
      })}`);
    }
    if (entry.kind === "deadline") {
      throw new Error(`Host preparation did not start within 120000ms: ${JSON.stringify(
        sink.events.map((event) => event.type),
      )}`);
    }
    controller.abort("test-cancel");
    await expect(completion).resolves.toEqual({ status: "cancelled" });
    expect(preparationCalls).toBe(1);
    expect(modelCalls).toBe(0);
    expect(sink.events.map((event) => event.type)).toEqual(["run.started", "run.cancelled"]);
  } finally {
    if (entryTimer !== undefined) clearTimeout(entryTimer);
    controller.abort("test-cleanup");
    await completion.catch(() => undefined);
    await kernel.close();
  }
}, 180_000);

test("stops before a second Host transport when the turn budget is exhausted", async () => {
  const profile = fixtureProfile({ turns: 1 });
  const command = fixtureCommand(profile, "turn-budget");
  const sink = new RecordingSink();
  let modelCalls = 0;
  let toolCalls = 0;
  const kernel = createKernel(command, async function* () {
    modelCalls += 1;
    yield {
      deltas: [],
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "turn-tool", name: "read_only", arguments: { path: "notes.txt" } }],
        stopReason: "toolUse",
      },
    };
  }, undefined, async () => {
    toolCalls += 1;
    return { status: "succeeded", output: "fixture content" };
  });

  await expect(kernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "timed_out" });
  expect(modelCalls).toBe(1);
  expect(toolCalls).toBe(1);
  expect(sink.events.filter((event) => event.type === "run.model.requested")).toHaveLength(1);
  await kernel.close();
}, 30_000);

test("fails when a budgeted Host response omits usage", async () => {
  const profile = fixtureProfile({ inputTokens: 10 });
  const command = fixtureCommand(profile, "usage-missing");
  const sink = new RecordingSink();
  let modelCalls = 0;
  const kernel = createKernel(command, async function* () {
    modelCalls += 1;
    yield textResponse("usage is required");
  });

  await expect(kernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "failed" });
  expect(modelCalls).toBe(1);
  expect(sink.events.at(-1)?.type).toBe("run.failed");
  expect(sink.events.at(-1)?.payload).toEqual(expect.objectContaining({
    reason: expect.stringContaining("Host usage"),
  }));
  await kernel.close();
}, 30_000);

test("persists over-cap Host usage before timing out", async () => {
  const profile = fixtureProfile({ inputTokens: 1 });
  const command = fixtureCommand(profile, "usage-over-cap");
  const sink = new RecordingSink();
  const kernel = createKernel(command, async function* () {
    yield {
      deltas: [],
      message: {
        ...textResponse("over cap").message,
        usage: { input: 2, output: 1 },
      },
    };
  });

  await expect(kernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "timed_out" });
  const usage = sink.events.find((event) => event.type === "run.usage.updated");
  expect(usage?.payload).toEqual(expect.objectContaining({
    cumulative: { input: 2, output: 1 },
  }));
  expect(sink.events.at(-1)?.type).toBe("run.timed_out");
  await kernel.close();
}, 30_000);

function fixtureProfile(budget: Budget, memoryRead: "none" | "channel" = "none"): ResolvedRunProfile {
  const model = { provider: "fixture", name: "fixture-model", reasoning: "low" as const };
  const skill = {
    id: "fixture-skill",
    name: "Fixture skill",
    version: "1.0.0",
    hash: "sha256:fixture-skill",
    provenance: { source: "test", uri: "fixture://skill" },
    content: "Use the approved read tool.",
    allowedTools: ["read_only"],
    forbiddenTools: ["shell"],
  };
  const artifactContract = { kind: "fixture", requiredFor: ["completed" as const], verification: "tests" as const };
  return resolveRunProfile({
    catalog: [skill],
    channelPolicy: {
      toolPolicy: { allowedTools: ["read_only"] },
      allowedSkillIds: ["fixture-skill"],
      allowedModels: [model],
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: [memoryRead], allowedWriteModes: ["disabled"] },
    },
    workerProfile: {
      id: "fixture-worker" as WorkerProfileId,
      version: "1.0.0",
      instructions: "Use the approved read tool.",
      allowedSkillIds: ["fixture-skill"],
      allowedTools: ["read_only"],
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: budget,
      artifactContract,
    },
    runProfile: {
      id: "profile:omp-budget" as RunProfileId,
      version: "1.0.0",
      model,
      skillIds: ["fixture-skill"],
      contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
      toolPolicy: { allowedTools: ["read_only"] },
      budget,
      memoryPolicy: { read: memoryRead, write: "disabled" },
      evalPolicy: { contract: "disabled", quality: "disabled" },
      artifactContract,
      terminalRules: { allowedOutcomes: ["completed", "failed", "timed_out", "cancelled"], stopCondition: "artifact_or_terminal" },
    },
  });
}

function fixtureCommand(profile: ResolvedRunProfile, suffix: string): StartRun {
  return parseStartRun({
    workspaceId: `workspace:omp-budget-${suffix}`,
    channelId: `channel:omp-budget-${suffix}`,
    commandId: `command:omp-budget-${suffix}`,
    runId: `run:omp-budget-${suffix}`,
    goal: "Read release notes.",
    source: { eventId: `event:omp-budget-${suffix}` },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: `permission:omp-budget-${suffix}`,
    stopCondition: profile.terminalRules.stopCondition,
  });
}

function createKernel(
  command: StartRun,
  modelTransport: OmpHostModelTransport,
  prepareContext?: (command: StartRun, signal: AbortSignal) => Promise<never>,
  toolExecute?: ToolGateway["execute"],
): OmpLoopKernel {
  return new OmpLoopKernel({
    runtimeRoot: runtime.root,
    expectedManifestDigest: runtime.manifestDigest,
    workspaceRoot: runtime.workspace,
    attemptParent: runtime.container,
    modelTransport,
    createToolGateway: () => ({ execute: toolExecute ?? (async () => ({ status: "succeeded", output: "fixture" })) }),
    ...(prepareContext === undefined ? {} : { prepareContext }),
  });
}

function textResponse(text: string): HostModelResponse {
  return {
    deltas: [],
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  };
}

async function materializeWorkerRuntime(): Promise<RuntimeFixture> {
  const container = await mkdtemp(join(tmpdir(), "anna-omp-budget-"));
  const root = join(container, "runtime");
  const workspace = join(container, "workspace");
  await cp(materializedRoot, root, { recursive: true });
  await mkdir(workspace);
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(root, name));
  }
  await rm(join(root, "manifest.json"));
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await stat(path);
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
  const manifestDigest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, files, sha256: `sha256:${manifestDigest}` }), "utf8");
  return { container, root, workspace, manifestDigest: `sha256:${manifestDigest}` };
}
