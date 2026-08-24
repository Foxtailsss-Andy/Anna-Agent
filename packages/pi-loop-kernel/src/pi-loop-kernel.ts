import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type, type Api, type Model, type Static } from "@earendil-works/pi-ai";
import { stream as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import {
  parseJsonValue,
  type CanonicalEvent,
  type ChannelMessage,
  type DurableEventSink,
  type EventId,
  type EventSink,
  type HumanAnswer,
  type JsonValue,
  type LoopKernel,
  type RunId,
  type RunOutcome,
  type StartRun,
  type StreamId,
  type ToolGateway,
  type ToolResult,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { createHash } from "node:crypto";
export interface PiLoopKernelOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  toolGateway: ToolGateway;
  workerProfileId: WorkerProfileId;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  now?: () => number;
  createId?: () => string;
}

export interface OpenAICompatiblePiLoopKernelOptions {
  endpoint: string;
  apiKey: string;
  modelName: string;
  toolGateway: ToolGateway;
  workerProfileId: WorkerProfileId;
}

const canaryExecutionLimits = {
  contextWindow: 16_384,
  maxTokens: 1_024,
} as const;

export function createOpenAICompatiblePiLoopKernel(
  options: OpenAICompatiblePiLoopKernelOptions,
): PiLoopKernel {
  const model: Model<"openai-completions"> = {
    id: options.modelName,
    name: options.modelName,
    api: "openai-completions",
    provider: "anna-openai-compatible",
    baseUrl: openAICompatibleBaseUrl(options.endpoint),
    reasoning: false,
    input: ["text"],
    // Pi requires this shape. It is not a provider pricing claim and is never canonicalized.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Local execution ceilings only; they are not provider context-window claims.
    contextWindow: canaryExecutionLimits.contextWindow,
    maxTokens: canaryExecutionLimits.maxTokens,
  };

  return new PiLoopKernel({
    model,
    streamFn: openAICompletionsStream as StreamFn,
    getApiKey: () => options.apiKey,
    toolGateway: options.toolGateway,
    workerProfileId: options.workerProfileId,
  });
}

function openAICompatibleBaseUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("OpenAI-compatible endpoint is invalid");
  }

  const suffix = "/chat/completions";
  if (!url.pathname.endsWith(suffix)) {
    throw new Error("OpenAI-compatible endpoint must end in /chat/completions");
  }

  url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}

interface ActiveRun {
  command: StartRun;
  sink: EventSink;
  agent: Agent;
  startedAt: number;
  seq: number;
  turns: number;
  timedOut: boolean;
  cancelled: boolean;
  lastStopReason?: string;
  sinkFailure?: unknown;
  terminal: boolean;
  readonly restoredTranscript: boolean;
  cumulativeUsage: Record<string, number>;
}

type ExecutionFingerprint = {
  algorithm: "sha256";
  provider: string;
  model: string;
  runProfileHash: string;
  systemPromptHash: string;
  hash: string;
};

type ReadableEventSink = DurableEventSink;

async function readRunHistory(
  sink: EventSink,
  runId: RunId,
): Promise<readonly CanonicalEvent[]> {
  const readable = sink as Partial<ReadableEventSink>;
  if (typeof readable.read !== "function") {
    return [];
  }
  const events: CanonicalEvent[] = [];
  for await (const event of readable.read(runId as unknown as StreamId)) {
    events.push(event);
  }
  return events;
}

function transcriptMessage(event: CanonicalEvent): AgentMessage | undefined {
  if (event.type !== "pi.transcript.message" || !isRecord(event.payload)) {
    return undefined;
  }
  const message = event.payload.message;
  if (
    !isRecord(message)
    || typeof message.role !== "string"
    || !Array.isArray(message.content)
    || typeof message.timestamp !== "number"
    || !Number.isFinite(message.timestamp)
  ) {
    return undefined;
  }
  return message as unknown as AgentMessage;
}

function restoredTranscript(events: readonly CanonicalEvent[]): AgentMessage[] {
  return events.flatMap((event) => {
    const message = transcriptMessage(event);
    return message === undefined ? [] : [message];
  });
}

function restoredTurnCount(events: readonly CanonicalEvent[]): number {
  return events.filter((event) =>
    event.type === "run.progress"
    && isRecord(event.payload)
    && event.payload.phase === "turn_finished",
  ).length;
}

function restoredUsage(events: readonly CanonicalEvent[]): Record<string, number> {
  const latest = [...events].reverse().find((event) =>
    event.type === "run.usage.updated"
    && isRecord(event.payload)
    && isRecord(event.payload.cumulative),
  );
  if (latest !== undefined && isRecord(latest.payload)) {
    return numericUsage(latest.payload.cumulative);
  }

  return events.reduce<Record<string, number>>((total, event) => {
    if (event.type !== "run.progress" || !isRecord(event.payload)) {
      return total;
    }
    const usage = isRecord(event.payload.usage) ? numericUsage(event.payload.usage) : {};
    return mergeUsage(total, usage);
  }, {});
}

const TERMINAL_RUN_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
]);

function isTerminalRunEvent(event: CanonicalEvent): boolean {
  return TERMINAL_RUN_EVENT_TYPES.has(event.type);
}

function jsonSnapshot(value: unknown, name: string): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`${name} must be serializable JSON`);
  }
  return parseJsonValue(JSON.parse(serialized), name);
}

const fixtureReadParameters = Type.Object(
  { key: Type.String() },
  { additionalProperties: false },
);
type FixtureReadParameters = Static<typeof fixtureReadParameters>;
type FixtureReadDetails = {
  status: ToolResult["status"];
  reason?: string;
};

const readOnlyParameters = Type.Object(
  { path: Type.String() },
  { additionalProperties: false },
);
type ReadOnlyParameters = Static<typeof readOnlyParameters>;

const webSearchParameters = Type.Object(
  { query: Type.String() },
  { additionalProperties: false },
);
type WebSearchParameters = Static<typeof webSearchParameters>;

const createArtifactParameters = Type.Object(
  {
    kind: Type.Literal("skill"),
    skill_id: Type.String(),
    preview: Type.String(),
  },
  { additionalProperties: false },
);
type CreateArtifactParameters = Static<typeof createArtifactParameters>;
type CreateArtifactDetails = {
  status: ToolResult["status"];
  reason?: string;
  artifact?: JsonValue;
  validation?: JsonValue;
};

function fixtureReadTool(
  command: StartRun,
  toolGateway: ToolGateway,
  workerProfileId: WorkerProfileId,
): AgentTool<typeof fixtureReadParameters, FixtureReadDetails> {
  return {
    name: "fixture_read",
    label: "Read fixture",
    description: "Read a named fixture through Anna ToolGateway.",
    parameters: fixtureReadParameters,
    executionMode: "sequential",
    async execute(toolCallId, params: FixtureReadParameters, signal) {
      const result = await toolGateway.execute({
        name: "fixture_read",
        input: { key: params.key },
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId,
        toolCallId,
        ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
        ...(command.parentEventId === undefined ? {} : { parentEventId: command.parentEventId }),
        ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
      }, signal ?? new AbortController().signal);
      const details = toolResultDetails(result);

      return {
        content: [{
          type: "text",
          text: result.status === "succeeded"
            ? toolResultText(result.output)
            : JSON.stringify(details),
        }],
        details,
      };
    },
  };
}

function readOnlyTool(
  command: StartRun,
  toolGateway: ToolGateway,
  workerProfileId: WorkerProfileId,
): AgentTool<typeof readOnlyParameters, FixtureReadDetails> {
  return {
    name: "read_only",
    label: "Read approved text",
    description: "Read one approved relative text path through Anna ToolGateway.",
    parameters: readOnlyParameters,
    executionMode: "sequential",
    async execute(toolCallId, params: ReadOnlyParameters, signal) {
      const result = await toolGateway.execute({
        name: "read_only",
        input: { path: params.path },
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId,
        toolCallId,
        ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
        ...(command.parentEventId === undefined ? {} : { parentEventId: command.parentEventId }),
        ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
      }, signal ?? new AbortController().signal);
      const details = toolResultDetails(result);
      return {
        content: [{
          type: "text",
          text: result.status === "succeeded"
            ? toolResultText(result.output)
            : JSON.stringify(details),
        }],
        details,
      };
    },
  };
}

function toolResultText(output: ToolResult["output"]): string {
  if (output === undefined) {
    return "";
  }

  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output) ?? "";
}

function webSearchTool(
  command: StartRun,
  toolGateway: ToolGateway,
  workerProfileId: WorkerProfileId,
): AgentTool<typeof webSearchParameters, FixtureReadDetails> {
  return {
    name: "web_search",
    label: "Search the web",
    description: "Search the configured WebSearch provider for current information.",
    parameters: webSearchParameters,
    executionMode: "sequential",
    async execute(toolCallId, params: WebSearchParameters, signal) {
      const result = await toolGateway.execute({
        name: "web_search",
        input: { query: params.query },
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId,
        toolCallId,
        ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
        ...(command.parentEventId === undefined ? {} : { parentEventId: command.parentEventId }),
        ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
      }, signal ?? new AbortController().signal);
      const details = toolResultDetails(result);
      return {
        content: [{
          type: "text",
          text: result.status === "succeeded"
            ? toolResultText(result.output)
            : JSON.stringify(details),
        }],
        details,
      };
    },
  };
}

function createArtifactTool(
  command: StartRun,
  toolGateway: ToolGateway,
  workerProfileId: WorkerProfileId,
): AgentTool<typeof createArtifactParameters, CreateArtifactDetails> {
  return {
    name: "create_artifact",
    label: "Create a Skill artifact",
    description: "Create one reviewable Skill artifact through Anna ToolGateway.",
    parameters: createArtifactParameters,
    executionMode: "sequential",
    async execute(toolCallId, params: CreateArtifactParameters, signal) {
      const result = await toolGateway.execute({
        name: "create_artifact",
        input: {
          kind: params.kind,
          skill_id: params.skill_id,
          preview: params.preview,
        },
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId,
        toolCallId,
        ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
        ...(command.parentEventId === undefined ? {} : { parentEventId: command.parentEventId }),
        ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
      }, signal ?? new AbortController().signal);
      const details = createArtifactResultDetails(result);
      return {
        content: [{
          type: "text",
          text: result.status === "succeeded"
            ? toolResultText(result.output)
            : JSON.stringify(details),
        }],
        details,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultDetails(result: ToolResult): FixtureReadDetails {
  const details: FixtureReadDetails = {
    status: result.status,
  };
  if (
    result.status !== "succeeded" &&
    isRecord(result.output) &&
    typeof result.output.reason === "string"
  ) {
    details.reason = result.output.reason;
  }
  return details;
}

function createArtifactResultDetails(result: ToolResult): CreateArtifactDetails {
  const details: CreateArtifactDetails = { status: result.status };
  if (result.status === "succeeded" && isRecord(result.output)) {
    if (result.output.artifact !== undefined) {
      details.artifact = result.output.artifact;
    }
    if (result.output.validation !== undefined) {
      details.validation = result.output.validation;
    }
  }
  if (
    result.status !== "succeeded"
    && isRecord(result.output)
    && typeof result.output.reason === "string"
  ) {
    details.reason = result.output.reason;
  }
  return details;
}

function isFailedAnnaToolResult(details: unknown): boolean {
  return isRecord(details) && (
    details.status === "failed" || details.status === "unknown"
  );
}

function isApprovalRequiredAnnaToolResult(details: unknown): boolean {
  return isRecord(details) && details.reason === "approval_required";
}

export class PiLoopKernel implements LoopKernel {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly runs = new Map<RunId, ActiveRun>();

  constructor(private readonly options: PiLoopKernelOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async start(
    command: StartRun,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const history = await readRunHistory(sink, command.runId);
    if (history.some(isTerminalRunEvent)) {
      throw new Error("Cannot restore a terminal Pi Run");
    }
    const fingerprint = executionFingerprintFor(command, this.options.model);
    validateRestoredFingerprint(history, fingerprint);
    const transcript = restoredTranscript(history);
    const restored = transcript.length > 0 || history.some((event) =>
      event.type === "run.started" || event.type === "run.resumed",
    );
    let awaitingApproval = false;
    const agent = new Agent({
      streamFn: this.options.streamFn,
      getApiKey: this.options.getApiKey,
      initialState: {
        model: this.options.model,
        systemPrompt: systemPromptFor(command),
        messages: transcript,
        tools: [
          ...(command.runProfileSnapshot.allowedTools.includes("fixture_read")
            ? [fixtureReadTool(command, this.options.toolGateway, this.options.workerProfileId)]
            : []),
          ...(command.runProfileSnapshot.allowedTools.includes("read_only")
            ? [readOnlyTool(command, this.options.toolGateway, this.options.workerProfileId)]
            : []),
          ...(command.runProfileSnapshot.allowedTools.includes("web_search")
            ? [webSearchTool(command, this.options.toolGateway, this.options.workerProfileId)]
            : []),
          ...(command.runProfileSnapshot.allowedTools.includes("create_artifact")
            ? [createArtifactTool(command, this.options.toolGateway, this.options.workerProfileId)]
            : []),
        ],
      },
      shouldStopAfterTurn: () => false,
      afterToolCall: async ({ result }) => {
        if (!isFailedAnnaToolResult(result.details)) {
          return undefined;
        }
        if (isApprovalRequiredAnnaToolResult(result.details)) {
          awaitingApproval = true;
          return { isError: true, terminate: true };
        }
        return { isError: true };
      },
    });
    const run: ActiveRun = {
      command,
      sink,
      agent,
      startedAt: this.now(),
      seq: 0,
      turns: restoredTurnCount(history),
      timedOut: false,
      cancelled: signal.aborted,
      terminal: false,
      restoredTranscript: restored,
      cumulativeUsage: restoredUsage(history),
    };
    if (history.length > 0) {
      run.seq = Math.max(...history.map((event) => event.seq)) + 1;
    }
    this.runs.set(command.runId, run);
    const unsubscribe = agent.subscribe((event) => this.record(run, event));
    const onAbort = () => {
      run.cancelled = true;
      agent.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const wallTimer = command.budget.wallTimeMs === undefined
      ? undefined
      : setTimeout(() => {
        if (run.terminal) {
          return;
        }

        run.timedOut = true;
        agent.abort();
      }, command.budget.wallTimeMs);

    let failure: RunOutcome | undefined;
    try {
      if (!signal.aborted) {
        agent.shouldStopAfterTurn = (context) => this.shouldStopAfterTurn(
          run,
          context.message.stopReason === "toolUse" || agent.hasQueuedMessages(),
        );
        if (restored) {
          await agent.continue();
        } else {
          await agent.prompt(command.goal);
        }
        await agent.waitForIdle();
      }
    } catch {
      failure = {
        status: run.cancelled ? "cancelled" : run.timedOut ? "timed_out" : "failed",
      };
    }

    try {
      if (run.sinkFailure !== undefined) {
        throw run.sinkFailure;
      }

      const awaitingApprovalOutcome = awaitingApproval && !run.cancelled && !run.timedOut
        ? { status: "awaiting_approval" as const }
        : undefined;
      return await this.finish(run, failure ?? awaitingApprovalOutcome);
    } finally {
      if (wallTimer !== undefined) {
        clearTimeout(wallTimer);
      }
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      this.runs.delete(command.runId);
    }
  }

  async steer(runId: RunId, message: ChannelMessage): Promise<void> {
    this.runs.get(runId)?.agent.steer(this.userMessage(message.content));
  }

  async answer(runId: RunId, answer: HumanAnswer): Promise<void> {
    this.runs.get(runId)?.agent.steer(this.userMessage(answer.content));
  }

  async abort(runId: RunId, _reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    run.cancelled = true;
    run.agent.abort();
  }

  private userMessage(content: string): AgentMessage {
    return {
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: this.now(),
    };
  }

  private async record(run: ActiveRun, event: AgentEvent): Promise<void> {
    if (run.sinkFailure !== undefined) {
      return;
    }
    switch (event.type) {
      case "agent_start":
        await this.append(run, run.restoredTranscript ? "run.resumed" : "run.started", {
          phase: run.restoredTranscript ? "resumed" : "started",
          executionFingerprint: executionFingerprintFor(run.command, this.options.model),
        });
        return;
      case "message_end":
        if (run.restoredTranscript || this.isDurableSink(run.sink)) {
          await this.append(run, "pi.transcript.message", {
            message: jsonSnapshot(event.message, "Pi transcript message"),
          });
        }
        return;
      case "message_start":
        if (event.message.role === "assistant") {
          await this.append(run, "run.progress", { phase: "model_response_started" });
        }
        return;
      case "message_update":
        if (event.message.role === "assistant") {
          await this.append(run, "run.progress", { phase: "model_response_updated" });
        }
        return;
      case "tool_execution_start":
        await this.append(run, "run.tool.started", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
        });
        return;
      case "tool_execution_end":
        await this.append(run, "run.tool.completed", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          outcome: event.isError ? "failed" : "succeeded",
        });
        if (!event.isError && event.toolName === "create_artifact") {
          const result = isRecord(event.result) ? event.result : undefined;
          const details = isRecord(result?.details) ? result.details : undefined;
          if (details?.artifact !== undefined) {
            await this.append(run, "create.artifact.created", {
              artifact: jsonSnapshot(details.artifact, "Create artifact"),
            });
          }
          if (details?.validation !== undefined) {
            await this.append(run, "create.artifact.validated", {
              validation: jsonSnapshot(details.validation, "Create validation"),
            });
          }
        }
        return;
      case "turn_end": {
        if (event.message.role !== "assistant") {
          return;
        }

        run.turns += 1;
        run.lastStopReason = event.message.stopReason;
        const usage = event.message.stopReason === "error" || event.message.stopReason === "aborted"
          ? undefined
          : this.canonicalUsage(event.message.usage);
        const payload: JsonValue = usage === undefined
          ? { phase: "turn_finished" }
          : { phase: "turn_finished", usage };
        await this.append(run, "run.progress", payload);
        if (usage !== undefined && isRecord(usage) && this.isDurableSink(run.sink)) {
          run.cumulativeUsage = mergeUsage(run.cumulativeUsage, numericUsage(usage));
          await this.append(run, "run.usage.updated", {
            phase: "usage_updated",
            cumulative: run.cumulativeUsage,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private shouldStopAfterTurn(run: ActiveRun, needsAnotherModelCall: boolean): boolean {
    const budget = run.command.budget;
    if (
      budget.wallTimeMs !== undefined &&
      this.now() - run.startedAt >= budget.wallTimeMs
    ) {
      run.timedOut = true;
      return true;
    }
    if (
      needsAnotherModelCall &&
      budget.turns !== undefined &&
      run.turns >= budget.turns
    ) {
      run.timedOut = true;
      return true;
    }
    return false;
  }

  private async finish(run: ActiveRun, override?: RunOutcome): Promise<RunOutcome> {
    if (run.terminal) {
      return override ?? this.outcome(run);
    }

    const outcome = override ?? this.outcome(run);
    run.terminal = true;
    await this.append(run, `run.${outcome.status}`, { outcome: outcome.status });
    return outcome;
  }

  private outcome(run: ActiveRun): RunOutcome {
    if (run.cancelled) {
      return { status: "cancelled" };
    }
    if (run.timedOut) {
      return { status: "timed_out" };
    }
    if (run.lastStopReason === "aborted") {
      return { status: "cancelled" };
    }
    if (run.lastStopReason === "error") {
      return { status: "failed" };
    }
    return { status: "completed" };
  }

  private canonicalUsage(usage: unknown): JsonValue | undefined {
    if (!isRecord(usage)) {
      return undefined;
    }

    const result: Record<string, number> = {};

    for (const field of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
      const value = usage[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        result[field] = value;
      }
    }

    if (isRecord(usage.cost)) {
      const total = usage.cost.total;
      if (typeof total === "number" && Number.isFinite(total) && total !== 0) {
        result.cost = total;
      }
    }

    return Object.keys(result).length === 0 ? undefined : result;
  }

  private async append(
    run: ActiveRun,
    type: string,
    payload: JsonValue,
  ): Promise<void> {
    const event: CanonicalEvent = {
      id: this.createId() as EventId,
      workspaceId: run.command.workspaceId,
      channelId: run.command.channelId,
      streamId: run.command.runId as unknown as StreamId,
      seq: run.seq,
      type,
      timestamp: new Date(this.now()).toISOString(),
      schemaVersion: 1,
      payload: this.withRunAttribution(run.command, payload),
    };
    run.seq += 1;
    try {
      await run.sink.append(event);
    } catch (error) {
      run.sinkFailure = error;
      run.agent.abort();
      throw error;
    }
  }

  private isDurableSink(sink: EventSink): boolean {
    return typeof (sink as ReadableEventSink).read === "function";
  }

  private withRunAttribution(command: StartRun, payload: JsonValue): JsonValue {
    if (command.parentRunId === undefined) {
      return payload;
    }
    if (!isRecord(payload)) {
      throw new Error("Run attribution requires an object event payload");
    }
    return {
      ...payload,
      parentRunId: command.parentRunId,
      parentEventId: command.parentEventId!,
      ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
    };
  }
}

function executionFingerprintFor(
  command: StartRun,
  model: Model<Api>,
): ExecutionFingerprint {
  const material = {
    provider: model.provider,
    model: model.id,
    runProfileHash: command.runProfileSnapshot.hash,
    systemPromptHash: sha256(systemPromptFor(command)),
  };
  return {
    algorithm: "sha256",
    ...material,
    hash: sha256(JSON.stringify(material)),
  };
}

function validateRestoredFingerprint(
  events: readonly CanonicalEvent[],
  expected: ExecutionFingerprint,
): void {
  const started = events.find((event) =>
    event.type === "run.started" || event.type === "run.resumed",
  );
  if (started === undefined) {
    return;
  }
  const payload = isRecord(started.payload) ? started.payload : undefined;
  const persisted = payload?.executionFingerprint;
  if (JSON.stringify(persisted) !== JSON.stringify(expected)) {
    throw new Error("Pi execution fingerprint mismatch");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function numericUsage(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) =>
      typeof field === "number" && Number.isFinite(field),
    ),
  ) as Record<string, number>;
}

function mergeUsage(
  existing: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const merged = { ...existing };
  for (const [field, value] of Object.entries(next)) {
    merged[field] = (merged[field] ?? 0) + value;
  }
  return merged;
}

function systemPromptFor(command: StartRun): string {
  const profile = command.runProfileSnapshot;
  return [
    "You are Anna. Complete the stated goal.",
    `Worker instructions:\n${profile.workerProfile.instructions}`,
    ...profile.skills.map((skill) => `Approved Skill ${skill.id} ${skill.version}:\n${skill.content}`),
  ].join("\n\n");
}
