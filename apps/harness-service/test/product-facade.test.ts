import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryEventStore } from "@anna/event-store";
import type { CanonicalEvent } from "@anna/harness-v2";
import { afterEach, describe, expect, test } from "vitest";

import {
  startProductHost,
} from "../src/product-facade";
import {
  ProductSessionStore,
  ProductTaskValidationError,
  validatedProductTask,
} from "../src/product-session";

const services: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProductTask boundary", () => {
  test("accepts the contract fields and rejects widened or credential-bearing context", () => {
    expect(validatedProductTask({
      run_id: "run-product-1",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Read the note.",
      context: { source: "home" },
      permission_mode: "readonly",
    })).toMatchObject({ surface: "chat", permission_mode: "readonly" });

    expect(() => validatedProductTask({
      run_id: "run-product-2",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Do work.",
      model_api_key: "must-not-cross-the-boundary",
    })).toThrow(ProductTaskValidationError);
    expect(() => validatedProductTask({
      run_id: "run-product-3",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Do work.",
      context: { authorization: "must-not-cross-the-boundary" },
    })).toThrow("credential-like");
  });

  test("persists a task without replacing an existing run identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-product-session-"));
    directories.push(directory);
    const store = new ProductSessionStore(join(directory, "sessions.json"));
    const task = validatedProductTask({
      run_id: "run-persisted",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Persist me.",
    });
    await store.save(task, "2026-08-31T00:00:00.000Z");
    const reopened = new ProductSessionStore(join(directory, "sessions.json"));
    await expect(reopened.get(task.run_id)).resolves.toMatchObject({ task, created_at: "2026-08-31T00:00:00.000Z" });
    await expect(reopened.save({ ...task, prompt: "Different." })).rejects.toThrow("different ProductTask");
  });
});

describe("Product Host public seams", () => {
  test("protects internal whole-task runs and returns 503 when business peer is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-product-host-"));
    directories.push(directory);
    await writeFile(join(directory, "index.html"), '<div id="root"></div>\n');
    const events = new Map<string, CanonicalEvent[]>();
    const store = new InMemoryEventStore();
    const runtime = {
      evidenceMode: "test" as const,
      surfaces: ["chat", "create", "hiker", "reimbursement", "crew"] as const,
      async start(_surface: string, input: unknown) {
        const body = input as Record<string, string>;
        const base = {
          workspaceId: body.workspace_id as CanonicalEvent["workspaceId"],
          channelId: body.channel_id as CanonicalEvent["channelId"],
          streamId: body.run_id as CanonicalEvent["streamId"],
          schemaVersion: 1,
        };
        events.set(body.run_id, [
          { ...base, id: `${body.run_id}:started`, seq: 0, type: "run.started", timestamp: "2026-08-31T00:00:00.000Z", payload: {} },
          { ...base, id: `${body.run_id}:message`, seq: 1, type: "omp.transcript.message", timestamp: "2026-08-31T00:00:01.000Z", payload: { message: { role: "assistant", content: [{ type: "text", text: "Done from Host." }] } } },
          { ...base, id: `${body.run_id}:completed`, seq: 2, type: "run.completed", timestamp: "2026-08-31T00:00:02.000Z", payload: { outcome: "completed" } },
        ] as CanonicalEvent[]);
        return { runId: body.run_id, status: "queued" };
      },
      async readEvents(_workspace: string, _channel: string, runId: string, fromSeq = -1) {
        return (events.get(runId) ?? []).filter((event) => event.seq > fromSeq);
      },
      async stop() { return { status: "cancelled" }; },
    };
    const service = await startProductHost({
      runtime,
      eventStore: store,
      staticRoot: directory,
      serviceToken: "test-service-token",
      sessionStore: new ProductSessionStore(),
    });
    services.push(service);

    const denied = await fetch(`${service.url}/_harness/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-denied",
        workspace_id: "workspace-1",
        actor_user_id: "user-1",
        surface: "chat",
        prompt: "Denied.",
      }),
    });
    expect(denied.status).toBe(401);

    const internal = await fetch(`${service.url}/_harness/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify({
        run_id: "run-internal",
        workspace_id: "workspace-1",
        actor_user_id: "user-1",
        surface: "chat",
        prompt: "Read the note.",
      }),
    });
    expect(internal.status).toBe(202);
    await expect(internal.json()).resolves.toMatchObject({ run_id: "run-internal", status: "queued" });

    const detail = await fetch(`${service.url}/_harness/runs/run-internal`, {
      headers: { "x-anna-service-token": "test-service-token" },
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { run_id: string; status: string; result?: Record<string, unknown>; events: CanonicalEvent[] };
    expect(detailBody).toMatchObject({
      run_id: "run-internal",
      status: "completed",
      result: { assistant_message: "Done from Host." },
    });
    expect(detailBody.events[0]).toMatchObject({ type: "run.started", seq: 0 });

    const eventsResponse = await fetch(`${service.url}/_harness/runs/run-internal/events?after_seq=0`, {
      headers: { "x-anna-service-token": "test-service-token", accept: "application/json" },
    });
    expect(eventsResponse.status).toBe(200);
    const eventsBody = await eventsResponse.json() as { run_id: string; events: CanonicalEvent[] };
    expect(eventsBody).toMatchObject({
      run_id: "run-internal",
    });
    expect(eventsBody.events).toHaveLength(2);
    expect(eventsBody.events[0]).toMatchObject({ seq: 1, type: "omp.transcript.message" });

    const chatSubmit = await fetch(`${service.url}/api/chat/runs/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-workspace-id": "workspace-1", "x-anna-user-id": "user-1" },
      body: JSON.stringify({ message: "Hello Host." }),
    });
    expect(chatSubmit.status).toBe(503);
  });
});
