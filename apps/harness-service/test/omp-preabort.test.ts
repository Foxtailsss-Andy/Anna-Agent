import { expect, test } from "vitest";

import { parseStartRun } from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import {
  OmpLoopKernel,
} from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";

test("pre-aborted OMP Run performs no manifest, Host preparation, or worker I/O", async () => {
  const profile = resolvedRunProfileFixture({
    memoryPolicy: { read: "channel", write: "disabled" },
  });
  const command = parseStartRun({
    workspaceId: "workspace:omp-preabort",
    channelId: "channel:omp-preabort",
    commandId: "command:omp-preabort",
    runId: "run:omp-preabort",
    goal: "Do not start.",
    source: { eventId: "event:omp-preabort" },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: "permission:omp-preabort",
    stopCondition: profile.terminalRules.stopCondition,
  });
  const controller = new AbortController();
  controller.abort("test-preabort");
  let preparationCalls = 0;
  let appendCalls = 0;
  const kernel = new OmpLoopKernel({
    runtimeRoot: "/private/var/empty/omp-runtime",
    expectedManifestDigest: `sha256:${"0".repeat(64)}`,
    workspaceRoot: "/private/var/empty/omp-workspace",
    modelTransport: async function* () {},
    createToolGateway: () => ({
      execute: async () => ({ status: "failed" as const }),
    }),
    prepareContext: async () => {
      preparationCalls += 1;
      throw new Error("preparation must not run");
    },
  });

  await expect(kernel.start(command, {
    append: async () => {
      appendCalls += 1;
    },
  }, controller.signal)).rejects.toThrow("cancelled before startup");
  expect(preparationCalls).toBe(0);
  expect(appendCalls).toBe(0);
  await kernel.close();
});
