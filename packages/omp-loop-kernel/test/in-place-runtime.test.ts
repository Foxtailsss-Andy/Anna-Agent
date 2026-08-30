import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";
import { runManagedOmpWorker } from "../src/worker-client";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("starts the materialized managed worker in its production layout", async () => {
  const protectedRoot = join(repositoryRoot, ".tmp-tests");
  await mkdir(protectedRoot, { recursive: true });
  const directory = await mkdtemp(join(protectedRoot, "omp-layout-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  let modelCalls = 0;
  let toolCalls = 0;
  let diagnostics = "";

  try {
    const result = await runManagedOmpWorker({
      onDiagnostic: text => { diagnostics += text; },
      runtimeRoot: materializedRoot,
      entryPath: join(materializedRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-omp-layout",
        channelId: "channel-omp-layout",
        runId: "run-omp-layout",
        attemptId: "attempt-omp-layout",
        commandId: "command-omp-layout",
        profileHash: "profile-omp-layout",
      },
      input: {
        systemPrompt: "test",
        goal: "already completed",
        modelId: "fixture-model",
        allowedTools: [],
        snapshotDigest: "snapshot-omp-layout",
        originalExecutionFingerprint: "fingerprint-omp-layout",
        transcript: [
          { role: "user", content: "already completed" },
          { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        ],
      },
      modelTransport: async function* () {
        modelCalls += 1;
      },
      toolGateway: async () => {
        toolCalls += 1;
        return { status: "failed" as const };
      },
    }).catch(error => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
    });

    expect(result.runtime).toMatchObject({ bunVersion: "1.3.14", ompVersion: "18.0.11" });
    expect(result.modelRequestCount).toBe(0);
    expect(result.terminal).toEqual({ outcome: "completed" });
    expect(modelCalls).toBe(0);
    expect(toolCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
