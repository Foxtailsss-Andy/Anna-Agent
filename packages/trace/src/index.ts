import type {
  CanonicalEvent,
  ChannelScope,
  EventCursor,
  RunId,
  ScopedChannelStore,
  StreamId,
} from "@anna/harness-v2";

export type TraceStatus = "ok" | "error" | "unset";
export type TraceSpanKind = "agent" | "turn" | "inference" | "tool";
export type TraceAttributeValue = string | number | boolean | readonly (string | number | boolean)[];

export interface TraceSpanEvent {
  readonly name: string;
  readonly time: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface TraceSpan {
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly name: string;
  readonly kind: TraceSpanKind;
  readonly start_time: string;
  readonly end_time: string | null;
  readonly duration_ms: number;
  readonly status: TraceStatus;
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>;
  readonly events: readonly TraceSpanEvent[];
}

export interface TraceDocument {
  readonly trace_id: string;
  readonly surface: string;
  readonly spans: readonly TraceSpan[];
}

export interface ProjectTraceOptions {
  readonly runId: string;
  readonly surface: string;
  readonly scope: ChannelScope;
  readonly conversationId?: string;
}

export interface LiveTraceCursorOptions extends ProjectTraceOptions {
  readonly events: Pick<ScopedChannelStore, "read" | "listRunStreamIds">;
  readonly streamId: StreamId;
}

export interface LiveTraceSnapshot {
  readonly document: TraceDocument;
  readonly cursor: EventCursor | undefined;
  readonly cursors: readonly EventCursor[];
}

export interface LiveTraceCursor {
  read(): Promise<LiveTraceSnapshot>;
}

type MutableTraceSpan = Omit<TraceSpan, "attributes" | "events"> & {
  end_time: string | null;
  duration_ms: number;
  status: TraceStatus;
  attributes: Record<string, TraceAttributeValue>;
  events: TraceSpanEvent[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarAttributes(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean] => {
      const candidate = entry[1];
      return typeof candidate === "string"
        || typeof candidate === "boolean"
        || (typeof candidate === "number" && Number.isFinite(candidate));
    },
  ));
}

function span(
  spanId: string,
  parentSpanId: string | null,
  name: string,
  kind: TraceSpanKind,
  startTime: string,
  attributes: Record<string, TraceAttributeValue>,
): MutableTraceSpan {
  return {
    span_id: spanId,
    parent_span_id: parentSpanId,
    name,
    kind,
    start_time: startTime,
    end_time: null,
    duration_ms: 0,
    status: "unset",
    attributes,
    events: [],
  };
}

function closeSpan(target: MutableTraceSpan, timestamp: string, status: TraceStatus): void {
  if (target.end_time !== null) {
    return;
  }
  const duration = Date.parse(timestamp) - Date.parse(target.start_time);
  target.end_time = timestamp;
  target.duration_ms = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  target.status = status;
}

function eventBelongsToRun(
  event: CanonicalEvent,
  options: ProjectTraceOptions,
): boolean {
  if (
    event.workspaceId !== options.scope.workspaceId
    || event.channelId !== options.scope.channelId
  ) {
    return false;
  }
  if (event.streamId === options.runId) {
    return true;
  }
  if (!isRecord(event.payload)) {
    return false;
  }
  if (event.payload.parentRunId === options.runId) {
    return true;
  }
  if (event.payload.runId !== options.runId) {
    return false;
  }
  return event.streamId.startsWith(`tool:${options.runId}:`)
    || event.streamId.startsWith("effect:");
}

function compareEvents(
  left: { event: CanonicalEvent; index: number },
  right: { event: CanonicalEvent; index: number },
): number {
  return Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp)
    || left.event.streamId.localeCompare(right.event.streamId)
    || left.event.seq - right.event.seq
    || left.event.id.localeCompare(right.event.id)
    || left.index - right.index;
}

export function projectTrace(
  events: readonly CanonicalEvent[],
  options: ProjectTraceOptions,
): TraceDocument {
  const runEvents = events
    .filter((event) => eventBelongsToRun(event, options))
    .map((event, index) => ({ event, index }))
    .sort(compareEvents)
    .map(({ event }) => event);
  if (runEvents.length === 0) {
    return { trace_id: options.runId, surface: options.surface, spans: [] };
  }

  const root = span(
    "s1",
    null,
    `invoke_agent ${options.surface}`,
    "agent",
    runEvents[0]!.timestamp,
    {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": `anna.${options.surface}`,
      "gen_ai.conversation.id": options.conversationId
        ?? conversationIdFromEvent(runEvents, options.runId),
      "anna.turns": 0,
    },
  );
  const spans: MutableTraceSpan[] = [root];
  let currentTurn: MutableTraceSpan | undefined;
  let currentInference: MutableTraceSpan | undefined;
  const openTools = new Map<string, MutableTraceSpan>();
  const appendEvent = (event: CanonicalEvent): void => {
    const eventToolCallId = isRecord(event.payload)
      && typeof event.payload.toolCallId === "string"
      ? event.payload.toolCallId
      : undefined;
    const target = eventToolCallId === undefined
      ? undefined
      : openTools.get(eventToolCallId);
    const container = target ?? (currentInference?.end_time === null
      ? currentInference
      : currentTurn ?? root);
    container.events.push({
      name: event.type,
      time: event.timestamp,
      attributes: scalarAttributes(event.payload),
    });
  };

  for (const event of runEvents) {
    if (
      (event.type === "run.tool.started"
        || event.type === "run.tool.completed"
        || event.type === "tool.requested"
        || event.type === "tool.result")
      && isRecord(event.payload)
    ) {
      const toolCallId = typeof event.payload.toolCallId === "string"
        ? event.payload.toolCallId
        : event.id;
      if (event.type === "run.tool.started" || event.type === "tool.requested") {
        if (openTools.has(toolCallId)) {
          continue;
        }
        if (currentInference !== undefined) {
          closeSpan(currentInference, event.timestamp, "ok");
        }
        const toolName = typeof event.payload.tool === "string"
          ? event.payload.tool
          : "unknown";
        const toolSpan = span(
          `s${spans.length + 1}`,
          currentTurn?.span_id ?? root.span_id,
          `execute_tool ${toolName}`,
          "tool",
          event.timestamp,
          {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": toolName,
            "anna.tool.call_id": toolCallId,
          },
        );
        spans.push(toolSpan);
        openTools.set(toolCallId, toolSpan);
      } else {
        const toolSpan = openTools.get(toolCallId);
        if (toolSpan !== undefined) {
          const failed = event.payload.outcome === "failed"
            || event.payload.status === "failed"
            || event.payload.status === "unknown";
          closeSpan(toolSpan, event.timestamp, failed ? "error" : "ok");
          openTools.delete(toolCallId);
        } else {
          appendEvent(event);
        }
      }
      continue;
    }
    if (isRunTerminal(event.type) && event.streamId === options.runId) {
      const rootStatus = event.type === "run.completed"
        ? "ok"
        : event.type === "run.awaiting_input" || event.type === "run.awaiting_approval"
          ? "unset"
          : "error";
      for (const openSpan of [currentInference, ...openTools.values()]) {
        if (openSpan === undefined || openSpan.end_time !== null) {
          continue;
        }
        openSpan.attributes["anna.orphaned"] = true;
        closeSpan(openSpan, event.timestamp, "error");
      }
      if (currentTurn !== undefined && currentTurn.end_time === null) {
        closeSpan(
          currentTurn,
          event.timestamp,
          spans.some((candidate) =>
            candidate.parent_span_id === currentTurn?.span_id && candidate.status === "error"
          ) ? "error" : "ok",
        );
      }
      closeSpan(root, event.timestamp, rootStatus);
      continue;
    }
    if (isRunTerminal(event.type)) {
      appendEvent(event);
      continue;
    }
    if (event.type === "run.started" && event.streamId === options.runId) {
      continue;
    }
    if (event.type !== "run.progress" || !isRecord(event.payload)) {
      appendEvent(event);
      continue;
    }
    if (event.payload.phase === "turn_finished") {
      if (currentInference !== undefined) {
        const usage = isRecord(event.payload.usage) ? event.payload.usage : undefined;
        if (typeof usage?.input === "number" && Number.isFinite(usage.input)) {
          currentInference.attributes["gen_ai.usage.input_tokens"] = usage.input;
        }
        if (typeof usage?.output === "number" && Number.isFinite(usage.output)) {
          currentInference.attributes["gen_ai.usage.output_tokens"] = usage.output;
        }
        if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) {
          currentInference.attributes["anna.usage.cost"] = usage.cost;
        }
        closeSpan(currentInference, event.timestamp, "ok");
      }
      if (currentTurn !== undefined) {
        closeSpan(currentTurn, event.timestamp, "ok");
      }
      currentInference = undefined;
      currentTurn = undefined;
      continue;
    }
    if (event.payload.phase !== "model_response_started") {
      appendEvent(event);
      continue;
    }

    currentTurn = span(
      `s${spans.length + 1}`,
      root.span_id,
      `turn ${spans.filter((candidate) => candidate.kind === "turn").length + 1}`,
      "turn",
      event.timestamp,
      {},
    );
    spans.push(currentTurn);
    const model = typeof event.payload.model === "string" ? event.payload.model : undefined;
    currentInference = span(
      `s${spans.length + 1}`,
      currentTurn.span_id,
      model === undefined ? "chat" : `chat ${model}`,
      "inference",
      event.timestamp,
      {
        "gen_ai.operation.name": "chat",
        ...(model === undefined ? {} : { "gen_ai.request.model": model }),
      },
    );
    spans.push(currentInference);
    root.attributes["anna.turns"] =
      spans.filter((candidate) => candidate.kind === "turn").length;
  }

  return { trace_id: options.runId, surface: options.surface, spans };
}

export function createLiveTraceCursor(
  options: LiveTraceCursorOptions,
): LiveTraceCursor {
  const events: CanonicalEvent[] = [];
  const lastSeqByStream = new Map<StreamId, number>();

  return {
    async read(): Promise<LiveTraceSnapshot> {
      const streamIds = new Set<StreamId>([
        options.streamId,
        ...(await options.events.listRunStreamIds(options.runId as RunId)),
      ]);
      for (const streamId of [...streamIds].sort()) {
        const lastSeq = lastSeqByStream.get(streamId) ?? -1;
        for await (const event of options.events.read(
          streamId,
          lastSeq < 0 ? undefined : lastSeq,
        )) {
          if (event.seq <= lastSeqByStream.get(streamId)!) {
            continue;
          }
          events.push(event);
          lastSeqByStream.set(streamId, event.seq);
        }
      }

      const cursors = [...lastSeqByStream.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([streamId, seq]) => ({ streamId, seq }));
      return {
        document: projectTrace(events, options),
        cursor: lastSeqByStream.has(options.streamId)
          ? {
            streamId: options.streamId,
            seq: lastSeqByStream.get(options.streamId)!,
          }
          : undefined,
        cursors,
      };
    },
  };
}

function conversationIdFromEvent(
  events: readonly CanonicalEvent[],
  fallback: string,
): string {
  for (const event of events) {
    if (!isRecord(event.payload)) {
      continue;
    }
    const threadId = event.payload.thread_id ?? event.payload.threadId;
    if (typeof threadId === "string" && threadId.length > 0) {
      return threadId;
    }
  }
  for (const event of events) {
    if (!isRecord(event.payload)) {
      continue;
    }
    const conversationId = event.payload.conversation_id ?? event.payload.conversationId;
    if (typeof conversationId === "string" && conversationId.length > 0) {
      return conversationId;
    }
  }
  return fallback;
}

function isRunTerminal(type: string): boolean {
  return type === "run.completed"
    || type === "run.awaiting_input"
    || type === "run.awaiting_approval"
    || type === "run.failed"
    || type === "run.timed_out"
    || type === "run.cancelled";
}
