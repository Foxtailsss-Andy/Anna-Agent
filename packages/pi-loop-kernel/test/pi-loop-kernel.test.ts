import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createToolGateway,
  parseCanonicalEvent,
  parseStartRun,
  type Budget,
  type CanonicalEvent,
  type StartRun,
  type EventSink,
  type RunId,
  type SandboxAdapter,
  type ScopedChannelStore,
  type ToolDefinition,
  type ToolGateway,
  type ToolPolicy,
  type ToolRequest,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { expect, test } from "vitest";

import { PiLoopKernel } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const workerProfileId = "worker-profile-1" as WorkerProfileId;

const inMemoryToolGateway: ToolGateway = {
  async execute(request) {
    const key = (request.input as { key?: unknown }).key;
    return {
      status: "succeeded",
      output: key === "release-note" ? "Fixture: release-note" : "Fixture unavailable",
    };
  },
};

function startRun(
  budget: Budget,
  overrides: {
    goal?: string;
    runId?: string;
    workspaceId?: string;
    channelId?: string;
    allowedTools?: readonly string[];
    parentRunId?: string;
    parentEventId?: string;
    laneId?: string;
  } = {},
): StartRun {
  return parseStartRun({
    commandId: "command-1",
    runId: overrides.runId ?? "run-1",
    goal: overrides.goal ?? "Deliver one sentence.",
    workspaceId: overrides.workspaceId ?? "workspace-1",
    channelId: overrides.channelId ?? "channel-1",
    source: { eventId: "event-1" },
    runProfile: { id: "profile-1", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({
      budget,
      allowedTools: overrides.allowedTools,
    }),
    budget,
    permissionScope: "scope-1",
    stopCondition: "artifact_or_terminal",
    ...(overrides.parentRunId === undefined ? {} : {
      parentRunId: overrides.parentRunId,
      parentEventId: overrides.parentEventId ?? "parent-event-1",
      ...(overrides.laneId === undefined ? {} : { laneId: overrides.laneId }),
    }),
  });
}

function collectingSink(events: CanonicalEvent[]): EventSink {
  return { append: async (event) => { events.push(event); } };
}

function durableSink(): EventSink & {
  events: CanonicalEvent[];
  read: (streamId: CanonicalEvent["streamId"], afterSeq?: number) => AsyncIterable<CanonicalEvent>;
} {
  const events: CanonicalEvent[] = [];
  return {
    events,
    async append(event) {
      if (event.seq !== events.length) {
        throw new Error(`Expected durable seq ${events.length}, got ${event.seq}`);
      }
      events.push(event);
    },
    async *read(_streamId, afterSeq = -1) {
      for (const event of events) {
        if (event.seq > afterSeq) {
          yield event;
        }
      }
    },
  };
}

function createStrictInMemoryToolEvents(): Pick<ScopedChannelStore, "append" | "read"> {
  const eventsByStream = new Map<string, CanonicalEvent[]>();

  return {
    async append(event) {
      const canonicalEvent = parseCanonicalEvent(event);
      const events = eventsByStream.get(canonicalEvent.streamId) ?? [];
      if (canonicalEvent.seq !== events.length) {
        throw new Error(`Expected ${canonicalEvent.streamId} seq ${events.length}`);
      }
      events.push(canonicalEvent);
      eventsByStream.set(canonicalEvent.streamId, events);
    },
    async *read(streamId, afterSeq) {
      for (const event of eventsByStream.get(streamId) ?? []) {
        if (afterSeq === undefined || event.seq > afterSeq) {
          yield event;
        }
      }
    },
  };
}

test("completes a natural first turn when the one-turn budget is exhausted", async () => {
  const provider = fauxProvider();
  let calls = 0;
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
    now: () => 0,
  });
  const events: CanonicalEvent[] = [];

  await expect(kernel.start(
    startRun({ turns: 1 }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  expect(calls).toBe(1);
  expect(events.at(-1)?.type).toBe("run.completed");
});

test("attributes every child Run event to its parent Run and lane", async () => {
  const provider = fauxProvider();
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("child done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
    now: () => 0,
  });
  const events: CanonicalEvent[] = [];

  await kernel.start(
    startRun({ turns: 1 }, {
      runId: "child-run",
      parentRunId: "parent-run",
      parentEventId: "parent-event",
      laneId: "lane-1",
    }),
    collectingSink(events),
    new AbortController().signal,
  );

  expect(events[0]?.payload).toMatchObject({
    phase: "started",
    parentRunId: "parent-run",
    parentEventId: "parent-event",
    laneId: "lane-1",
  });
  expect(events.at(-1)?.payload).toMatchObject({
    outcome: "completed",
    parentRunId: "parent-run",
    parentEventId: "parent-event",
    laneId: "lane-1",
  });
});

test("restores a durable Pi transcript and continues from the last tool result", async () => {
  const provider = fauxProvider();
  const first = fauxAssistantMessage(
    fauxToolCall("fixture_read", { key: "release-note" }),
    { stopReason: "toolUse" },
  );
  const sink = durableSink();
  const approvalRequiredGateway: ToolGateway = {
    async execute() {
      return { status: "failed", output: { reason: "approval_required" } };
    },
  };
  const firstKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: approvalRequiredGateway,
    workerProfileId,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: first });
      stream.push({ type: "done", reason: "toolUse", message: first });
      return stream;
    },
    now: () => 0,
  });
  const command = startRun({ turns: 2 }, {
    runId: "restore-run",
    allowedTools: ["fixture_read"],
  });

  await expect(firstKernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "awaiting_approval" });
  expect(sink.events.filter((event) => event.type === "pi.transcript.message").length)
    .toBeGreaterThanOrEqual(3);

  const contexts: Array<{ messages: unknown[] }> = [];
  const resumedKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: approvalRequiredGateway,
    workerProfileId,
    streamFn: (_model, context) => {
      contexts.push({ messages: context.messages });
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("resumed");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
    now: () => 0,
  });

  await expect(resumedKernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "completed" });
  expect(contexts[0]?.messages.map((message) => (message as { role: string }).role)).toEqual([
    "user",
    "assistant",
    "toolResult",
  ]);
  expect(sink.events.some((event) => event.type === "run.resumed")).toBe(true);
  expect(sink.events.map((event) => event.seq)).toEqual(
    sink.events.map((_event, index) => index),
  );
});

test("persists the execution fingerprint and refuses restore after the model changes", async () => {
  const provider = fauxProvider();
  const first = fauxAssistantMessage(
    fauxToolCall("fixture_read", { key: "release-note" }),
    { stopReason: "toolUse" },
  );
  const sink = durableSink();
  const approvalRequiredGateway: ToolGateway = {
    async execute() {
      return { status: "failed", output: { reason: "approval_required" } };
    },
  };
  const command = startRun({ turns: 2 }, {
    runId: "fingerprint-run",
    allowedTools: ["fixture_read"],
  });
  const firstKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: approvalRequiredGateway,
    workerProfileId,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: first });
      stream.push({ type: "done", reason: "toolUse", message: first });
      return stream;
    },
    now: () => 0,
  });

  await expect(firstKernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "awaiting_approval" });
  expect(sink.events.find((event) => event.type === "run.started")?.payload)
    .toMatchObject({
      executionFingerprint: {
        algorithm: "sha256",
        provider: provider.getModel().provider,
        model: provider.getModel().id,
      },
    });

  const changedModel = {
    ...provider.getModel(),
    id: "changed-model",
    name: "changed-model",
  };
  const resumedKernel = new PiLoopKernel({
    model: changedModel,
    toolGateway: approvalRequiredGateway,
    workerProfileId,
    streamFn: () => {
      throw new Error("stream must not be called after fingerprint drift");
    },
  });

  await expect(resumedKernel.start(command, sink, new AbortController().signal))
    .rejects.toThrow("Pi execution fingerprint mismatch");
});

test("restores and accumulates provider-reported usage without inventing cost", async () => {
  const provider = fauxProvider();
  const first = fauxAssistantMessage(
    fauxToolCall("fixture_read", { key: "release-note" }),
    { stopReason: "toolUse" },
  );
  Object.assign(first, { usage: { input: 11, output: 7, totalTokens: 18 } });
  const second = fauxAssistantMessage("resumed");
  Object.assign(second, { usage: { input: 13, output: 9, totalTokens: 22 } });
  const sink = durableSink();
  const command = startRun({ turns: 3 }, {
    runId: "usage-ledger-run",
    allowedTools: ["fixture_read"],
  });
  const firstKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: {
      async execute() {
        return { status: "failed", output: { reason: "approval_required" } };
      },
    },
    workerProfileId,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: first });
      stream.push({ type: "done", reason: "toolUse", message: first });
      return stream;
    },
    now: () => 0,
  });

  await expect(firstKernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "awaiting_approval" });
  expect(sink.events.at(-2)?.type).toBe("run.usage.updated");
  expect(sink.events.at(-2)?.payload).toMatchObject({
    cumulative: { input: 11, output: 7 },
  });
  expect(sink.events.at(-2)?.payload).not.toHaveProperty("cost");

  const resumedKernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: second });
      stream.push({ type: "done", reason: "stop", message: second });
      return stream;
    },
    now: () => 0,
  });

  await expect(resumedKernel.start(command, sink, new AbortController().signal))
    .resolves.toEqual({ status: "completed" });
  expect(sink.events.at(-2)?.type).toBe("run.usage.updated");
  expect(sink.events.at(-2)?.payload).toMatchObject({
    cumulative: { input: 24, output: 16 },
  });
  expect(sink.events.at(-2)?.payload).not.toHaveProperty("cost");
  expect(sink.events.map((event) => event.seq)).toEqual(
    sink.events.map((_event, index) => index),
  );
});

test("refuses to restore a terminal Pi Run", async () => {
  const sink = durableSink();
  sink.events.push({
    id: "terminal-event" as never,
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    streamId: "terminal-run" as never,
    seq: 0,
    type: "run.completed",
    timestamp: "2026-08-22T00:00:00.000Z",
    schemaVersion: 1,
    payload: { outcome: "completed" },
  });
  const kernel = new PiLoopKernel({
    model: fauxProvider().getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      throw new Error("stream must not be called");
    },
  });

  await expect(kernel.start(
    startRun({ turns: 1 }, { runId: "terminal-run" }),
    sink,
    new AbortController().signal,
  )).rejects.toThrow("Cannot restore a terminal Pi Run");
});

test("times out at the one-turn boundary when a steer requires another model call", async () => {
  const provider = fauxProvider();
  let calls = 0;
  let resolveFirstStream: (() => void) | undefined;
  const firstStream = new Promise<void>((resolve) => {
    resolveFirstStream = resolve;
  });
  let activeStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      activeStream = stream;
      resolveFirstStream?.();
      return stream;
    },
    now: () => 0,
  });
  const run = kernel.start(
    startRun({ turns: 1 }),
    { append: async () => undefined },
    new AbortController().signal,
  );

  await firstStream;
  await kernel.steer("run-1" as RunId, {
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    content: "Use a table.",
  });
  const message = fauxAssistantMessage("done");
  activeStream?.push({ type: "start", partial: message });
  activeStream?.push({ type: "done", reason: "stop", message });

  await expect(run).resolves.toEqual({ status: "timed_out" });
  expect(calls).toBe(1);
});

test("keeps only provider-reported token fields in canonical usage", async () => {
  const provider = fauxProvider();
  const message = fauxAssistantMessage("done");
  message.usage = {
    input: 11,
    output: 7,
    cacheRead: 5,
    cacheWrite: 3,
    reasoning: 2,
    totalTokens: 28,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
    now: () => 0,
  });
  const events: CanonicalEvent[] = [];

  await kernel.start(
    startRun({ turns: 1 }),
    collectingSink(events),
    new AbortController().signal,
  );

  const finishedTurn = events.find(
    (event) => event.type === "run.progress" &&
      (event.payload as { phase?: string }).phase === "turn_finished",
  );
  expect(finishedTurn?.payload).toEqual({
    phase: "turn_finished",
    usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 2 },
  });
});

test("does not carry one turn's usage into a later turn without usage", async () => {
  const provider = fauxProvider();
  let calls = 0;
  const first = fauxAssistantMessage(
    fauxToolCall("fixture_read", { key: "release-note" }),
    { stopReason: "toolUse" },
  );
  Object.assign(first, { usage: { input: 11, output: 7, totalTokens: 18 } });
  const second = fauxAssistantMessage("done");
  Reflect.deleteProperty(second, "usage");
  const events: CanonicalEvent[] = [];
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const message = calls === 1 ? first : second;
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
    now: () => 0,
  });

  await expect(kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture and deliver one sentence." }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  const finishedTurns = events.filter(
    (event) => event.type === "run.progress" &&
      (event.payload as { phase?: string }).phase === "turn_finished",
  );
  expect(finishedTurns).toHaveLength(2);
  expect(finishedTurns[0]?.payload).toEqual({
    phase: "turn_finished",
    usage: { input: 11, output: 7 },
  });
  expect(finishedTurns[1]?.payload).toEqual({ phase: "turn_finished" });
});

test("omits undefined, malformed, and local-error usage", async () => {
  for (const usage of [undefined, "not-an-object"] as const) {
    const provider = fauxProvider();
    const message = fauxAssistantMessage("done");
    Object.assign(message, { usage });
    const events: CanonicalEvent[] = [];
    const kernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: inMemoryToolGateway,
      workerProfileId,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    await expect(kernel.start(
      startRun({ turns: 1 }),
      collectingSink(events),
      new AbortController().signal,
    )).resolves.toEqual({ status: "completed" });

    expect(events).toContainEqual(expect.objectContaining({
      type: "run.progress",
      payload: { phase: "turn_finished" },
    }));
  }

  const provider = fauxProvider();
  const localErrorEvents: CanonicalEvent[] = [];
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => {
      throw new Error("local stream failure");
    },
  });

  await expect(kernel.start(
    startRun({ turns: 1 }),
    collectingSink(localErrorEvents),
    new AbortController().signal,
  )).resolves.toEqual({ status: "failed" });

  const localErrorTurn = localErrorEvents.find(
    (event) => event.type === "run.progress" &&
      (event.payload as { phase?: string }).phase === "turn_finished",
  );
  expect(localErrorTurn?.payload).toEqual({ phase: "turn_finished" });
});

test("appends model progress before a blocked provider stream completes", async () => {
  const provider = fauxProvider();
  const stream = createAssistantMessageEventStream();
  const events: CanonicalEvent[] = [];
  let resolveUpdate: (() => void) | undefined;
  const update = new Promise<void>((resolve) => {
    resolveUpdate = resolve;
  });
  const sink: EventSink = {
    async append(event) {
      events.push(event);
      if (
        event.type === "run.progress" &&
        (event.payload as { phase?: string }).phase === "model_response_updated"
      ) {
        resolveUpdate?.();
      }
    },
  };
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: () => stream,
    now: () => 0,
    createId: () => `event-${events.length + 1}`,
  });

  const run = kernel.start(
    startRun({ turns: 2 }, { goal: "Summarize the supplied fixture." }),
    sink,
    new AbortController().signal,
  );

  const partial = fauxAssistantMessage("");
  stream.push({ type: "start", partial });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: "do-not-store-this-delta",
    partial: fauxAssistantMessage("do-not-store-this-delta"),
  });
  await expect(Promise.race([
    update,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Pi message update was not recorded")), 50);
    }),
  ])).resolves.toBeUndefined();

  expect(events).toContainEqual(expect.objectContaining({
    type: "run.progress",
    payload: { phase: "model_response_updated" },
  }));
  expect(JSON.stringify(events)).not.toContain("do-not-store-this-delta");
  expect(events.some((event) => event.type.startsWith("run.completed"))).toBe(false);

  stream.push({
    type: "done",
    reason: "stop",
    message: fauxAssistantMessage("done"),
  });

  await expect(run).resolves.toEqual({ status: "completed" });
  expect(events.map((event) => event.type)).toEqual([
    "run.started",
    "run.progress",
    "run.progress",
    "run.progress",
    "run.completed",
  ]);
  expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
});

test("times out before a wall-time or turn budget can start another provider call", async () => {
  for (const [budget, advanceClock] of [
    [{ wallTimeMs: 5, turns: 2 }, true],
    [{ turns: 1 }, false],
  ] as const) {
    const provider = fauxProvider();
    let now = 0;
    let calls = 0;
    const kernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: inMemoryToolGateway,
      workerProfileId,
      streamFn: () => {
        calls += 1;
        if (advanceClock) {
          now = 5;
        }
        const stream = createAssistantMessageEventStream();
        const message = calls === 1
          ? fauxAssistantMessage(
            fauxToolCall("fixture_read", { key: "release-note" }),
            { stopReason: "toolUse" },
          )
          : fauxAssistantMessage("extra provider call");
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        return stream;
      },
      now: () => now,
    });
    const sink: EventSink = { append: async () => undefined };

    await expect(kernel.start(
      startRun(budget, { goal: "Read the fixture." }),
      sink,
      new AbortController().signal,
    )).resolves.toEqual({ status: "timed_out" });
    expect(calls).toBe(1);
  }
});

test("delivers a steer message once at the next Pi turn boundary", async () => {
  const provider = fauxProvider();
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  const contexts: Array<{ messages: unknown[] }> = [];
  let resolveFirstStream: (() => void) | undefined;
  const firstStream = new Promise<void>((resolve) => {
    resolveFirstStream = resolve;
  });
  let resolveSecondStream: (() => void) | undefined;
  const secondStream = new Promise<void>((resolve) => {
    resolveSecondStream = resolve;
  });
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: (_model, context) => {
      contexts.push({ messages: context.messages });
      const stream = createAssistantMessageEventStream();
      streams.push(stream);
      if (streams.length === 1) {
        resolveFirstStream?.();
      }
      if (streams.length === 2) {
        resolveSecondStream?.();
      }
      return stream;
    },
    now: () => 0,
  });
  const sink: EventSink = { append: async () => undefined };
  const run = kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture." }),
    sink,
    new AbortController().signal,
  );

  await firstStream;
  await kernel.steer("run-1" as RunId, {
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    content: "Use a table.",
  });
  const first = fauxAssistantMessage(
    fauxToolCall("fixture_read", { key: "release-note" }),
    { stopReason: "toolUse" },
  );
  streams[0]?.push({ type: "start", partial: first });
  streams[0]?.push({ type: "done", reason: "toolUse", message: first });
  await secondStream;

  const steerMessages = contexts[1]?.messages.filter(
    (message): message is { role: string; content: Array<{ text?: string }> } =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "user" &&
      (message as { content?: unknown }).content instanceof Array &&
      (message as { content: Array<{ text?: unknown }> }).content[0]?.text === "Use a table.",
  );
  expect(steerMessages).toHaveLength(1);

  const second = fauxAssistantMessage("done");
  streams[1]?.push({ type: "start", partial: second });
  streams[1]?.push({ type: "done", reason: "stop", message: second });
  await expect(run).resolves.toEqual({ status: "completed" });
});

test("aborts the Pi run and appends one cancelled terminal event", async () => {
  const provider = fauxProvider();
  const events: CanonicalEvent[] = [];
  let resolveFirstStream: (() => void) | undefined;
  const firstStream = new Promise<void>((resolve) => {
    resolveFirstStream = resolve;
  });
  let resolveAbort: (() => void) | undefined;
  const providerAbort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const aborted = fauxAssistantMessage("ignored", {
          stopReason: "aborted",
          errorMessage: "provider abort detail",
        });
        stream.push({ type: "error", reason: "aborted", error: aborted });
        resolveAbort?.();
      }, { once: true });
      resolveFirstStream?.();
      return stream;
    },
    now: () => 0,
  });
  const sink: EventSink = {
    append: async (event) => {
      events.push(event);
    },
  };
  const run = kernel.start(
    startRun({ turns: 2 }, { goal: "Read the fixture." }),
    collectingSink(events),
    new AbortController().signal,
  );

  await firstStream;
  await kernel.abort("run-1" as RunId, "user cancelled");
  const abortState = await Promise.race([
    providerAbort.then(() => "aborted"),
    new Promise<string>((resolve) => setTimeout(() => resolve("not aborted"), 20)),
  ]);

  expect(abortState).toBe("aborted");
  await expect(run).resolves.toEqual({ status: "cancelled" });
  expect(events.filter((event) => /run\.(completed|failed|timed_out|cancelled)$/.test(event.type)))
    .toHaveLength(1);
  expect(events.at(-1)?.type).toBe("run.cancelled");
});

test("exposes only the Gateway-backed fixture_read Pi tool", async () => {
  const provider = fauxProvider();
  const contexts: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
  const events: CanonicalEvent[] = [];
  let calls = 0;
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: (_model, context) => {
      calls += 1;
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      const message = calls === 1
        ? fauxAssistantMessage(
          fauxToolCall("fixture_read", { key: "release-note" }),
          { stopReason: "toolUse" },
        )
        : fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
    now: () => 0,
  });
  await expect(kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture." }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["fixture_read"]);
  expect(contexts[1]?.messages).toContainEqual(expect.objectContaining({
    role: "toolResult",
    toolName: "fixture_read",
    content: [{ type: "text", text: "Fixture: release-note" }],
  }));
  expect(JSON.stringify(events)).not.toMatch(/release-note|Fixture: release-note/);
});

test("projects a successful create_artifact Tool into Create events", async () => {
  const provider = fauxProvider();
  const events: CanonicalEvent[] = [];
  let calls = 0;
  const gateway: ToolGateway = {
    async execute(request) {
      expect(request.name).toBe("create_artifact");
      return {
        status: "succeeded",
        output: {
          artifact: {
            kind: "skill",
            skill_id: "csv_to_markdown",
            path: "create-runs/run-1/skill/csv_to_markdown/SKILL.md",
            preview: "---\nname: CSV\nversion: 1.0.0\n---\n",
            hash: "sha256:artifact",
          },
          validation: {
            valid: true,
            loaded_skill_id: "csv_to_markdown",
            errors: [],
          },
        },
      };
    },
  };
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: gateway,
    workerProfileId,
    streamFn: (_model, context) => {
      calls += 1;
      expect(context.tools?.map((tool) => tool.name)).toEqual(["create_artifact"]);
      const stream = createAssistantMessageEventStream();
      const message = calls === 1
        ? fauxAssistantMessage(
          fauxToolCall("create_artifact", {
            kind: "skill",
            skill_id: "csv_to_markdown",
            preview: "---\nname: CSV\nversion: 1.0.0\n---\n",
          }),
          { stopReason: "toolUse" },
        )
        : fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
    now: () => 0,
  });

  await expect(kernel.start(
    startRun({ turns: 3 }, { allowedTools: ["create_artifact"], goal: "Create a skill." }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "create.artifact.created",
      payload: expect.objectContaining({
        artifact: expect.objectContaining({ skill_id: "csv_to_markdown" }),
      }),
    }),
    expect.objectContaining({
      type: "create.artifact.validated",
      payload: expect.objectContaining({
        validation: expect.objectContaining({ valid: true }),
      }),
    }),
  ]));
});

test("does not expose a Pi tool excluded by the resolved RunProfile snapshot", async () => {
  const provider = fauxProvider();
  const contexts: Array<{ tools?: readonly { name: string }[] }> = [];
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: (_model, context) => {
      contexts.push({ tools: context.tools });
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });

  await kernel.start(
    startRun({ turns: 1 }, { allowedTools: ["read_workspace"] }),
    collectingSink([]),
    new AbortController().signal,
  );

  expect(contexts[0]?.tools ?? []).toEqual([]);
});

test("exposes WebSearch only when the resolved RunProfile allows it", async () => {
  const provider = fauxProvider();
  const contexts: Array<{ tools?: readonly { name: string }[] }> = [];
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: (_model, context) => {
      contexts.push({ tools: context.tools });
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });

  await kernel.start(
    startRun({ turns: 1 }, { allowedTools: ["web_search"] }),
    collectingSink([]),
    new AbortController().signal,
  );

  expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["web_search"]);
});

test("routes the sole Pi tool through ToolGateway with the Run scope", async () => {
  const provider = fauxProvider();
  const fixtureOutput = { fixture: "gateway" };
  const sandboxRequests: ToolRequest[] = [];
  const contexts: Array<{ messages: unknown[] }> = [];
  const events = createStrictInMemoryToolEvents();
  const fixtureRead: ToolDefinition = {
    name: "fixture_read",
    replayPolicy: "safe",
    inputSchema: {
      parse(input: unknown) {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          typeof (input as { key?: unknown }).key !== "string"
        ) {
          throw new Error("fixture_read input requires exactly { key: string }");
        }
        return { key: (input as { key: string }).key };
      },
    },
  };
  const policy: ToolPolicy = {
    async decide() {
      return "allow";
    },
  };
  const sandbox: SandboxAdapter = {
    async execute(request) {
      sandboxRequests.push(request);
      return { status: "succeeded", output: fixtureOutput };
    },
  };
  const gateway = createToolGateway({
    catalog: [fixtureRead],
    scope: Object.freeze({
      workspaceId: "workspace-1" as ToolRequest["workspaceId"],
      channelId: "channel-1" as ToolRequest["channelId"],
    }),
    workerProfileId: "worker-profile-1" as WorkerProfileId,
    policy,
    sandbox,
    events,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  let calls = 0;
  const options = {
    model: provider.getModel(),
    streamFn: (_model: unknown, context: { messages: unknown[] }) => {
      calls += 1;
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      const message = calls === 1
        ? fauxAssistantMessage(
          fauxToolCall("fixture_read", { key: "release-note" }),
          { stopReason: "toolUse" },
        )
        : fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
    toolGateway: gateway,
    workerProfileId: "worker-profile-1" as WorkerProfileId,
  };
  const kernel = new PiLoopKernel(options);

  await expect(kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture." }),
    { append: async () => undefined },
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  expect(sandboxRequests).toEqual([{
    name: "fixture_read",
    input: { key: "release-note" },
    workspaceId: "workspace-1",
    channelId: "channel-1",
    runId: "run-1",
    workerProfileId: "worker-profile-1",
    toolCallId: expect.any(String),
  }]);
  expect(contexts[1]?.messages).toContainEqual(expect.objectContaining({
    role: "toolResult",
    toolName: "fixture_read",
    content: [{ type: "text", text: JSON.stringify(fixtureOutput) }],
  }));
  const toolResult = contexts[1]?.messages.find(
    (message): message is { toolCallId?: string } => (
      typeof message === "object"
      && message !== null
      && (message as { role?: unknown }).role === "toolResult"
    ),
  );
  const request = sandboxRequests[0];
  if (request === undefined) {
    throw new Error("fixture_read Sandbox request was not captured");
  }
  expect(request.toolCallId).not.toBe("");
  expect(toolResult?.toolCallId).toBe(request.toolCallId);

  const lifecycleEvents: CanonicalEvent[] = [];
  const lifecycleStreamId = `tool:${request.runId}:${request.toolCallId}`;
  for await (const event of events.read(lifecycleStreamId as never)) {
    lifecycleEvents.push(event);
  }
  expect(lifecycleEvents.map((event) => [event.seq, event.type])).toEqual([
    [0, "tool.requested"],
    [1, "tool.policy.decided"],
    [2, "tool.result"],
  ]);
  expect(lifecycleEvents[1]?.payload).toMatchObject({ decision: "allow" });
  expect(lifecycleEvents[2]?.payload).toMatchObject({ status: "succeeded" });
  expect(JSON.stringify(lifecycleEvents)).not.toContain(JSON.stringify(fixtureOutput));
});

test("maps non-success Gateway result into safe Pi observation", async () => {
  const provider = fauxProvider();
  const contexts: Array<{ messages: unknown[] }> = [];
  const events: CanonicalEvent[] = [];
  const requests: ToolRequest[] = [];
  let calls = 0;
  const gateway: ToolGateway = {
    async execute(request) {
      requests.push(request);
      return {
        status: "unknown",
        output: {
          reason: "effect_outcome_unknown",
          detail: "secret-must-not-leak",
        },
      };
    },
  };
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: gateway,
    workerProfileId,
    streamFn: (_model, context) => {
      calls += 1;
      contexts.push({ messages: context.messages });
      const stream = createAssistantMessageEventStream();
      const message = calls === 1
        ? fauxAssistantMessage(
          fauxToolCall("fixture_read", { key: "release-note" }),
          { stopReason: "toolUse" },
        )
        : fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
  });

  await expect(kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture." }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  expect(calls).toBe(2);
  const toolResult = contexts[1]?.messages.find(
    (message): message is {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      details: unknown;
      content: Array<{ type: string; text?: string }>;
    } => (
      typeof message === "object"
      && message !== null
      && (message as { role?: unknown }).role === "toolResult"
    ),
  );
  const request = requests[0];
  const toolCallId = request?.toolCallId;
  expect(toolCallId).toEqual(expect.any(String));
  expect(toolCallId).not.toBe("");
  expect(toolResult).toMatchObject({
    role: "toolResult",
    toolCallId,
    toolName: "fixture_read",
    isError: true,
    details: { status: "unknown" },
  });
  expect(toolResult?.content).toHaveLength(1);
  const content = toolResult?.content[0];
  expect(content).toMatchObject({ type: "text", text: expect.any(String) });
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("Pi tool error must expose one text observation");
  }
  expect(content.text).toContain("unknown");
  expect(content.text).toContain("effect_outcome_unknown");
  expect(content.text).not.toContain("secret-must-not-leak");
  expect(content.text).not.toContain("detail");
  expect(events.filter((event) => (
    event.type === "run.tool.started" || event.type === "run.tool.completed"
  ))).toEqual([
    expect.objectContaining({
      type: "run.tool.started",
      payload: expect.objectContaining({
        tool: "fixture_read",
        toolCallId,
      }),
    }),
    expect.objectContaining({
      type: "run.tool.completed",
      payload: expect.objectContaining({
        tool: "fixture_read",
        toolCallId,
        outcome: "failed",
      }),
    }),
  ]);
});

test("maps Gateway approval_required to an awaiting-approval Run", async () => {
  const provider = fauxProvider();
  const events: CanonicalEvent[] = [];
  let calls = 0;
  let toolCompletion: {
    isError: boolean;
    result: { content: Array<{ type: string; text?: string }>; details: unknown };
  } | undefined;
  const gateway: ToolGateway = {
    async execute() {
      return {
        status: "failed",
        output: { reason: "approval_required", approvalId: "approval-1" },
      };
    },
  };
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: gateway,
    workerProfileId,
    streamFn: () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const message = calls === 1
        ? fauxAssistantMessage(
          fauxToolCall("fixture_read", { key: "release-note" }),
          { stopReason: "toolUse" },
        )
        : fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
  });
  const record = (kernel as unknown as {
    record: (run: unknown, event: unknown) => Promise<void>;
  }).record;
  (kernel as unknown as {
    record: (run: unknown, event: unknown) => Promise<void>;
  }).record = async (run, event) => {
    const toolEvent = event as {
      type?: unknown;
      isError?: unknown;
      result?: unknown;
    };
    if (toolEvent.type === "tool_execution_end") {
      toolCompletion = {
        isError: toolEvent.isError === true,
        result: toolEvent.result as {
          content: Array<{ type: string; text?: string }>;
          details: unknown;
        },
      };
    }
    await record.call(kernel, run, event);
  };

  await expect(kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture." }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "awaiting_approval" });

  expect(calls).toBe(1);
  expect(toolCompletion).toMatchObject({
    isError: true,
    result: {
      content: [{ type: "text", text: '{"status":"failed","reason":"approval_required"}' }],
      details: { status: "failed", reason: "approval_required" },
    },
  });
  expect(JSON.stringify(toolCompletion)).not.toContain("approval-1");
  expect(events.filter((event) => event.type === "run.tool.completed")).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({ tool: "fixture_read", outcome: "failed" }),
    }),
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "run.awaiting_approval",
    payload: { outcome: "awaiting_approval" },
  });
  expect(JSON.stringify(events)).not.toContain("approval-1");
});

test("rejects invalid fixture_read arguments before calling ToolGateway", async () => {
  const provider = fauxProvider();
  const gateway: ToolGateway = {
    execute: async () => ({ status: "succeeded" }),
  };
  let gatewayCalls = 0;
  const countingGateway: ToolGateway = {
    async execute(request, signal) {
      gatewayCalls += 1;
      return gateway.execute(request, signal);
    },
  };
  const events: CanonicalEvent[] = [];
  let calls = 0;
  const options = {
    model: provider.getModel(),
    streamFn: () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const message = calls === 1
        ? fauxAssistantMessage(
          fauxToolCall("fixture_read", {}),
          { stopReason: "toolUse" },
        )
        : fauxAssistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
    toolGateway: countingGateway,
    workerProfileId: "worker-profile-1" as WorkerProfileId,
  };
  const kernel = new PiLoopKernel(options);

  await expect(kernel.start(
    startRun({ turns: 3 }, { goal: "Read the fixture." }),
    collectingSink(events),
    new AbortController().signal,
  )).resolves.toEqual({ status: "completed" });

  expect(gatewayCalls).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({
    type: "run.tool.completed",
    payload: expect.objectContaining({ tool: "fixture_read", outcome: "failed" }),
  }));
});

test("propagates EventSink append failures instead of claiming a Run outcome", async () => {
  const provider = fauxProvider();
  const progressFailure = new Error("progress sink failure");
  const terminalFailure = new Error("terminal sink failure");

  for (const [failure, failWhen] of [
    [progressFailure, "run.progress"],
    [terminalFailure, "run.completed"],
  ] as const) {
    const persisted: CanonicalEvent[] = [];
    const kernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: inMemoryToolGateway,
      workerProfileId,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("done");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    await expect(kernel.start(
      startRun({ turns: 1 }),
      {
        append: async (event) => {
          if (event.type === failWhen) {
            throw failure;
          }
          persisted.push(event);
        },
      },
      new AbortController().signal,
    )).rejects.toBe(failure);
    expect(persisted.map((event) => event.type)).not.toContain("pi.transcript.message");
    expect(persisted.map((event) => event.type)).not.toContain("run.failed");
  }
});

test("maps provider errors to failed and omits unreported usage from canonical payloads", async () => {
  async function runResponse(
    message: ReturnType<typeof fauxAssistantMessage>,
    type: "done" | "error",
  ): Promise<{ events: CanonicalEvent[]; outcome: unknown }> {
    const provider = fauxProvider();
    const events: CanonicalEvent[] = [];
    const kernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: inMemoryToolGateway,
      workerProfileId,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        if (type === "done") {
          stream.push({ type: "done", reason: "stop", message });
        } else {
          stream.push({ type: "error", reason: "error", error: message });
        }
        return stream;
      },
      now: () => 0,
    });
    const outcome = await kernel.start(
      startRun({ turns: 2 }, { goal: "do-not-store-this-prompt" }),
      collectingSink(events),
      new AbortController().signal,
    );
    return { events, outcome };
  }

  const withoutUsage = fauxAssistantMessage("do-not-store-this-output") as Omit<
    ReturnType<typeof fauxAssistantMessage>,
    "usage"
  > & { usage?: unknown };
  delete withoutUsage.usage;
  const completed = await runResponse(withoutUsage as ReturnType<typeof fauxAssistantMessage>, "done");
  const providerError = await runResponse(
    fauxAssistantMessage("do-not-store-this-error", {
      stopReason: "error",
      errorMessage: "do-not-store-provider-error",
    }),
    "error",
  );

  const finishedTurn = completed.events.find(
    (event) => event.type === "run.progress" &&
      (event.payload as { phase?: string }).phase === "turn_finished",
  );
  expect(finishedTurn?.payload).not.toHaveProperty("usage");
  expect(completed.outcome).toEqual({ status: "completed" });
  expect(providerError.outcome).toEqual({ status: "failed" });
  expect(providerError.events.at(-1)?.type).toBe("run.failed");
  expect(JSON.stringify([...completed.events, ...providerError.events]))
    .not.toMatch(/do-not-store-this-(prompt|output|error|provider-error)/);
});

test("enforces wall time while a provider stream remains blocked", async () => {
  const provider = fauxProvider();
  const events: CanonicalEvent[] = [];
  let resolveProviderAbort: (() => void) | undefined;
  const providerAbort = new Promise<void>((resolve) => {
    resolveProviderAbort = resolve;
  });
  const kernel = new PiLoopKernel({
    model: provider.getModel(),
    toolGateway: inMemoryToolGateway,
    workerProfileId,
    streamFn: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const aborted = fauxAssistantMessage("timeout", { stopReason: "aborted" });
        stream.push({ type: "error", reason: "aborted", error: aborted });
        resolveProviderAbort?.();
      }, { once: true });
      return stream;
    },
  });
  const run = kernel.start(
    startRun({ wallTimeMs: 10, turns: 2 }, { goal: "Read the fixture." }),
    collectingSink(events),
    new AbortController().signal,
  );

  const timeoutState = await Promise.race([
    providerAbort.then(() => "timed_out"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still_running"), 50)),
  ]);

  expect(timeoutState).toBe("timed_out");
  await expect(run).resolves.toEqual({ status: "timed_out" });
  expect(events.at(-1)?.type).toBe("run.timed_out");
});
