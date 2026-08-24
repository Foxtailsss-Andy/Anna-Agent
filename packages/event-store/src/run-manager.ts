import type {
  CanonicalEvent,
  EventId,
  Run,
  RunId,
  RunOutcome,
  ScopedChannelStore,
  StartRun,
  StreamId,
} from "@anna/harness-v2";

import {
  EventSequenceConflictError,
  TerminalEventConflictError,
} from "./errors";
import { isTerminalEvent, isTerminalRunState, terminalOutcome } from "./lifecycle";

function runFields(command: StartRun) {
  return {
    id: command.runId,
    goal: command.goal,
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    source: command.source,
    runProfile: command.runProfile,
    runProfileSnapshot: command.runProfileSnapshot,
    budget: command.budget,
    permissionScope: command.permissionScope,
    stopCondition: command.stopCondition,
    ...(command.parentRunId === undefined
      ? {}
      : { parentRunId: command.parentRunId, parentEventId: command.parentEventId! }),
    ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
    ...(command.trigger === undefined
      ? {}
      : { trigger: command.trigger, notificationAudience: command.notificationAudience! }),
  };
}

function activeRun(command: StartRun, status: "queued" | "running"): Run {
  return { ...runFields(command), status };
}

function terminalRun(command: StartRun, outcome: RunOutcome): Run {
  switch (outcome.status) {
    case "completed":
      return { ...runFields(command), status: "completed", outcome };
    case "awaiting_input":
      return { ...runFields(command), status: "awaiting_input", outcome };
    case "awaiting_approval":
      return { ...runFields(command), status: "awaiting_approval", outcome };
    case "failed":
      return { ...runFields(command), status: "failed", outcome };
    case "timed_out":
      return { ...runFields(command), status: "timed_out", outcome };
    case "cancelled":
      return { ...runFields(command), status: "cancelled", outcome };
  }
}

export interface RunManagerDependencies {
  now?: () => string;
  createEventId?: () => EventId;
}

export class RunManager {
  private readonly now: () => string;
  private readonly createEventId: () => EventId;

  constructor(
    private readonly store: ScopedChannelStore,
    dependencies: RunManagerDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createEventId = dependencies.createEventId ?? (() => crypto.randomUUID() as EventId);
  }

  async start(command: StartRun): Promise<Run> {
    if (command.parentRunId !== undefined) {
      const parent = await this.store.getRunCommand(command.parentRunId);
      if (parent === undefined) {
        throw new Error(`Parent Run ${command.parentRunId} is not claimed in this Channel`);
      }
    }
    const claimed = await this.store.claimStart(command);
    return (await this.get(claimed.runId))!;
  }

  async get(runId: RunId): Promise<Run | undefined> {
    const command = await this.store.getRunCommand(runId);
    if (command === undefined) {
      return undefined;
    }

    let status: "queued" | "running" = "queued";
    let suspendedOutcome: RunOutcome | undefined;
    for await (const event of this.store.read(runId as unknown as StreamId)) {
      const outcome = terminalOutcome(event.type);
      if (outcome !== undefined) {
        if (isTerminalEvent(event.type)) {
          return terminalRun(command, outcome);
        }
        suspendedOutcome = outcome;
        continue;
      }
      if (
        event.type === "run.started"
        || event.type === "run.resumed"
        || event.type === "run.progress"
      ) {
        status = "running";
        suspendedOutcome = undefined;
      }
    }
    if (suspendedOutcome !== undefined) {
      return terminalRun(command, suspendedOutcome);
    }
    return activeRun(command, status);
  }

  async reconcile(): Promise<void> {
    for (const runId of await this.store.activeRunIds()) {
      const run = await this.get(runId);
      if (run?.status !== "running") {
        continue;
      }

      const events: CanonicalEvent[] = [];
      for await (const event of this.store.read(runId as unknown as StreamId)) {
        events.push(event);
      }
      try {
        await this.store.append({
          id: this.createEventId(),
          workspaceId: run.workspaceId,
          channelId: run.channelId,
          streamId: runId as unknown as StreamId,
          seq: events.length,
          type: "run.failed",
          timestamp: this.now(),
          schemaVersion: 1,
          payload: { errorType: "process_restarted" },
        });
      } catch (error) {
        if (
          !(error instanceof EventSequenceConflictError)
          && !(error instanceof TerminalEventConflictError)
        ) {
          throw error;
        }

        const refreshed = await this.get(runId);
        if (refreshed !== undefined && isTerminalRunState(refreshed.status)) {
          continue;
        }
        throw error;
      }
    }
  }
}
