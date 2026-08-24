import {
  SchemaValidationError,
  expectNonEmptyString,
  expectNonNegativeInteger,
  expectPositiveFiniteNumber,
  expectPositiveInteger,
  expectRecord,
  type Schema,
} from "./schema";
import { parseResolvedRunProfileSnapshot } from "./run-profile";
import type { ResolvedRunProfile } from "./run-profile";

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ChannelId = Brand<string, "ChannelId">;
export type ChannelSessionId = Brand<string, "ChannelSessionId">;
export type RunId = Brand<string, "RunId">;
export type EventId = Brand<string, "EventId">;
export type StreamId = Brand<string, "StreamId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type MemoryCandidateId = Brand<string, "MemoryCandidateId">;
export type RunProfileId = Brand<string, "RunProfileId">;
export type PermissionScopeId = Brand<string, "PermissionScopeId">;
export type CommandId = Brand<string, "CommandId">;
export type WorkerProfileId = Brand<string, "WorkerProfileId">;
export type LaneId = Brand<string, "LaneId">;
export type ActorId = Brand<string, "ActorId">;
export type ScheduleId = Brand<string, "ScheduleId">;
export type OccurrenceId = Brand<string, "OccurrenceId">;
export type NotificationId = Brand<string, "NotificationId">;

export interface ChannelScope {
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}

export interface ChannelSession extends ChannelScope {
  id: ChannelSessionId;
}

export interface EventSource {
  eventId: EventId;
}

export interface RunProfileRef {
  id: RunProfileId;
  version: string;
}

export interface Budget {
  wallTimeMs?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  toolCalls?: number;
  retryAttempts?: number;
  concurrentChildLanes?: number;
}

export interface StartRun extends ChannelScope {
  commandId: CommandId;
  runId: RunId;
  surfaceId?: string;
  goal: string;
  source: EventSource;
  runProfile: RunProfileRef;
  runProfileSnapshot: RunProfileSnapshot;
  budget: Budget;
  permissionScope: PermissionScopeId;
  stopCondition: string;
  parentRunId?: RunId;
  parentEventId?: EventId;
  laneId?: LaneId;
  trigger?: ScheduleTrigger;
  notificationAudience?: readonly ActorId[];
}

export interface ScheduleRun extends StartRun {
  trigger: ScheduleTrigger;
  notificationAudience: readonly ActorId[];
}

export type ScheduleTrigger =
  | { kind: "explicit"; label: string }
  | { kind: "unresolved_thread_sla"; threadId: string; deadlineAt: string }
  | { kind: "waiting_node_deadline"; nodeId: string; deadlineAt: string }
  | { kind: "connector_event"; connector: string; eventType: string; registrationId: string }
  | { kind: "monitor"; monitorId: string; label: string };

export type ScheduleCatchUpPolicy = "skip" | "run_latest";
export type ScheduleStatus = "active" | "cancelled" | "completed";

export interface ScheduleRecurrence {
  kind: "fixed_interval";
  intervalMs: number;
}

export type ScheduledRunSpec = Omit<ScheduleRun, "commandId" | "runId">;

export interface ScheduleRecord extends ChannelScope {
  id: ScheduleId;
  kind: ScheduleTrigger["kind"];
  trigger: ScheduleTrigger;
  dueAt: string;
  catchUpPolicy: ScheduleCatchUpPolicy;
  status: ScheduleStatus;
  run: ScheduledRunSpec;
  recurrence?: ScheduleRecurrence;
}

export interface ScheduleOccurrence extends ChannelScope {
  id: OccurrenceId;
  scheduleId: ScheduleId;
  dueAt: string;
  runId: RunId;
  commandId: CommandId;
  claimedAt: string;
  status?: "claimed" | "started" | "skipped";
}

export type ScheduleOccurrenceClaim =
  | { claimed: true; occurrence: ScheduleOccurrence }
  | { claimed: false; reason: "already_claimed"; occurrence: ScheduleOccurrence }
  | { claimed: false; reason: "schedule_inactive" };

export interface ScheduleNotification extends ChannelScope {
  id: NotificationId;
  scheduleId: ScheduleId;
  occurrenceId: OccurrenceId;
  runId: RunId;
  trigger: ScheduleTrigger;
  audience: readonly ActorId[];
  createdAt: string;
}

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunProfileSnapshot = ResolvedRunProfile;

export interface CanonicalEvent extends ChannelScope {
  id: EventId;
  streamId: StreamId;
  seq: number;
  type: string;
  timestamp: string;
  schemaVersion: number;
  payload: JsonValue;
}

export interface Artifact extends ChannelScope {
  id: ArtifactId;
  runId: RunId;
  kind: string;
  uri: string;
  hash: string;
  version: string;
  validationStatus: string;
  reviewState: string;
}

export interface MemoryCandidate extends ChannelScope {
  id: MemoryCandidateId;
  content: string;
  sourceEventIds: EventId[];
}

export type RunOutcome =
  | { status: "completed" }
  | { status: "awaiting_input" }
  | { status: "awaiting_approval" }
  | { status: "failed" }
  | { status: "timed_out" }
  | { status: "cancelled" };

export type RunState = "queued" | "running" | RunOutcome["status"];

interface RunFields extends ChannelScope {
  id: RunId;
  goal: string;
  source: EventSource;
  runProfile: RunProfileRef;
  runProfileSnapshot: RunProfileSnapshot;
  budget: Budget;
  permissionScope: PermissionScopeId;
  stopCondition: string;
  parentRunId?: RunId;
  parentEventId?: EventId;
  laneId?: LaneId;
  trigger?: ScheduleTrigger;
  notificationAudience?: readonly ActorId[];
}

export type Run =
  | (RunFields & { status: "queued" | "running"; outcome?: never })
  | (RunFields & { status: RunOutcome["status"]; outcome: RunOutcome });

function parseId<Name extends string>(input: unknown, name: string): Brand<string, Name> {
  return expectNonEmptyString(input, name) as Brand<string, Name>;
}

function parseTimestamp(input: unknown, name: string): string {
  const timestamp = expectNonEmptyString(input, name);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new SchemaValidationError(`${name} must be a parseable timestamp`);
  }

  return timestamp;
}

export function parseBudget(input: unknown): Budget {
  const value = expectRecord(input, "budget");
  const budget: Budget = {};
  const integerFields = [
    "wallTimeMs",
    "turns",
    "inputTokens",
    "outputTokens",
    "toolCalls",
    "retryAttempts",
    "concurrentChildLanes",
  ] as const;

  for (const field of integerFields) {
    if (value[field] !== undefined) {
      budget[field] = expectPositiveInteger(value[field], `budget.${field}`);
    }
  }

  if (value.cost !== undefined) {
    budget.cost = expectPositiveFiniteNumber(value.cost, "budget.cost");
  }

  if (Object.keys(budget).length === 0) {
    throw new SchemaValidationError("budget must define at least one limit");
  }

  return budget;
}

function budgetsMatch(expected: Budget, actual: Budget): boolean {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].every((key) => expected[key as keyof Budget] === actual[key as keyof Budget]);
}

function assertRunProfileExecutionContract(
  snapshot: RunProfileSnapshot,
  budget: Budget,
  stopCondition: string,
  name: string,
): void {
  if (!budgetsMatch(snapshot.budget, budget)) {
    throw new SchemaValidationError(
      `${name}.budget must match RunProfileSnapshot.budget`,
    );
  }
  if (stopCondition !== snapshot.terminalRules.stopCondition) {
    throw new SchemaValidationError(
      `${name}.stopCondition must match RunProfileSnapshot.terminalRules.stopCondition`,
    );
  }
}

export const budgetSchema: Schema<Budget> = {
  parse: parseBudget,
};

export function parseJsonValue(input: unknown, name = "JsonValue"): JsonValue {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string"
  ) {
    return input;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new SchemaValidationError(`${name} must contain only JSON values`);
    }

    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item, index) => parseJsonValue(item, `${name}[${index}]`));
  }

  if (typeof input === "object" && input !== null) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        parseJsonValue(value, `${name}.${key}`),
      ]),
    );
  }

  throw new SchemaValidationError(`${name} must contain only JSON values`);
}

export const startRunSchema: Schema<StartRun> = {
  parse(input: unknown): StartRun {
    const value = expectRecord(input, "StartRun");
    const source = expectRecord(value.source, "StartRun.source");
    const runProfile = expectRecord(value.runProfile, "StartRun.runProfile");
    const parsedRunProfile: RunProfileRef = {
      id: parseId<"RunProfileId">(runProfile.id, "StartRun.runProfile.id"),
      version: expectNonEmptyString(
        runProfile.version,
        "StartRun.runProfile.version",
      ),
    };
    const runProfileSnapshot = parseResolvedRunProfileSnapshot(
      value.runProfileSnapshot,
    );
    if (
      runProfileSnapshot.id !== parsedRunProfile.id
      || runProfileSnapshot.version !== parsedRunProfile.version
    ) {
      throw new SchemaValidationError(
        "StartRun.runProfileSnapshot must match StartRun.runProfile identity and version",
      );
    }

    const budget = parseBudget(value.budget);
    const stopCondition = expectNonEmptyString(
      value.stopCondition,
      "StartRun.stopCondition",
    );
    assertRunProfileExecutionContract(
      runProfileSnapshot,
      budget,
      stopCondition,
      "StartRun",
    );
    const trigger = value.trigger === undefined ? undefined : parseScheduleTrigger(value.trigger);
    const audience = value.notificationAudience === undefined
      ? undefined
      : (() => {
        if (!Array.isArray(value.notificationAudience)) {
          throw new SchemaValidationError("StartRun.notificationAudience must be an array");
        }
        return value.notificationAudience.map((item, index) =>
          parseId<"ActorId">(item, `StartRun.notificationAudience[${index}]`));
      })();
    if ((trigger === undefined) !== (audience === undefined)) {
      throw new SchemaValidationError("StartRun.trigger and notificationAudience must be provided together");
    }
    const parentRunId = value.parentRunId === undefined
      ? undefined
      : parseId<"RunId">(value.parentRunId, "StartRun.parentRunId");
    const parentEventId = value.parentEventId === undefined
      ? undefined
      : parseId<"EventId">(value.parentEventId, "StartRun.parentEventId");
    if ((parentRunId === undefined) !== (parentEventId === undefined)) {
      throw new SchemaValidationError(
        "StartRun.parentRunId and StartRun.parentEventId must be provided together",
      );
    }
    const laneId = value.laneId === undefined
      ? undefined
      : parseId<"LaneId">(value.laneId, "StartRun.laneId");

    return {
      commandId: parseId(value.commandId, "StartRun.commandId"),
      runId: parseId(value.runId, "StartRun.runId"),
      ...(value.surfaceId === undefined
        ? {}
        : { surfaceId: expectNonEmptyString(value.surfaceId, "StartRun.surfaceId") }),
      goal: expectNonEmptyString(value.goal, "StartRun.goal"),
      workspaceId: parseId(value.workspaceId, "StartRun.workspaceId"),
      channelId: parseId(value.channelId, "StartRun.channelId"),
      source: {
        eventId: parseId(source.eventId, "StartRun.source.eventId"),
      },
      runProfile: parsedRunProfile,
      runProfileSnapshot,
      budget,
      permissionScope: parseId(value.permissionScope, "StartRun.permissionScope"),
      stopCondition,
      ...(parentRunId === undefined ? {} : { parentRunId, parentEventId: parentEventId! }),
      ...(laneId === undefined ? {} : { laneId }),
      ...(trigger === undefined ? {} : { trigger, notificationAudience: audience! }),
    };
  },
};

export const channelSessionSchema: Schema<ChannelSession> = {
  parse(input: unknown): ChannelSession {
    const value = expectRecord(input, "ChannelSession");

    return {
      id: parseId(value.id, "ChannelSession.id"),
      workspaceId: parseId(value.workspaceId, "ChannelSession.workspaceId"),
      channelId: parseId(value.channelId, "ChannelSession.channelId"),
    };
  },
};

export const channelScopeSchema: Schema<ChannelScope> = {
  parse(input: unknown): ChannelScope {
    const value = expectRecord(input, "ChannelScope");

    return {
      workspaceId: parseId(value.workspaceId, "ChannelScope.workspaceId"),
      channelId: parseId(value.channelId, "ChannelScope.channelId"),
    };
  },
};

export function parseStartRun(input: unknown): StartRun {
  return startRunSchema.parse(input);
}

function parseScheduleTrigger(input: unknown): ScheduleTrigger {
  const value = expectRecord(input, "ScheduleTrigger");
  switch (value.kind) {
    case "explicit":
      return { kind: value.kind, label: expectNonEmptyString(value.label, "ScheduleTrigger.label") };
    case "unresolved_thread_sla":
      return {
        kind: value.kind,
        threadId: expectNonEmptyString(value.threadId, "ScheduleTrigger.threadId"),
        deadlineAt: parseTimestamp(value.deadlineAt, "ScheduleTrigger.deadlineAt"),
      };
    case "waiting_node_deadline":
      return {
        kind: value.kind,
        nodeId: expectNonEmptyString(value.nodeId, "ScheduleTrigger.nodeId"),
        deadlineAt: parseTimestamp(value.deadlineAt, "ScheduleTrigger.deadlineAt"),
      };
    case "connector_event":
      return {
        kind: value.kind,
        connector: expectNonEmptyString(value.connector, "ScheduleTrigger.connector"),
        eventType: expectNonEmptyString(value.eventType, "ScheduleTrigger.eventType"),
        registrationId: expectNonEmptyString(value.registrationId, "ScheduleTrigger.registrationId"),
      };
    case "monitor":
      return {
        kind: value.kind,
        monitorId: expectNonEmptyString(value.monitorId, "ScheduleTrigger.monitorId"),
        label: expectNonEmptyString(value.label, "ScheduleTrigger.label"),
      };
    default:
      throw new SchemaValidationError("ScheduleTrigger.kind is unsupported");
  }
}

function parseScheduledRunSpec(input: unknown): ScheduledRunSpec {
  const value = expectRecord(input, "ScheduledRunSpec");
  const parsed = parseStartRun({
    ...value,
    commandId: "schedule-template-command",
    runId: "schedule-template-run",
  });
  const trigger = parseScheduleTrigger(value.trigger);
  const audience = value.notificationAudience;
  if (!Array.isArray(audience)) {
    throw new SchemaValidationError("ScheduledRunSpec.notificationAudience must be an array");
  }
  return {
    workspaceId: parsed.workspaceId,
    channelId: parsed.channelId,
    goal: parsed.goal,
    source: parsed.source,
    runProfile: parsed.runProfile,
    runProfileSnapshot: parsed.runProfileSnapshot,
    budget: parsed.budget,
    permissionScope: parsed.permissionScope,
    stopCondition: parsed.stopCondition,
    trigger,
    notificationAudience: audience.map((item, index) =>
      parseId<"ActorId">(item, `ScheduledRunSpec.notificationAudience[${index}]`)),
  };
}

export function parseSchedule(input: unknown): ScheduleRecord {
  const value = expectRecord(input, "ScheduleRecord");
  const run = parseScheduledRunSpec(value.run);
  const id = parseId<"ScheduleId">(value.id, "ScheduleRecord.id");
  const trigger = parseScheduleTrigger(value.trigger);
  if (value.kind !== trigger.kind) {
    throw new SchemaValidationError("ScheduleRecord.kind must match ScheduleRecord.trigger.kind");
  }
  if (JSON.stringify(run.trigger) !== JSON.stringify(trigger)) {
    throw new SchemaValidationError("ScheduleRecord.trigger must match ScheduledRunSpec.trigger");
  }
  const recurrenceValue = value.recurrence;
  const recurrence = recurrenceValue === undefined
    ? undefined
    : (() => {
      const recurrenceRecord = expectRecord(recurrenceValue, "ScheduleRecord.recurrence");
      if (recurrenceRecord.kind !== "fixed_interval") {
        throw new SchemaValidationError("ScheduleRecord.recurrence.kind is unsupported");
      }
      return {
        kind: "fixed_interval" as const,
        intervalMs: expectPositiveInteger(recurrenceRecord.intervalMs, "ScheduleRecord.recurrence.intervalMs"),
      };
    })();
  if (value.catchUpPolicy !== "skip" && value.catchUpPolicy !== "run_latest") {
    throw new SchemaValidationError("ScheduleRecord.catchUpPolicy is unsupported");
  }
  if (value.status !== "active" && value.status !== "cancelled" && value.status !== "completed") {
    throw new SchemaValidationError("ScheduleRecord.status is unsupported");
  }
  if (run.workspaceId !== parseId(value.workspaceId, "ScheduleRecord.workspaceId")
    || run.channelId !== parseId(value.channelId, "ScheduleRecord.channelId")) {
    throw new SchemaValidationError("ScheduleRecord scope must match its ScheduledRunSpec");
  }
  return {
    id,
    workspaceId: run.workspaceId,
    channelId: run.channelId,
    kind: trigger.kind,
    trigger,
    dueAt: parseTimestamp(value.dueAt, "ScheduleRecord.dueAt"),
    catchUpPolicy: value.catchUpPolicy,
    status: value.status,
    run,
    ...(recurrence === undefined ? {} : { recurrence }),
  };
}

export function parseScheduleOccurrence(input: unknown): ScheduleOccurrence {
  const value = expectRecord(input, "ScheduleOccurrence");
  const status = value.status === undefined
    ? undefined
    : value.status === "claimed" || value.status === "started" || value.status === "skipped"
      ? value.status
      : (() => { throw new SchemaValidationError("ScheduleOccurrence.status is unsupported"); })();
  return {
    id: parseId<"OccurrenceId">(value.id, "ScheduleOccurrence.id"),
    scheduleId: parseId<"ScheduleId">(value.scheduleId, "ScheduleOccurrence.scheduleId"),
    dueAt: parseTimestamp(value.dueAt, "ScheduleOccurrence.dueAt"),
    runId: parseId<"RunId">(value.runId, "ScheduleOccurrence.runId"),
    commandId: parseId<"CommandId">(value.commandId, "ScheduleOccurrence.commandId"),
    claimedAt: parseTimestamp(value.claimedAt, "ScheduleOccurrence.claimedAt"),
    ...(status === undefined ? {} : { status }),
    workspaceId: parseId(value.workspaceId, "ScheduleOccurrence.workspaceId"),
    channelId: parseId(value.channelId, "ScheduleOccurrence.channelId"),
  };
}

export function parseScheduleNotification(input: unknown): ScheduleNotification {
  const value = expectRecord(input, "ScheduleNotification");
  const audience = value.audience;
  if (!Array.isArray(audience)) {
    throw new SchemaValidationError("ScheduleNotification.audience must be an array");
  }
  return {
    id: parseId<"NotificationId">(value.id, "ScheduleNotification.id"),
    scheduleId: parseId<"ScheduleId">(value.scheduleId, "ScheduleNotification.scheduleId"),
    occurrenceId: parseId<"OccurrenceId">(value.occurrenceId, "ScheduleNotification.occurrenceId"),
    runId: parseId<"RunId">(value.runId, "ScheduleNotification.runId"),
    trigger: parseScheduleTrigger(value.trigger),
    audience: audience.map((item, index) =>
      parseId<"ActorId">(item, `ScheduleNotification.audience[${index}]`)),
    createdAt: parseTimestamp(value.createdAt, "ScheduleNotification.createdAt"),
    workspaceId: parseId(value.workspaceId, "ScheduleNotification.workspaceId"),
    channelId: parseId(value.channelId, "ScheduleNotification.channelId"),
  };
}

export function parseChannelSession(input: unknown): ChannelSession {
  return channelSessionSchema.parse(input);
}

export function parseChannelScope(input: unknown): ChannelScope {
  return channelScopeSchema.parse(input);
}

export const canonicalEventSchema: Schema<CanonicalEvent> = {
  parse(input: unknown): CanonicalEvent {
    const value = expectRecord(input, "CanonicalEvent");

    return {
      id: parseId(value.id, "CanonicalEvent.id"),
      workspaceId: parseId(value.workspaceId, "CanonicalEvent.workspaceId"),
      channelId: parseId(value.channelId, "CanonicalEvent.channelId"),
      streamId: parseId(value.streamId, "CanonicalEvent.streamId"),
      seq: expectNonNegativeInteger(value.seq, "CanonicalEvent.seq"),
      type: expectNonEmptyString(value.type, "CanonicalEvent.type"),
      timestamp: parseTimestamp(value.timestamp, "CanonicalEvent.timestamp"),
      schemaVersion: expectPositiveInteger(
        value.schemaVersion,
        "CanonicalEvent.schemaVersion",
      ),
      payload: parseJsonValue(value.payload, "CanonicalEvent.payload"),
    };
  },
};

export function parseCanonicalEvent(input: unknown): CanonicalEvent {
  return canonicalEventSchema.parse(input);
}

export const runOutcomeSchema: Schema<RunOutcome> = {
  parse(input: unknown): RunOutcome {
    const value = expectRecord(input, "RunOutcome");

    switch (value.status) {
      case "completed":
      case "awaiting_input":
      case "awaiting_approval":
      case "failed":
      case "timed_out":
      case "cancelled":
        return { status: value.status };
      default:
        throw new SchemaValidationError("RunOutcome.status must be terminal");
    }
  },
};

export function parseRunOutcome(input: unknown): RunOutcome {
  return runOutcomeSchema.parse(input);
}

function parseRunState(input: unknown): RunState {
  switch (input) {
    case "queued":
    case "running":
    case "completed":
    case "awaiting_input":
    case "awaiting_approval":
    case "failed":
    case "timed_out":
    case "cancelled":
      return input;
    default:
      throw new SchemaValidationError("Run.status must be a lifecycle state");
  }
}

export const runSchema: Schema<Run> = {
  parse(input: unknown): Run {
    const value = expectRecord(input, "Run");
    const source = expectRecord(value.source, "Run.source");
    const runProfile = expectRecord(value.runProfile, "Run.runProfile");
    const parsedRunProfile: RunProfileRef = {
      id: parseId<"RunProfileId">(runProfile.id, "Run.runProfile.id"),
      version: expectNonEmptyString(
        runProfile.version,
        "Run.runProfile.version",
      ),
    };
    const runProfileSnapshot = parseResolvedRunProfileSnapshot(
      value.runProfileSnapshot,
    );
    if (
      runProfileSnapshot.id !== parsedRunProfile.id
      || runProfileSnapshot.version !== parsedRunProfile.version
    ) {
      throw new SchemaValidationError(
        "Run.runProfileSnapshot must match Run.runProfile identity and version",
      );
    }
    const budget = parseBudget(value.budget);
    const stopCondition = expectNonEmptyString(value.stopCondition, "Run.stopCondition");
    assertRunProfileExecutionContract(runProfileSnapshot, budget, stopCondition, "Run");
    const trigger = value.trigger === undefined ? undefined : parseScheduleTrigger(value.trigger);
    const audience = value.notificationAudience === undefined
      ? undefined
      : (() => {
        if (!Array.isArray(value.notificationAudience)) {
          throw new SchemaValidationError("Run.notificationAudience must be an array");
        }
        return value.notificationAudience.map((item, index) =>
          parseId<"ActorId">(item, `Run.notificationAudience[${index}]`));
      })();
    if ((trigger === undefined) !== (audience === undefined)) {
      throw new SchemaValidationError("Run.trigger and notificationAudience must be provided together");
    }
    const parentRunId = value.parentRunId === undefined
      ? undefined
      : parseId<"RunId">(value.parentRunId, "Run.parentRunId");
    const parentEventId = value.parentEventId === undefined
      ? undefined
      : parseId<"EventId">(value.parentEventId, "Run.parentEventId");
    if ((parentRunId === undefined) !== (parentEventId === undefined)) {
      throw new SchemaValidationError(
        "Run.parentRunId and Run.parentEventId must be provided together",
      );
    }
    const laneId = value.laneId === undefined
      ? undefined
      : parseId<"LaneId">(value.laneId, "Run.laneId");
    const fields: RunFields = {
      id: parseId(value.id, "Run.id"),
      goal: expectNonEmptyString(value.goal, "Run.goal"),
      workspaceId: parseId(value.workspaceId, "Run.workspaceId"),
      channelId: parseId(value.channelId, "Run.channelId"),
      source: { eventId: parseId(source.eventId, "Run.source.eventId") },
      runProfile: parsedRunProfile,
      runProfileSnapshot,
      budget,
      permissionScope: parseId(value.permissionScope, "Run.permissionScope"),
      stopCondition,
      ...(parentRunId === undefined ? {} : { parentRunId, parentEventId: parentEventId! }),
      ...(laneId === undefined ? {} : { laneId }),
      ...(trigger === undefined ? {} : { trigger, notificationAudience: audience! }),
    };
    const status = parseRunState(value.status);

    if (status === "queued" || status === "running") {
      if (value.outcome !== undefined) {
        throw new SchemaValidationError("active Run must not have a terminal outcome");
      }

      return { ...fields, status };
    }

    const outcome = parseRunOutcome(value.outcome);
    if (outcome.status !== status) {
      throw new SchemaValidationError("Run outcome must match its terminal state");
    }

    return { ...fields, status, outcome };
  },
};

export function parseRun(input: unknown): Run {
  return runSchema.parse(input);
}

export const artifactSchema: Schema<Artifact> = {
  parse(input: unknown): Artifact {
    const value = expectRecord(input, "Artifact");

    return {
      id: parseId(value.id, "Artifact.id"),
      workspaceId: parseId(value.workspaceId, "Artifact.workspaceId"),
      channelId: parseId(value.channelId, "Artifact.channelId"),
      runId: parseId(value.runId, "Artifact.runId"),
      kind: expectNonEmptyString(value.kind, "Artifact.kind"),
      uri: expectNonEmptyString(value.uri, "Artifact.uri"),
      hash: expectNonEmptyString(value.hash, "Artifact.hash"),
      version: expectNonEmptyString(value.version, "Artifact.version"),
      validationStatus: expectNonEmptyString(
        value.validationStatus,
        "Artifact.validationStatus",
      ),
      reviewState: expectNonEmptyString(value.reviewState, "Artifact.reviewState"),
    };
  },
};

export function parseArtifact(input: unknown): Artifact {
  return artifactSchema.parse(input);
}

export const memoryCandidateSchema: Schema<MemoryCandidate> = {
  parse(input: unknown): MemoryCandidate {
    const value = expectRecord(input, "MemoryCandidate");
    if (!Array.isArray(value.sourceEventIds) || value.sourceEventIds.length === 0) {
      throw new SchemaValidationError(
        "MemoryCandidate.sourceEventIds must contain provenance",
      );
    }

    return {
      id: parseId(value.id, "MemoryCandidate.id"),
      workspaceId: parseId(value.workspaceId, "MemoryCandidate.workspaceId"),
      channelId: parseId(value.channelId, "MemoryCandidate.channelId"),
      content: expectNonEmptyString(value.content, "MemoryCandidate.content"),
      sourceEventIds: value.sourceEventIds.map((eventId, index) =>
        parseId(eventId, `MemoryCandidate.sourceEventIds[${index}]`),
      ),
    };
  },
};

export function parseMemoryCandidate(input: unknown): MemoryCandidate {
  return memoryCandidateSchema.parse(input);
}
