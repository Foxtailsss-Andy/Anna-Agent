import type { ManagedOmpWorkerOptions } from "../../../packages/omp-loop-kernel/src/worker-client";
import type { AssistantMessage, Content, Message, ModelDelta, ModelContext, ToolDefinition, Usage } from "../../../packages/omp-loop-kernel/src/protocol";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REASONING_EFFORT = "high" as const;

type DeepSeekReasoningEffort = "low" | "high" | "max";

export function createOmpModelTransport(options: {
  endpoint: string;
  apiKey: string;
  modelName: string;
  fetchImpl?: typeof fetch;
  tools?: readonly ToolDefinition[];
  reasoningEffort?: DeepSeekReasoningEffort;
  thinking?: "enabled" | "disabled";
}): ManagedOmpWorkerOptions["modelTransport"] {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("OMP provider endpoint must use HTTPS without embedded credentials");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const thinking = options.thinking ?? "enabled";

  return async function* (context: ModelContext, signal: AbortSignal) {
    signal.throwIfAborted();
    const messages = context.messages.map(toDeepSeekMessage);
    const tools = context.tools ?? options.tools;
    const body = {
      model: options.modelName,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: context.systemPrompt }, ...messages],
      thinking: { type: thinking },
      reasoning_effort: reasoningEffort,
      ...(tools !== undefined && tools.length > 0 ? { tools: tools.map(toDeepSeekTool) } : {}),
    };
    const response = await fetchImpl(endpoint, {
      method: "POST",
      signal,
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("OMP provider request failed");
    if (!response.body) throw new Error("OMP provider returned no response body");

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      yield parseStreamingResponse(response.body, signal);
      return;
    }

    const payload = await readJsonResponse(response.body, signal);
    yield parseCompletionPayload(payload);
  };
}

function toDeepSeekMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "toolResult") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  const text = message.content
    .filter((block): block is Extract<Content, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  const calls = message.content
    .filter((block): block is Extract<Content, { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.arguments) },
    }));
  return {
    role: "assistant",
    // DeepSeek's tool-call path accepts an empty string but some deployments
    // reject a null assistant content even though the public schema marks it
    // nullable.
    content: text,
    ...(message.reasoningContent === undefined ? {} : { reasoning_content: message.reasoningContent }),
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
  };
}

function toDeepSeekTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

async function readJsonResponse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("OMP provider response exceeds limit");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return object(JSON.parse(text));
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  let dataLines: string[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("OMP provider response exceeds limit");
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          const event = decodeSseData(dataLines);
          dataLines = [];
          if (event === "done") return;
          if (event !== undefined) yield event;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    const event = decodeSseData(dataLines);
    if (event !== undefined && event !== "done") yield event;
  } finally {
    await reader.cancel();
  }
}

function decodeSseData(lines: readonly string[]): Record<string, unknown> | "done" | undefined {
  if (lines.length === 0) return undefined;
  const value = lines.join("\n").trim();
  if (value === "[DONE]") return "done";
  return object(JSON.parse(value));
}

async function parseStreamingResponse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<HostModelResponse> {
  const accumulator = createAccumulator();
  for await (const payload of readServerSentEvents(body, signal)) accumulatePayload(accumulator, payload);
  return finishAccumulator(accumulator);
}

function parseCompletionPayload(payload: Record<string, unknown>): HostModelResponse {
  const accumulator = createAccumulator();
  accumulatePayload(accumulator, payload);
  return finishAccumulator(accumulator);
}

interface TextBlock {
  readonly type: "text";
  text: string;
  index: number;
}

interface ToolBlock {
  readonly type: "toolCall";
  id: string;
  name: string;
  argumentsText: string;
  index: number;
  streamIndex: number;
}

interface CompletionAccumulator {
  readonly deltas: ModelDelta[];
  readonly blocks: Array<TextBlock | ToolBlock>;
  readonly toolBlocks: Map<number, ToolBlock>;
  reasoningContent: string;
  reasoningSeen: boolean;
  finishReason?: "stop" | "length" | "toolUse";
  usage?: Usage;
}

function createAccumulator(): CompletionAccumulator {
  return { deltas: [], blocks: [], toolBlocks: new Map(), reasoningContent: "", reasoningSeen: false };
}

function accumulatePayload(accumulator: CompletionAccumulator, payload: Record<string, unknown>): void {
  if (payload.error !== undefined) throw new Error("OMP provider returned an in-band error");
  if (payload.usage !== undefined && payload.usage !== null) accumulator.usage = parseUsage(payload.usage);
  if (payload.choices === undefined) return;
  if (!Array.isArray(payload.choices)) throw new Error("OMP provider choice is invalid");
  if (payload.choices.length === 0) return;
  if (payload.choices.length !== 1) throw new Error("OMP provider choice is invalid");
  const choice = object(payload.choices[0]);
  if (choice.usage !== undefined && choice.usage !== null) accumulator.usage = parseUsage(choice.usage);
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    accumulator.finishReason = parseFinishReason(choice.finish_reason);
  }
  if (choice.message !== undefined && choice.message !== null) {
    accumulateMessage(accumulator, object(choice.message));
  }
  if (choice.delta !== undefined && choice.delta !== null) {
    accumulateDelta(accumulator, object(choice.delta));
  }
}

function accumulateMessage(accumulator: CompletionAccumulator, message: Record<string, unknown>): void {
  if (message.role !== "assistant") throw new Error("OMP provider message role is invalid");
  if (typeof message.reasoning_content === "string") {
    accumulator.reasoningSeen = true;
    accumulator.reasoningContent = message.reasoning_content;
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    appendText(accumulator, message.content);
  } else if (message.content !== null && message.content !== undefined && message.content !== "") {
    throw new Error("OMP provider text is invalid");
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error("OMP provider tool calls are invalid");
    for (const rawCall of message.tool_calls) {
      const call = object(rawCall);
      const fn = object(call.function);
      if (call.type !== "function" || typeof call.id !== "string" || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        throw new Error("OMP provider tool call is invalid");
      }
      const streamIndex = typeof call.index === "number" ? call.index : accumulator.toolBlocks.size;
      appendTool(accumulator, streamIndex, call.id, fn.name, fn.arguments);
    }
  }
}

function accumulateDelta(accumulator: CompletionAccumulator, delta: Record<string, unknown>): void {
  const reasoning = firstString(delta, ["reasoning_content", "reasoning", "reasoning_text"]);
  if (reasoning !== undefined) {
    accumulator.reasoningSeen = true;
    accumulator.reasoningContent += reasoning;
    if (reasoning.length > 0) accumulator.deltas.push({ type: "reasoning", text: reasoning });
  }
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string") throw new Error("OMP provider text delta is invalid");
    if (delta.content.length > 0) appendText(accumulator, delta.content);
  }
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) throw new Error("OMP provider tool calls are invalid");
    for (const [offset, rawCall] of delta.tool_calls.entries()) {
      const call = object(rawCall);
      const streamIndex = typeof call.index === "number" && Number.isSafeInteger(call.index) && call.index >= 0
        ? call.index
        : offset;
      if (streamIndex === undefined) throw new Error("OMP provider tool call index is invalid");
      const fn = call.function === undefined || call.function === null ? {} : object(call.function);
      const id = call.id === undefined || call.id === null ? undefined : string(call.id, "OMP provider tool call id");
      const name = fn.name === undefined || fn.name === null ? undefined : string(fn.name, "OMP provider tool name");
      const argumentsDelta = fn.arguments === undefined || fn.arguments === null ? "" : string(fn.arguments, "OMP provider tool arguments");
      const existing = accumulator.toolBlocks.get(streamIndex);
      if (existing === undefined) {
        if (id === undefined || name === undefined) throw new Error("OMP provider tool call identity is incomplete");
        appendTool(accumulator, streamIndex, id, name, argumentsDelta);
      } else {
        if (id !== undefined && id !== existing.id) throw new Error("OMP provider tool call identity changed");
        if (name !== undefined && name !== existing.name) throw new Error("OMP provider tool name changed");
        if (argumentsDelta.length > 0) {
          existing.argumentsText += argumentsDelta;
          accumulator.deltas.push({
            type: "toolCall",
            contentIndex: existing.index,
            id: existing.id,
            name: existing.name,
            argumentsDelta,
          });
        }
      }
    }
  }
}

function appendText(accumulator: CompletionAccumulator, text: string): void {
  const previous = accumulator.blocks.at(-1);
  if (previous?.type === "text") {
    previous.text += text;
    accumulator.deltas.push({ type: "text", contentIndex: previous.index, text });
    return;
  }
  const index = accumulator.blocks.length;
  const block: TextBlock = { type: "text", text, index };
  accumulator.blocks.push(block);
  accumulator.deltas.push({ type: "text", contentIndex: index, text });
}

function appendTool(accumulator: CompletionAccumulator, streamIndex: number, id: string, name: string, argumentsText: string): void {
  const existing = accumulator.toolBlocks.get(streamIndex);
  if (existing !== undefined) {
    if (existing.id !== id || existing.name !== name) throw new Error("OMP provider tool call identity changed");
    existing.argumentsText += argumentsText;
    if (argumentsText.length > 0) {
      accumulator.deltas.push({ type: "toolCall", contentIndex: existing.index, id, name, argumentsDelta: argumentsText });
    }
    return;
  }
  const index = accumulator.blocks.length;
  const block: ToolBlock = { type: "toolCall", id, name, argumentsText, index, streamIndex };
  accumulator.blocks.push(block);
  accumulator.toolBlocks.set(streamIndex, block);
  accumulator.deltas.push({ type: "toolCall", contentIndex: index, id, name, argumentsDelta: argumentsText });
}

function finishAccumulator(accumulator: CompletionAccumulator): HostModelResponse {
  if (accumulator.finishReason === undefined) throw new Error("OMP provider stop reason is invalid");
  const content: Content[] = accumulator.blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(block.argumentsText);
    } catch {
      throw new Error("OMP provider tool arguments are invalid JSON");
    }
    return { type: "toolCall", id: block.id, name: block.name, arguments: jsonObject(argumentsValue) };
  });
  if (content.length === 0) throw new Error("OMP provider returned no assistant content");
  return {
    deltas: accumulator.deltas,
    message: {
      role: "assistant",
      content,
      stopReason: accumulator.finishReason,
      ...(accumulator.reasoningSeen ? { reasoningContent: accumulator.reasoningContent } : {}),
      ...(accumulator.usage === undefined ? {} : { usage: accumulator.usage }),
    },
  };
}

function parseFinishReason(value: unknown): "stop" | "length" | "toolUse" {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "tool_calls") return "toolUse";
  throw new Error("OMP provider finish reason is invalid");
}

function parseUsage(value: unknown): Usage {
  const reported = object(value);
  const input = tokenCount(reported.prompt_tokens);
  const output = tokenCount(reported.completion_tokens);
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    if (typeof record[field] === "string") return record[field] as string;
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("OMP provider response object is invalid");
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown): { readonly [key: string]: import("../../../packages/omp-loop-kernel/src/protocol").JsonValue } {
  const record = object(value);
  assertJsonValue(record);
  return record as { readonly [key: string]: import("../../../packages/omp-loop-kernel/src/protocol").JsonValue };
}

function assertJsonValue(value: unknown): asserts value is import("../../../packages/omp-loop-kernel/src/protocol").JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error("OMP provider JSON number is invalid");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) assertJsonValue(item);
    return;
  }
  throw new Error("OMP provider JSON value is invalid");
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  return value;
}

function tokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("OMP provider usage is invalid");
  return value;
}

interface HostModelResponse {
  readonly deltas: readonly ModelDelta[];
  readonly message: AssistantMessage;
}
