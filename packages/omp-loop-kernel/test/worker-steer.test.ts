import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";
import { runManagedOmpWorker, type ManagedOmpWorkerControl } from "../src/worker-client";
import type { Message, Observation } from "../src/protocol";

const repository = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repository, "build/omp-runtime/darwin-arm64");
const sourceRuntimeRoot = join(repository, "packages/omp-loop-kernel/runtime");

test("managed worker steers the live OMP session and persists the consumed user turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-worker-steer-"));
  const runtimeRoot = join(directory, "runtime");
  const workspaceRoot = join(directory, "workspace");
  await cp(materializedRoot, runtimeRoot, { recursive: true });
  for (const name of ["worker.ts", "protocol.ts"]) {
    await cp(join(sourceRuntimeRoot, name), join(runtimeRoot, name));
  }
  await mkdir(workspaceRoot);

  let control!: ManagedOmpWorkerControl;
  let steerPromise!: Promise<void>;
  let modelCalls = 0;
  const observations: Observation[] = [];
  try {
    const result = await runManagedOmpWorker({
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: directory,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-worker-steer",
        channelId: "channel-worker-steer",
        runId: "run-worker-steer",
        attemptId: "attempt-worker-steer",
        commandId: "command-worker-steer",
        profileHash: "profile-worker-steer",
      },
      input: {
        systemPrompt: "test",
        goal: "begin the bounded task",
        modelId: "fixture-model",
        allowedTools: [],
        snapshotDigest: "snapshot-worker-steer",
        originalExecutionFingerprint: "fingerprint-worker-steer",
      },
      onControlReady: (nextControl) => { control = nextControl; },
      beforeModel: async (context) => {
        if (modelCalls !== 0) return;
        expect(context.messages).toEqual([{ role: "user", content: "begin the bounded task" }]);
        steerPromise = control.steer({ content: "change direction to the checked path" });
      },
      modelTransport: async function* (context) {
        modelCalls += 1;
        if (modelCalls === 1) {
          expect(context.messages).toEqual([{ role: "user", content: "begin the bounded task" }]);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
          yield {
            deltas: [],
            message: {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "acknowledged" }],
              stopReason: "stop" as const,
            },
          };
          return;
        }
        expect(context.messages).toEqual([
          { role: "user", content: "begin the bounded task" },
          { role: "assistant", content: [{ type: "text", text: "acknowledged" }], stopReason: "stop" },
          {
            role: "user",
            content: "<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\nchange direction to the checked path",
          },
        ]);
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "steered" }],
            stopReason: "stop" as const,
          },
        };
      },
      toolGateway: async () => ({ status: "failed" as const, output: "unexpected tool" }),
      persistObservation: async (observation) => { observations.push(observation); },
    });

    await expect(steerPromise).resolves.toBeUndefined();
    expect(result.terminal.outcome).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(observations).toContainEqual({
      type: "message_end",
      message: { role: "user", content: "change direction to the checked path" },
    } satisfies Observation);
    expect(observations.filter((observation) => observation.type === "message_end").map((observation) =>
      observation.type === "message_end" ? (observation.message as Message).role : undefined,
    )).toEqual(["user", "assistant", "user", "assistant"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
