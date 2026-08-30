import type { ManagedOmpWorkerOptions } from "../../../packages/omp-loop-kernel/src/worker-client";
import type { AssistantMessage, Content, ToolDefinition, Usage } from "../../../packages/omp-loop-kernel/src/protocol";

export function createOmpModelTransport(options: {
  endpoint: string; apiKey: string; modelName: string; fetchImpl?: typeof fetch;
  tools?: readonly ToolDefinition[];
}): ManagedOmpWorkerOptions["modelTransport"] {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("OMP provider endpoint must use HTTPS without embedded credentials");
  const fetchImpl = options.fetchImpl ?? fetch;
  return async function* (context, signal) {
    signal.throwIfAborted();
    const messages = [
      { role: "system", content: context.systemPrompt },
      ...context.messages.map(message => {
        if (message.role === "user") return message;
        if (message.role === "toolResult") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
        const calls = message.content.filter(block => block.type === "toolCall").map(block => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.arguments) } }));
        return { role: "assistant", content: message.content.filter(block => block.type === "text").map(block => block.text).join(""), ...(calls.length ? { tool_calls: calls } : {}) };
      }),
    ];
    const response = await fetchImpl(endpoint, {
      method: "POST", signal, redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.modelName, stream: false, messages,
        ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: "function", function: tool })) } : {}) }),
    });
    if (!response.ok) throw new Error("OMP provider request failed");
    if (!response.body) throw new Error("OMP provider returned no response body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 1024 * 1024) throw new Error("OMP provider response exceeds limit");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!Array.isArray(payload.choices) || payload.choices.length !== 1) throw new Error("OMP provider choice is invalid");
    const choice = object(payload.choices[0]);
    const message = object(choice.message);
    if (message.role !== "assistant") throw new Error("OMP provider message role is invalid");
    const content: Content[] = [];
    if (typeof message.content === "string" && message.content !== "") content.push({ type: "text", text: message.content });
    else if (message.content !== null && message.content !== undefined && message.content !== "") throw new Error("OMP provider text is invalid");
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new Error("OMP provider tool calls are invalid");
      for (const raw of message.tool_calls) {
        const call = object(raw);
        const fn = object(call.function);
        if (call.type !== "function" || typeof call.id !== "string" || typeof fn.name !== "string" || typeof fn.arguments !== "string") throw new Error("OMP provider tool call is invalid");
        const args = object(JSON.parse(fn.arguments));
        content.push({ type: "toolCall", id: call.id, name: fn.name, arguments: args as Extract<Content, {type: "toolCall"}>["arguments"] });
      }
    }
    const stopReason = choice.finish_reason === "stop" ? "stop" : choice.finish_reason === "length" ? "length" : choice.finish_reason === "tool_calls" ? "toolUse" : undefined;
    if (!stopReason || content.length === 0) throw new Error("OMP provider stop reason or content is invalid");
    let usage: Usage | undefined;
    if (payload.usage !== undefined && payload.usage !== null) {
      const reported = object(payload.usage);
      const input = tokenCount(reported.prompt_tokens);
      const output = tokenCount(reported.completion_tokens);
      usage = { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
    }
    const final: AssistantMessage = { role: "assistant", content, stopReason, ...(usage === undefined ? {} : { usage }) };
    yield { deltas: [], message: final };
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("OMP provider response object is invalid");
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("OMP provider usage is invalid");
  return value;
}
