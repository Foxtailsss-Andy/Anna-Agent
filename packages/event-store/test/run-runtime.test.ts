import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import {
  parseStartRun,
  type CanonicalEvent,
  type ChannelScope,
  type EventSink,
  type LoopKernel,
  type RunOutcome,
  type StartRun,
} from "@anna/harness-v2";

import { RunManager, SqliteEventStore } from "../src/index";
import { DurableRunRuntime, RunResumeRequiredError } from "../src/run-runtime";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const scope = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
} as ChannelScope;

function command(
  runId = "run-1",
  commandId = `command-${runId}`,
  overrides: Partial<Pick<ChannelScope, "workspaceId" | "channelId">> = {},
): StartRun {
  return parseStartRun({
    commandId,
    runId,
    goal: "Prepare the release brief.",
    workspaceId: overrides.workspaceId ?? scope.workspaceId,
    channelId: overrides.channelId ?? scope.channelId,
    source: { eventId: "source-event-1" },
    runProfile: { id: "profile-1", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture(),
    budget: { turns: 1 },
    permissionScope: "permission-1",
    stopCondition: "artifact_or_terminal",
  });
}

function eventFor(
  run: StartRun,
  seq: number,
  type: string,
  payload: CanonicalEvent["payload"] = {},
): CanonicalEvent {
  return {
    id: `${run.runId}-event-${seq}`,
    workspaceId: run.workspaceId,
    channelId: run.channelId,
    streamId: run.runId,
    seq,
    type,
    timestamp: "2026-08-23T00:00:00.000Z",
    schemaVersion: 1,
    payload,
  } as unknown as CanonicalEvent;
}

async function readAll(
  sink: Pick<EventSink, "append"> & { read(streamId: string): AsyncIterable<CanonicalEvent> },
  streamId: string,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of sink.read(streamId)) {
    events.push(event);
  }
  return events;
}

class FakeKernel implements LoopKernel {
  starts = 0;
  readonly startedCommands: StartRun[] = [];
  fail = false;
  mismatchedTerminal = false;

  async start(command: StartRun, sink: EventSink): Promise<RunOutcome> {
    this.starts += 1;
    this.startedCommands.push(command);
    const durable = sink as EventSink & {
      read(streamId: string): AsyncIterable<CanonicalEvent>;
    };
    const events = await readAll(durable, command.runId);
    let nextSeq = events.length;
    const next = async (type: string, payload: CanonicalEvent["payload"] = {}) => {
      await sink.append(eventFor(command, nextSeq, type, payload));
      nextSeq += 1;
    };

    await next("run.started", { phase: "started" });
    if (this.fail) {
      throw new Error("provider failed");
    }
    await next("run.progress", { phase: "turn_finished" });
    await next(
      this.mismatchedTerminal ? "run.failed" : "run.completed",
      this.mismatchedTerminal
        ? { errorType: "provider_failed" }
        : { outcome: "completed" },
    );
    return { status: "completed" };
  }

  async steer(): Promise<void> {}
  async answer(): Promise<void> {}
  async abort(): Promise<void> {}
}

function withDatabase(
  body: (path: string, stores: SqliteEventStore[]) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "anna-runtime-"));
  const stores: SqliteEventStore[] = [];
  return body(join(directory, "events.sqlite"), stores).finally(() => {
    for (const store of stores.reverse()) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });
}

test("claims and drives one Run exactly once through a durable SQLite stream", async () => {
  await withDatabase(async (path, stores) => {
    const store = new SqliteEventStore(path);
    stores.push(store);
    const kernel = new FakeKernel();
    const runtime = new DurableRunRuntime(store, kernel, {
      now: () => "2026-08-23T00:00:00.000Z",
      createEventId: (() => {
        let index = 0;
        return () => `runtime-event-${++index}` as CanonicalEvent["id"];
      })(),
    });

    const first = runtime.start(command());
    const second = runtime.start(command());
    const [left, right] = await Promise.all([first, second]);
    const otherChannel = await runtime.start(command("run-1", "command-other", {
      channelId: "channel-2" as ChannelScope["channelId"],
    }));

    expect(kernel.starts).toBe(2);
    expect(left.run.id).toBe(command().runId);
    expect(right.run.id).toBe(command().runId);
    await expect(left.completion).resolves.toEqual({ status: "completed" });
    await expect(right.completion).resolves.toEqual({ status: "completed" });
    await expect(otherChannel.completion).resolves.toEqual({ status: "completed" });
    await expect(readAll(store.scope(scope), command().runId)).resolves.toMatchObject([
      { type: "run.queued", seq: 0 },
      { type: "run.started", seq: 1 },
      { type: "run.progress", seq: 2 },
      { type: "run.completed", seq: 3 },
    ]);
  });
});

test("requires explicit resume for a durable non-terminal Run after restart", async () => {
  await withDatabase(async (path, stores) => {
    const run = command("run-restart");
    const first = new SqliteEventStore(path);
    stores.push(first);
    const scoped = first.scope(scope);
    await scoped.claimStart(run);
    await scoped.append(eventFor(run, 0, "run.queued", {}));
    await scoped.append(eventFor(run, 1, "run.started", { phase: "started" }));
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const kernel = new FakeKernel();
    const runtime = new DurableRunRuntime(reopened, kernel);

    await expect(runtime.start(run)).rejects.toBeInstanceOf(RunResumeRequiredError);
    const resumed = await runtime.resume(run);
    await expect(resumed.completion).resolves.toEqual({ status: "completed" });
    expect(kernel.starts).toBe(1);
    await expect(readAll(reopened.scope(scope), run.runId)).resolves.toMatchObject([
      { type: "run.queued", seq: 0 },
      { type: "run.started", seq: 1 },
      { type: "run.started", seq: 2 },
      { type: "run.progress", seq: 3 },
      { type: "run.completed", seq: 4 },
    ]);
  });
});

test("resumes a durable Run after an approval decision across SQLite reopen", async () => {
  await withDatabase(async (path, stores) => {
    const run = command("run-approval-restart");
    const first = new SqliteEventStore(path);
    stores.push(first);
    const scoped = first.scope(scope);
    await scoped.claimStart(run);
    await scoped.append(eventFor(run, 0, "run.queued", {}));
    await scoped.append(eventFor(run, 1, "run.started", { phase: "started" }));
    await scoped.append(eventFor(run, 2, "run.awaiting_approval", { reason: "approval_required" }));
    await expect(new RunManager(scoped).get(run.runId)).resolves.toMatchObject({
      status: "awaiting_approval",
    });
    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const kernel = new FakeKernel();
    const runtime = new DurableRunRuntime(reopened, kernel);

    await expect(runtime.start(run)).resolves.toMatchObject({
      run: { status: "awaiting_approval" },
    });
    const resumed = await runtime.resume(run);
    await expect(resumed.completion).resolves.toEqual({ status: "completed" });
    expect(kernel.starts).toBe(1);
    await expect(readAll(reopened.scope(scope), run.runId)).resolves.toMatchObject([
      { type: "run.queued", seq: 0 },
      { type: "run.started", seq: 1 },
      { type: "run.awaiting_approval", seq: 2 },
      { type: "run.started", seq: 3 },
      { type: "run.progress", seq: 4 },
      { type: "run.completed", seq: 5 },
    ]);
  });
});

test("seals a failed Run when the LoopKernel throws before terminalizing", async () => {
  await withDatabase(async (path, stores) => {
    const store = new SqliteEventStore(path);
    stores.push(store);
    const kernel = new FakeKernel();
    kernel.fail = true;
    const runtime = new DurableRunRuntime(store, kernel);

    const started = await runtime.start(command());

    await expect(started.completion).resolves.toEqual({ status: "failed" });
    await expect(readAll(store.scope(scope), command().runId)).resolves.toMatchObject([
      { type: "run.queued", seq: 0 },
      { type: "run.started", seq: 1 },
      { type: "run.failed", seq: 2, payload: { errorType: "runtime_bridge_failed" } },
    ]);
  });
});

test("uses the durable terminal event when a kernel returns a conflicting outcome", async () => {
  await withDatabase(async (path, stores) => {
    const store = new SqliteEventStore(path);
    stores.push(store);
    const kernel = new FakeKernel();
    kernel.mismatchedTerminal = true;
    const runtime = new DurableRunRuntime(store, kernel);

    const started = await runtime.start(command("run-mismatch"));

    await expect(started.completion).resolves.toEqual({ status: "failed" });
    const events = await readAll(store.scope(scope), "run-mismatch");
    expect(events.at(-1)).toMatchObject({ type: "run.failed", seq: 3 });
  });
});
