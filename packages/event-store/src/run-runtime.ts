import type {
  CanonicalEvent,
  EventId,
  EventStore,
  LoopKernel,
  Run,
  RunId,
  RunOutcome,
  ScopedChannelStore,
  StartRun,
  StreamId,
} from "@anna/harness-v2";

import { RunManager } from "./run-manager";

const terminalEventTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
]);

function outcomeForTerminalEvent(event: CanonicalEvent): RunOutcome | undefined {
  switch (event.type) {
    case "run.completed":
      return { status: "completed" };
    case "run.awaiting_input":
      return { status: "awaiting_input" };
    case "run.awaiting_approval":
      return { status: "awaiting_approval" };
    case "run.failed":
      return { status: "failed" };
    case "run.timed_out":
      return { status: "timed_out" };
    case "run.cancelled":
      return { status: "cancelled" };
    default:
      return undefined;
  }
}

export class RunResumeRequiredError extends Error {
  constructor(runId: RunId) {
    super(`Run ${runId} is already running; call resume(command) explicitly`);
    this.name = "RunResumeRequiredError";
  }
}

export interface DurableRunHandle {
  readonly run: Run;
  readonly completion: Promise<RunOutcome>;
}

export interface DurableRunRuntimeDependencies {
  readonly now?: () => string;
  readonly createEventId?: () => EventId;
}

/**
 * Binds command claiming, durable lifecycle events, and one LoopKernel drive.
 * Recovery is explicit: a persisted running Run is never restarted by start().
 */
export class DurableRunRuntime {
  private readonly now: () => string;
  private readonly createEventId: () => EventId;
  private readonly active = new Map<string, DurableRunHandle>();
  private readonly inFlight = new Map<string, Promise<DurableRunHandle>>();

  constructor(
    private readonly eventStore: EventStore,
    private readonly kernel: LoopKernel,
    dependencies: DurableRunRuntimeDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createEventId = dependencies.createEventId
      ?? (() => crypto.randomUUID() as EventId);
  }

  start(
    command: StartRun,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DurableRunHandle> {
    return this.begin(command, signal, false);
  }

  resume(
    command: StartRun,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DurableRunHandle> {
    return this.begin(command, signal, true);
  }

  private begin(
    command: StartRun,
    signal: AbortSignal,
    allowRunning: boolean,
  ): Promise<DurableRunHandle> {
    const runtimeKey = keyFor(command);

    const inFlight = this.inFlight.get(runtimeKey);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const pending = this.beginOnce(command, signal, allowRunning);
    this.inFlight.set(runtimeKey, pending);
    void pending.then(
      () => this.clearInFlight(runtimeKey, pending),
      () => this.clearInFlight(runtimeKey, pending),
    );
    return pending;
  }

  private clearInFlight(runtimeKey: string, pending: Promise<DurableRunHandle>): void {
    if (this.inFlight.get(runtimeKey) === pending) {
      this.inFlight.delete(runtimeKey);
    }
  }

  private async beginOnce(
    command: StartRun,
    signal: AbortSignal,
    allowRunning: boolean,
  ): Promise<DurableRunHandle> {
    const store = this.eventStore.scope(command);
    const manager = new RunManager(store, {
      now: this.now,
      createEventId: this.createEventId,
    });
    await manager.start(command);
    const current = await manager.get(command.runId);
    if (current === undefined) {
      throw new Error(`Claimed Run ${command.runId} cannot be rebuilt`);
    }

    if (current.outcome !== undefined && !isSuspendedOutcome(current.outcome)) {
      return {
        run: current,
        completion: Promise.resolve(current.outcome),
      };
    }

    if (current.outcome !== undefined && !allowRunning) {
      return {
        run: current,
        completion: Promise.resolve(current.outcome),
      };
    }

    const runtimeKey = keyFor(command);
    const active = this.active.get(runtimeKey);
    if (active !== undefined) {
      return active;
    }

    if (current.status === "running" && !allowRunning) {
      throw new RunResumeRequiredError(command.runId);
    }

    await this.ensureQueued(store, command);
    const queued = await manager.get(command.runId);
    if (queued === undefined || (
      queued.outcome !== undefined && !isSuspendedOutcome(queued.outcome)
    )) {
      throw new Error(`Run ${command.runId} became terminal before it started`);
    }

    const completion = this.drive(command, store, signal);
    const handle: DurableRunHandle = { run: queued, completion };
    this.active.set(runtimeKey, handle);
    void completion.then(
      () => this.clearActive(runtimeKey, handle),
      () => this.clearActive(runtimeKey, handle),
    );
    return handle;
  }

  private clearActive(runtimeKey: string, handle: DurableRunHandle): void {
    if (this.active.get(runtimeKey) === handle) {
      this.active.delete(runtimeKey);
    }
  }

  private async ensureQueued(
    store: ScopedChannelStore,
    command: StartRun,
  ): Promise<void> {
    const events = await readEvents(store, command.runId);
    if (events.length > 0) {
      return;
    }

    await store.append(this.event(command, 0, "run.queued", {
      phase: "queued",
      ...runAttribution(command),
    }));
  }

  private async drive(
    command: StartRun,
    store: ScopedChannelStore,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    try {
      const outcome = await this.kernel.start(command, store, signal);
      const events = await readEvents(store, command.runId);
      const last = events.at(-1);
      if (last !== undefined && terminalEventTypes.has(last.type)) {
        return outcomeForTerminalEvent(last)!;
      }
      if (last !== undefined && isSuspendedEvent(last.type)) {
        return outcomeForTerminalEvent(last)!;
      }
      await store.append(this.event(
        command,
        events.length,
        `run.${outcome.status}`,
        { outcome: outcome.status, ...runAttribution(command) },
      ));
      return outcome;
    } catch {
      const events = await readEvents(store, command.runId);
      const last = events.at(-1);
      if (last !== undefined && terminalEventTypes.has(last.type)) {
        return outcomeForTerminalEvent(last)!;
      }
      if (last !== undefined && isSuspendedEvent(last.type)) {
        return outcomeForTerminalEvent(last)!;
      }
      await store.append(this.event(
        command,
        events.length,
        "run.failed",
        { errorType: "runtime_bridge_failed", ...runAttribution(command) },
      ));
      return { status: "failed" };
    }
  }

  private event(
    command: StartRun,
    seq: number,
    type: string,
    payload: CanonicalEvent["payload"],
  ): CanonicalEvent {
    return {
      id: this.createEventId(),
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      streamId: command.runId as unknown as StreamId,
      seq,
      type,
      timestamp: this.now(),
      schemaVersion: 1,
      payload,
    };
  }
}

function isSuspendedEvent(type: string): boolean {
  return type === "run.awaiting_input" || type === "run.awaiting_approval";
}

function isSuspendedOutcome(outcome: RunOutcome): boolean {
  return outcome.status === "awaiting_input" || outcome.status === "awaiting_approval";
}

async function readEvents(
  store: ScopedChannelStore,
  runId: RunId,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.read(runId as unknown as StreamId)) {
    events.push(event);
  }
  return events;
}

function runAttribution(command: StartRun): Record<string, string> {
  if (command.parentRunId === undefined) {
    return {};
  }
  return {
    parentRunId: command.parentRunId,
    parentEventId: command.parentEventId!,
    ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
  };
}

function keyFor(command: StartRun): string {
  return `${command.workspaceId}\u0000${command.channelId}\u0000${command.runId}`;
}
