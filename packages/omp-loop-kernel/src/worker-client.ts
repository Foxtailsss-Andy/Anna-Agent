import { randomUUID } from "node:crypto";
import { launchManagedWorker, type ManagedWorkerLaunchSpec } from "./managed-launcher";
import {
  OMP_PROTOCOL, MAX_FRAME_BYTES, byteLength, encodeFrame, parseWorkerFrame,
  projectRestoreTranscript,
  type AssistantMessage, type HostFrame, type JsonValue, type ModelContext,
  type Message, type ModelDelta, type Observation, type StartInput, type WorkerBinding, type WorkerFrame,
} from "./protocol";

export interface HostModelResponse {
  readonly deltas: readonly ModelDelta[];
  readonly message: AssistantMessage;
}

export interface ManagedOmpWorkerOptions extends ManagedWorkerLaunchSpec {
  readonly binding: WorkerBinding;
  readonly input: StartInput;
  readonly signal?: AbortSignal;
  readonly wallTimeMs?: number;
  readonly modelTransport: (context: ModelContext, signal: AbortSignal) => AsyncIterable<HostModelResponse>;
  readonly toolGateway: (name: string, input: JsonValue, toolCallId: string, signal: AbortSignal) => Promise<{status: "succeeded" | "failed" | "unknown"; output?: JsonValue}>;
  readonly persistObservation?: (event: Observation) => Promise<void>;
  readonly beforeModel?: (context: ModelContext) => Promise<void>;
  readonly onDiagnostic?: (text: string) => void;
}

export async function runManagedOmpWorker(options: ManagedOmpWorkerOptions) {
  const restoreProjection = options.input.transcript === undefined
    ? undefined
    : projectRestoreTranscript(options.input.transcript);
  const worker = await launchManagedWorker(options);
  const controller = new AbortController();
  const observations: Observation[] = [];
  const seen = new Set<string>();
  const requests = new Set<string>();
  const pendingCalls = new Map<string, {
    name: string;
    arguments: JsonValue;
    authorizingIndex: number;
    authorizingObserved: boolean;
  }>();
  const authorizingCalls = new Map<number, string[]>();
  const acknowledgedToolReplies = new Set<string>();
  const usedCalls = new Set<string>();
  const expectedMessages: Message[] = options.input.transcript === undefined
    ? [{ role: "user", content: options.input.goal }]
    : [...options.input.transcript];
  let observedMessages = options.input.transcript?.length ?? 0;
  for (const [authorizingIndex, message] of expectedMessages.entries()) {
    if (message.role === "assistant") {
      const callIds: string[] = [];
      for (const content of message.content) {
        if (content.type === "toolCall") {
          pendingCalls.set(content.id, {
            name: content.name,
            arguments: content.arguments,
            authorizingIndex,
            authorizingObserved: true,
          });
          callIds.push(content.id);
        }
      }
      if (callIds.length > 0) authorizingCalls.set(authorizingIndex, callIds);
    } else if (message.role === "toolResult") {
      const pending = pendingCalls.get(message.toolCallId);
      if (pending !== undefined && pending.name === message.toolName) {
        pendingCalls.delete(message.toolCallId);
        usedCalls.add(message.toolCallId);
        acknowledgedToolReplies.add(message.toolCallId);
      }
    }
  }
  const bootstrapId = randomUUID();
  let sequence = -1;
  let ready: Extract<WorkerFrame, {kind: "ready"}>["runtime"] | undefined;
  let modelRequestCount = 0;
  let pendingOperation = false;
  let lastModelStop: AssistantMessage["stopReason"] | undefined = [...expectedMessages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant")
    ?.stopReason;
  let settled = false;
  let buffer = "";
  let chain = Promise.resolve();
  let failed = false;
  let closed = false;
  let resolveClosed!: () => void;
  const childClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
  worker.child.once("close", () => { closed = true; resolveClosed(); });
  let resolveResult!: (outcome: string) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  void result.catch(() => {});
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    failed = true;
    controller.abort();
    if (!closed && worker.child.stdin.writable && !worker.child.stdin.destroyed) {
      worker.child.stdin.write(encodeFrame({ protocol: OMP_PROTOCOL, kind: "abort", frameId: randomUUID(),
        requestId: bootstrapId, binding: options.binding, workerSeq: sequence, reason: "cancelled" }), () => {});
    }
    rejectResult(error instanceof Error ? error : new Error("OMP worker failed"));
  };
  const onAbort = () => fail(new Error("OMP worker cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => fail(new Error("OMP worker wall budget exhausted")), options.wallTimeMs ?? 30_000);
  const startupTimer = setTimeout(() => fail(new Error("OMP worker readiness timed out")), Math.min(options.wallTimeMs ?? 30_000, 10_000));
  worker.child.once("error", fail);
  worker.child.once("close", () => { if (!settled) fail(new Error("OMP worker closed before terminal proposal")); });
  worker.child.stdin.on("error", fail);
  let diagnosticBytes = 0;
  worker.child.stderr.on("data", (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 64 * 1024) fail(new Error("OMP worker diagnostics exceeded limit"));
    else options.onDiagnostic?.(chunk.toString("utf8"));
  });

  async function send(frame: HostFrame): Promise<void> {
    if (settled) throw new Error("OMP worker is stopped");
    const line = encodeFrame(frame);
    if (worker.child.stdin.writableLength + byteLength(line) > 4 * MAX_FRAME_BYTES) throw new Error("OMP output queue exceeded limit");
    await new Promise<void>((resolve, reject) => worker.child.stdin.write(line, error => error ? reject(error) : resolve()));
  }
  function response(frame: WorkerFrame) {
    return { protocol: OMP_PROTOCOL, frameId: randomUUID(), requestId: frame.requestId, binding: options.binding, workerSeq: frame.workerSeq };
  }
  async function handle(frame: WorkerFrame): Promise<void> {
    if (settled) return;
    if (Object.keys(options.binding).some(key => frame.binding[key as keyof WorkerBinding] !== options.binding[key as keyof WorkerBinding])
      || frame.workerSeq !== sequence + 1 || seen.has(frame.frameId)) throw new Error("OMP frame binding or sequence mismatch");
    sequence = frame.workerSeq;
    seen.add(frame.frameId);
    if (seen.size > 100_000) throw new Error("OMP frame count exceeded limit");
    if (frame.kind === "ready") {
      if (ready || frame.requestId !== bootstrapId || frame.runtime.bunVersion !== "1.3.14" || frame.runtime.ompVersion !== "18.0.11"
        || [...frame.runtime.activeTools].sort().join("\0") !== options.input.allowedTools.map(tool => tool.name).sort().join("\0")) throw new Error("OMP readiness identity mismatch");
      ready = frame.runtime;
      clearTimeout(startupTimer);
      await send({ ...response(frame), kind: "receipt", forFrameId: frame.frameId, accepted: true, throughWorkerSeq: sequence });
      return;
    }
    if (!ready) throw new Error("OMP worker dispatched before readiness");
    switch (frame.kind) {
      case "event": {
        let observation = frame.event;
        let acknowledgedMessage: Message | undefined;
        if (observation.type === "message_end") {
          const expected = expectedMessages[observedMessages];
          if (!expected || !sameMessages([observation.message], [expected])) throw new Error("OMP observation differs from Host history");
          observation = { type: "message_end", message: expected };
          acknowledgedMessage = expected;
        }
        await options.persistObservation?.(observation);
        if (settled) return;
        observations.push(observation);
        await send({ ...response(frame), kind: "receipt", forFrameId: frame.frameId, accepted: true, throughWorkerSeq: sequence });
        if (acknowledgedMessage !== undefined) {
          if (acknowledgedMessage.role === "assistant") {
            for (const toolCallId of authorizingCalls.get(observedMessages) ?? []) {
              const pending = pendingCalls.get(toolCallId);
              if (pending !== undefined) pending.authorizingObserved = true;
            }
          }
          observedMessages += 1;
        }
        return;
      }
      case "model.request": {
        if (frame.modelId !== options.input.modelId || frame.context.systemPrompt !== options.input.systemPrompt) throw new Error("OMP model input mismatch");
        const projectedExpected = projectedMessagesFor(restoreProjection, options.input.transcript, expectedMessages);
        if (requests.has(frame.requestId) || pendingCalls.size !== 0 || observedMessages !== expectedMessages.length
          || !sameMessages(frame.context.messages, projectedExpected)) {
          throw new Error("OMP model request history mismatch");
        }
        requests.add(frame.requestId);
        // The SDK context is a disposable projection: it may normalize usage
        // and add runtime-only fields. Host checkpoints authorize the canonical
        // transcript, so both the admission hook and transport see that exact
        // history after the projection has been verified.
        const canonicalContext: ModelContext = {
          systemPrompt: options.input.systemPrompt,
          messages: [...expectedMessages],
        };
        await options.beforeModel?.(canonicalContext);
        if (settled) return;
        modelRequestCount += 1;
        pendingOperation = true;
        let index = 0;
        let final: AssistantMessage | undefined;
        for await (const item of options.modelTransport(canonicalContext, controller.signal)) {
          if (final) throw new Error("OMP model transport returned multiple final responses");
          for (const delta of item.deltas) await send({ ...response(frame), kind: "model.delta", index: index++, delta });
          final = item.message;
        }
        if (!final) throw new Error("OMP model transport returned no final response");
        for (const content of final.content) {
          if (content.type !== "toolCall") continue;
          if (pendingCalls.has(content.id) || usedCalls.has(content.id)
            || !options.input.allowedTools.some(tool => tool.name === content.name)) throw new Error("OMP model returned invalid tool identity");
        }
        const authorizingIndex = expectedMessages.length;
        const callIds: string[] = [];
        for (const content of final.content) {
          if (content.type !== "toolCall") continue;
          pendingCalls.set(content.id, {
            name: content.name,
            arguments: content.arguments,
            authorizingIndex,
            authorizingObserved: false,
          });
          callIds.push(content.id);
        }
        if (callIds.length > 0) authorizingCalls.set(authorizingIndex, callIds);
        expectedMessages.push(final);
        lastModelStop = final.stopReason;
        await send({ ...response(frame), kind: "model.end", index, message: final });
        pendingOperation = false;
        return;
      }
      case "tool.request": {
        if (!options.input.allowedTools.some(tool => tool.name === frame.name)) throw new Error("OMP undeclared tool request");
        const expected = pendingCalls.get(frame.toolCallId);
        const siblings = expected === undefined ? [] : authorizingCalls.get(expected.authorizingIndex) ?? [frame.toolCallId];
        const siblingIndex = siblings.indexOf(frame.toolCallId);
        const priorSiblingUnacknowledged = siblingIndex > 0
          && siblings.slice(0, siblingIndex).some((toolCallId) => !acknowledgedToolReplies.has(toolCallId));
        if (!validateToolContext(frame.context, options.input, restoreProjection, expectedMessages, observedMessages, expected, frame.toolCallId, frame.name, frame.input)) {
          throw new Error("OMP tool request raw context mismatch");
        }
        if (requests.has(frame.requestId) || expected === undefined || expected.name !== frame.name
          || !expected.authorizingObserved || priorSiblingUnacknowledged
          || stableJson(expected.arguments) !== stableJson(frame.input)) {
          throw new Error("OMP tool request lacks durable authorization or prior Host reply checkpoint ACK");
        }
        requests.add(frame.requestId);
        pendingCalls.delete(frame.toolCallId);
        usedCalls.add(frame.toolCallId);
        pendingOperation = true;
        const tool = await options.toolGateway(frame.name, frame.input, frame.toolCallId, controller.signal);
        const resultMessage: Message = { role: "toolResult", toolCallId: frame.toolCallId, toolName: frame.name,
          status: tool.status, content: tool.output === undefined ? tool.status : typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output) };
        expectedMessages.push(resultMessage);
        await send({ ...response(frame), kind: "tool.result", toolCallId: frame.toolCallId, ...tool });
        acknowledgedToolReplies.add(frame.toolCallId);
        pendingOperation = false;
        return;
      }
      case "terminal.proposed":
        if (observedMessages !== expectedMessages.length) throw new Error("OMP terminal precedes durable message observations");
        if (frame.outcome === "completed" && (lastModelStop !== "stop" || pendingCalls.size !== 0)) throw new Error("OMP completion lacks a completed model response");
        settled = true;
        resolveResult(frame.outcome);
    }
  }
  let queuedBytes = 0;
  worker.child.stdout.setEncoding("utf8");
  worker.child.stdout.on("data", (chunk: string) => {
    if (settled) return;
    buffer += chunk;
    if (byteLength(buffer) > 4 * MAX_FRAME_BYTES) { fail(new Error("OMP input queue exceeded limit")); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const bytes = byteLength(line) + 1;
      queuedBytes += bytes;
      if (bytes > MAX_FRAME_BYTES || queuedBytes > 4 * MAX_FRAME_BYTES) { fail(new Error("OMP frame queue exceeded limit")); return; }
      let frame: WorkerFrame;
      try {
        frame = parseWorkerFrame(JSON.parse(line));
        if (frame.kind === "terminal.proposed" && (pendingOperation || queuedBytes > bytes)) {
          throw new Error("OMP terminal proposed with pending work");
        }
      } catch (error) { fail(error); return; }
      chain = chain.then(async () => { await handle(frame); }).catch(fail).finally(() => { queuedBytes -= bytes; });
    }
    if (byteLength(buffer) >= MAX_FRAME_BYTES) fail(new Error("OMP incomplete frame exceeded limit"));
  });
  try {
    if (options.signal?.aborted) onAbort();
    await send({ protocol: OMP_PROTOCOL, kind: "start", frameId: randomUUID(), requestId: bootstrapId,
      binding: options.binding, workerSeq: -1, input: options.input });
    const outcome = await result;
    return { modelRequestCount, observations, runtime: ready!, terminal: { outcome } };
  } finally {
    clearTimeout(timer);
    clearTimeout(startupTimer);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
    if (failed && !closed) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([childClosed, new Promise<void>(resolve => { grace = setTimeout(resolve, 2_000); })]);
      if (grace !== undefined) clearTimeout(grace);
    }
    await worker.close();
    await chain;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return item;
  });
}

function sameMessages(actual: readonly Message[], expected: readonly Message[]): boolean {
  const withoutSdkUsage = (messages: readonly Message[]) => messages.map(message => {
    if (message.role !== "assistant") return message;
    const { usage: _usage, ...content } = message;
    return content;
  });
  return stableJson(withoutSdkUsage(actual)) === stableJson(withoutSdkUsage(expected));
}

function projectedMessagesFor(
  restoreProjection: ReturnType<typeof projectRestoreTranscript> | undefined,
  transcript: readonly Message[] | undefined,
  expectedMessages: readonly Message[],
): readonly Message[] {
  if (restoreProjection === undefined || transcript === undefined) return expectedMessages;
  return [...restoreProjection.messages, ...expectedMessages.slice(transcript.length)];
}

function validateToolContext(
  actual: ModelContext | undefined,
  input: StartInput,
  restoreProjection: ReturnType<typeof projectRestoreTranscript> | undefined,
  expectedMessages: readonly Message[],
  observedMessages: number,
  expected: {
    readonly name: string;
    readonly arguments: JsonValue;
    readonly authorizingIndex: number;
    readonly authorizingObserved: boolean;
  } | undefined,
  toolCallId: string,
  toolName: string,
  toolInput: JsonValue,
): boolean {
  if (input.transcript === undefined) return actual === undefined;
  if (actual === undefined || expected === undefined || !expected.authorizingObserved || restoreProjection === undefined) return false;
  const initialTranscriptLength = input.transcript.length;
  const upperMessages = [...restoreProjection.messages, ...expectedMessages.slice(initialTranscriptLength)];
  const lowerMessages = [...restoreProjection.messages, ...expectedMessages.slice(initialTranscriptLength, observedMessages)];
  if (actual.systemPrompt !== input.systemPrompt
    || actual.messages.length < lowerMessages.length
    || actual.messages.length > upperMessages.length
    || !sameMessages(actual.messages, upperMessages.slice(0, actual.messages.length))) return false;
  if (expected.name !== toolName || stableJson(expected.arguments) !== stableJson(toolInput)) return false;
  const authorizing = expectedMessages[expected.authorizingIndex];
  return authorizing?.role === "assistant"
    && authorizing.content.some((content) => content.type === "toolCall"
      && content.id === toolCallId
      && content.name === toolName
      && stableJson(content.arguments) === stableJson(toolInput))
    && actual.messages.some((message) => message.role === "assistant"
      && message.content.some((content) => content.type === "toolCall"
        && content.id === toolCallId
        && content.name === toolName
        && stableJson(content.arguments) === stableJson(toolInput)));
}
