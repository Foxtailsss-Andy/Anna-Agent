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
  expect(JSON.parse(String(requests[0].body))).toMatchObject({
    model: "fixture-model",
    stream: true,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  expect(responses[0].message).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 11, output: 7 } });
});

test("Host transport enables DeepSeek high thinking and preserves reasoning across tool history", async () => {
  const requests: RequestInit[] = [];
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"inspect "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"the result"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"I will check."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-todo","type":"function","function":{"name":"todo","arguments":"{\\"op\\":\\"view\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const transport = createOmpModelTransport({
    endpoint: "https://api.deepseek.com/chat/completions", apiKey: "fixture-only", modelName: "deepseek-v4-pro",
    fetchImpl: async (_url, init) => {
      requests.push(init!);
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const responses = [];
  for await (const item of transport({
    systemPrompt: "Anna",
    messages: [
      { role: "user", content: "Use the todo tool." },
      {
        role: "assistant",
        reasoningContent: "previous reasoning",
        content: [{ type: "toolCall", id: "call-previous", name: "todo", arguments: { op: "view" } }],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "call-previous", toolName: "todo", content: "[]", status: "succeeded" },
    ],
    tools: [{ name: "todo", description: "Track work", parameters: { type: "object" } }],
  }, new AbortController().signal)) responses.push(item);

  expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
    model: "deepseek-v4-pro",
    stream: true,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream_options: { include_usage: true },
  });
  const requestBody = JSON.parse(String(requests[0]?.body)) as { messages: Array<Record<string, unknown>> };
  expect(requestBody.messages[2]).toMatchObject({ reasoning_content: "previous reasoning" });
  expect(responses).toHaveLength(1);
  expect(responses[0]?.deltas).toEqual([
    { type: "reasoning", text: "inspect " },
    { type: "reasoning", text: "the result" },
    { type: "text", contentIndex: 0, text: "I will check." },
    { type: "toolCall", contentIndex: 1, id: "call-todo", name: "todo", argumentsDelta: "{\"op\":\"view\"}" },
  ]);
  expect(responses[0]?.message).toEqual({
    role: "assistant",
    reasoningContent: "inspect the result",
    content: [
      { type: "text", text: "I will check." },
      { type: "toolCall", id: "call-todo", name: "todo", arguments: { op: "view" } },
    ],
    stopReason: "toolUse",
  });
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

test("Host transport aliases dotted tools on the provider wire and restores them across turns", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-hiker","type":"function","function":{"name":"hiker__report__get_dashboard_summary","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } }),
    new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
    })),
  ];
  const tools = [
    { name: "todo", description: "Track work", parameters: { type: "object" } },
    {
      name: "hiker.report.get_dashboard_summary",
      description: "Read the Hiker dashboard.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  const transport = createOmpModelTransport({
    endpoint: "https://provider.invalid/v1/chat/completions", apiKey: "fixture-only", modelName: "fixture-model",
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift()!;
    },
  });
  const first = [];
  for await (const item of transport({
    systemPrompt: "Anna",
    messages: [{ role: "user", content: "Read the dashboard." }],
    tools,
  }, new AbortController().signal)) first.push(item);
  const second = [];
  for await (const item of transport({
    systemPrompt: "Anna",
    messages: [
      { role: "user", content: "Read the dashboard." },
      {
        role: "assistant",
        reasoningContent: "inspect the dashboard",
        content: [{ type: "toolCall", id: "call-hiker", name: "hiker.report.get_dashboard_summary", arguments: {} }],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "call-hiker", toolName: "hiker.report.get_dashboard_summary", content: "{}", status: "succeeded" },
    ],
    tools,
  }, new AbortController().signal)) second.push(item);

  const firstBody = requests[0]!;
  const firstTools = firstBody.tools as Array<{ function: { name: string } }>;
  expect(firstTools.map((tool) => tool.function.name)).toEqual(["todo", "hiker__report__get_dashboard_summary"]);
  expect(first[0]?.message.content).toEqual([{
    type: "toolCall",
    id: "call-hiker",
    name: "hiker.report.get_dashboard_summary",
    arguments: {},
  }]);
  expect(first[0]?.deltas).toEqual([{
    type: "toolCall",
    contentIndex: 0,
    id: "call-hiker",
    name: "hiker.report.get_dashboard_summary",
    argumentsDelta: "{}",
  }]);

  const secondBody = requests[1]!;
  const secondMessages = secondBody.messages as Array<Record<string, unknown>>;
  expect((secondMessages[2]?.tool_calls as Array<{ function: { name: string } }>)[0]?.function.name)
    .toBe("hiker__report__get_dashboard_summary");
  expect((secondMessages[2]?.reasoning_content)).toBe("inspect the dashboard");
  expect(second[0]?.message.content).toEqual([{ type: "text", text: "done" }]);
});
