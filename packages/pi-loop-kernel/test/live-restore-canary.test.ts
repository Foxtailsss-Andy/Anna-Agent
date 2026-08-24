import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseStartRun,
  type CanonicalEvent,
  type EventSink,
  type ToolGateway,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { SqliteEventStore } from "@anna/event-store";
import { expect, test } from "vitest";

import { createOpenAICompatiblePiLoopKernel } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const runLive = process.env.ANNA_T01_LIVE_RESTORE === "1" ? test : test.skip;
const workerProfileId = "t01-live-restore-worker" as WorkerProfileId;

runLive("live provider restores a Pi transcript after SQLite close and reopen", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const config = JSON.parse(
    await readFile(join(repositoryRoot, ".anna", "runtime.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    config.model_provider !== "openai-compatible"
    || typeof config.model_name !== "string"
    || typeof config.model_api_key !== "string"
    || typeof config.model_endpoint !== "string"
  ) {
    throw new Error("T01 live restore runtime config unavailable");
  }

  const directory = await mkdtemp(join(repositoryRoot, ".anna-t01-live-restore-"));
  const databasePath = join(directory, "events.sqlite");
  const command = parseStartRun({
    commandId: "t01-live-restore-command",
    runId: "t01-live-restore-run",
    workspaceId: "t01-live-restore-workspace",
    channelId: "t01-live-restore-channel",
    source: { eventId: "t01-live-restore-source" },
    goal: "Use the fixture_read tool with key release-note, then reply briefly after approval so this Run can be resumed after a process restart.",
    runProfile: { id: "t01-live-restore-profile", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({
      id: "t01-live-restore-profile",
      budget: { wallTimeMs: 30_000, turns: 2 },
      allowedTools: ["fixture_read"],
    }),
    budget: { wallTimeMs: 30_000, turns: 2 },
    permissionScope: "t01-live-restore-scope",
    stopCondition: "artifact_or_terminal",
  });

  const firstKernelOptions = {
    endpoint: config.model_endpoint,
    apiKey: config.model_api_key,
    modelName: config.model_name,
    toolGateway: {
      async execute() {
        return { status: "failed" as const, output: { reason: "approval_required" } };
      },
    } satisfies ToolGateway,
    workerProfileId,
  };
  const resumedKernelOptions = {
    ...firstKernelOptions,
    toolGateway: {
      async execute() {
        return { status: "succeeded" as const, output: { fixture: "approved" } };
      },
    } satisfies ToolGateway,
  };

  try {
    const firstStore = new SqliteEventStore(databasePath);
    const firstScope = firstStore.scope(command);
    let transcriptPersisted = false;
    const firstAttemptEventTypes: string[] = [];
    const interruption = new AbortController();
    const crashingSink: EventSink & { read: typeof firstScope.read } = {
      read: firstScope.read.bind(firstScope),
      async append(event) {
        await firstScope.append(event);
        firstAttemptEventTypes.push(event.type);
        const message = isRecord(event.payload) && isRecord(event.payload.message)
          ? event.payload.message
          : undefined;
        if (
          event.type === "pi.transcript.message"
          && message?.role === "toolResult"
          && !transcriptPersisted
        ) {
          transcriptPersisted = true;
          interruption.abort();
          throw new Error("simulated process interruption after tool result commit");
        }
      },
    };
    await expect(
      createOpenAICompatiblePiLoopKernel(firstKernelOptions).start(
        command,
        crashingSink,
        interruption.signal,
      ),
    ).rejects.toThrow("simulated process interruption after tool result commit");
    expect(transcriptPersisted).toBe(true);
    firstStore.close();

    const reopenedStore = new SqliteEventStore(databasePath);
    try {
      const resumedScope = reopenedStore.scope(command);
      const outcome = await createOpenAICompatiblePiLoopKernel(resumedKernelOptions).start(
        command,
        resumedScope,
        new AbortController().signal,
      );
      const events: CanonicalEvent[] = [];
      for await (const event of resumedScope.read(command.runId as never)) {
        events.push(event);
      }
      const terminal = events.filter((event) => /^run\.(completed|failed|timed_out|cancelled)$/.test(event.type));
      const evidence = {
        outcome: outcome.status,
        eventTypes: events.map((event) => event.type),
        transcriptRoles: events.flatMap((event) => {
          if (event.type !== "pi.transcript.message" || !isRecord(event.payload)) return [];
          const message = event.payload.message;
          return isRecord(message) && typeof message.role === "string" ? [message.role] : [];
        }),
        firstAttemptEventTypes,
        sequence: events.map((event) => event.seq),
        resumed: events.some((event) => event.type === "run.resumed"),
        usagePresent: events.some((event) => event.type === "run.usage.updated"),
        terminalCount: terminal.length,
      };
      const evidenceDirectory = process.env.ANNA_T01_LIVE_RESTORE_EVIDENCE_DIR;
      if (evidenceDirectory !== undefined) {
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(join(evidenceDirectory, "summary.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
      }

      expect(evidence.outcome).toBe("completed");
      expect(evidence.resumed).toBe(true);
      expect(evidence.terminalCount).toBe(1);
      expect(evidence.sequence).toEqual(evidence.sequence.map((_, index) => index));
    } finally {
      reopenedStore.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 70_000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
