import { expect, test } from "vitest";

import { InMemoryEventStore, projectNext } from "../src/index";
import type { CanonicalEvent, ChannelScope } from "@anna/harness-v2";

const scope = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
} as ChannelScope;

const event = {
  id: "event-1",
  workspaceId: scope.workspaceId,
  channelId: scope.channelId,
  streamId: "run-1",
  seq: 0,
  type: "run.started",
  timestamp: "2026-08-18T00:00:00.000Z",
  schemaVersion: 1,
  payload: {},
} as CanonicalEvent;

test("does not commit projection state or a receipt when its reducer throws", async () => {
  const store = new InMemoryEventStore().scope(scope);
  await store.append(event);

  await expect(
    projectNext(store, "run-view", event.streamId, 0, () => {
      throw new Error("reducer failed");
    }),
  ).rejects.toThrow("reducer failed");

  await expect(store.loadProjection("run-view", event.streamId)).resolves.toBeUndefined();
});

test("retries the same source event after a reducer failure", async () => {
  const store = new InMemoryEventStore().scope(scope);
  await store.append(event);

  await expect(
    projectNext(store, "run-view", event.streamId, 0, () => {
      throw new Error("reducer failed");
    }),
  ).rejects.toThrow("reducer failed");

  await expect(
    projectNext(store, "run-view", event.streamId, 0 as number, (state) => state + 1),
  ).resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
});

test("parses and clones projection state at its persistence boundary", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const state = { phase: "original" };

  await store.append(event);
  await store.commitProjection({
    projector: "run-view",
    streamId: event.streamId,
    eventId: event.id,
    eventSeq: event.seq,
    expectedVersion: 0,
    state,
  });
  state.phase = "caller-mutated";

  const loaded = await store.loadProjection("run-view", event.streamId);
  expect(loaded?.state).toEqual({ phase: "original" });
  (loaded?.state as { phase: string }).phase = "reader-mutated";

  await expect(store.loadProjection("run-view", event.streamId)).resolves.toEqual({
    state: { phase: "original" },
    version: 1,
    lastSeq: 0,
  });
});

test("rejects a projection receipt for a missing source event", async () => {
  const store = new InMemoryEventStore().scope(scope);

  await expect(
    store.commitProjection({
      projector: "run-view",
      streamId: event.streamId,
      eventId: event.id,
      eventSeq: event.seq,
      expectedVersion: 0,
      state: 1,
    }),
  ).rejects.toMatchObject({ name: "ProjectionSourceEventNotFoundError" });
});

test("projects only the next event after its persisted sequence", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const nextEvent = { ...event, id: "event-2", seq: 1 } as CanonicalEvent;
  const reduced: string[] = [];

  await store.append(event);
  await store.append(nextEvent);

  await expect(
    projectNext(store, "run-view", event.streamId, 0 as number, (state, sourceEvent) => {
      reduced.push(sourceEvent.id);
      return state + 1;
    }),
  ).resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
  await expect(
    projectNext(store, "run-view", event.streamId, 0 as number, (state, sourceEvent) => {
      reduced.push(sourceEvent.id);
      return state + 1;
    }),
  ).resolves.toEqual({ applied: true, state: 2, version: 2, lastSeq: 1 });
  await expect(
    projectNext(store, "run-view", event.streamId, 0 as number, (state, sourceEvent) => {
      reduced.push(sourceEvent.id);
      return state + 1;
    }),
  ).resolves.toBeUndefined();

  expect(reduced).toEqual([event.id, nextEvent.id]);
});

test("fences stale projection commits and keeps one receipt per event", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const nextEvent = { ...event, id: "event-2", seq: 1 } as CanonicalEvent;

  await store.append(event);
  await store.append(nextEvent);

  await expect(
    store.commitProjection({
      projector: "run-view",
      streamId: event.streamId,
      eventId: event.id,
      eventSeq: event.seq,
      expectedVersion: 0,
      state: 1,
    }),
  ).resolves.toEqual({ applied: true, state: 1, version: 1, lastSeq: 0 });
  await expect(
    store.commitProjection({
      projector: "run-view",
      streamId: event.streamId,
      eventId: event.id,
      eventSeq: event.seq,
      expectedVersion: 1,
      state: 2,
    }),
  ).resolves.toEqual({ applied: false, state: 1, version: 1, lastSeq: 0 });
  await expect(
    store.commitProjection({
      projector: "run-view",
      streamId: nextEvent.streamId,
      eventId: nextEvent.id,
      eventSeq: nextEvent.seq,
      expectedVersion: 0,
      state: 2,
    }),
  ).rejects.toMatchObject({ name: "ProjectionVersionConflictError" });
});

test("returns the current projection state for an already acknowledged receipt", async () => {
  const store = new InMemoryEventStore().scope(scope);
  const nextEvent = { ...event, id: "event-2", seq: 1 } as CanonicalEvent;

  await store.append(event);
  await store.append(nextEvent);
  await store.commitProjection({
    projector: "run-view",
    streamId: event.streamId,
    eventId: event.id,
    eventSeq: event.seq,
    expectedVersion: 0,
    state: 1,
  });
  await store.commitProjection({
    projector: "run-view",
    streamId: nextEvent.streamId,
    eventId: nextEvent.id,
    eventSeq: nextEvent.seq,
    expectedVersion: 1,
    state: 2,
  });

  await expect(
    store.commitProjection({
      projector: "run-view",
      streamId: event.streamId,
      eventId: event.id,
      eventSeq: event.seq,
      expectedVersion: 0,
      state: 1,
    }),
  ).resolves.toEqual({ applied: false, state: 2, version: 2, lastSeq: 1 });
});
