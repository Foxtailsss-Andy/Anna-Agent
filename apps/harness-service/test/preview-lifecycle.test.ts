import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { SqliteEventStore } from "@anna/event-store";
import {
  parseCanonicalEvent,
  parseStartRun,
  type CanonicalEvent,
  type ChannelScope,
  type StartRun,
} from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import {
  derivePreviewScope,
  startPreviewHarnessService,
  type PreviewRuntimeFactory,
} from "../src/preview";

test("Preview Run stop, SSE, duplicate admission and SQLite reopen stay scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-preview-lifecycle-"));
  const stateRoot = join(directory, "state");
  const workspaceRoot = join(directory, "workspace");
  let stopped: { workspaceId: string; channelId: string; runId: string } | undefined;
  let finishRun: (() => Promise<void>) | undefined;
  let factoryCalls = 0;

  const createRuntime: PreviewRuntimeFactory = async ({ eventStorePath, scope }) => {
    factoryCalls += 1;
    const eventStore = new SqliteEventStore(eventStorePath);
    const profile = resolvedRunProfileFixture({ id: "profile-preview-lifecycle" });
    let activeCommand: StartRun | undefined;
    const append = async (
      command: StartRun,
      type: string,
      seq: number,
      payload: Record<string, string>,
    ) => {
      await eventStore.scope(scope).append(parseCanonicalEvent({
        id: `event:${command.runId}:${seq}`,
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        streamId: command.runId,
        seq,
        type,
        timestamp: `2026-08-31T00:00:0${seq}.000Z`,
        schemaVersion: 1,
        payload,
      }));
    };
    const runtime = {
      async start(_surfaceId: "preview", input: unknown) {
        const body = input as Record<string, string>;
        const command = parseStartRun({
          workspaceId: scope.workspaceId,
          channelId: scope.channelId,
          commandId: body.command_id,
          runId: body.run_id,
          source: { eventId: body.source_event_id },
          goal: body.goal,
          runProfile: { id: profile.id, version: profile.version },
          runProfileSnapshot: profile,
          budget: profile.budget,
          permissionScope: "preview-lifecycle",
          stopCondition: profile.terminalRules.stopCondition,
        });
        const scoped = eventStore.scope(scope);
        const existing = await scoped.getRunCommand(command.runId);
        if (existing === undefined) {
          await scoped.claimStart(command);
          await append(command, "run.queued", 0, { phase: "queued" });
          await append(command, "run.started", 1, { phase: "started" });
          activeCommand = command;
          finishRun = async () => {
            if (activeCommand === undefined) return;
            const events = await readAll(eventStore.scope(scope), activeCommand.runId);
            if (events.some((event) => event.type === "run.completed" || event.type === "run.cancelled")) return;
            await append(activeCommand, "run.completed", events.length, { outcome: "completed" });
          };
        }
        return { runId: command.runId, status: "running" };
      },
      async stop(workspaceId: string, channelId: string, runId: string) {
        stopped = { workspaceId, channelId, runId };
        const scoped = eventStore.scope({ workspaceId, channelId } as ChannelScope);
        const events = await readAll(scoped, runId);
        const command = await scoped.getRunCommand(runId as never);
        if (command !== undefined && !events.some((event) => event.type === "run.cancelled" || event.type === "run.completed")) {
          await append(command, "run.cancelled", events.length, { outcome: "cancelled" });
        }
        return { status: "cancelled" };
      },
    };
    return {
      eventStore,
      runtime,
      close() {
        eventStore.close();
      },
    };
  };

  const common = {
    stateRoot,
    workspaceRoot,
    createRuntime,
  } satisfies Parameters<typeof startPreviewHarnessService>[0];
  let service = await startPreviewHarnessService(common);
  try {
    const settings = {
      model_name: "fixture-model",
      model_endpoint: "https://provider.example/v1/chat/completions",
      workspace_root: workspaceRoot,
      model_api_key: "fixture-key",
    };
    await expect(fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    }).then((response) => response.json())).resolves.toMatchObject({ has_api_key: true });

    const firstStart = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "preview-lifecycle-run",
        command_id: "preview-lifecycle-command",
        goal: "Keep this Preview Run scoped.",
      }),
    });
    expect(firstStart.status).toBe(202);
    await expect(firstStart.json()).resolves.toEqual({
      run_id: "preview-lifecycle-run",
      status: "running",
    });

    const retry = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "preview-lifecycle-run",
        command_id: "preview-lifecycle-command",
        goal: "Keep this Preview Run scoped.",
      }),
    });
    expect(retry.status).toBe(202);
    expect((await fetch(`${service.url}/api/preview/runs`).then((response) => response.json())).runs).toHaveLength(1);

    const conflict = await fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ code: "active_run_settings_conflict" });

    const stoppedResponse = await fetch(`${service.url}/api/preview/runs/preview-lifecycle-run/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(stoppedResponse.status).toBe(202);
    await expect(stoppedResponse.json()).resolves.toEqual({
      run_id: "preview-lifecycle-run",
      status: "cancelling",
    });
    expect(stopped).toEqual({
      ...derivePreviewScope(workspaceRoot),
      runId: "preview-lifecycle-run",
    });

    const detail = await fetch(`${service.url}/api/preview/runs/preview-lifecycle-run`).then((response) => response.json()) as {
      run: { status: string };
      events: CanonicalEvent[];
    };
    expect(detail.run.status).toBe("cancelled");
    expect(detail.events.at(-1)?.type).toBe("run.cancelled");

    const sse = await fetch(`${service.url}/api/preview/runs/preview-lifecycle-run/events?after_seq=1`);
    expect(sse.status).toBe(200);
    const sseText = await sse.text();
    const data = sseText
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as CanonicalEvent);
    expect(data.map((event) => event.seq)).toEqual([2]);
    expect(data[0]?.type).toBe("run.cancelled");
    expect(sseText).toContain("event: canonical");
    expect(factoryCalls).toBe(1);

    await service.close();
    service = await startPreviewHarnessService(common);
    const reopened = await fetch(`${service.url}/api/preview/runs/preview-lifecycle-run`).then((response) => response.json()) as {
      run: { status: string };
      events: CanonicalEvent[];
    };
    expect(reopened.run.status).toBe("cancelled");
    expect(reopened.events.map((event) => event.type)).toEqual([
      "run.queued",
      "run.started",
      "run.cancelled",
    ]);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function readAll(
  store: Pick<ReturnType<SqliteEventStore["scope"]>, "read">,
  runId: string,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.read(runId as never)) events.push(event);
  return events;
}
