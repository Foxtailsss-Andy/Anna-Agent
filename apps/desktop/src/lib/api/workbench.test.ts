import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./client";
import { getRunTrace, getWorkbenchRunTrace } from "./trace";
import {
  completeWorkbenchGoal,
  createWorkbenchGoal,
  createWorkbenchSession,
  getWorkbenchRun,
  getWorkbenchRunEvents,
  pauseWorkbenchGoal,
  resumeWorkbenchGoal,
  steerWorkbenchRun,
  stopWorkbenchGoal,
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

  it("submits the requested permission mode with the Run and omits it when not chosen", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ run_id: "run-1", session_id: "session-1", status: "queued" }), { status: 202 });
    }));

    await submitWorkbenchRun("session-1", {
      prompt: "整理工作目录",
      sourceEventId: "source-1",
      resourceRefs: ["workdir:wd-1"],
      permissionMode: "contained-write",
    });
    await submitWorkbenchRun("session-1", { prompt: "普通问题", sourceEventId: "source-2" });

    expect(bodies[0]).toMatchObject({ resource_refs: ["workdir:wd-1"], permission_mode: "contained-write" });
    expect(bodies[1]).not.toHaveProperty("permission_mode");
  });

  it("steers a running Run and reports whether the Host accepted the text", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ run_id: "run/1", status: "running", accepted: true }), { status: 202 });
    }));

    await expect(steerWorkbenchRun("run/1", "只看 2026 年的数据")).resolves.toEqual({
      run_id: "run/1",
      status: "running",
      accepted: true,
    });
    expect(requests[0]?.url).toBe("/api/workbench/runs/run%2F1/steer");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ text: "只看 2026 年的数据" });
  });

  it("surfaces the Host signal-unavailable conflict as an ApiError carrying the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "harness_signal_unavailable" }), { status: 409 })));

    const failure = await steerWorkbenchRun("run-1", "补充").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect(String(failure)).toContain("harness_signal_unavailable");
  });

  it("creates a session Goal with budget/permission and drives pause, resume, stop and complete", async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const goal = {
      goal_id: "goal-1",
      objective: "写完调研报告",
      status: "active",
      max_runs: 3,
      runs_used: 1,
      run_ids: ["run-1"],
      permission_mode: "contained-write",
      created_at: "2026-10-08T00:00:00.000Z",
      updated_at: "2026-10-08T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url.endsWith("/goal")) return new Response(JSON.stringify({ goal, run_id: "run-1" }), { status: 201 });
      if (url.endsWith("/goal/resume")) return new Response(JSON.stringify({ goal: { ...goal, run_ids: ["run-1", "run-2"] }, run_id: "run-2" }), { status: 200 });
      if (url.endsWith("/goal/pause")) return new Response(JSON.stringify({ goal: { ...goal, status: "paused" } }), { status: 200 });
      if (url.endsWith("/goal/stop")) return new Response(JSON.stringify({ goal: { ...goal, status: "stopped" } }), { status: 200 });
      if (url.endsWith("/goal/complete")) return new Response(JSON.stringify({ goal: { ...goal, status: "completed" } }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    }));

    await expect(createWorkbenchGoal("session 1", {
      objective: "写完调研报告",
      sourceEventId: "desktop:goal:1",
      maxRuns: 3,
      permissionMode: "contained-write",
      resourceRefs: ["workdir:wd-1"],
    })).resolves.toMatchObject({ run_id: "run-1", goal: { goal_id: "goal-1", max_runs: 3 } });
    await expect(pauseWorkbenchGoal("session 1")).resolves.toMatchObject({ goal: { status: "paused" } });
    await expect(resumeWorkbenchGoal("session 1")).resolves.toMatchObject({ run_id: "run-2" });
    await expect(stopWorkbenchGoal("session 1")).resolves.toMatchObject({ goal: { status: "stopped" } });
    await expect(completeWorkbenchGoal("session 1")).resolves.toMatchObject({ goal: { status: "completed" } });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST /api/workbench/sessions/session%201/goal",
      "POST /api/workbench/sessions/session%201/goal/pause",
      "POST /api/workbench/sessions/session%201/goal/resume",
      "POST /api/workbench/sessions/session%201/goal/stop",
      "POST /api/workbench/sessions/session%201/goal/complete",
    ]);
    expect(requests[0]?.body).toEqual({
      objective: "写完调研报告",
      source_event_id: "desktop:goal:1",
      max_runs: 3,
      permission_mode: "contained-write",
      resource_refs: ["workdir:wd-1"],
    });
    expect(requests.slice(1).map((request) => request.body)).toEqual([{}, {}, {}, {}]);
  });

  it("reads a Workbench Run trace from the Workbench route while the chat trace keeps its legacy route", async () => {
    const urls: string[] = [];
    const trace = { trace_id: "run-1", surface: "chat", spans: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(trace), { status: 200 });
    }));

    await expect(getWorkbenchRunTrace("run/1")).resolves.toEqual(trace);
    await expect(getRunTrace("chat-run-1")).resolves.toEqual(trace);

    expect(urls).toEqual([
      "/api/workbench/runs/run%2F1/trace",
      "/api/chat/runs/chat-run-1/trace",
    ]);
  });
});
