import type {
  Artifact,
  CanonicalEvent,
  ChannelScope,
  ChannelSession,
  EventId,
  JsonValue,
  MemoryCandidate,
  Run,
  RunId,
  RunOutcome,
  ScheduleId,
  ScheduleNotification,
  ScheduleOccurrence,
  ScheduleOccurrenceClaim,
  ScheduleRecord,
  ScheduleTrigger,
  ScheduleRun,
  StartRun,
  StreamId,
  WorkerProfileId,
} from "./contracts";

export interface ChannelMessage extends ChannelScope {
  content: string;
}

export interface HumanAnswer {
  content: string;
}

export interface LoopKernel {
  start(
    command: StartRun,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<RunOutcome>;
  steer(runId: RunId, message: ChannelMessage): Promise<void>;
  answer(runId: RunId, answer: HumanAnswer): Promise<void>;
  abort(runId: RunId, reason: string): Promise<void>;
}

export interface EventSink {
  append(event: CanonicalEvent): Promise<void>;
}

export interface EventReader {
  read(streamId: StreamId, afterSeq?: number): AsyncIterable<CanonicalEvent>;
}

export type DurableEventSink = EventSink & EventReader;

export interface EventCursor {
  streamId: StreamId;
  seq: number;
}

export interface ProjectionSnapshot {
  state: JsonValue;
  version: number;
  lastSeq: number;
}

export interface ProjectionCommit {
  projector: string;
  streamId: StreamId;
  eventId: EventId;
  eventSeq: number;
  expectedVersion: number;
  state: JsonValue;
}

export interface ProjectionCommitResult extends ProjectionSnapshot {
  applied: boolean;
}

export interface ScopedChannelStore extends EventSink {
  appendIdempotent(event: CanonicalEvent): Promise<boolean>;
  read(streamId: StreamId, afterSeq?: number): AsyncIterable<CanonicalEvent>;
  listRunCommands(): Promise<readonly StartRun[]>;
  listRunStreamIds(runId: RunId): Promise<readonly StreamId[]>;
  claimStart(command: StartRun): Promise<StartRun>;
  getCommand(commandId: StartRun["commandId"]): Promise<StartRun | undefined>;
  getRunCommand(runId: RunId): Promise<StartRun | undefined>;
  claimChannelSession(session: ChannelSession): Promise<ChannelSession>;
  getChannelSession(): Promise<ChannelSession | undefined>;
  loadProjection(
    projector: string,
    streamId: StreamId,
  ): Promise<ProjectionSnapshot | undefined>;
  commitProjection(commit: ProjectionCommit): Promise<ProjectionCommitResult>;
  activeRunIds(): Promise<readonly RunId[]>;
  createSchedule(schedule: ScheduleRecord): Promise<ScheduleRecord>;
  listSchedules(): Promise<readonly ScheduleRecord[]>;
  cancelSchedule(scheduleId: ScheduleId, cancelledAt: string): Promise<ScheduleRecord | undefined>;
  claimScheduleOccurrence(occurrence: ScheduleOccurrence): Promise<ScheduleOccurrenceClaim>;
  claimScheduleOccurrenceRecovery(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean>;
  renewScheduleOccurrenceRecovery(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean>;
  claimScheduleOccurrenceExecution(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean>;
  skipScheduleOccurrence(occurrence: ScheduleOccurrence): Promise<boolean>;
  recordScheduleNotification(notification: ScheduleNotification): Promise<ScheduleNotification>;
  registerScheduleTrigger(trigger: ScheduleTrigger): Promise<void>;
  hasScheduleTriggerRegistration(trigger: ScheduleTrigger): Promise<boolean>;
  listScheduleOccurrences(scheduleId: ScheduleId): Promise<readonly ScheduleOccurrence[]>;
  listScheduleNotifications(scheduleId: ScheduleId): Promise<readonly ScheduleNotification[]>;
}

export interface EventStore {
  scope(scope: ChannelScope): ScopedChannelStore;
}

export interface ToolRequest extends ChannelScope {
  runId: RunId;
  workerProfileId: WorkerProfileId;
  name: string;
  input: JsonValue;
  effectKey?: string;
  toolCallId: string;
  parentRunId?: RunId;
  parentEventId?: EventId;
  laneId?: string;
}

export interface ToolResult {
  status: "succeeded" | "failed" | "unknown";
  output?: JsonValue;
}

export interface ToolGateway {
  execute(request: ToolRequest, signal: AbortSignal): Promise<ToolResult>;
}

export interface ToolApprovalAnswer extends ChannelScope {
  runId: RunId;
  effectKey: string;
  approvalId: string;
  actorId: string;
  decision: "approved" | "denied";
  parentRunId?: RunId;
  parentEventId?: EventId;
  laneId?: string;
}

export interface DurableToolGateway extends ToolGateway {
  answerApproval(answer: ToolApprovalAnswer): Promise<void>;
}

export interface SandboxAdapter {
  execute(request: ToolRequest, signal: AbortSignal): Promise<ToolResult>;
}

export interface MemoryPolicy {
  propose(candidate: MemoryCandidate): Promise<void>;
}

export interface EvalResult {
  passed: boolean;
}

export interface EvalGate {
  evaluate(run: Run, artifacts: readonly Artifact[]): Promise<EvalResult>;
}

export interface SchedulerRuntimeStatus {
  executionMode: "local";
  runsWhileAppClosed: false;
  recoveryMode: "explicit";
}

export interface Scheduler {
  schedule(record: ScheduleRecord): Promise<ScheduleRecord>;
  cancel(scheduleId: ScheduleId): Promise<ScheduleRecord | undefined>;
  tick(): Promise<void>;
  recover(): Promise<void>;
  runtimeStatus(): SchedulerRuntimeStatus;
}
