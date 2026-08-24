import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseStartRun,
  type CanonicalEvent,
  type ToolGateway,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { expect, test } from "vitest";

import { createOpenAICompatiblePiLoopKernel } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const runLive = process.env.ANNA_T01_LIVE === "1" ? test : test.skip;
const liveWorkerProfileId = "t01-live-worker" as WorkerProfileId;
const liveToolGateway: ToolGateway = {
  async execute() {
    return { status: "succeeded" };
  },
};

function runtimeConfig(): { model_name: string; model_api_key: string; model_endpoint: string } {
  try {
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const config = JSON.parse(readFileSync(join(repositoryRoot, ".anna", "runtime.json"), "utf8")) as {
      model_provider?: unknown;
      model_name?: unknown;
      model_api_key?: unknown;
      model_endpoint?: unknown;
    };
    if (
      config.model_provider !== "openai-compatible" ||
      typeof config.model_name !== "string" || config.model_name.length === 0 ||
      typeof config.model_api_key !== "string" || config.model_api_key.length === 0 ||
      typeof config.model_endpoint !== "string" || !config.model_endpoint.startsWith("https://")
    ) {
      throw new Error("invalid runtime config");
    }
    return {
      model_name: config.model_name,
      model_api_key: config.model_api_key,
      model_endpoint: config.model_endpoint,
    };
  } catch {
    throw new Error("T01 live canary runtime config unavailable");
  }
}

runLive("live-canary reaches one completed terminal outcome without exposing content", async () => {
  const config = runtimeConfig();
  const events: CanonicalEvent[] = [];
  let outcome: { status: string };

  try {
    outcome = await createOpenAICompatiblePiLoopKernel({
      endpoint: config.model_endpoint,
      apiKey: config.model_api_key,
      modelName: config.model_name,
      toolGateway: liveToolGateway,
      workerProfileId: liveWorkerProfileId,
    }).start(
      parseStartRun({
        commandId: "t01-live-command",
        runId: "t01-live-run",
        goal: "Reply with exactly: canary complete.",
        workspaceId: "t01-live-workspace",
        channelId: "t01-live-channel",
        source: { eventId: "t01-live-source" },
        runProfile: { id: "t01-live-profile", version: "1" },
        runProfileSnapshot: resolvedRunProfileFixture({
          id: "t01-live-profile",
          budget: { wallTimeMs: 30_000, turns: 1 },
          allowedTools: ["read_workspace"],
        }),
        budget: { wallTimeMs: 30_000, turns: 1 },
        permissionScope: "t01-live-scope",
        stopCondition: "artifact_or_terminal",
      }),
      { append: async (event) => { events.push(event); } },
      new AbortController().signal,
    );
  } catch {
    throw new Error("T01 live canary failed");
  }

  const terminalEvents = events.filter((event) =>
    /^run\.(completed|failed|timed_out|cancelled)$/.test(event.type),
  );
  const terminalIndex = events.findIndex((event) => terminalEvents.includes(event));
  const summary = {
    outcome: outcome.status,
    eventTypes: events.map((event) => event.type),
    seq: events.map((event) => event.seq),
    progressBeforeTerminal: terminalIndex > 0 && events.slice(0, terminalIndex)
      .some((event) => event.type === "run.progress"),
    terminalCount: terminalEvents.length,
    usagePresent: events.some((event) =>
      event.type === "run.progress" &&
      Object.prototype.hasOwnProperty.call(event.payload, "usage"),
    ),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  expect(summary.outcome).toBe("completed");
  expect(summary.terminalCount).toBe(1);
  expect(summary.progressBeforeTerminal).toBe(true);
  expect(summary.seq).toEqual(summary.seq.map((_, index) => index));
}, 35_000);
