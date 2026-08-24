import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateHarnessV2CreateRun,
  readHarnessV2CreateRun,
  listHarnessV2CreateRuns,
  readHarnessV2RunEvents,
  resumeHarnessV2Run,
  startHarnessV2Run,
  subscribeHarnessV2CreateRun,
} from "./harnessV2";

const runtime = {
  __ANNA_RUNTIME__: {
    apiBase: "http://legacy.example",
    v2ApiBase: "http://v2.example",
  },
};

vi.mock("./identity", () => ({
  getIdentity: async () => ({
    workspaceId: "workspace-test",
    userId: "user-test",
    role: "owner",
    displayName: "Test User",
    source: "local-runtime",
  }),
  identityHeaders: (identity: { workspaceId: string; userId: string }) => ({
    "X-Anna-Workspace-ID": identity.workspaceId,
    "X-Anna-User-ID": identity.userId,
  }),
}));

describe("Harness v2 Desktop API seam", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts one canonical v2 Run with channel and lineage attribution", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      return new Response(JSON.stringify({
        surface_id: "create",
        run_id: "run-create-1",
        status: "queued",
      }), { status: 202, headers: { "content-type": "application/json" } });
    }));

    await expect(startHarnessV2Run("create", {
      channelId: "channel-test",
      commandId: "command-test",
      sourceEventId: "event-test",
      goal: "Prepare a bounded draft.",
      parentRunId: "parent-run",
      parentEventId: "parent-event",
      laneId: "lane-1",
    })).resolves.toEqual({
      surface_id: "create",
      run_id: "run-create-1",
      status: "queued",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://v2.example/v2/surfaces/create/runs");
    expect(requests[0].init?.headers).toEqual({
      "X-Anna-Workspace-ID": "workspace-test",
      "X-Anna-User-ID": "user-test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      workspace_id: "workspace-test",
      channel_id: "channel-test",
      command_id: "command-test",
      source_event_id: "event-test",
      goal: "Prepare a bounded draft.",
      parent_run_id: "parent-run",
      parent_event_id: "parent-event",
      lane_id: "lane-1",
    });
  });

  it("reads only events after the supplied durable cursor", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      return new Response(JSON.stringify({ run_id: "run-1", events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(readHarnessV2RunEvents("run-1", {
      channelId: "channel-test",
      fromSeq: 7,
    })).resolves.toEqual({ run_id: "run-1", events: [] });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://v2.example/v2/runs/run-1/events?workspace_id=workspace-test&channel_id=channel-test&from_seq=7",
    );
    expect(requests[0].init?.headers).toEqual({
      "X-Anna-Workspace-ID": "workspace-test",
      "X-Anna-User-ID": "user-test",
    });
    expect(requests[0].init?.method).toBe("GET");
  });

  it("resumes a v2 Run through its explicit surface route", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        surface_id: "cowork",
        run_id: "run-cowork-1",
        status: "running",
      }), { status: 202, headers: { "content-type": "application/json" } });
    }));

    await expect(resumeHarnessV2Run("cowork", "run-cowork-1", {
      channelId: "channel-test",
    })).resolves.toEqual({
      surface_id: "cowork",
      run_id: "run-cowork-1",
      status: "running",
    });
    expect(requests[0].url).toBe(
      "http://v2.example/v2/surfaces/cowork/runs/run-cowork-1/resume",
    );
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      workspace_id: "workspace-test",
      channel_id: "channel-test",
    });
  });

  it("does not retry a v2 failure through a Legacy endpoint", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return new Response(JSON.stringify({
        detail: { code: "legacy_surface_not_migrated" },
      }), { status: 409 });
    }));

    await expect(startHarnessV2Run("hub", {
      channelId: "channel-test",
      commandId: "command-test",
      sourceEventId: "event-test",
      goal: "Open the bounded Hub surface.",
    })).rejects.toMatchObject({ status: 409 });
    expect(urls).toEqual([
      "http://v2.example/v2/surfaces/hub/runs",
    ]);
  });

  it("fails closed when the sidecar base is not configured", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __ANNA_RUNTIME__: { apiBase: "http://legacy.example" } },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("unexpected", { status: 200 });
    }));

    await expect(startHarnessV2Run("create", {
      channelId: "channel-test",
      commandId: "command-test",
      sourceEventId: "event-test",
      goal: "The sidecar must be explicit.",
    })).rejects.toThrow("Harness v2 API base is not configured");
    expect(urls).toEqual([]);
  });

  it("reads the Create projection and exposes activation as an explicit v2 boundary", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/create?")) {
        return new Response(JSON.stringify({
          runId: "run-create-1",
          status: "ready_for_review",
          activation: { status: "blocked", reason: "create_activation_not_implemented" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: "create_activation_not_implemented",
        status: "unsupported",
      }), { status: 409 });
    }));

    await expect(readHarnessV2CreateRun("run-create-1", {
      channelId: "channel-test",
    })).resolves.toMatchObject({ status: "ready_for_review" });
    await expect(activateHarnessV2CreateRun("run-create-1", {
      channelId: "channel-test",
    })).rejects.toMatchObject({ status: 409 });
    expect(requests.map((request) => request.url)).toEqual([
      "http://v2.example/v2/runs/run-create-1/create?workspace_id=workspace-test&channel_id=channel-test",
      "http://v2.example/v2/runs/run-create-1/create/activate?workspace_id=workspace-test&channel_id=channel-test",
    ]);
  });

  it("lists Create projections from the v2 sidecar without using Legacy drafts", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }));

    await expect(listHarnessV2CreateRuns({ channelId: "channel-test" })).resolves.toEqual({ runs: [] });
    expect(urls).toEqual([
      "http://v2.example/v2/create/runs?workspace_id=workspace-test&channel_id=channel-test",
    ]);
  });

  it("replays canonical events from the durable cursor and closes with the Create projection", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const urls: string[] = [];
    let eventRead = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/events?")) {
        eventRead += 1;
        const events = eventRead === 1
          ? [{ seq: 0, type: "run.started", timestamp: "2026-08-23T00:00:00.000Z" }]
          : [{
              seq: 1,
              type: "run.completed",
              timestamp: "2026-08-23T00:00:01.000Z",
              payload: { outcome: "completed" },
            }];
        return new Response(JSON.stringify({ run_id: "run-create-1", events }), { status: 200 });
      }
      return new Response(JSON.stringify({
        runId: "run-create-1",
        status: "ready_for_review",
        artifact: {
          kind: "skill",
          skill_id: "csv_to_markdown",
          path: "create-runs/run-create-1/skill/csv_to_markdown/SKILL.md",
          preview: "---\nname: CSV\nversion: 1.0.0\nallowed_tools:\nforbidden_tools:\n---\n",
          hash: "sha256:artifact",
        },
        validation: { valid: true, loaded_skill_id: "csv_to_markdown", errors: [] },
        activation: { status: "blocked", reason: "create_activation_not_implemented" },
      }), { status: 200 });
    }));

    const frames: Record<string, unknown>[] = [];
    await subscribeHarnessV2CreateRun("run-create-1", {
      channelId: "channel-test",
      fromSeq: 0,
      pollMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    expect(frames).toEqual([
      {
        type: "event",
        seq: 1,
        event: {
          type: "run.started",
          created_at: "2026-08-23T00:00:00.000Z",
        },
      },
      {
        type: "done",
        seq: 2,
        run: {
          runId: "run-create-1",
          artifacts: [{ id: "sha256:artifact", title: "csv_to_markdown", kind: "skill" }],
          plan: [],
        },
      },
    ]);
    expect(urls).toEqual([
      "http://v2.example/v2/runs/run-create-1/events?workspace_id=workspace-test&channel_id=channel-test&from_seq=-1",
      "http://v2.example/v2/runs/run-create-1/events?workspace_id=workspace-test&channel_id=channel-test&from_seq=0",
      "http://v2.example/v2/runs/run-create-1/create?workspace_id=workspace-test&channel_id=channel-test",
    ]);
  });

  it("maps a reconnect cursor back to the canonical Event Store sequence", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtime,
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/events?")) {
        return new Response(JSON.stringify({
          run_id: "run-create-1",
          events: [{ seq: 4, type: "run.failed", payload: { reason: "provider_failed" } }],
        }), { status: 200 });
      }
      throw new Error("projection must not be read for a failed Run");
    }));

    const frames: Record<string, unknown>[] = [];
    await subscribeHarnessV2CreateRun("run-create-1", {
      channelId: "channel-test",
      fromSeq: 4,
      pollMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    expect(frames).toEqual([{
      type: "error",
      seq: 5,
      run: { status: "failed", error_message: "provider_failed" },
    }]);
    expect(urls).toEqual([
      "http://v2.example/v2/runs/run-create-1/events?workspace_id=workspace-test&channel_id=channel-test&from_seq=3",
    ]);
  });
});
