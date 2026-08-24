import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime } from "../src/production";
import { startHarnessService } from "../src/index";

const runLive = process.env.ANNA_HARNESS_V2_LIVE === "1" ? test : test.skip;

test("live Runtime advertises the enabled Create, Cowork, and Hub surfaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-live-capabilities-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "test-model",
    model_api_key: "test-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
  });
  const service = await startHarnessService({ runtime: live.runtime });

  try {
    const capabilities = await fetch(`${service.url}/capabilities`);
    const body = await capabilities.json() as {
      surfaces: Array<{ id: string; status: string }>;
    };
    expect(body.surfaces).toEqual([
      expect.objectContaining({ id: "create", status: "available" }),
      expect.objectContaining({ id: "cowork", status: "available" }),
      expect.objectContaining({ id: "hub", status: "available" }),
    ]);

  } finally {
    await service.close();
    live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live Runtime accepts an explicit surface selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-live-surface-"));
  const configPath = join(directory, "runtime.json");
  try {
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "test-model",
      model_api_key: "test-key",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
    }), "utf8");
    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      surfaces: ["cowork"],
    });
    expect(live.runtime.surfaces).toEqual(["cowork"]);
    live.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

runLive("live HTTP v2 create drives Pi through the durable Event Store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-live-runtime-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const configuredPath = process.env.ANNA_RUNTIME_CONFIG_PATH;
  const configuredStorePath = process.env.ANNA_HARNESS_V2_EVENT_STORE_PATH;
  const sourceConfigPath = configuredPath
    ?? resolve(import.meta.dirname, "../../../.anna/runtime.json");
  const config = JSON.parse(await readFile(
    sourceConfigPath,
    "utf8",
  )) as Record<string, unknown>;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await writeFile(join(directory, "notes.txt"), "The approved local note is durable.\n", "utf8");

  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
      workspaceRoot: directory,
  });
  const service = await startHarnessService({ runtime: live.runtime });

  try {
    const response = await fetch(`${service.url}/v2/surfaces/create/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "workspace-live-runtime",
        channel_id: "channel-live-runtime",
        command_id: "command-live-runtime",
        source_event_id: "event-source-live-runtime",
        goal: "Use create_artifact exactly once to create a Skill named csv_to_markdown. "
          + "The Skill must include valid name, version, allowed_tools, and forbidden_tools frontmatter, "
          + "then reply with a short confirmation without claiming activation.",
      }),
    });
    expect(response.status).toBe(202);
    const started = await response.json() as { run_id: string };
    const eventsUrl = `${service.url}/v2/runs/${started.run_id}/events?workspace_id=workspace-live-runtime&channel_id=channel-live-runtime`;
    let events: Array<{ seq: number; type: string; payload?: Record<string, unknown> }> = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const eventsResponse = await fetch(eventsUrl);
      expect(eventsResponse.status).toBe(200);
      const body = await eventsResponse.json() as { events: typeof events };
      events = body.events;
      if (events.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const terminal = events.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type));
    const evidence = {
      eventCount: events.length,
      terminalTypes: terminal.map((event) => event.type),
      sequence: events.map((event) => event.seq),
      usagePresent: events.some((event) => event.payload?.usage !== undefined),
      toolCalls: events.filter((event) => event.type === "run.tool.completed").length,
      createArtifactEvents: events.filter((event) => event.type === "create.artifact.created").length,
      createValidationEvents: events.filter((event) => event.type === "create.artifact.validated").length,
      evalPassed: events.some((event) => event.type === "run.eval.contract"
        && event.payload?.passed === true),
    };
    const evidenceDirectory = process.env.ANNA_HARNESS_V2_LIVE_EVIDENCE_DIR;
    if (evidenceDirectory === undefined) {
      await writeFile(join(directory, "summary.json"), JSON.stringify(evidence), "utf8");
    } else {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        join(evidenceDirectory, "summary.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        "utf8",
      );
    }

    expect(terminal).toHaveLength(1);
    expect(evidence.sequence).toEqual(
      evidence.sequence.map((_, index) => index),
    );
    expect(evidence.usagePresent).toBe(true);
    expect(evidence.toolCalls).toBeGreaterThan(0);
    expect(evidence.createArtifactEvents).toBe(1);
    expect(evidence.createValidationEvents).toBe(1);
    expect(evidence.evalPassed).toBe(true);
  } finally {
    await service.close();
    live.close();
    if (configuredPath === undefined) delete process.env.ANNA_RUNTIME_CONFIG_PATH;
    if (configuredStorePath === undefined) delete process.env.ANNA_HARNESS_V2_EVENT_STORE_PATH;
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);
