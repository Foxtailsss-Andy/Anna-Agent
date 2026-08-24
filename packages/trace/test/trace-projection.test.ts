import { parseCanonicalEvent, type CanonicalEvent, type ChannelScope } from "@anna/harness-v2";
import { expect, test } from "vitest";

import { projectTrace } from "../src/index";

function event(
  seq: number,
  type: string,
  timestamp: string,
  payload: CanonicalEvent["payload"],
): CanonicalEvent {
  return parseCanonicalEvent({
    id: `event-${seq}`,
    workspaceId: "workspace-trace",
    channelId: "channel-trace",
    streamId: "run-trace",
    seq,
    type,
    timestamp,
    schemaVersion: 1,
    payload,
  });
}

const traceOptions = {
  runId: "run-trace",
  surface: "channel",
  scope: {
    workspaceId: "workspace-trace",
    channelId: "channel-trace",
  } as ChannelScope,
};

test("projects an active model call before the Run reaches a terminal event", () => {
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T00:00:01.000Z", {
      phase: "model_response_started",
      model: "fixture-model",
    }),
  ], traceOptions);

  expect(trace.trace_id).toBe("run-trace");
  expect(trace.spans.map((span) => span.kind)).toEqual(["agent", "turn", "inference"]);
  expect(trace.spans[0]).toMatchObject({
    parent_span_id: null,
    status: "unset",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "anna.channel",
      "gen_ai.conversation.id": "run-trace",
      "anna.turns": 1,
    },
  });
  expect(trace.spans[2]).toMatchObject({
    name: "chat fixture-model",
    status: "unset",
    end_time: null,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "fixture-model",
    },
  });
});

test("uses thread_id from canonical evidence before falling back to Run id", () => {
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T00:00:01.000Z", {
      phase: "model_response_started",
      thread_id: "thread-42",
    }),
  ], traceOptions);

  expect(trace.spans[0]?.attributes["gen_ai.conversation.id"]).toBe("thread-42");
});

test("closes inference spans without inventing missing token usage", () => {
  const withoutUsage = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T00:00:01.000Z", {
      phase: "model_response_started",
    }),
    event(2, "run.progress", "2026-08-20T00:00:03.000Z", {
      phase: "turn_finished",
    }),
    event(3, "run.completed", "2026-08-20T00:00:04.000Z", {}),
  ], traceOptions);
  const inferenceWithoutUsage = withoutUsage.spans.find((span) => span.kind === "inference")!;

  expect(inferenceWithoutUsage).toMatchObject({
    end_time: "2026-08-20T00:00:03.000Z",
    duration_ms: 2_000,
    status: "ok",
  });
  expect(inferenceWithoutUsage.attributes).not.toHaveProperty("gen_ai.usage.input_tokens");
  expect(inferenceWithoutUsage.attributes).not.toHaveProperty("gen_ai.usage.output_tokens");
  expect(withoutUsage.spans[0]).toMatchObject({
    end_time: "2026-08-20T00:00:04.000Z",
    duration_ms: 4_000,
    status: "ok",
  });

  const withUsage = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T00:00:01.000Z", {
      phase: "model_response_started",
    }),
    event(2, "run.progress", "2026-08-20T00:00:03.000Z", {
      phase: "turn_finished",
      usage: { input: 17, output: 5, cost: 0.25 },
    }),
  ], traceOptions);

  expect(withUsage.spans.find((span) => span.kind === "inference")?.attributes).toMatchObject({
    "gen_ai.usage.input_tokens": 17,
    "gen_ai.usage.output_tokens": 5,
    "anna.usage.cost": 0.25,
  });
});

test("pairs Tool calls by id and marks a terminal Run's open Tool as orphaned", () => {
  const completed = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T00:00:01.000Z", {
      phase: "model_response_started",
    }),
    event(2, "run.tool.started", "2026-08-20T00:00:02.000Z", {
      tool: "fixture_read",
      toolCallId: "call-1",
    }),
    event(3, "run.tool.completed", "2026-08-20T00:00:05.000Z", {
      tool: "fixture_read",
      toolCallId: "call-1",
      outcome: "succeeded",
    }),
    event(4, "run.progress", "2026-08-20T00:00:06.000Z", {
      phase: "turn_finished",
    }),
    event(5, "run.completed", "2026-08-20T00:00:07.000Z", {}),
  ], traceOptions);

  expect(completed.spans.find((span) => span.kind === "tool")).toMatchObject({
    name: "execute_tool fixture_read",
    parent_span_id: "s2",
    start_time: "2026-08-20T00:00:02.000Z",
    end_time: "2026-08-20T00:00:05.000Z",
    duration_ms: 3_000,
    status: "ok",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "fixture_read",
      "anna.tool.call_id": "call-1",
    },
  });

  const orphaned = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.tool.started", "2026-08-20T00:00:02.000Z", {
      tool: "fixture_read",
      toolCallId: "call-orphaned",
    }),
    event(2, "run.failed", "2026-08-20T00:00:04.000Z", { errorType: "loop_failed" }),
  ], traceOptions);

  expect(orphaned.spans.find((span) => span.kind === "tool")).toMatchObject({
    end_time: "2026-08-20T00:00:04.000Z",
    status: "error",
    attributes: {
      "anna.orphaned": true,
    },
  });
});

test("attaches turn usage even when the model response opened a Tool call", () => {
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T00:00:01.000Z", {
      phase: "model_response_started",
    }),
    event(2, "run.tool.started", "2026-08-20T00:00:02.000Z", {
      tool: "fixture_read",
      toolCallId: "usage-call",
    }),
    event(3, "run.tool.completed", "2026-08-20T00:00:03.000Z", {
      tool: "fixture_read",
      toolCallId: "usage-call",
      outcome: "succeeded",
    }),
    event(4, "run.progress", "2026-08-20T00:00:04.000Z", {
      phase: "turn_finished",
      usage: { input: 11, output: 4, cost: 0.12 },
    }),
  ], traceOptions);

  expect(trace.spans.find((span) => span.kind === "inference")?.attributes).toMatchObject({
    "gen_ai.usage.input_tokens": 11,
    "gen_ai.usage.output_tokens": 4,
    "anna.usage.cost": 0.12,
  });
});

test("preserves unknown and governance events with scalar-only attributes", () => {
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "tool.approval.requested", "2026-08-20T00:00:01.000Z", {
      approvalId: "approval-1",
      tool: "write_workspace",
    }),
    event(2, "retry.scheduled", "2026-08-20T00:00:02.000Z", { attempt: 2 }),
    event(3, "budget.exhausted", "2026-08-20T00:00:03.000Z", { limit: "turns" }),
    event(4, "eval.contract.completed", "2026-08-20T00:00:04.000Z", { passed: false }),
    event(5, "future.signal", "2026-08-20T00:00:05.000Z", {
      label: "preserved",
      count: 3,
      nested: { mustNotLeakIntoAttributes: true },
      values: [1, 2],
    }),
  ], traceOptions);
  const traceEvents = trace.spans.flatMap((span) => span.events);

  expect(traceEvents.map((item) => item.name)).toEqual([
    "tool.approval.requested",
    "retry.scheduled",
    "budget.exhausted",
    "eval.contract.completed",
    "future.signal",
  ]);
  expect(traceEvents.at(-1)?.attributes).toEqual({ label: "preserved", count: 3 });
});

test("projects durable ToolGateway lifecycle events from a Tool stream", () => {
  const toolEvent = (
    seq: number,
    type: string,
    payload: CanonicalEvent["payload"],
  ): CanonicalEvent => parseCanonicalEvent({
    id: `tool-event-${seq}`,
    workspaceId: "workspace-trace",
    channelId: "channel-trace",
    streamId: "tool:run-trace:call-gateway",
    seq,
    type,
    timestamp: new Date(Date.UTC(2026, 7, 20, 2, 0, seq)).toISOString(),
    schemaVersion: 1,
    payload,
  });
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T02:00:00.000Z", {}),
    toolEvent(0, "tool.requested", {
      runId: "run-trace",
      workerProfileId: "worker-1",
      tool: "fixture_read",
      toolCallId: "call-gateway",
    }),
    toolEvent(1, "tool.policy.decided", {
      runId: "run-trace",
      toolCallId: "call-gateway",
      decision: "allow",
    }),
    toolEvent(2, "tool.result", {
      runId: "run-trace",
      tool: "fixture_read",
      toolCallId: "call-gateway",
      status: "succeeded",
    }),
  ], traceOptions);
  const tool = trace.spans.find((span) => span.kind === "tool")!;

  expect(tool).toMatchObject({
    name: "execute_tool fixture_read",
    parent_span_id: "s1",
    status: "ok",
    attributes: { "anna.tool.call_id": "call-gateway" },
  });
  expect(tool.events).toEqual([{
    name: "tool.policy.decided",
    time: "2026-08-20T02:00:01.000Z",
    attributes: {
      runId: "run-trace",
      toolCallId: "call-gateway",
      decision: "allow",
    },
  }]);
});

test("attributes child Run events to the parent Trace without closing the parent early", () => {
  const childStarted = parseCanonicalEvent({
    id: "child-started",
    workspaceId: "workspace-trace",
    channelId: "channel-trace",
    streamId: "child-run",
    seq: 0,
    type: "run.started",
    timestamp: "2026-08-20T02:00:01.000Z",
    schemaVersion: 1,
    payload: {
      runId: "child-run",
      parentRunId: "run-trace",
      parentEventId: "event-0",
      laneId: "lane-1",
    },
  });
  const childCompleted = parseCanonicalEvent({
    ...childStarted,
    id: "child-completed",
    seq: 1,
    type: "run.completed",
    timestamp: "2026-08-20T02:00:02.000Z",
  });
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T02:00:00.000Z", {}),
    childStarted,
    childCompleted,
    event(1, "run.completed", "2026-08-20T02:00:03.000Z", {}),
  ], traceOptions);

  expect(trace.spans[0]).toMatchObject({
    end_time: "2026-08-20T02:00:03.000Z",
    status: "ok",
  });
  expect(trace.spans.flatMap((span) => span.events)).toEqual([
    expect.objectContaining({
      name: "run.started",
      attributes: expect.objectContaining({
        runId: "child-run",
        parentRunId: "run-trace",
        laneId: "lane-1",
      }),
    }),
    expect.objectContaining({ name: "run.completed" }),
  ]);
});

test("ignores events that belong to another Run", () => {
  const foreign = parseCanonicalEvent({
    id: "foreign-event",
    workspaceId: "workspace-trace",
    channelId: "channel-trace",
    streamId: "run-foreign",
    seq: 0,
    type: "future.signal",
    timestamp: "2026-08-20T03:00:01.000Z",
    schemaVersion: 1,
    payload: { label: "foreign" },
  });
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T03:00:00.000Z", {}),
    foreign,
    parseCanonicalEvent({
      id: "foreign-scope-event",
      workspaceId: "workspace-other",
      channelId: "channel-trace",
      streamId: "tool:run-trace:foreign-call",
      seq: 0,
      type: "tool.requested",
      timestamp: "2026-08-20T03:00:02.000Z",
      schemaVersion: 1,
      payload: { runId: "run-trace", toolCallId: "foreign-call", tool: "write" },
    }),
  ], traceOptions);

  expect(trace.spans.flatMap((span) => span.events)).toEqual([]);
});

test("orders offset timestamps by their instant and retains unmatched Tool completion", () => {
  const trace = projectTrace([
    event(0, "run.started", "2026-08-20T00:00:00.000Z", {}),
    event(1, "run.tool.completed", "2026-08-20T00:00:03.000Z", {
      tool: "fixture_read",
      toolCallId: "missing-call",
      outcome: "succeeded",
    }),
    event(2, "run.progress", "2026-08-20T01:00:01.000+01:00", {
      phase: "model_response_started",
    }),
  ], traceOptions);

  expect(trace.spans.find((span) => span.kind === "inference")?.start_time)
    .toBe("2026-08-20T01:00:01.000+01:00");
  expect(trace.spans.flatMap((span) => span.events)).toEqual([
    expect.objectContaining({ name: "run.tool.completed" }),
  ]);
});

test("projects merged streams deterministically regardless of input order", () => {
  const ordered = [
    event(0, "run.started", "2026-08-20T04:00:00.000Z", {}),
    event(1, "run.progress", "2026-08-20T04:00:01.000Z", {
      phase: "model_response_started",
    }),
    event(2, "run.completed", "2026-08-20T04:00:03.000Z", {}),
  ];
  const reversed = [...ordered].reverse();

  expect(projectTrace(reversed, traceOptions))
    .toEqual(projectTrace(ordered, traceOptions));
});
