import { expect, test } from "vitest";
import { createOmpModelTransport } from "../src/omp-model-transport";

test("Host transport sends one authorized request and preserves reported usage", async () => {
  const requests: RequestInit[] = [];
  const transport = createOmpModelTransport({
    endpoint: "https://provider.invalid/v1/chat/completions", apiKey: "fixture-only", modelName: "fixture-model",
    fetchImpl: async (_url, init) => {
      requests.push(init!);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    },
  });
  const responses = [];
  for await (const item of transport({ systemPrompt: "Anna", messages: [{ role: "user", content: "task" }] }, new AbortController().signal)) responses.push(item);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(String(requests[0].body))).toMatchObject({ model: "fixture-model", stream: false });
  expect(responses[0].message).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 11, output: 7 } });
});

test("Host transport rejects provider failure without retrying", async () => {
  let calls = 0;
  const transport = createOmpModelTransport({
    endpoint: "https://provider.invalid/v1/chat/completions", apiKey: "fixture-only", modelName: "fixture-model",
    fetchImpl: async () => { calls += 1; return new Response("failed", { status: 503 }); },
  });
  await expect((async () => {
    for await (const _ of transport({ systemPrompt: "Anna", messages: [] }, new AbortController().signal)) {}
  })()).rejects.toThrow();
  expect(calls).toBe(1);
});
