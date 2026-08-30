export const OMP_PROTOCOL = "anna-omp/1" as const;
export const MAX_FRAME_BYTES = 1024 * 1024;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkerBinding {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly profileHash: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: { readonly [key: string]: JsonValue };
}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: { readonly [key: string]: JsonValue } };

export interface Usage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly Content[];
  readonly stopReason: "stop" | "length" | "toolUse";
  readonly usage?: Usage;
}

export type Message =
  | { readonly role: "user"; readonly content: string }
  | AssistantMessage
  | {
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly status: "succeeded" | "failed" | "unknown";
    };

export interface ModelContext {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
}

export type ModelDelta =
  | { readonly type: "text"; readonly contentIndex: number; readonly text: string }
  | {
      readonly type: "toolCall";
      readonly contentIndex: number;
      readonly id: string;
      readonly name: string;
      readonly argumentsDelta: string;
    };

export type Observation =
  | { readonly type: "message_end"; readonly message: Message }
  | { readonly type: "turn_end"; readonly modelRequestId: string }
  | { readonly type: "progress"; readonly phase: "started" | "tool_started" | "tool_finished" };

export interface StartInput {
  readonly systemPrompt: string;
  readonly goal: string;
  readonly modelId: string;
  readonly allowedTools: readonly ToolDefinition[];
  readonly snapshotDigest: string;
  readonly originalExecutionFingerprint: JsonValue;
}

interface FrameBase {
  readonly protocol: typeof OMP_PROTOCOL;
  readonly kind: string;
  readonly frameId: string;
  readonly requestId: string;
  readonly binding: WorkerBinding;
  readonly workerSeq: number;
}

export type WorkerFrame =
  | (FrameBase & {
      readonly kind: "ready";
      readonly workerSeq: 0;
      readonly runtime: { readonly bunVersion: string; readonly ompVersion: string; readonly activeTools: readonly string[] };
    })
  | (FrameBase & { readonly kind: "event"; readonly event: Observation })
  | (FrameBase & { readonly kind: "model.request"; readonly modelId: string; readonly context: ModelContext })
  | (FrameBase & { readonly kind: "tool.request"; readonly toolCallId: string; readonly name: string; readonly input: { readonly [key: string]: JsonValue } })
  | (FrameBase & { readonly kind: "terminal.proposed"; readonly outcome: "completed" | "failed" | "timed_out" | "cancelled" });

export type HostFrame =
  | (FrameBase & { readonly kind: "start"; readonly workerSeq: -1; readonly input: StartInput })
  | (FrameBase & { readonly kind: "receipt"; readonly forFrameId: string; readonly accepted: true; readonly throughWorkerSeq: number })
  | (FrameBase & { readonly kind: "model.delta"; readonly index: number; readonly delta: ModelDelta })
  | (FrameBase & { readonly kind: "model.end"; readonly index: number; readonly message: AssistantMessage })
  | (FrameBase & { readonly kind: "model.error"; readonly index: number; readonly code: "transport_failed" | "budget_exhausted" | "cancelled" | "protocol_failed" })
  | (FrameBase & { readonly kind: "tool.result"; readonly toolCallId: string; readonly status: "succeeded" | "failed" | "unknown"; readonly output?: JsonValue })
  | (FrameBase & { readonly kind: "abort"; readonly reason: "cancelled" | "timed_out" | "protocol_failed" | "shutdown" });

export type OmpFrame = WorkerFrame | HostFrame;

const BASE_KEYS = ["protocol", "kind", "frameId", "requestId", "binding", "workerSeq"] as const;

export function encodeFrame(frame: OmpFrame): string {
  const line = JSON.stringify(frame) + "\n";
  if (byteLength(line) > MAX_FRAME_BYTES) throw new Error("OMP frame exceeds 1 MiB");
  return line;
}

export function parseHostFrame(value: unknown): HostFrame {
  const record = parseBase(value);
  switch (record.kind) {
    case "start":
      assertKeys(record, [...BASE_KEYS, "input"]);
      assertWorkerSeq(record.workerSeq, -1, true);
      return { ...record, kind: "start", workerSeq: -1, input: parseStartInput(record.input) } as HostFrame;
    case "receipt":
      assertKeys(record, [...BASE_KEYS, "forFrameId", "accepted", "throughWorkerSeq"]);
      assertIdentifier(record.forFrameId, "forFrameId");
      if (record.accepted !== true) throw new Error("receipt must be accepted");
      assertSafeNonnegativeInteger(record.throughWorkerSeq, "throughWorkerSeq");
      assertWorkerSeq(record.workerSeq);
      return { ...record, kind: "receipt", forFrameId: record.forFrameId, accepted: true, throughWorkerSeq: record.throughWorkerSeq } as HostFrame;
    case "model.delta":
      assertKeys(record, [...BASE_KEYS, "index", "delta"]);
      assertSafeNonnegativeInteger(record.index, "model delta index");
      assertWorkerSeq(record.workerSeq);
      return { ...record, kind: "model.delta", index: record.index, delta: parseDelta(record.delta) } as HostFrame;
    case "model.end":
      assertKeys(record, [...BASE_KEYS, "index", "message"]);
      assertSafeNonnegativeInteger(record.index, "model end index");
      assertWorkerSeq(record.workerSeq);
      const message = parseAssistant(record.message);
      return { ...record, kind: "model.end", index: record.index, message } as HostFrame;
    case "model.error":
      assertKeys(record, [...BASE_KEYS, "index", "code"]);
      assertSafeNonnegativeInteger(record.index, "model error index");
      assertWorkerSeq(record.workerSeq);
      assertEnum(record.code, ["transport_failed", "budget_exhausted", "cancelled", "protocol_failed"], "model error code");
      return { ...record, kind: "model.error", index: record.index, code: record.code } as HostFrame;
    case "tool.result":
      assertKeys(record, [...BASE_KEYS, "toolCallId", "status", ...(Object.hasOwn(record, "output") ? ["output"] : [])]);
      assertIdentifier(record.toolCallId, "toolCallId");
      assertEnum(record.status, ["succeeded", "failed", "unknown"], "tool result status");
      assertWorkerSeq(record.workerSeq);
      if (Object.hasOwn(record, "output")) assertJsonValue(record.output);
      return { ...record, kind: "tool.result", toolCallId: record.toolCallId, status: record.status, ...(Object.hasOwn(record, "output") ? { output: record.output } : {}) } as HostFrame;
    case "abort":
      assertKeys(record, [...BASE_KEYS, "reason"]);
      assertEnum(record.reason, ["cancelled", "timed_out", "protocol_failed", "shutdown"], "abort reason");
      assertWorkerSeq(record.workerSeq, undefined, true);
      return { ...record, kind: "abort", reason: record.reason } as HostFrame;
    default:
      throw new Error(`unsupported Host frame kind: ${record.kind}`);
  }
}

export function parseWorkerFrame(value: unknown): WorkerFrame {
  const record = parseBase(value);
  switch (record.kind) {
    case "ready":
      assertKeys(record, [...BASE_KEYS, "runtime"]);
      assertWorkerSeq(record.workerSeq, 0);
      const runtime = asRecord(record.runtime);
      assertKeys(runtime, ["bunVersion", "ompVersion", "activeTools"]);
      assertString(runtime.bunVersion, "Bun version");
      assertString(runtime.ompVersion, "OMP version");
      const activeTools = parseStringArray(runtime.activeTools, "active tools");
      return { ...record, kind: "ready", workerSeq: 0, runtime: { bunVersion: runtime.bunVersion, ompVersion: runtime.ompVersion, activeTools } } as unknown as WorkerFrame;
    case "event":
      assertKeys(record, [...BASE_KEYS, "event"]);
      assertWorkerSeq(record.workerSeq);
      return { ...record, kind: "event", event: parseObservation(record.event) } as WorkerFrame;
    case "model.request":
      assertKeys(record, [...BASE_KEYS, "modelId", "context"]);
      assertWorkerSeq(record.workerSeq);
      assertIdentifier(record.modelId, "modelId");
      return { ...record, kind: "model.request", modelId: record.modelId, context: parseContext(record.context) } as WorkerFrame;
    case "tool.request":
      assertKeys(record, [...BASE_KEYS, "toolCallId", "name", "input"]);
      assertWorkerSeq(record.workerSeq);
      assertIdentifier(record.toolCallId, "toolCallId");
      assertIdentifier(record.name, "tool name");
      const input = parseObject(record.input, "tool input");
      return { ...record, kind: "tool.request", toolCallId: record.toolCallId, name: record.name, input } as WorkerFrame;
    case "terminal.proposed":
      assertKeys(record, [...BASE_KEYS, "outcome"]);
      assertWorkerSeq(record.workerSeq);
      assertEnum(record.outcome, ["completed", "failed", "timed_out", "cancelled"], "terminal outcome");
      return { ...record, kind: "terminal.proposed", outcome: record.outcome } as WorkerFrame;
    default:
      throw new Error(`unsupported worker frame kind: ${record.kind}`);
  }
}

export function parseLine(line: string, side: "host" | "worker"): HostFrame | WorkerFrame {
  if (byteLength(line) > MAX_FRAME_BYTES) throw new Error("OMP frame exceeds 1 MiB");
  const value: unknown = JSON.parse(line);
  return side === "host" ? parseHostFrame(value) : parseWorkerFrame(value);
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseBase(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  assertString(record.protocol, "protocol");
  if (record.protocol !== OMP_PROTOCOL) throw new Error("unsupported OMP protocol");
  assertString(record.kind, "frame kind");
  assertIdentifier(record.frameId, "frameId");
  assertIdentifier(record.requestId, "requestId");
  parseBinding(record.binding);
  if (typeof record.workerSeq !== "number" || !Number.isSafeInteger(record.workerSeq)) throw new Error("workerSeq must be a safe integer");
  return record;
}

function parseBinding(value: unknown): WorkerBinding {
  const record = asRecord(value);
  assertKeys(record, ["workspaceId", "channelId", "runId", "attemptId", "commandId", "profileHash"]);
  for (const key of ["workspaceId", "channelId", "runId", "attemptId", "commandId", "profileHash"] as const) assertIdentifier(record[key], key);
  return record as unknown as WorkerBinding;
}

function parseStartInput(value: unknown): StartInput {
  const record = asRecord(value);
  assertKeys(record, ["systemPrompt", "goal", "modelId", "allowedTools", "snapshotDigest", "originalExecutionFingerprint"]);
  assertString(record.systemPrompt, "system prompt");
  assertString(record.goal, "goal");
  assertIdentifier(record.modelId, "modelId");
  assertIdentifier(record.snapshotDigest, "snapshotDigest");
  assertJsonValue(record.originalExecutionFingerprint);
  if (!Array.isArray(record.allowedTools)) throw new Error("allowedTools must be an array");
  const allowedTools = record.allowedTools.map(parseToolDefinition);
  return { systemPrompt: record.systemPrompt, goal: record.goal, modelId: record.modelId, allowedTools, snapshotDigest: record.snapshotDigest, originalExecutionFingerprint: record.originalExecutionFingerprint };
}

function parseToolDefinition(value: unknown): ToolDefinition {
  const record = asRecord(value);
  assertKeys(record, ["name", "description", "parameters"]);
  assertIdentifier(record.name, "tool name");
  assertString(record.description, "tool description");
  return { name: record.name, description: record.description, parameters: parseObject(record.parameters, "tool parameters") };
}

function parseContext(value: unknown): ModelContext {
  const record = asRecord(value);
  assertKeys(record, ["systemPrompt", "messages"]);
  assertString(record.systemPrompt, "context system prompt");
  if (!Array.isArray(record.messages)) throw new Error("context messages must be an array");
  return { systemPrompt: record.systemPrompt, messages: record.messages.map(parseMessage) };
}

function parseMessage(value: unknown): Message {
  const record = asRecord(value);
  assertString(record.role, "message role");
  if (record.role === "user") {
    assertKeys(record, ["role", "content"]);
    assertString(record.content, "user content");
    return { role: "user", content: record.content };
  }
  if (record.role === "assistant") return parseAssistant(record);
  if (record.role === "toolResult") {
    assertKeys(record, ["role", "toolCallId", "toolName", "content", "status"]);
    assertIdentifier(record.toolCallId, "toolCallId");
    assertIdentifier(record.toolName, "toolName");
    assertString(record.content, "tool result content");
    assertEnum(record.status, ["succeeded", "failed", "unknown"], "tool result status");
    return { role: "toolResult", toolCallId: record.toolCallId, toolName: record.toolName, content: record.content, status: record.status };
  }
  throw new Error("unsupported message role");
}

function parseAssistant(value: unknown): AssistantMessage {
  const record = asRecord(value);
  assertKeys(record, ["role", "content", "stopReason", ...(Object.hasOwn(record, "usage") ? ["usage"] : [])]);
  if (record.role !== "assistant") throw new Error("model message must be assistant");
  if (!Array.isArray(record.content)) throw new Error("assistant content must be an array");
  assertEnum(record.stopReason, ["stop", "length", "toolUse"], "assistant stop reason");
  const content = record.content.map(parseContent);
  const usage = Object.hasOwn(record, "usage") ? parseUsage(record.usage) : undefined;
  return { role: "assistant", content, stopReason: record.stopReason, ...(usage === undefined ? {} : { usage }) };
}

function parseContent(value: unknown): Content {
  const record = asRecord(value);
  assertString(record.type, "content type");
  if (record.type === "text") {
    assertKeys(record, ["type", "text"]);
    assertString(record.text, "text content");
    return { type: "text", text: record.text };
  }
  if (record.type === "toolCall") {
    assertKeys(record, ["type", "id", "name", "arguments"]);
    assertIdentifier(record.id, "tool call id");
    assertIdentifier(record.name, "tool call name");
    return { type: "toolCall", id: record.id, name: record.name, arguments: parseObject(record.arguments, "tool call arguments") };
  }
  throw new Error("unsupported content type");
}

function parseUsage(value: unknown): Usage {
  const record = asRecord(value);
  assertAllowedKeys(record, ["input", "output", "cacheRead", "cacheWrite", "cost"]);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
    if (Object.hasOwn(record, key)) assertFiniteNonnegative(record[key], `usage ${key}`);
  }
  return record as Usage;
}

function parseDelta(value: unknown): ModelDelta {
  const record = asRecord(value);
  assertString(record.type, "delta type");
  assertKeys(record, record.type === "text" ? ["type", "contentIndex", "text"] : ["type", "contentIndex", "id", "name", "argumentsDelta"]);
  assertSafeNonnegativeInteger(record.contentIndex, "delta content index");
  const contentIndex = record.contentIndex as number;
  if (record.type === "text") {
    assertString(record.text, "text delta");
    return { type: "text", contentIndex, text: record.text };
  }
  if (record.type !== "toolCall") throw new Error("unsupported delta type");
  assertIdentifier(record.id, "delta tool call id");
  assertIdentifier(record.name, "delta tool name");
  assertString(record.argumentsDelta, "tool arguments delta");
  return { type: "toolCall", contentIndex, id: record.id, name: record.name, argumentsDelta: record.argumentsDelta };
}

function parseObservation(value: unknown): Observation {
  const record = asRecord(value);
  assertString(record.type, "observation type");
  if (record.type === "message_end") {
    assertKeys(record, ["type", "message"]);
    return { type: "message_end", message: parseMessage(record.message) };
  }
  if (record.type === "turn_end") {
    assertKeys(record, ["type", "modelRequestId"]);
    assertIdentifier(record.modelRequestId, "modelRequestId");
    return { type: "turn_end", modelRequestId: record.modelRequestId };
  }
  if (record.type === "progress") {
    assertKeys(record, ["type", "phase"]);
    assertEnum(record.phase, ["started", "tool_started", "tool_finished"], "progress phase");
    return { type: "progress", phase: record.phase };
  }
  throw new Error("unsupported observation type");
}

function parseObject(value: unknown, name: string): { readonly [key: string]: JsonValue } {
  const record = asRecord(value);
  assertJsonValue(record);
  return record as { readonly [key: string]: JsonValue };
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    assertString(item, `${name}[${index}]`);
    assertIdentifier(item, `${name}[${index}]`);
    return item;
  });
}

function assertKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  const uniqueExpected = [...new Set(expected)].sort();
  if (keys.length !== uniqueExpected.length || keys.some((key, index) => key !== uniqueExpected[index])) {
    throw new Error(`unexpected or missing frame fields: expected ${uniqueExpected.join(",")}, received ${keys.join(",")}`);
  }
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`unexpected fields: ${unexpected.join(",")}`);
}

function assertWorkerSeq(value: unknown, expected?: number, allowBootstrap = false): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 && !(allowBootstrap && value === -1)) throw new Error("invalid workerSeq");
  if (expected !== undefined && value !== expected) throw new Error(`workerSeq must be ${expected}`);
}

function assertSafeNonnegativeInteger(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a safe nonnegative integer`);
}

function assertFiniteNonnegative(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (value.length === 0 || byteLength(value) > 256) throw new Error(`${name} must be non-empty and at most 256 UTF-8 bytes`);
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], name: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${name} is invalid`);
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error("JSON number must be finite");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) assertJsonValue(item);
    return;
  }
  throw new Error("value is not JSON");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
