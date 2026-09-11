import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkbenchSession,
  getWorkbenchRun,
  getWorkbenchRunEvents,
  submitWorkbenchRun,
  stopWorkbenchRun,
} from "./workbench";

vi.mock("./identity", () => ({
  getIdentity: async () => ({
    workspaceId: "workspace-test",
    userId: "user-test",
    role: "owner",
    displayName: "Test User",
    source: "local-runtime",
  }),
  identityHeaders: () => ({
    "X-Anna-Workspace-ID": "workspace-test",
    "X-Anna-User-ID": "user-test",
  }),
  getToken: () => "token-test",
}));

describe("Workbench Desktop API seam", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a session, submits a plain chat Run, reads projection/events, and stops only that Run", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/workbench/sessions")) {
        return new Response(JSON.stringify({ session_id: "session-1", surface: "chat" }), { status: 201 });
      }
      if (url.endsWith("/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run-1", session_id: "session-1", status: "queued" }), { status: 202 });
      }
      if (url.endsWith("/api/workbench/runs/run-1/events?after_seq=4")) {
        return new Response(JSON.stringify({ run_id: "run-1", events: [] }), { status: 200 });
      }
      if (url.endsWith("/api/workbench/runs/run-1/stop") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run-1", status: "cancelled" }), { status: 202 });
      }
      if (url.endsWith("/api/workbench/runs/run-1")) {
        return new Response(JSON.stringify({ run_id: "run-1", status: "completed", messages: [] }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }));

    await expect(createWorkbenchSession({ surface: "chat" })).resolves.toMatchObject({ session_id: "session-1" });
    await expect(submitWorkbenchRun("session-1", {
      prompt: "回答一个普通问题",
      sourceEventId: "desktop:workbench:source-1",
    })).resolves.toMatchObject({ run_id: "run-1" });
    await expect(getWorkbenchRun("run-1")).resolves.toMatchObject({ status: "completed" });
    await expect(getWorkbenchRunEvents("run-1", 4)).resolves.toEqual({ run_id: "run-1", events: [] });
    await expect(stopWorkbenchRun("run-1")).resolves.toMatchObject({ status: "cancelled" });

    expect(requests.map((request) => request.url)).toEqual([
      "/api/workbench/sessions",
      "/api/workbench/sessions/session-1/runs",
      "/api/workbench/runs/run-1",
      "/api/workbench/runs/run-1/events?after_seq=4",
      "/api/workbench/runs/run-1/stop",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      prompt: "回答一个普通问题",
      source_event_id: "desktop:workbench:source-1",
      resource_refs: [],
    });
    expect(requests[4]?.init?.method).toBe("POST");
    expect(requests[4]?.init?.headers).toBeInstanceOf(Headers);
  });
});
