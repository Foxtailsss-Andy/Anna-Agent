import { createServer } from "node:http";

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
      truncated: false,
      results: [
        expect.objectContaining({
          title: "Anna",
          url: "https://example.com/anna",
          snippet: "A result.",
          fetched_at: expect.any(String),
        }),
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
  expect(request?.init?.redirect).toBe("manual");
});

test("web search rejects a provider redirect without contacting its target", async () => {
  let targetRequests = 0;
  let redirectClosed = false;
  let redirectAborted = false;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => resolve());
  });
  const targetAddress = target.address();
  if (targetAddress === null || typeof targetAddress === "string") throw new Error("target did not bind");
  const redirect = createServer((request, response) => {
    response.statusCode = 302;
    response.setHeader("location", `http://127.0.0.1:${targetAddress.port}/target`);
    response.on("close", () => { redirectClosed = true; });
    request.on("aborted", () => { redirectAborted = true; });
    response.write("redirect body must not leak");
  });
  await new Promise<void>((resolve, reject) => {
    redirect.once("error", reject);
    redirect.listen(0, "127.0.0.1", () => resolve());
  });
  const redirectAddress = redirect.address();
  if (redirectAddress === null || typeof redirectAddress === "string") throw new Error("redirect did not bind");

  try {
    const provider = createWebSearchProvider({
      endpoint: `http://127.0.0.1:${redirectAddress.port}/search`,
    });
    const result = await provider("anna", new AbortController().signal);
    expect(result).toEqual({ status: "failed", output: { reason: "web_search_redirect_rejected" } });
    expect(targetRequests).toBe(0);
    expect(JSON.stringify(result)).not.toContain("target");
    await new Promise<void>((resolvePromise) => {
      const startedWaiting = Date.now();
      const check = () => {
        if (redirectClosed || redirectAborted || Date.now() - startedWaiting >= 100) {
          resolvePromise();
          return;
        }
        setImmediate(check);
      };
      check();
    });
    expect(redirectClosed || redirectAborted).toBe(true);
  } finally {
    await Promise.all([
      new Promise<void>((resolvePromise, reject) => redirect.close((error) => error ? reject(error) : resolvePromise())),
      new Promise<void>((resolvePromise, reject) => target.close((error) => error ? reject(error) : resolvePromise())),
    ]);
  }
});

test("web search marks provider results trimmed to five", async () => {
  const provider = createWebSearchProvider({
    endpoint: "https://search.example/query",
    fetchImpl: async () => new Response(JSON.stringify({
      results: Array.from({ length: 6 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: `Snippet ${index}`,
      })),
    }), { status: 200 }),
  });

  await expect(provider("anna", new AbortController().signal)).resolves.toEqual(expect.objectContaining({
    status: "succeeded",
    output: expect.objectContaining({
      truncated: true,
      results: expect.arrayContaining([expect.objectContaining({ title: "Result 4" })]),
    }),
  }));
  const result = await provider("anna", new AbortController().signal);
  expect((result.output as { results: unknown[] }).results).toHaveLength(5);
});

test.each([
  ["empty title", { title: "", url: "https://example.com/a", snippet: "ok" }],
  ["empty URL", { title: "A", url: "", snippet: "ok" }],
  ["missing title", { url: "https://example.com/a", snippet: "ok" }],
  ["invalid URL", { title: "A", url: "not-a-url", snippet: "ok" }],
  ["missing snippet", { title: "A", url: "https://example.com/a" }],
] as const)("web search rejects %s result metadata", async (_label, item) => {
  const provider = createWebSearchProvider({
    endpoint: "https://search.example/query",
    fetchImpl: async () => new Response(JSON.stringify({ results: [item] }), { status: 200 }),
  });

  await expect(provider("anna", new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "invalid_web_search_response" },
  });
});

test("web search cancels an upstream response as soon as its bounded body is exceeded", async () => {
  let sourceEnded = false;
  let sourceClosed = false;
  let delayedClose: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(Buffer.alloc(1024 * 1024 + 1, "x")));
      delayedClose = setTimeout(() => {
        sourceEnded = true;
        controller.close();
      }, 250);
    },
    cancel() {
      if (delayedClose !== undefined) clearTimeout(delayedClose);
      sourceClosed = true;
    },
  });
  const provider = createWebSearchProvider({
    endpoint: "https://search.example/query",
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  const startedAt = Date.now();
  await expect(provider("large", new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_search_response_too_large" },
  });
  expect(Date.now() - startedAt).toBeLessThan(200);
  expect(sourceEnded).toBe(false);
  expect(sourceClosed).toBe(true);
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
