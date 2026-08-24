import { describe, expect, test } from "vitest";

import { InMemoryEventStore } from "@anna/event-store";
import type { CanonicalEvent, ChannelScope, EventStore } from "@anna/harness-v2";
import { startHarnessService } from "../src/index";

const scopeA: ChannelScope = {
  workspaceId: "workspace-a" as ChannelScope["workspaceId"],
  channelId: "channel-a" as ChannelScope["channelId"],
};
const scopeB: ChannelScope = {
  workspaceId: "workspace-b" as ChannelScope["workspaceId"],
  channelId: "channel-b" as ChannelScope["channelId"],
};

function event(
  scope: ChannelScope,
  id: string,
  streamId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): CanonicalEvent {
  return {
    ...scope,
    id: id as CanonicalEvent["id"],
    streamId: streamId as CanonicalEvent["streamId"],
    seq,
    type,
    timestamp: `2026-08-23T00:00:0${seq}.000Z`,
    schemaVersion: 1,
    payload,
  };
}

async function append(store: EventStore, value: CanonicalEvent): Promise<void> {
  await store.scope({
    workspaceId: value.workspaceId,
    channelId: value.channelId,
  }).append(value);
}

describe("Harness v2 review cursor HTTP contract", () => {
  test("accepts only loopback service binding", async () => {
    await expect(startHarnessService({ host: "0.0.0.0" })).rejects.toThrow(
      "Harness v2 service must bind to a loopback host",
    );
  });

  test("reads Channel events after the durable cursor and returns the next cursor", async () => {
    const store = new InMemoryEventStore();
    await append(store, event(scopeA, "event-0", "run-a", 0, "run.started"));
    await append(store, event(scopeA, "event-1", "run-a", 1, "run.completed"));
    const service = await startHarnessService({ eventStore: store });

    try {
      const response = await fetch(
        `${service.url}/v2/channels/workspace-a/channel-a/events?streamId=run-a&afterSeq=0`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        events: [expect.objectContaining({ id: "event-1", seq: 1 })],
        nextCursor: { streamId: "run-a", seq: 1 },
      });
    } finally {
      await service.close();
    }
  });

  test("keeps Channel reads isolated by URL scope and ignores widening query fields", async () => {
    const store = new InMemoryEventStore();
    await append(store, event(scopeA, "event-a", "run-a", 0, "run.started"));
    await append(store, event(scopeB, "event-b", "run-b", 0, "run.started"));
    const service = await startHarnessService({ eventStore: store });

    try {
      const response = await fetch(
        `${service.url}/v2/channels/workspace-a/channel-a/events?streamId=run-b&workspaceId=workspace-b`,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ code: "v2_channel_stream_not_found" });
    } finally {
      await service.close();
    }
  });

  test("projects Trace and cursors from the same scoped Run", async () => {
    const store = new InMemoryEventStore();
    await append(store, event(scopeA, "trace-start", "trace-a", 0, "run.started", {
      surface: "review",
      runId: "trace-a",
    }));
    await append(store, event(scopeA, "trace-end", "trace-a", 1, "run.completed", {
      runId: "trace-a",
    }));
    await append(store, event(scopeA, "child-start", "child-a", 0, "run.started", {
      runId: "child-a",
      parentRunId: "trace-a",
      parentEventId: "trace-start",
      laneId: "lane-1",
    }));
    await append(store, event(scopeA, "child-end", "child-a", 1, "run.completed", {
      runId: "child-a",
      parentRunId: "trace-a",
      parentEventId: "trace-start",
      laneId: "lane-1",
    }));
    const service = await startHarnessService({ eventStore: store });

    try {
      const response = await fetch(
        `${service.url}/v2/runs/trace-a/trace?workspaceId=workspace-a&channelId=channel-a&surface=review`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        document: expect.objectContaining({ trace_id: "trace-a", surface: "review" }),
        cursors: [
          { streamId: "child-a", seq: 1 },
          { streamId: "trace-a", seq: 1 },
        ],
        harnessState: [
          {
            runId: "child-a",
            parentRunId: "trace-a",
            parentEventId: "trace-start",
            laneId: "lane-1",
            status: "completed",
            lastSeq: 1,
            lastEventType: "run.completed",
          },
          {
            runId: "trace-a",
            status: "completed",
            lastSeq: 1,
            lastEventType: "run.completed",
          },
        ],
      });
    } finally {
      await service.close();
    }
  });

  test("rejects scope widening when request identity headers are required", async () => {
    const service = await startHarnessService({
      eventStore: new InMemoryEventStore(),
      requireScopeHeaders: true,
    });

    try {
      const response = await fetch(
        `${service.url}/v2/runs/run-a/trace?workspaceId=workspace-a&channelId=channel-a&surface=review&workspace_id=workspace-b`,
        { headers: { "X-Anna-Workspace-ID": "workspace-b", "X-Anna-Channel-ID": "channel-a" } },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ code: "v2_scope_mismatch" });
    } finally {
      await service.close();
    }
  });

  test("reports an explicit unavailable error when review storage is not configured", async () => {
    const service = await startHarnessService();

    try {
      const response = await fetch(
        `${service.url}/v2/channels/workspace-a/channel-a/events?streamId=run-a`,
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ code: "v2_event_store_unavailable" });
    } finally {
      await service.close();
    }
  });
});
