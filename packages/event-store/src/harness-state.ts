import type {
  CanonicalEvent,
  JsonValue,
  RunId,
  ScopedChannelStore,
  StreamId,
} from "@anna/harness-v2";

import { projectNext } from "./projection-runner";

export interface HarnessState {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly parentEventId?: string;
  readonly laneId?: string;
  readonly status: "queued" | "running" | "completed" | "awaiting_input" | "awaiting_approval" | "failed" | "timed_out" | "cancelled";
  readonly lastSeq: number;
  readonly lastEventType?: string;
}

const TERMINAL_STATUS: Record<string, HarnessState["status"]> = {
  "run.completed": "completed",
  "run.awaiting_input": "awaiting_input",
  "run.awaiting_approval": "awaiting_approval",
  "run.failed": "failed",
  "run.timed_out": "timed_out",
  "run.cancelled": "cancelled",
};

function record(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value;
}

function initialState(runId: RunId): HarnessState {
  return { runId, status: "queued", lastSeq: -1 };
}

function reduce(state: HarnessState, event: CanonicalEvent): HarnessState {
  const payload = record(event.payload);
  const parentRunId = typeof payload.parentRunId === "string"
    ? payload.parentRunId
    : state.parentRunId;
  const parentEventId = typeof payload.parentEventId === "string"
    ? payload.parentEventId
    : state.parentEventId;
  const laneId = typeof payload.laneId === "string" ? payload.laneId : state.laneId;
  const terminalStatus = TERMINAL_STATUS[event.type];
  return {
    ...state,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(parentEventId === undefined ? {} : { parentEventId }),
    ...(laneId === undefined ? {} : { laneId }),
    status: terminalStatus ?? (
      event.type === "run.started"
      || event.type === "run.resumed"
      || event.type === "run.progress"
        ? "running"
        : state.status
    ),
    lastSeq: event.seq,
    lastEventType: event.type,
  };
}

export async function projectHarnessState(
  store: ScopedChannelStore,
  runId: string,
): Promise<HarnessState> {
  const streamId = runId as StreamId;
  const command = await store.getRunCommand(runId as RunId);
  const seed = initialState(runId as RunId);
  const seeded = command?.parentRunId === undefined
    ? seed
    : {
      ...seed,
      parentRunId: command.parentRunId,
      parentEventId: command.parentEventId,
      ...(command.laneId === undefined ? {} : { laneId: command.laneId }),
    };
  while (await projectNext(
    store,
    "harness-state",
    streamId,
    seeded as unknown as JsonValue,
    (state, event) => reduce(state as unknown as HarnessState, event) as unknown as JsonValue,
  ) !== undefined) {
    // Drain all events after the persisted cursor; each commit advances lastSeq.
  }
  const snapshot = await store.loadProjection("harness-state", streamId);
  return (snapshot?.state ?? seeded) as unknown as HarnessState;
}

export async function projectRunFamilyHarnessState(
  store: ScopedChannelStore,
  parentRunId: string,
): Promise<readonly HarnessState[]> {
  const streamIds = await store.listRunStreamIds(parentRunId as RunId);
  const ids = new Set<string>([parentRunId, ...streamIds.map(String)]);
  const states = await Promise.all([...ids].map((runId) => projectHarnessState(store, runId)));
  return states.sort((left, right) => left.runId.localeCompare(right.runId));
}
