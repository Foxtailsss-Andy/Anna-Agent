import {
  parseCanonicalEvent,
  type CanonicalEvent,
  type ChannelScope,
  type StreamId,
} from "@anna/harness-v2";
import { InMemoryEventStore } from "@anna/event-store";
import { expect, test } from "vitest";

import { createLiveTraceCursor } from "../src/index";

const scope = {
  workspaceId: "workspace-live-trace",
  channelId: "channel-live-trace",
} as ChannelScope;
const streamId = "run-live-trace" as StreamId;
const toolStreamId = "tool:run-live-trace:call-live" as StreamId;

function event(
  seq: number,
  type: string,
  payload: CanonicalEvent["payload"],
): CanonicalEvent {
  return parseCanonicalEvent({
    id: `event-live-${seq}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId,
    seq,
    type,
    timestamp: new Date(Date.UTC(2026, 7, 20, 1, 0, seq)).toISOString(),
    schemaVersion: 1,
    payload,
  });
}

function toolEvent(seq: number, type: string, payload: CanonicalEvent["payload"]): CanonicalEvent {
  return parseCanonicalEvent({
    id: `tool-event-live-${seq}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: toolStreamId,
    seq,
    type,
    timestamp: new Date(Date.UTC(2026, 7, 20, 1, 1, seq)).toISOString(),
    schemaVersion: 1,
    payload,
  });
}

test("advances a live Trace from the durable stream without replaying consumed events", async () => {
  const store = new InMemoryEventStore().scope(scope);
  await store.append(event(0, "run.started", {}));
  await store.append(event(1, "run.progress", {
    phase: "model_response_started",
    model: "fixture-model",
  }));
  const cursor = createLiveTraceCursor({
    events: store,
    streamId,
    runId: "run-live-trace",
    surface: "channel",
    scope,
  });

  const activeModel = await cursor.read();
  expect(activeModel.cursor).toEqual({ streamId, seq: 1 });
  expect(activeModel.cursors).toEqual([{ streamId, seq: 1 }]);
  expect(activeModel.document.spans.find((span) => span.kind === "inference")).toMatchObject({
    status: "unset",
    end_time: null,
  });

  await store.append(event(2, "run.tool.started", {
    tool: "fixture_read",
    toolCallId: "call-live",
  }));
  const activeTool = await cursor.read();
  expect(activeTool.cursor).toEqual({ streamId, seq: 2 });
  expect(activeTool.document.spans.filter((span) => span.kind === "agent")).toHaveLength(1);
  expect(activeTool.document.spans.find((span) => span.kind === "tool")).toMatchObject({
    status: "unset",
    end_time: null,
  });

  await store.append(event(3, "run.tool.completed", {
    tool: "fixture_read",
    toolCallId: "call-live",
    outcome: "succeeded",
  }));
  await store.append(event(4, "run.progress", { phase: "turn_finished" }));
  await store.append(event(5, "run.completed", { outcome: "completed" }));
  const terminal = await cursor.read();

  expect(terminal.cursor).toEqual({ streamId, seq: 5 });
  expect(terminal.document.spans[0]?.status).toBe("ok");
  expect(terminal.document.spans.find((span) => span.kind === "tool")?.status).toBe("ok");
});

test("discovers and advances independent Tool streams in the same scoped Run", async () => {
  const store = new InMemoryEventStore().scope(scope);
  await store.append(event(0, "run.started", {}));
  await store.append(toolEvent(0, "tool.requested", {
    runId: "run-live-trace",
    tool: "fixture_read",
    toolCallId: "call-live",
  }));
  const cursor = createLiveTraceCursor({
    events: store,
    streamId,
    runId: "run-live-trace",
    surface: "channel",
    scope,
  });

  const snapshot = await cursor.read();
  expect(snapshot.cursors).toEqual([
    { streamId, seq: 0 },
    { streamId: toolStreamId, seq: 0 },
  ]);
  expect(snapshot.document.spans.find((span) => span.kind === "tool")).toMatchObject({
    status: "unset",
    attributes: { "anna.tool.call_id": "call-live" },
  });

  await store.append(toolEvent(1, "tool.result", {
    runId: "run-live-trace",
    tool: "fixture_read",
    toolCallId: "call-live",
    status: "succeeded",
  }));
  const completed = await cursor.read();
  expect(completed.cursors).toContainEqual({ streamId: toolStreamId, seq: 1 });
  expect(completed.document.spans.find((span) => span.kind === "tool")?.status).toBe("ok");
});
