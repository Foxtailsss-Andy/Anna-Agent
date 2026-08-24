import { expect, test } from "vitest";

import { createLiveProfile, createWebSearchProvider, probeReviewGate } from "../src/production";

test("exposes WebSearch in the live Create profile only when configured", async () => {
  const withoutProvider = await createLiveProfile("test-model", undefined, false, "create");
  expect(withoutProvider.allowedTools).not.toContain("web_search");

  const withProvider = await createLiveProfile("test-model", undefined, true, "create");
  expect(withProvider.allowedTools).toContain("web_search");
});

test("web search provider sends a bounded query and normalizes results", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const provider = createWebSearchProvider({
    endpoint: "https://search.example/query",
    apiKey: "search-secret",
    fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({
        results: [
          { title: "Anna", url: "https://example.com/anna", snippet: "A result." },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await expect(provider(" durable runs ", new AbortController().signal)).resolves.toEqual({
    status: "succeeded",
    output: {
      query: "durable runs",
      results: [
        { title: "Anna", url: "https://example.com/anna", snippet: "A result." },
      ],
    },
  });
  expect(request?.url).toBe("https://search.example/query");
  expect(request?.init?.headers).toMatchObject({
    authorization: "Bearer search-secret",
    "content-type": "application/json",
  });
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    query: "durable runs",
    max_results: 5,
  });
});

test("web search provider reports upstream failure without exposing response content", async () => {
  const provider = createWebSearchProvider({
    endpoint: "https://search.example/query",
    fetchImpl: async () => new Response("provider secret", { status: 503 }),
  });

  await expect(provider("anna", new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_search_provider_failed" },
  });
});

test("review gate probe requires a ready status owned by the configured actor", async () => {
  const responses = [
    new Response(JSON.stringify({
      status: "ready",
      owner_id: "owner-1",
      decision_endpoint: "ready",
      durability: "durable",
    }), { status: 200 }),
    new Response(JSON.stringify({
      status: "ready",
      owner_id: "owner-2",
      decision_endpoint: "ready",
      durability: "durable",
    }), { status: 200 }),
  ];
  const fetchImpl = async () => responses.shift() ?? new Response(null, { status: 503 });

  await expect(probeReviewGate("http://owner.example", "owner-1", fetchImpl)).resolves.toBe(true);
  await expect(probeReviewGate("http://owner.example", "owner-1", fetchImpl)).resolves.toBe(false);
  await expect(probeReviewGate(undefined, "owner-1", fetchImpl)).resolves.toBe(false);
});
