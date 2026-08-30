import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";
import { SqliteEventStore } from "@anna/event-store";
import { parseStartRun } from "@anna/harness-v2";
import { createLiveProfile, createProductionToolGateway } from "../src/production";

import {
  runManagedOmpWorker,
  type HostModelResponse,
} from "../../../packages/omp-loop-kernel/src/worker-client";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("drives an actual OMP model/tool/model turn through the Host client", async () => {
  const container = await mkdtemp(join(tmpdir(), "anna-omp-worker-test-"));
  const runtimeRoot = join(container, "runtime");
  const workspaceRoot = join(container, "workspace");
  const sourceRuntimeRoot = join(repositoryRoot, "packages/omp-loop-kernel/runtime");
  const toolCalls: unknown[] = [];
  const store = new SqliteEventStore(join(container, "events.sqlite"));
  try {
  const profile = await createLiveProfile("fixture-model");
  const command = parseStartRun({
    workspaceId: "workspace-worker-test", channelId: "channel-worker-test", runId: "run-worker-test",
    commandId: "command-worker-test", goal: "Summarize release notes.", source: { eventId: "source-worker-test" },
    runProfile: { id: profile.id, version: profile.version }, runProfileSnapshot: profile,
    budget: profile.budget, permissionScope: "permission-worker-test", stopCondition: profile.terminalRules.stopCondition,
  });
  await store.scope(command).claimStart(command);
  const gateway = createProductionToolGateway({ eventStore: store, command, workspaceRoot });
  let diagnostics = "";
  const modelRequests: HostModelResponse[] = [
    {
      deltas: [
        { type: "toolCall", contentIndex: 0, id: "tool-call-1", name: "read_only", argumentsDelta: '{"path":"release-notes.md"}' },
      ],
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-call-1", name: "read_only", arguments: { path: "release-notes.md" } }],
        stopReason: "toolUse",
      },
    },
    {
      deltas: [{ type: "text", contentIndex: 0, text: "Release notes are ready." }],
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Release notes are ready." }],
        stopReason: "stop",
      },
    },
  ];
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "release-notes.md"), "release notes content", "utf8");
  await cp(join(materializedRoot, "bun"), join(runtimeRoot, "bun"));
  await cp(join(materializedRoot, "node_modules"), join(runtimeRoot, "node_modules"), { recursive: true });
  await rm(join(runtimeRoot, "node_modules/.bin"), { recursive: true, force: true });
  await cp(join(sourceRuntimeRoot, "worker.ts"), join(runtimeRoot, "worker.ts"));
  await cp(join(sourceRuntimeRoot, "protocol.ts"), join(runtimeRoot, "protocol.ts"));

    const result = await runManagedOmpWorker({
      onDiagnostic: text => { diagnostics += text; },
      runtimeRoot,
      entryPath: join(runtimeRoot, "worker.ts"),
      attemptParent: container,
      workspaceRoot,
      binding: {
        workspaceId: "workspace-worker-test",
        channelId: "channel-worker-test",
        runId: "run-worker-test",
        attemptId: "attempt-worker-test",
        commandId: "command-worker-test",
        profileHash: profile.hash,
      },
      input: {
        systemPrompt: "Use only the declared read tool.",
        goal: "Summarize release notes.",
        modelId: "fixture-model",
        allowedTools: [{
          name: "read_only",
          description: "Read an admitted workspace file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        }],
        snapshotDigest: "sha256:snapshot-worker-test",
        originalExecutionFingerprint: "sha256:input-worker-test",
      },
      modelTransport: async function* (context) {
        if (modelRequests.length === 1) {
          expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", status: "succeeded" });
          expect(context.messages.at(-1)?.content).toContain("release notes content");
        }
        const response = modelRequests.shift();
        if (response === undefined) throw new Error("unexpected model request");
        yield response;
      },
      toolGateway: async (name, input, toolCallId, signal) => {
        toolCalls.push({ name, input });
        return gateway.execute({ workspaceId: command.workspaceId, channelId: command.channelId,
          runId: command.runId, workerProfileId: profile.workerProfileId, name, input, toolCallId }, signal);
      },
    }).catch(error => { throw new Error(`${error.message}\n${diagnostics}`); });

    expect(result.modelRequestCount).toBe(2);
    expect(toolCalls).toEqual([{ name: "read_only", input: { path: "release-notes.md" } }]);
    expect(result.terminal).toEqual({ outcome: "completed" });
    expect(result.runtime).toMatchObject({ bunVersion: "1.3.14", ompVersion: "18.0.11" });
    const events = [];
    for await (const event of store.scope(command).read(`tool:${command.runId}:tool-call-1` as never)) events.push(event);
    expect(events.map(event => event.type)).toEqual(["tool.requested", "tool.policy.decided", "tool.result"]);
    expect(result.observations.map((event) => event.type)).toEqual(expect.arrayContaining([
      "progress",
      "message_end",
      "turn_end",
    ]));
  } finally {
    store.close();
    await rm(container, { recursive: true, force: true });
  }
}, 60_000);
