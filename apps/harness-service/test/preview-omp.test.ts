import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { SqliteEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  parseCanonicalEvent,
  parseStartRun,
  type ChannelOwnerAuthorization,
  type ChannelScope,
} from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import { derivePreviewScope, startPreviewHarnessService } from "../src/preview";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const ompRuntimeRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("Preview Host drives the actual OMP worker, read_only gateway, Eval and history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-preview-omp-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "notes.txt"), "actual Preview content\n", "utf8");
  let calls = 0;
  const service = await startPreviewHarnessService({
    stateRoot: join(directory, "state"),
    workspaceRoot,
    ompRuntimeRoot,
    ompModelTransport: async function* (context, signal) {
      signal.throwIfAborted();
      calls += 1;
      if (calls === 1) {
        expect(context.systemPrompt).toContain("Preview runs require owner review.");
        yield {
          deltas: [],
          message: {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "preview-read",
              name: "read_only",
              arguments: { path: "notes.txt" },
            }],
            stopReason: "toolUse",
          },
        };
        return;
      }
      expect(JSON.stringify(context.messages)).toContain("actual Preview content");
      yield {
        deltas: [],
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Preview finished." }],
          stopReason: "stop",
        },
      };
    },
  });

  try {
    const settings = await fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_name: "fixture-model",
        model_endpoint: "https://provider.invalid/v1/chat/completions",
        workspace_root: workspaceRoot,
        model_api_key: "fixture-only",
      }),
    });
    expect(settings.status).toBe(200);

    const stateRoot = join(directory, "state");
    const eventStorePath = join(stateRoot, "events.sqlite3");
    const memoryStore = new SqliteEventStore(eventStorePath);
    const memoryScope = derivePreviewScope(workspaceRoot);
    const memoryProfile = resolvedRunProfileFixture({
      id: "profile-preview-memory-source",
      memoryPolicy: { read: "channel", write: "propose" },
    });
    const memorySource = parseStartRun({
      workspaceId: memoryScope.workspaceId,
      channelId: memoryScope.channelId,
      commandId: "preview-memory-source-command",
      runId: "preview-memory-source-run",
      goal: "Seed Preview channel Memory.",
      source: { eventId: "preview-memory-source-event" },
      runProfile: { id: memoryProfile.id, version: memoryProfile.version },
      runProfileSnapshot: memoryProfile,
      budget: memoryProfile.budget,
      permissionScope: "preview-memory-source-permission",
      stopCondition: memoryProfile.terminalRules.stopCondition,
    });
    const scopedMemoryStore = memoryStore.scope(memoryScope);
    await scopedMemoryStore.claimStart(memorySource);
    await scopedMemoryStore.append(parseCanonicalEvent({
      id: "preview-memory-source-event",
      workspaceId: memoryScope.workspaceId,
      channelId: memoryScope.channelId,
      streamId: memorySource.runId,
      seq: 0,
      type: "run.completed",
      timestamp: "2026-08-31T00:00:00.000Z",
      schemaVersion: 1,
      payload: { outcome: "completed" },
    }));
    const memoryAuthorization: ChannelOwnerAuthorization = {
      async assertOwner(scope: ChannelScope, actorId: string): Promise<void> {
        if (scope.workspaceId !== memoryScope.workspaceId
          || scope.channelId !== memoryScope.channelId
          || actorId !== "preview-owner") {
          throw new Error("Preview Memory owner denied");
        }
      },
    };
    const memoryRepository = createChannelMemoryRepository({
      eventStore: memoryStore,
      scope: memoryScope,
      authorization: memoryAuthorization,
      runProfileSnapshot: memoryProfile,
    });
    await memoryRepository.propose({
      id: "preview-memory",
      content: "Preview runs require owner review.",
      sourceRunId: memorySource.runId,
      sourceEventIds: ["preview-memory-source-event"],
    });
    await memoryRepository.accept({ candidateId: "preview-memory", actorId: "preview-owner" });
    memoryStore.close();

    const status = await fetch(`${service.url}/api/preview/status`).then((response) => response.json());
    expect(status).toMatchObject({
      protocol: "anna-harness-preview/1",
      kernel: "omp",
      configured: true,
      ready: true,
    });

    const started = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "preview-run",
        command_id: "preview-command",
        goal: "Preview runs require owner review.",
      }),
    });
    expect(started.status).toBe(202);
    await expect(started.json()).resolves.toEqual({ run_id: "preview-run", status: "queued" });

    let detail: {
      run: { status: string };
      events: Array<{ type: string; payload?: Record<string, unknown> }>;
    } | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      detail = await fetch(`${service.url}/api/preview/runs/preview-run`).then((response) => response.json());
      if (["completed", "failed", "timed_out", "cancelled"].includes(detail.run.status)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    expect(detail?.run.status, JSON.stringify(detail)).toBe("completed");
    expect(calls).toBe(2);
    expect(detail?.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run.started",
      "memory.hit",
      "run.context.ready",
      "omp.tool.dispatch",
      "omp.tool.response",
      "omp.transcript.message",
      "run.eval.contract",
      "run.completed",
    ]));
    const memoryHit = detail?.events.find((event) => event.type === "memory.hit");
    expect(memoryHit?.payload).toMatchObject({ memoryId: "preview-memory" });
    expect(JSON.stringify(memoryHit)).not.toContain("Preview runs require owner review.");
    const finalMessage = detail?.events
      .filter((event) => event.type === "omp.transcript.message")
      .at(-1)?.payload?.message as { role?: string; content?: Array<{ text?: string }> } | undefined;
    expect(finalMessage).toMatchObject({ role: "assistant", content: [{ text: "Preview finished." }] });
    const toolResponse = detail?.events
      .find((event) => event.type === "omp.tool.response")?.payload?.result as { output?: { content?: string } } | undefined;
    expect(toolResponse?.output?.content).toContain("actual Preview content");

    const reopened = await fetch(`${service.url}/api/preview/runs/preview-run`).then((response) => response.json()) as typeof detail;
    expect(reopened?.events).toEqual(detail?.events);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
