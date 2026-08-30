import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseStartRun } from "@anna/harness-v2";
import { expect, test } from "vitest";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";

test("concurrent close calls share completion while Host preparation is active", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const runtimeRoot = resolve(repositoryRoot, "build/omp-runtime/darwin-arm64");
  const manifest = JSON.parse(await readFile(
    resolve(runtimeRoot, "manifest.json"),
    "utf8",
  )) as { sha256: string };
  const profile = resolvedRunProfileFixture({
    budget: { turns: 1 },
    memoryPolicy: { read: "channel", write: "disabled" },
  });
  const command = parseStartRun({
    workspaceId: "workspace:omp-close",
    channelId: "channel:omp-close",
    commandId: "command:omp-close",
    runId: "run:omp-close",
    goal: "Wait for close.",
    source: { eventId: "event:omp-close" },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: "permission:omp-close",
    stopCondition: profile.terminalRules.stopCondition,
  });
  let preparationStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { preparationStarted = resolveStarted; });
  let releasePreparation!: () => void;
  const preparationReleased = new Promise<void>((resolveReleased) => { releasePreparation = resolveReleased; });
  let modelCalls = 0;
  const kernel = new OmpLoopKernel({
    runtimeRoot,
    expectedManifestDigest: manifest.sha256,
    workspaceRoot: repositoryRoot,
    modelTransport: async function* () {
      modelCalls += 1;
    },
    createToolGateway: () => ({ execute: async () => ({ status: "succeeded" as const }) }),
    prepareContext: async () => {
      preparationStarted();
      await preparationReleased;
      throw new Error("Host preparation released after close");
    },
  });

  const start = kernel.start(command, { append: async () => {} }, new AbortController().signal);
  await started;
  const firstClose = kernel.close();
  const secondClose = kernel.close();
  await expect(Promise.race([
    firstClose.then(() => "settled"),
    new Promise<string>((resolvePending) => setTimeout(() => resolvePending("pending"), 50)),
  ])).resolves.toBe("pending");
  await expect(Promise.race([
    secondClose.then(() => "settled"),
    new Promise<string>((resolvePending) => setTimeout(() => resolvePending("pending"), 50)),
  ])).resolves.toBe("pending");
  releasePreparation();
  await expect(start).resolves.toEqual({ status: "cancelled" });
  await Promise.all([firstClose, secondClose]);
  expect(modelCalls).toBe(0);
}, 30_000);
