import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";

import { Type } from "@oh-my-pi/omptype/typebox";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { AssistantMessage as OmpAssistantMessage, Context as OmpContext, Model as OmpModel } from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

import {
  OMP_PROTOCOL,
  encodeFrame,
  parseHostFrame,
  type AssistantMessage,
  type Content,
  type HostFrame,
  type JsonValue,
  type Message,
  type ModelContext,
  type ModelDelta,
  type Observation,
  type StartInput,
  type ToolDefinition,
  type WorkerBinding,
  type WorkerFrame,
} from "./protocol.ts";

const CUSTOM_API = "anna-host-transport-v1";
const MAX_QUEUED_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_RECEIPTS = 64;
const configuredAttemptRoot = process.env.ANNA_OMP_ATTEMPT_ROOT;
if (configuredAttemptRoot === undefined) throw new Error("managed launcher attempt root is required");
const attemptRoot = configuredAttemptRoot;

class WorkerRuntime {
  private readonly reader: Interface;
  private binding: WorkerBinding | undefined;
  private input: StartInput | undefined;
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  private authStorage: AuthStorage | undefined;
  private nextWorkerSeq = 0;
  private outputChain = Promise.resolve();
  private queuedOutputBytes = 0;
  private startPromise: Promise<void> | undefined;
  private ready = false;
  private stopping = false;
  private disposed = false;
  private aborted = false;
  private runOutcome: "completed" | "failed" | "timed_out" | "cancelled" = "completed";
  private lastModelRequestId: string | undefined;
  private pendingModel: PendingModel | undefined;
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly pendingReceipts = new Map<string, Deferred<void>>();
  private readonly receiptBindings = new Map<string, { requestId: string; workerSeq: number }>();
  private readonly acknowledgedReceipts = new Map<string, string>();
  private observationBarrier: Promise<void> = Promise.resolve();
  private initialUserObservationContent: string | undefined;

  constructor() {
    this.reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  }

  async run(): Promise<void> {
    try {
      for await (const line of this.reader) {
        const frame = parseHostFrame(JSON.parse(line)) as HostFrame;
        if (frame.kind === "start") {
          if (this.startPromise !== undefined) throw new Error("duplicate worker start");
          this.binding = frame.binding;
          this.input = frame.input;
          this.startPromise = this.start(frame);
          void this.startPromise.catch((error) => this.fail(error));
        } else {
          await this.receive(frame);
        }
      }
      await this.startPromise;
    } finally {
      this.reader.close();
    }
  }

  private async start(frame: Extract<HostFrame, { kind: "start" }>): Promise<void> {
    const input = this.input;
    if (input === undefined || this.binding === undefined) throw new Error("worker start state is missing");
    this.session = await this.createSession(input);
    const activeTools = this.session.getActiveToolNames();
    const runtimePackage = JSON.parse(await readFile(
      new URL("./node_modules/@oh-my-pi/pi-coding-agent/package.json", import.meta.url),
      "utf8",
    )) as { version?: unknown };
    if (Bun.version !== "1.3.14" || runtimePackage.version !== "18.0.11") {
      throw new Error("managed OMP runtime identity mismatch");
    }
    await this.sendFrame(
      "ready",
      { runtime: { bunVersion: Bun.version, ompVersion: runtimePackage.version, activeTools } },
      frame.requestId,
      true,
    );
    this.ready = true;
    if (this.aborted) throw new Error("worker was aborted before prompt");
    await this.emitObservation({
      type: "message_end",
      message: { role: "user", content: input.goal },
    });
    this.initialUserObservationContent = input.goal;
    await this.session.prompt(input.goal, { expandPromptTemplates: false, userInitiated: true });
    await this.session.waitForIdle();
    await this.awaitObservations();
    await Promise.all([...this.pendingReceipts.values()].map((receipt) => receipt.promise));
    if (this.aborted) throw new Error("worker was aborted before terminal proposal");
    await this.sendFrame("terminal.proposed", { outcome: this.runOutcome });
    await this.dispose();
  }

  private async createSession(input: StartInput) {
    const rejectNetwork = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        throw new Error("managed OMP worker network is disabled");
      },
      {
        preconnect: (..._args: Parameters<typeof fetch.preconnect>): void => {
          throw new Error("managed OMP worker network is disabled");
        },
      },
    );
    globalThis.fetch = rejectNetwork;
    const settings = Settings.isolated({
      "memory.backend": "off",
      "autolearn.enabled": false,
      "autolearn.autoContinue": false,
      "compaction.enabled": false,
      "retry.enabled": false,
      "advisor.enabled": false,
      "prewalk.enabled": false,
      "goal.enabled": false,
      "async.enabled": false,
      "title.refreshOnReplan": false,
      "features.unexpectedStopDetection": "none",
      includeWorkspaceTree: false,
    });
    const authStorage = await AuthStorage.create(":memory:", {
      usageFetch: rejectNetwork,
      usageProviderResolver: () => undefined,
    });
    this.authStorage = authStorage;
    const modelRegistry = new ModelRegistry(
      authStorage,
      `${attemptRoot}/models.yml`,
      {
        ignoreLocalModelConfig: true,
        cacheDbPath: `${attemptRoot}/models.db`,
        settings,
        fetch: rejectNetwork,
      },
    );
    registerCustomApi(CUSTOM_API, (model, context, options) => {
      const stream = new AssistantMessageEventStream();
      void this.pumpModel(model, context, options?.signal, stream);
      return stream;
    });
    modelRegistry.registerProvider("anna-host", {
      api: CUSTOM_API,
      baseUrl: "anna://managed-host-transport",
      apiKey: "managed-worker",
      models: [{
        id: input.modelId,
        name: input.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      }],
    });
    const model = modelRegistry.find("anna-host", input.modelId);
    if (model === undefined) throw new Error("admitted OMP model is unavailable");
    const sessionManager = SessionManager.inMemory(attemptRoot);
    const options: CreateAgentSessionOptions = {
      cwd: attemptRoot,
      agentDir: `${attemptRoot}/agent`,
      additionalDirectories: [],
      spawns: "",
      authStorage,
      modelRegistry,
      model,
      settings,
      sessionManager,
      systemPrompt: input.systemPrompt,
      skills: [],
      rules: [],
      contextFiles: [],
      promptTemplates: [],
      slashCommands: [],
      workspaceTree: {
        rootPath: attemptRoot,
        rendered: "",
        truncated: false,
        totalLines: 0,
        agentsMdFiles: [],
      },
      customTools: input.allowedTools.map((tool) => this.createProxyTool(tool)),
      toolNames: input.allowedTools.map((tool) => tool.name),
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      disableExtensionDiscovery: true,
      additionalExtensionPaths: [],
      extensions: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      hasUI: false,
      interactivePrompts: false,
      requireYieldTool: false,
    };
    const created = await createAgentSession(options);
    this.session = created.session;
    this.session.subscribe((event) => this.onSessionEvent(event));
    return created.session;
  }

  private createProxyTool(tool: ToolDefinition): CustomTool {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.parameters),
      strict: true,
      loadMode: "essential" as const,
      approval: { tier: "read" as const, policy: "allow" as const },
      execute: async (toolCallId: string, params: unknown, _onUpdate: unknown, _context: unknown, signal?: AbortSignal) => {
        const input = asObject(params, "tool input");
        const result = await this.requestTool(toolCallId, tool.name, input, signal);
        const text = result.output === undefined ? result.status : renderJson(result.output);
        return {
          content: [{ type: "text", text }],
          details: { status: result.status, ...(result.output === undefined ? {} : { output: result.output }) },
          ...(result.status === "succeeded" ? {} : { isError: true }),
        };
      },
    };
  }

  private onSessionEvent(event: { type: string; message?: unknown; toolName?: string }): void {
    if (event.type === "agent_start") {
      this.enqueueObservation({ type: "progress", phase: "started" });
    } else if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      this.enqueueObservation({ type: "progress", phase: "tool_started" });
    } else if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      this.enqueueObservation({ type: "progress", phase: "tool_finished" });
    } else if (event.type === "message_end") {
      const message = toNeutralMessage(event.message);
      if (message?.role === "user" && message.content === this.initialUserObservationContent) {
        this.initialUserObservationContent = undefined;
        return;
      }
      if (message !== undefined) this.enqueueObservation({ type: "message_end", message });
    } else if (event.type === "turn_end") {
      if (this.lastModelRequestId !== undefined) {
        this.enqueueObservation({ type: "turn_end", modelRequestId: this.lastModelRequestId });
      }
    }
  }

  private enqueueObservation(event: Observation): void {
    const next = this.observationBarrier.then(() => this.emitObservation(event));
    this.observationBarrier = next;
    void next.catch((error) => this.fail(error));
  }

  private async awaitObservations(): Promise<void> {
    while (true) {
      const tail = this.observationBarrier;
      await tail;
      if (tail === this.observationBarrier) return;
    }
  }

  private async emitObservation(event: Observation): Promise<void> {
    if (this.stopping || this.aborted || this.binding === undefined) return;
    await this.sendFrame("event", { event }, randomUUID(), true);
  }

  private async pumpModel(
    model: OmpModel,
    context: OmpContext,
    signal: AbortSignal | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const neutralContext = toNeutralContext(context);
      const response = await this.requestModel(model.id, neutralContext, signal);
      const message = toOmpAssistant(response.message, model);
      const partial = { ...message, content: [] as OmpAssistantMessage["content"] };
      const stopReason = response.message.stopReason;
      stream.push({ type: "start", partial });
      const startedToolIndexes = new Set<number>();
      for (const delta of response.deltas) {
        if (delta.type === "text") {
          const existing = partial.content[delta.contentIndex];
          partial.content[delta.contentIndex] = {
            type: "text",
            text: existing?.type === "text" ? existing.text + delta.text : delta.text,
          };
          stream.push({ type: "text_start", contentIndex: delta.contentIndex, partial });
          stream.push({ type: "text_delta", contentIndex: delta.contentIndex, delta: delta.text, partial });
          stream.push({ type: "text_end", contentIndex: delta.contentIndex, content: delta.text, partial });
        } else {
          if (!startedToolIndexes.has(delta.contentIndex)) {
            startedToolIndexes.add(delta.contentIndex);
            partial.content[delta.contentIndex] = {
              type: "toolCall",
              id: delta.id,
              name: delta.name,
              arguments: {},
            };
            setStreamingPartialJson(partial.content[delta.contentIndex]!, delta.argumentsDelta);
            stream.push({ type: "toolcall_start", contentIndex: delta.contentIndex, partial });
          }
          const existing = partial.content[delta.contentIndex];
          if (existing?.type === "toolCall") {
            setStreamingPartialJson(existing, `${getStreamingPartialJson(existing) ?? ""}${delta.argumentsDelta}`);
          }
          stream.push({ type: "toolcall_delta", contentIndex: delta.contentIndex, delta: delta.argumentsDelta, partial });
        }
      }
      partial.content = message.content;
      for (const [index, block] of message.content.entries()) {
        if (block.type === "toolCall") {
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial });
        }
      }
      partial.stopReason = message.stopReason;
      partial.usage = message.usage;
      stream.push({ type: "done", reason: stopReason, message });
    } catch (error) {
      const failed = error instanceof HostModelError && error.code === "cancelled" ? "aborted" : "error";
      this.runOutcome = failed === "aborted" ? "cancelled" : "failed";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failure = toOmpAssistant({
        role: "assistant",
        content: [],
        stopReason: "stop",
        usage: emptyUsage(),
      }, model);
      failure.stopReason = failed;
      failure.errorMessage = errorMessage;
      failure.timestamp = startedAt;
      stream.push({ type: "error", reason: failed, error: failure });
    }
  }

  private async requestModel(modelId: string, context: ModelContext, signal?: AbortSignal): Promise<ModelReply> {
    await this.awaitObservations();
    if (this.aborted || this.stopping) throw new HostModelError("cancelled", "model request cancelled");
    if (this.pendingModel !== undefined) throw new Error("OMP model request overlap");
    const requestId = randomUUID();
    const frame = this.makeFrame("model.request", { modelId, context }, requestId);
    return new Promise<ModelReply>((resolvePromise, rejectPromise) => {
      const pending: PendingModel = {
        requestId,
        workerSeq: frame.workerSeq,
        nextIndex: 0,
        deltas: [],
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      this.pendingModel = pending;
      this.lastModelRequestId = requestId;
      const onAbort = () => {
        if (this.pendingModel === pending) {
          this.pendingModel = undefined;
          pending.cleanupAbort?.();
          rejectPromise(new HostModelError("cancelled", "model request cancelled"));
        }
      };
      pending.cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.writeFrame(frame).catch((error) => {
        pending.cleanupAbort?.();
        if (this.pendingModel === pending) this.pendingModel = undefined;
        rejectPromise(error);
      });
    });
  }

  private async requestTool(
    toolCallId: string,
    name: string,
    input: { readonly [key: string]: JsonValue },
    signal?: AbortSignal,
  ): Promise<Extract<HostFrame, { kind: "tool.result" }>> {
    await this.awaitObservations();
    if (this.aborted || this.stopping) throw new HostModelError("cancelled", "tool request cancelled");
    if (this.pendingTools.size > 0) throw new Error("OMP tool request overlap");
    const requestId = randomUUID();
    const frame = this.makeFrame("tool.request", { toolCallId, name, input }, requestId);
    return new Promise((resolvePromise, rejectPromise) => {
      const pending: PendingTool = { requestId, workerSeq: frame.workerSeq, resolve: resolvePromise, reject: rejectPromise };
      this.pendingTools.set(toolCallId, pending);
      const onAbort = () => {
        if (this.pendingTools.get(toolCallId) === pending) {
          this.pendingTools.delete(toolCallId);
          pending.cleanupAbort?.();
          rejectPromise(new HostModelError("cancelled", "tool request cancelled"));
        }
      };
      pending.cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.writeFrame(frame).catch((error) => {
        pending.cleanupAbort?.();
        if (this.pendingTools.get(toolCallId) === pending) this.pendingTools.delete(toolCallId);
        rejectPromise(error);
      });
    });
  }

  private async receive(frame: HostFrame): Promise<void> {
    if (this.binding === undefined || !sameBinding(frame.binding, this.binding)) throw new Error("Host frame binding mismatch");
    if (frame.kind === "start") throw new Error("duplicate worker start");
    if (frame.kind === "abort") {
      this.aborted = true;
      for (const pending of this.pendingReceipts.values()) pending.reject(new HostModelError("cancelled", frame.reason));
      this.pendingReceipts.clear();
      this.pendingModel?.reject(new HostModelError("cancelled", frame.reason));
      this.pendingModel = undefined;
      for (const pending of this.pendingTools.values()) pending.reject(new HostModelError("cancelled", frame.reason));
      this.pendingTools.clear();
      if (this.session !== undefined && !this.stopping) await this.session.abort({ reason: frame.reason });
      return;
    }
    if (frame.kind === "receipt") {
      const acknowledged = this.acknowledgedReceipts.get(frame.forFrameId);
      if (acknowledged !== undefined) {
        if (acknowledged !== JSON.stringify(frame)) throw new Error("changed duplicate OMP receipt");
        return;
      }
      const receipt = this.pendingReceipts.get(frame.forFrameId);
      const expected = this.receiptBindings.get(frame.forFrameId);
      if (receipt === undefined || expected === undefined) throw new Error("unknown OMP receipt");
      if (frame.requestId !== expected.requestId || frame.workerSeq !== expected.workerSeq
        || frame.throughWorkerSeq !== expected.workerSeq) throw new Error("OMP receipt correlation mismatch");
      this.pendingReceipts.delete(frame.forFrameId);
      this.receiptBindings.delete(frame.forFrameId);
      this.acknowledgedReceipts.set(frame.forFrameId, JSON.stringify(frame));
      if (this.acknowledgedReceipts.size > 100_000) throw new Error("OMP receipt history exceeded limit");
      receipt.resolve();
      return;
    }
    if (frame.kind === "model.delta" || frame.kind === "model.end" || frame.kind === "model.error") {
      const pending = this.pendingModel;
      if (pending === undefined || pending.requestId !== frame.requestId || pending.workerSeq !== frame.workerSeq) {
        if (this.aborted) return;
        throw new Error("uncorrelated OMP model response");
      }
      if (frame.kind === "model.delta") {
        if (frame.index !== pending.nextIndex) throw new Error("OMP model delta index gap");
        pending.nextIndex += 1;
        pending.deltas.push(frame.delta);
      } else if (frame.kind === "model.end") {
        if (frame.index !== pending.nextIndex) throw new Error("OMP model end index gap");
        assertModelResponseMatchesDeltas(pending.deltas, frame.message);
        pending.cleanupAbort?.();
        this.pendingModel = undefined;
        pending.resolve({ deltas: pending.deltas, message: frame.message });
      } else {
        pending.cleanupAbort?.();
        this.pendingModel = undefined;
        pending.reject(new HostModelError(frame.code, `Host model ${frame.code}`));
      }
      return;
    }
    if (frame.kind === "tool.result") {
      const pending = this.pendingTools.get(frame.toolCallId);
      if (pending === undefined || pending.requestId !== frame.requestId || pending.workerSeq !== frame.workerSeq) {
        if (this.aborted) return;
        throw new Error("uncorrelated OMP tool response");
      }
      this.pendingTools.delete(frame.toolCallId);
      pending.cleanupAbort?.();
      pending.resolve(frame);
      return;
    }
  }

  private makeFrame(kind: string, payload: Record<string, unknown>, requestId: string = randomUUID()): WorkerFrame {
    if (this.binding === undefined) throw new Error("worker binding is not initialized");
    const frame = {
      protocol: OMP_PROTOCOL,
      kind,
      frameId: randomUUID(),
      requestId,
      binding: this.binding,
      workerSeq: this.nextWorkerSeq++,
      ...payload,
    } as WorkerFrame;
    return frame;
  }

  private async sendFrame(
    kind: string,
    payload: Record<string, unknown>,
    requestId: string = randomUUID(),
    requireReceipt = false,
  ): Promise<void> {
    const frame = this.makeFrame(kind, payload, requestId);
    let receipt: Deferred<void> | undefined;
    let receiptTimer: ReturnType<typeof setTimeout> | undefined;
    if (requireReceipt) {
      if (this.pendingReceipts.size >= MAX_PENDING_RECEIPTS) {
        throw new Error("OMP receipt queue exceeded limit");
      }
      receipt = deferred<void>();
      this.pendingReceipts.set(frame.frameId, receipt);
      this.receiptBindings.set(frame.frameId, { requestId: frame.requestId, workerSeq: frame.workerSeq });
      const pendingReceipt = receipt;
      receiptTimer = setTimeout(() => pendingReceipt.reject(new Error("OMP receipt deadline exceeded")), 10_000);
    }
    try {
      await this.writeFrame(frame);
      await receipt?.promise;
    } catch (error) {
      if (receipt !== undefined) this.pendingReceipts.delete(frame.frameId);
      throw error;
    } finally {
      if (receiptTimer !== undefined) clearTimeout(receiptTimer);
      this.receiptBindings.delete(frame.frameId);
    }
  }

  private writeFrame(frame: WorkerFrame): Promise<void> {
    const line = encodeFrame(frame);
    const bytes = new TextEncoder().encode(line).byteLength;
    if (this.queuedOutputBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
      throw new Error("OMP output queue exceeded limit");
    }
    this.queuedOutputBytes += bytes;
    const write = this.outputChain.then(() => new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        process.stdout.off("error", onError);
        process.stdout.off("drain", onDrain);
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      };
      const onError = (error: Error) => settle(error);
      const onDrain = () => settle();
      process.stdout.once("error", onError);
      const accepted = process.stdout.write(line, "utf8", () => settle());
      if (!accepted) process.stdout.once("drain", onDrain);
    }));
    this.outputChain = write.catch(() => undefined).finally(() => {
      this.queuedOutputBytes -= bytes;
    });
    return write;
  }

  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopping = true;
    this.session?.beginDispose();
    await this.session?.dispose();
    this.authStorage?.close();
    this.reader.close();
    process.stdin.pause();
    await this.outputChain;
    process.stdout.end();
  }

  private fail(error: unknown): void {
    if (this.stopping) return;
    this.stopping = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    this.pendingModel?.reject(error);
    for (const pending of this.pendingTools.values()) pending.reject(error);
    for (const receipt of this.pendingReceipts.values()) receipt.reject(error);
    this.pendingModel = undefined;
    this.pendingTools.clear();
    this.pendingReceipts.clear();
    void (async () => {
      try {
        await this.session?.abort({ reason: "managed worker failure" });
      } catch {
        // Preserve the original protocol/startup failure.
      }
      await this.dispose().catch(() => undefined);
      process.exitCode = 1;
    })();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingModel {
  readonly requestId: string;
  readonly workerSeq: number;
  nextIndex: number;
  readonly deltas: ModelDelta[];
  readonly resolve: (value: ModelReply) => void;
  readonly reject: (error: unknown) => void;
  cleanupAbort?: () => void;
}

interface PendingTool {
  readonly requestId: string;
  readonly workerSeq: number;
  readonly resolve: (value: Extract<HostFrame, { kind: "tool.result" }>) => void;
  readonly reject: (error: unknown) => void;
  cleanupAbort?: () => void;
}

interface ModelReply {
  readonly deltas: readonly ModelDelta[];
  readonly message: AssistantMessage;
}

class HostModelError extends Error {
  constructor(readonly code: "transport_failed" | "budget_exhausted" | "cancelled" | "protocol_failed", message: string) {
    super(message);
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function sameBinding(left: WorkerBinding, right: WorkerBinding): boolean {
  return left.workspaceId === right.workspaceId
    && left.channelId === right.channelId
    && left.runId === right.runId
    && left.attemptId === right.attemptId
    && left.commandId === right.commandId
    && left.profileHash === right.profileHash;
}

function toNeutralContext(context: OmpContext): ModelContext {
  const systemPrompt = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n") : "";
  return {
    systemPrompt,
    messages: context.messages.map(toNeutralMessage).filter((message): message is Message => message !== undefined),
  };
}

function toNeutralMessage(value: unknown): Message | undefined {
  if (!isRecord(value) || typeof value.role !== "string") return undefined;
  if (value.role === "user" || value.role === "developer") {
    return { role: "user", content: neutralUserContent(value.content) };
  }
  if (value.role === "toolResult") {
    if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string") return undefined;
    const details = isRecord(value.details) && (
      value.details.status === "succeeded" || value.details.status === "failed" || value.details.status === "unknown"
    ) ? value.details : undefined;
    const detailStatus = details?.status;
    const status = detailStatus === "succeeded" || detailStatus === "failed" || detailStatus === "unknown"
      ? detailStatus
      : value.isError === true ? "failed" : "succeeded";
    return {
      role: "toolResult",
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      content: textContent(value.content),
      status,
    };
  }
  if (value.role === "assistant" && Array.isArray(value.content)) {
    if (value.stopReason !== "stop" && value.stopReason !== "length" && value.stopReason !== "toolUse") return undefined;
    const content: Content[] = [];
    for (const block of value.content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
      else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
        content.push({ type: "toolCall", id: block.id, name: block.name, arguments: asObject(block.arguments, "assistant tool arguments") });
      }
    }
    const stopReason = value.stopReason;
    return { role: "assistant", content, stopReason, ...(value.usage === undefined ? {} : { usage: toNeutralUsage(value.usage) }) };
  }
  return undefined;
}

function toNeutralUsage(value: unknown): AssistantMessage["usage"] {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  if (isRecord(value.cost) && typeof value.cost.total === "number" && Number.isFinite(value.cost.total) && value.cost.total >= 0) usage.cost = value.cost.total;
  return usage;
}

function toOmpAssistant(message: AssistantMessage, model: OmpModel): OmpAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((block) => block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }),
    api: CUSTOM_API,
    provider: model.provider,
    model: model.id,
    usage: toOmpUsage(message.usage),
    stopReason: message.stopReason,
    timestamp: Date.now(),
  } as OmpAssistantMessage;
}

function toOmpUsage(usage: AssistantMessage["usage"]): OmpAssistantMessage["usage"] {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.cost ?? 0 },
  } as OmpAssistantMessage["usage"];
}

function assertModelResponseMatchesDeltas(
  deltas: readonly ModelDelta[],
  message: AssistantMessage,
): void {
  if (deltas.length === 0) return;
  const fragments = new Map<number, { type: ModelDelta["type"]; text: string; id?: string; name?: string }>();
  for (const delta of deltas) {
    const current = fragments.get(delta.contentIndex);
    if (delta.type === "text") {
      if (current !== undefined && current.type !== "text") throw new Error("OMP model delta content type mismatch");
      fragments.set(delta.contentIndex, {
        type: "text",
        text: (current?.text ?? "") + delta.text,
      });
    } else {
      if (current !== undefined && (current.type !== "toolCall" || current.id !== delta.id || current.name !== delta.name)) {
        throw new Error("OMP model tool delta identity mismatch");
      }
      fragments.set(delta.contentIndex, {
        type: "toolCall",
        text: (current?.text ?? "") + delta.argumentsDelta,
        id: delta.id,
        name: delta.name,
      });
    }
  }
  if (fragments.size !== message.content.length) throw new Error("OMP model delta count does not match final message");
  for (const [index, block] of message.content.entries()) {
    const fragment = fragments.get(index);
    if (fragment === undefined) throw new Error("OMP model delta index does not match final message");
    if (block.type === "text") {
      if (fragment.type !== "text" || fragment.text !== block.text) throw new Error("OMP model text delta mismatch");
      continue;
    }
    if (fragment.type !== "toolCall" || fragment.id !== block.id || fragment.name !== block.name) {
      throw new Error("OMP model tool delta mismatch");
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(fragment.text);
    } catch {
      throw new Error("OMP model tool arguments are not complete JSON");
    }
    if (!isRecord(argumentsValue) || stableJson(argumentsValue) !== stableJson(block.arguments)) {
      throw new Error("OMP model tool arguments mismatch");
    }
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (isRecord(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return item;
  });
}

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n");
}

function neutralUserContent(value: unknown): string {
  const reminder = managedDateCwdReminder();
  if (typeof value === "string") {
    const prefix = `${reminder}\n\n`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((part, index) => {
      if (index !== 0 || !isRecord(part) || part.type !== "text" || typeof part.text !== "string") return true;
      return part.text !== reminder;
    });
    return parts.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n");
  }
  return "";
}

function managedDateCwdReminder(): string {
  const now = new Date();
  const date = [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `<system-reminder>\nToday: ${date}; current working directory: '${attemptRoot}'. Do not repeat this information in your reply.\n</system-reminder>`;
}

function asObject(value: unknown, name: string): { readonly [key: string]: JsonValue } {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value as { readonly [key: string]: JsonValue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderJson(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

await new WorkerRuntime().run();
