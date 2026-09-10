import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createOmpKernelDescriptor,
} from "../src/production";
import { resolveRunProfile } from "@anna/harness-v2";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import {
  OmpKernelControlUnavailableError,
  OmpLoopKernel,
} from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import type { HostModelResponse } from "../../../packages/omp-loop-kernel/src/worker-client";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

test("WB-00 records the current Create Skill intersection through the public profile API", async () => {
  const profile = await createLiveProfile(
    "fixture-model",
    undefined,
    false,
    "create",
    "none",
    undefined,
    true,
  );

  expect(profile.allowedTools).toEqual([
    "todo",
    "create.emit_skill_draft",
    "create.emit_prompt_draft",
    "create.emit_python_tool_draft",
  ]);
  expect(profile.allowedTools).not.toContain("web_search");
  expect(profile.allowedTools).not.toContain("workdir.read_file");
  await writeReceipt("receipt-create-profile.json", {
    schemaVersion: 1,
    observationId: "OBS-CREATE-PROFILE-INTERSECTION",
    status: "fail",
    surface: "create",
    allowedTools: profile.allowedTools,
    absentGeneralTools: ["web_search", "workdir.read_file"],
  });
});

test("WB-00 records the public profile resolver removing tools outside the selected Skill", async () => {
  const allowedBySurface = ["tool.allowed", "tool.skill-only", "tool.forbidden"];
  const skill = {
    id: "baseline-skill",
    name: "Baseline Skill",
    version: "1.0.0",
    hash: "sha256:baseline-skill",
    provenance: { source: "fixture", uri: "fixture://wb00-skill" },
    content: "Use the selected baseline tools.",
    allowedTools: ["tool.allowed", "tool.forbidden"],
    forbiddenTools: ["tool.forbidden"],
  } as const;
  const resolved = resolveRunProfile({
    catalog: [skill],
    channelPolicy: {
      toolPolicy: { allowedTools: allowedBySurface },
      allowedSkillIds: ["baseline-skill"],
      allowedModels: [{ provider: "fixture", name: "fixture-model", reasoning: "low" }],
      budgetLimits: { turns: 1 },
      memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
    },
    workerProfile: {
      id: "baseline-worker",
      version: "1.0.0",
      instructions: "Use the baseline Skill.",
      allowedSkillIds: ["baseline-skill"],
      allowedTools: allowedBySurface,
      modelPolicy: { allowedModels: [{ provider: "fixture", name: "fixture-model", reasoning: "low" }] },
      budgetDefaults: { turns: 1 },
      artifactContract: { kind: "baseline", requiredFor: ["completed"], verification: "tests" },
    },
    runProfile: {
      id: "baseline-profile",
      version: "1.0.0",
      model: { provider: "fixture", name: "fixture-model", reasoning: "low" },
      skillIds: ["baseline-skill"],
      contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
      toolPolicy: { allowedTools: allowedBySurface },
      budget: { turns: 1 },
      memoryPolicy: { read: "none", write: "disabled" },
      evalPolicy: { contract: "disabled", quality: "disabled" },
      artifactContract: { kind: "baseline", requiredFor: ["completed"], verification: "tests" },
      terminalRules: { allowedOutcomes: ["completed", "failed"], stopCondition: "artifact_or_terminal" },
    },
  });

  expect(resolved.allowedTools).toEqual(["tool.allowed"]);
  await writeReceipt("receipt-skill-intersection.json", {
    schemaVersion: 1,
    observationId: "OBS-CREATE-PROFILE-INTERSECTION",
    status: "pass",
    channelTools: allowedBySurface,
    skillAllowedTools: skill.allowedTools,
    skillForbiddenTools: skill.forbiddenTools,
    resolvedTools: resolved.allowedTools,
  });
});

test("WB-00 records OMP answer as an explicit current limitation", async () => {
  const kernel = new OmpLoopKernel({
    runtimeRoot: materializedRoot,
    expectedManifestDigest: "sha256:" + "0".repeat(64),
    workspaceRoot: repositoryRoot,
    modelTransport: async function* () {
      yield textResponse("unused");
    },
    createToolGateway: () => async () => ({ status: "succeeded", output: "unused" }),
  });

  await expect(kernel.answer("baseline-answer-run" as never, { content: "fixture answer" }))
    .rejects.toBeInstanceOf(OmpKernelControlUnavailableError);
  await writeReceipt("receipt-omp-answer.json", {
    schemaVersion: 1,
    observationId: "OBS-OMP-ANSWER",
    status: "fail",
    runId: "baseline-answer-run",
    operation: "answer",
    error: "OmpKernelControlUnavailableError",
  });
  await kernel.close();
});

test("WB-00 records Product signal semantics against the live OMP-backed Host", async () => {
  const fixture = await createLiveRuntimeFixture("product-signal");
  const staticRoot = join(fixture.directory, "static");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<div id=\"root\"></div>\n", "utf8");

  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let releaseTransport!: () => void;
  const transportReleased = new Promise<void>((resolveRelease) => {
    releaseTransport = resolveRelease;
  });
  let transportEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => {
    transportEntered = resolveEntered;
  });
  try {
    fixture.live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: fixture.configPath,
      eventStorePath: join(fixture.directory, "events.sqlite"),
      workspaceRoot: fixture.workspaceRoot,
      surfaces: ["chat"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      ompModelTransport: async function* (_context, signal) {
        transportEntered();
        await waitForRelease(transportReleased, signal);
        yield textResponse("fixture response after signal probe");
      },
    });
    host = await startProductHost({
      runtime: fixture.live.runtime,
      eventStore: fixture.live.eventStore,
      staticRoot,
      serviceToken: "wb00-service-token",
      sessionStore: new ProductSessionStore(),
    });

    const submitted = await fetch(`${host.url}/_harness/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anna-service-token": "wb00-service-token",
      },
      body: JSON.stringify({
        run_id: "wb00-product-signal-run",
        workspace_id: "wb00-product-signal-workspace",
        channel_id: "wb00-product-signal-channel",
        actor_user_id: "wb00-user",
        surface: "chat",
        prompt: "Hold at the provider boundary for a signal probe.",
        source_event_id: "wb00-product-signal-source",
      }),
    });
    const submittedBody = await submitted.text();
    expect(submitted.status, submittedBody).toBe(202);
    await withTimeout(entered, 15_000, "OMP Product signal transport did not enter before signal probe");

    const answer = await fetch(`${host.url}/_harness/runs/wb00-product-signal-run/signal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anna-service-token": "wb00-service-token",
      },
      body: JSON.stringify({ kind: "answer", payload: { text: "fixture answer" } }),
    });
    expect(answer.status).toBe(409);
    const answerBody = await answer.json();
    expect(answerBody).toEqual({ code: "harness_signal_unavailable" });
    await writeReceipt("receipt-product-signal.json", {
      schemaVersion: 1,
      observationId: "OBS-OMP-ANSWER",
      status: "fail",
      runId: "wb00-product-signal-run",
      signalKind: "answer",
      httpStatus: answer.status,
      responseCode: answerBody.code,
    });
  } finally {
    releaseTransport();
    await host?.close();
    await fixture.live?.close();
  }
}, 60_000);

test("WB-00 proves two independent Runs overlap at the real OMP transport barrier", async () => {
  const fixture = await createLiveRuntimeFixture("parallel-runs");
  let enteredCount = 0;
  let resolveBothEntered!: () => void;
  const bothEntered = new Promise<void>((resolveEntered) => {
    resolveBothEntered = resolveEntered;
  });
  let releaseTransport!: () => void;
  const transportReleased = new Promise<void>((resolveRelease) => {
    releaseTransport = resolveRelease;
  });
  try {
    fixture.live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: fixture.configPath,
      eventStorePath: join(fixture.directory, "events.sqlite"),
      workspaceRoot: fixture.workspaceRoot,
      surfaces: ["cowork"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      ompModelTransport: async function* (_context, signal) {
        enteredCount += 1;
        if (enteredCount === 2) resolveBothEntered();
        await waitForRelease(transportReleased, signal);
        yield textResponse("completed from the shared transport barrier");
      },
    });

    await Promise.all([
      fixture.live.runtime.start("cowork", startBody("wb00-parallel-run-a", "wb00-parallel-channel-a")),
      fixture.live.runtime.start("cowork", startBody("wb00-parallel-run-b", "wb00-parallel-channel-b")),
    ]);
    await withTimeout(bothEntered, 15_000, "independent OMP Runs did not overlap at transport");
    expect(enteredCount).toBe(2);
    releaseTransport();

    const [eventsA, eventsB] = await Promise.all([
      waitForTerminal(fixture.live.runtime, "wb00-parallel-run-a", "wb00-parallel-channel-a"),
      waitForTerminal(fixture.live.runtime, "wb00-parallel-run-b", "wb00-parallel-channel-b"),
    ]);
    expect(eventsA.at(-1)?.type).toBe("run.completed");
    expect(eventsB.at(-1)?.type).toBe("run.completed");
    expect(eventsA.some((event) => event.type === "run.eval.contract")).toBe(true);
    expect(eventsB.some((event) => event.type === "run.eval.contract")).toBe(true);
    await writeReceipt("receipt-omp-parallel.json", {
      schemaVersion: 1,
      observationId: "OBS-OMP-PARALLEL-BARRIER",
      status: "pass",
      runIds: ["wb00-parallel-run-a", "wb00-parallel-run-b"],
      barrier: { enteredCount, released: true },
      events: {
        "wb00-parallel-run-a": eventsA.map((event) => ({ type: event.type, seq: event.seq })),
        "wb00-parallel-run-b": eventsB.map((event) => ({ type: event.type, seq: event.seq })),
      },
    });
  } finally {
    releaseTransport();
    await fixture.live?.close();
  }
}, 60_000);

async function createLiveRuntimeFixture(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `anna-wb00-${label}-`));
  temporaryDirectories.push(directory);
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  const configPath = join(directory, "runtime.json");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");
  return {
    directory,
    workspaceRoot,
    configPath,
    live: undefined as Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined,
  };
}

async function writeReceipt(name: string, payload: Record<string, unknown>): Promise<void> {
  const root = process.env.ANNA_WB00_RECEIPT_DIR;
  if (root === undefined || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function startBody(runId: string, channelId: string) {
  return {
    workspace_id: "wb00-parallel-workspace",
    channel_id: channelId,
    command_id: `${runId}-command`,
    source_event_id: `${runId}-source`,
    run_id: runId,
    goal: "Complete one bounded baseline transport task.",
  };
}

function textResponse(text: string): HostModelResponse {
  return {
    deltas: [{ type: "text", contentIndex: 0, text }],
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

async function waitForRelease(released: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("transport aborted");
  await Promise.race([
    released,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("transport aborted")), { once: true });
    }),
  ]);
}

async function waitForTerminal(
  runtime: NonNullable<Awaited<ReturnType<typeof createLiveHarnessV2Runtime>>>["runtime"],
  runId: string,
  channelId: string,
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const events = await runtime.readEvents!("wb00-parallel-workspace", channelId, runId);
    if (events.some((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))) return events;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`OMP Run did not terminate: ${runId}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
