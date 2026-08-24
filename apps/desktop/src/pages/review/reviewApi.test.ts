import { afterEach, describe, expect, it, vi } from "vitest";

import { getChannelEvents, getRunTraceCursor } from "./reviewApi";

describe("Review Channel Inspector v2 API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the explicit v2 base and binds Channel scope to request headers", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __ANNA_RUNTIME__: {
          apiBase: "http://legacy.example",
          v2ApiBase: "http://v2.example",
        },
      },
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        events: [],
        nextCursor: { streamId: "run/a", seq: -1 },
      }), { status: 200 });
    }));

    await expect(getChannelEvents("workspace/a", "channel/a", "run/a")).resolves.toEqual({
      events: [],
      nextCursor: { streamId: "run/a", seq: -1 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://v2.example/v2/channels/workspace%2Fa/channel%2Fa/events?streamId=run%2Fa",
    );
    expect(requests[0]?.init?.headers).toEqual({
      "X-Anna-Workspace-ID": "workspace/a",
      "X-Anna-Channel-ID": "channel/a",
    });
    expect(requests[0]?.url).not.toContain("legacy.example");
  });

  it("reads the scoped Run Trace cursor through v2 only", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __ANNA_RUNTIME__: { v2ApiBase: "http://v2.example" } },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ document: {}, cursors: [] }), { status: 200 });
    }));

    await getRunTraceCursor("run/a", "workspace-a", "channel-a");

    expect(urls).toEqual([
      "http://v2.example/v2/runs/run%2Fa/trace?workspaceId=workspace-a&channelId=channel-a&surface=review",
    ]);
  });

  it("does not fall back to the Legacy base when v2 is not configured", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __ANNA_RUNTIME__: { apiBase: "http://legacy.example" } },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ events: [], nextCursor: { streamId: "run", seq: -1 } }), {
        status: 404,
      });
    }));

    await expect(getChannelEvents("workspace", "channel", "run")).rejects.toThrow("Harness v2 API 404");
    expect(urls).toEqual(["/v2/channels/workspace/channel/events?streamId=run"]);
    expect(urls[0]).not.toContain("legacy.example");
  });
});
