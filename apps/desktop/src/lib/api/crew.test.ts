import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmChannelCommand } from "./crew";

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

function captureFetch() {
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ id: "proj_1", tasks: [] }), { status: 200 });
  }));
  return requests;
}

describe("confirmChannelCommand · Coordination Proposal confirm body (CONTRACTS §2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends chosen draft and assignment indexes to the owner confirm endpoint", async () => {
    const requests = captureFetch();
    await confirmChannelCommand("proj_1", "msg_9", [0, 2], [1]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/\/api\/crew\/projects\/proj_1\/channel\/command\/confirm$/);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toEqual({ message_id: "msg_9", draft_indexes: [0, 2], assignment_indexes: [1] });
  });

  it("an explicitly empty draft selection is sent (assignments-only adoption)", async () => {
    const requests = captureFetch();
    await confirmChannelCommand("proj_1", "msg_9", [], [0]);
    expect(requests[0].body).toEqual({ message_id: "msg_9", draft_indexes: [], assignment_indexes: [0] });
  });

  it("legacy callers (drafts only / nothing) keep today's body", async () => {
    const requests = captureFetch();
    await confirmChannelCommand("proj_1", "msg_1", [1]);
    await confirmChannelCommand("proj_1", "msg_2");
    expect(requests[0].body).toEqual({ message_id: "msg_1", draft_indexes: [1] });
    expect(requests[1].body).toEqual({ message_id: "msg_2" });
  });
});
