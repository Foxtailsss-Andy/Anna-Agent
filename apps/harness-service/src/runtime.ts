import type {
  CanonicalEvent,
  ChannelScope,
  EventStore,
  EventSink,
  LoopKernel,
  ResolvedRunProfile,
  StartRun,
  RunOutcome,
} from "@anna/harness-v2";
import { parseStartRun } from "@anna/harness-v2";
import { DurableRunRuntime } from "@anna/event-store";
import { evaluateContract, type ContractEvalResult } from "@anna/eval";

import type { HarnessV2Runtime, V2SurfaceId } from "./index";

export interface DurableHarnessV2RuntimeOptions {
  readonly eventStore: EventStore;
  readonly kernel: LoopKernel;
  readonly profile: ResolvedRunProfile;
  readonly surfaceProfiles?: Partial<Record<V2SurfaceId, ResolvedRunProfile>>;
  readonly surfaces: readonly V2SurfaceId[];
  readonly evidenceMode?: HarnessV2Runtime["evidenceMode"];
  readonly permissionScope?: string;
  readonly webSearchConfigured?: boolean;
  readonly reviewGateConfigured?: boolean;
}

export function createDurableHarnessV2Runtime(
  options: DurableHarnessV2RuntimeOptions,
): HarnessV2Runtime {
  const runtime = new DurableRunRuntime(
    options.eventStore,
    options.profile.evalPolicy.contract === "required"
      ? withContractEval(options.kernel)
      : options.kernel,
  );
  const permissionScope = options.permissionScope ?? "permission:harness-v2";

  return {
    evidenceMode: options.evidenceMode ?? "test",
    surfaces: [...options.surfaces],
    webSearchConfigured: options.webSearchConfigured ?? false,
    reviewGateConfigured: options.reviewGateConfigured ?? false,
    async start(surfaceId, body) {
      if (!options.surfaces.includes(surfaceId)) {
        throw new Error("v2 surface is not enabled by this Runtime");
      }

      const command = commandFromRequest(
        surfaceId,
        body,
        options.surfaceProfiles?.[surfaceId] ?? options.profile,
        permissionScope,
      );
      const handle = await runtime.start(command);
      return { runId: command.runId, status: handle.run.status };
    },
    async resume(surfaceId, runId, body) {
      if (!options.surfaces.includes(surfaceId)) {
        throw new Error("v2 surface is not enabled by this Runtime");
      }

      const request = requestRecord(body);
      const workspaceId = requiredString(request.workspace_id, "workspace_id");
      const channelId = requiredString(request.channel_id, "channel_id");
      const command = await options.eventStore
        .scope({
          workspaceId: workspaceId as ChannelScope["workspaceId"],
          channelId: channelId as ChannelScope["channelId"],
        })
        .getRunCommand(runId as never);
      if (command === undefined) {
        throw new Error("v2 Run is not present in the requested Channel scope");
      }
      if (command.surfaceId !== undefined && command.surfaceId !== surfaceId) {
        throw new Error("v2 Run surface does not match the resume route");
      }
      const handle = await runtime.resume(command);
      return { runId: command.runId, status: handle.run.status };
    },
    async readEvents(workspaceId, channelId, runId, fromSeq = -1) {
      if (!Number.isSafeInteger(fromSeq) || fromSeq < -1) {
        throw new Error("from_seq must be an integer greater than or equal to -1");
      }
      const scope: ChannelScope = {
        workspaceId: workspaceId as ChannelScope["workspaceId"],
        channelId: channelId as ChannelScope["channelId"],
      };
      const store = options.eventStore.scope(scope);
      if (await store.getRunCommand(runId as never) === undefined) {
        throw new Error("Run is outside the requested Channel scope");
      }

      const events: CanonicalEvent[] = [];
      for await (const event of store.read(runId as never, fromSeq)) {
        events.push(event);
      }
      return events;
    },
  };
}

function withContractEval(kernel: LoopKernel): LoopKernel {
  return {
    async start(command, sink, signal): Promise<RunOutcome> {
      let terminalEvent: CanonicalEvent | undefined;
      const durableSink = sink as EventSink & {
        read?: (streamId: never, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
      };
      const evalSink = {
        append: async (event: CanonicalEvent): Promise<void> => {
          if (isTerminalEvent(event.type)) {
            terminalEvent = event;
            return;
          }
          await sink.append(event);
        },
        ...(typeof durableSink.read === "function"
          ? { read: durableSink.read.bind(durableSink) }
          : {}),
      } as EventSink & {
        read?: (streamId: never, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
      };
      let outcome: RunOutcome;
      try {
        outcome = await kernel.start(command, evalSink, signal);
      } catch {
        outcome = { status: "failed" };
      }
      let events: CanonicalEvent[] = [];
      let result: ContractEvalResult;
      try {
        events = await readEvents(sink, command.runId);
        const evidenceEvents = terminalEvent === undefined
          ? events
          : [...events, terminalEvent];
        result = evaluateContract(
          { traceId: command.runId, events: evidenceEvents, artifacts: [] },
          { requiredEventTypes: ["run.started"], requireTerminal: true },
        );
      } catch {
        result = {
          passed: false,
          version: "contract-1",
          reason: "invalid_evidence",
          failedRules: ["eval_runtime_error"],
          checkedEventIds: events.map((event) => event.id),
        };
      }
      const nextSeq = events.reduce((next, event) => Math.max(next, event.seq + 1), 0);
      await sink.append({
        id: crypto.randomUUID() as CanonicalEvent["id"],
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        streamId: command.runId as never,
        seq: nextSeq,
        type: "run.eval.contract",
        timestamp: new Date().toISOString(),
        schemaVersion: 1,
        payload: {
          passed: result.passed,
          version: result.version,
          failedRules: [...result.failedRules],
        },
      });
      if (terminalEvent !== undefined) {
        await sink.append({
          ...terminalEvent,
          seq: nextSeq + 1,
          type: result.passed ? terminalEvent.type : "run.failed",
          payload: result.passed
            ? terminalEvent.payload
            : { outcome: "failed", reason: "contract_eval_failed" },
        });
      }
      return result.passed ? outcome : { status: "failed" };
    },
    steer: (runId, message) => kernel.steer(runId, message),
    answer: (runId, answer) => kernel.answer(runId, answer),
    abort: (runId, reason) => kernel.abort(runId, reason),
  };
}

function isTerminalEvent(type: string): boolean {
  return [
    "run.completed",
    "run.awaiting_input",
    "run.awaiting_approval",
    "run.failed",
    "run.timed_out",
    "run.cancelled",
  ].includes(type);
}

async function readEvents(
  sink: EventSink & { read?: (streamId: never) => AsyncIterable<CanonicalEvent> },
  runId: string,
): Promise<CanonicalEvent[]> {
  if (typeof sink.read !== "function") {
    throw new Error("Contract Eval requires a durable event reader");
  }
  const events: CanonicalEvent[] = [];
  for await (const event of sink.read(runId as never)) {
    events.push(event);
  }
  return events;
}

function commandFromRequest(
  surfaceId: V2SurfaceId,
  input: unknown,
  profile: ResolvedRunProfile,
  permissionScope: string,
): StartRun {
  const body = requestRecord(input);
  const workspaceId = requiredString(body.workspace_id, "workspace_id");
  const channelId = requiredString(body.channel_id, "channel_id");
  const commandId = requiredString(body.command_id, "command_id");
  const sourceEventId = requiredString(body.source_event_id, "source_event_id");
  const goal = requiredString(body.goal, "goal");
  const runId = optionalString(body.run_id) ?? `run:${surfaceId}:${commandId}`;

  return parseStartRun({
    workspaceId,
    channelId,
    commandId,
    runId,
    surfaceId,
    goal,
    source: { eventId: sourceEventId },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope,
    stopCondition: profile.terminalRules.stopCondition,
    ...(optionalString(body.parent_run_id) === undefined
      ? {}
      : {
          parentRunId: body.parent_run_id,
          parentEventId: requiredString(body.parent_event_id, "parent_event_id"),
          ...(optionalString(body.lane_id) === undefined ? {} : { laneId: body.lane_id }),
        }),
  });
}

function requestRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("v2 run body must be a JSON object");
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (result === undefined) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
