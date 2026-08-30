import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import { parseStartRun, type CanonicalEvent, type EventSink, type StreamId } from "@anna/harness-v2";
import { expect, test } from "vitest";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";

test("turns an abort after durable context ready into a cancelled Run", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const runtimeRoot = resolve(repositoryRoot, "build/omp-runtime/darwin-arm64");
  const manifest = JSON.parse(await readFile(
    resolve(runtimeRoot, "manifest.json"),
    "utf8",
  )) as { sha256: string };
  const profile = resolvedRunProfileFixture({
    budget: { turns: 1 },
    memoryPolicy: { read: "none", write: "disabled" },
  });
  const command = parseStartRun({
    workspaceId: "workspace:omp-ready-abort",
    channelId: "channel:omp-ready-abort",
    commandId: "command:omp-ready-abort",
    runId: "run:omp-ready-abort",
    goal: "Abort after the durable context is ready.",
    source: { eventId: "event:omp-ready-abort" },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: "permission:omp-ready-abort",
    stopCondition: profile.terminalRules.stopCondition,
  });
  const controller = new AbortController();
  const storageDirectory = await mkdtemp(join(tmpdir(), "anna-omp-ready-abort-"));
  const store = new SqliteEventStore(join(storageDirectory, "events.sqlite"));
  await store.scope(command).claimStart(command);
  let workerFactoryCalls = 0;
  let modelCalls = 0;
  const sink = new AbortAfterReadySink(store.scope(command), controller);
  const kernel = new OmpLoopKernel({
    runtimeRoot,
    expectedManifestDigest: manifest.sha256,
    workspaceRoot: repositoryRoot,
    modelTransport: async function* () {
      modelCalls += 1;
    },
    createToolGateway: () => {
      workerFactoryCalls += 1;
      return { execute: async () => ({ status: "succeeded" as const }) };
    },
  });

  try {
    await expect(kernel.start(command, sink, controller.signal)).resolves.toEqual({ status: "cancelled" });
    expect(workerFactoryCalls).toBe(0);
    expect(modelCalls).toBe(0);
    const events = await readEvents(store, command);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.context.ready",
      "run.cancelled",
    ]);
  } finally {
    await kernel.close();
    store.close();
    await rm(storageDirectory, { recursive: true, force: true });
  }
}, 30_000);

class AbortAfterReadySink implements EventSink {
  constructor(
    private readonly durable: ReturnType<SqliteEventStore["scope"]>,
    private readonly controller: AbortController,
  ) {}

  async append(event: CanonicalEvent): Promise<void> {
    await this.durable.append(event);
    if (event.type === "run.context.ready") this.controller.abort("ready persisted");
  }

  read(streamId: StreamId): AsyncIterable<CanonicalEvent> {
    return this.durable.read(streamId);
  }
}

async function readEvents(store: SqliteEventStore, command: ReturnType<typeof parseStartRun>): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope(command).read(command.runId as never as StreamId)) events.push(event);
  return events;
}
