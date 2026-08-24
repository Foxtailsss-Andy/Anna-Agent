import { parseJsonValue } from "@anna/harness-v2";
import type {
  CanonicalEvent,
  ChannelScope,
  ChannelSession,
  EventStore,
  ProjectionCommit,
  ProjectionCommitResult,
  ProjectionSnapshot,
  ScopedChannelStore,
  ScheduleId,
  ScheduleNotification,
  ScheduleOccurrence,
  ScheduleOccurrenceClaim,
  ScheduleRecord,
  ScheduleTrigger,
  StartRun,
  RunId,
  StreamId,
} from "@anna/harness-v2";

import {
  CommandConflictError,
  ChannelSessionConflictError,
  EventConflictError,
  EventScopeMismatchError,
  EventSequenceConflictError,
  ProjectionSourceEventNotFoundError,
  ProjectionVersionConflictError,
  ScheduleConflictError,
  ScheduleNotificationConflictError,
  TerminalEventConflictError,
  UnsupportedSchemaVersionError,
} from "./errors";
import {
  cloneEvent,
  cloneProjectionCommitResult,
  cloneProjectionSnapshot,
  cloneSchedule,
  cloneScheduleNotification,
  cloneScheduleOccurrence,
  cloneScope,
  cloneSession,
  cloneStartRun,
  scopedKey,
  scopedPrefix,
  stableJson,
} from "./codec";
import { isTerminalEvent } from "./lifecycle";

interface RecoveryLease {
  readonly claimedAt: number;
  readonly ownerId: string;
}

export { ChannelSessionService } from "./channel-session";
export { RunManager } from "./run-manager";
export {
  DurableRunRuntime,
  RunResumeRequiredError,
  type DurableRunHandle,
  type DurableRunRuntimeDependencies,
} from "./run-runtime";
export {
  projectHarnessState,
  projectRunFamilyHarnessState,
  type HarnessState,
} from "./harness-state";
export { SqliteEventStore } from "./sqlite-event-store";
export {
  projectNext,
  type ProjectionReducer,
} from "./projection-runner";
export {
  claimRunWithResolvedProfile,
  type ClaimRunWithResolvedProfileOptions,
  type UnresolvedStartRun,
} from "./resolved-run-profile";
export {
  CommandConflictError,
  EventConflictError,
  EventScopeMismatchError,
  EventSequenceConflictError,
  ChannelSessionConflictError,
  ProjectionSourceEventNotFoundError,
  ProjectionVersionConflictError,
  ScheduleConflictError,
  ScheduleNotificationConflictError,
  TerminalEventConflictError,
  UnsupportedSchemaVersionError,
} from "./errors";

class InMemoryScopedChannelStore implements ScopedChannelStore {
  constructor(
    private readonly scope: ChannelScope,
    private readonly eventsByStream: Map<string, CanonicalEvent[]>,
    private readonly eventsById: Map<string, CanonicalEvent>,
    private readonly commandsById: Map<string, StartRun>,
    private readonly channelSessions: Map<string, ChannelSession>,
    private readonly projections: Map<string, ProjectionSnapshot>,
    private readonly projectionReceipts: Set<string>,
    private readonly schedules: Map<string, ScheduleRecord>,
    private readonly occurrences: Map<string, ScheduleOccurrence>,
    private readonly occurrenceClaims: Map<string, ScheduleOccurrence>,
    private readonly occurrenceRecoveryLeases: Map<string, RecoveryLease>,
    private readonly notifications: Map<string, ScheduleNotification>,
    private readonly triggerRegistrations: Map<string, ScheduleTrigger>,
  ) {}

  async append(event: CanonicalEvent): Promise<void> {
    const candidate = cloneEvent(event);
    if (
      candidate.workspaceId !== this.scope.workspaceId ||
      candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }

    const existing = this.eventsById.get(scopedKey(this.scope, "event", candidate.id));
    if (existing !== undefined) {
      if (stableJson(existing) === stableJson(candidate)) {
        return;
      }
      throw new EventConflictError();
    }
    const events = this.eventsByStream.get(scopedKey(this.scope, "stream", candidate.streamId)) ?? [];
    if (candidate.seq !== events.length) {
      throw new EventSequenceConflictError();
    }
    if (events.some((stored) => isTerminalEvent(stored.type))) {
      throw new TerminalEventConflictError();
    }
    events.push(candidate);
    this.eventsByStream.set(scopedKey(this.scope, "stream", candidate.streamId), events);
    this.eventsById.set(scopedKey(this.scope, "event", candidate.id), candidate);
  }

  async appendIdempotent(event: CanonicalEvent): Promise<boolean> {
    const candidate = cloneEvent(event);
    if (
      candidate.workspaceId !== this.scope.workspaceId
      || candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }
    const existing = this.eventsById.get(scopedKey(this.scope, "event", candidate.id));
    if (existing !== undefined) {
      if (
        stableJson({ ...existing, seq: 0, timestamp: "" })
        !== stableJson({ ...candidate, seq: 0, timestamp: "" })
      ) {
        throw new EventConflictError();
      }
      return false;
    }
    const events = this.eventsByStream.get(scopedKey(this.scope, "stream", candidate.streamId)) ?? [];
    const storedCandidate = candidate.seq === events.length
      ? candidate
      : { ...candidate, seq: events.length };
    if (events.some((stored) => isTerminalEvent(stored.type))) {
      throw new TerminalEventConflictError();
    }
    events.push(storedCandidate);
    this.eventsByStream.set(scopedKey(this.scope, "stream", candidate.streamId), events);
    this.eventsById.set(scopedKey(this.scope, "event", candidate.id), storedCandidate);
    return true;
  }

  async *read(
    streamId: CanonicalEvent["streamId"],
    afterSeq?: number,
  ): AsyncIterable<CanonicalEvent> {
    for (const event of this.eventsByStream.get(scopedKey(this.scope, "stream", streamId)) ?? []) {
      if (afterSeq === undefined || event.seq > afterSeq) {
        yield cloneEvent(event);
      }
    }
  }

  async listRunCommands(): Promise<readonly StartRun[]> {
    const commands = new Map<string, StartRun>();
    for (const command of this.commandsById.values()) {
      commands.set(command.runId, command);
    }
    return [...commands.values()]
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map((command) => cloneStartRun(command));
  }

  async listRunStreamIds(runId: RunId): Promise<readonly StreamId[]> {
    const streamIds = new Set<StreamId>();
    for (const command of this.commandsById.values()) {
      if (command.parentRunId === runId) {
        streamIds.add(command.runId as unknown as StreamId);
      }
    }
    for (const events of this.eventsByStream.values()) {
      for (const event of events) {
        if (
          event.workspaceId !== this.scope.workspaceId
          || event.channelId !== this.scope.channelId
        ) {
          continue;
        }
        const payload = event.payload;
        const payloadRunId = typeof payload === "object"
          && payload !== null
          && !Array.isArray(payload)
          && typeof payload.runId === "string"
          ? payload.runId
          : undefined;
        const payloadParentRunId = typeof payload === "object"
          && payload !== null
          && !Array.isArray(payload)
          && typeof payload.parentRunId === "string"
          ? payload.parentRunId
          : undefined;
        if (
          (event.streamId as string) === (runId as string)
          || (
            payloadRunId === runId
            && (
              event.streamId.startsWith(`tool:${runId}:`)
              || event.streamId.startsWith("effect:")
            )
          )
          || payloadParentRunId === runId
        ) {
          streamIds.add(event.streamId);
        }
      }
    }
    return [...streamIds].sort();
  }

  async claimStart(
    command: StartRun,
  ): Promise<StartRun> {
    const candidate = cloneStartRun(command);
    if (
      candidate.workspaceId !== this.scope.workspaceId ||
      candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }
    const key = scopedKey(this.scope, "command", candidate.commandId);
    const existing = this.commandsById.get(key);
    if (existing !== undefined) {
      if (stableJson(existing) === stableJson(candidate)) {
        return cloneStartRun(existing);
      }
      throw new CommandConflictError();
    }

    const runKey = scopedKey(this.scope, "run", candidate.runId);
    if (this.commandsById.has(runKey)) {
      throw new CommandConflictError();
    }

    this.commandsById.set(key, candidate);
    this.commandsById.set(runKey, candidate);
    return cloneStartRun(candidate);
  }

  async getCommand(
    commandId: StartRun["commandId"],
  ): Promise<StartRun | undefined> {
    const command = this.commandsById.get(scopedKey(this.scope, "command", commandId));
    return command === undefined ? undefined : cloneStartRun(command);
  }

  async getRunCommand(runId: RunId): Promise<StartRun | undefined> {
    const command = this.commandsById.get(scopedKey(this.scope, "run", runId));
    return command === undefined ? undefined : cloneStartRun(command);
  }

  async claimChannelSession(session: ChannelSession): Promise<ChannelSession> {
    const candidate = cloneSession(session);
    if (
      candidate.workspaceId !== this.scope.workspaceId
      || candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }
    const key = scopedKey(this.scope, "channel-session", "");
    const existing = this.channelSessions.get(key);
    if (existing !== undefined) {
      if (stableJson(existing) === stableJson(candidate)) {
        return cloneSession(existing);
      }
      throw new ChannelSessionConflictError();
    }
    this.channelSessions.set(key, candidate);
    return cloneSession(candidate);
  }

  async getChannelSession(): Promise<ChannelSession | undefined> {
    const session = this.channelSessions.get(scopedKey(this.scope, "channel-session", ""));
    return session === undefined ? undefined : cloneSession(session);
  }

  async loadProjection(
    projector: string,
    streamId: CanonicalEvent["streamId"],
  ): Promise<ProjectionSnapshot | undefined> {
    const snapshot = this.projections.get(scopedKey(
      this.scope,
      `projection:${projector}`,
      streamId,
    ));
    return snapshot === undefined ? undefined : cloneProjectionSnapshot(snapshot);
  }

  async commitProjection(
    commit: ProjectionCommit,
  ): Promise<ProjectionCommitResult> {
    const sourceEvent = this.eventsById.get(
      scopedKey(this.scope, "event", commit.eventId),
    );
    if (
      sourceEvent === undefined
      || sourceEvent.streamId !== commit.streamId
      || sourceEvent.seq !== commit.eventSeq
    ) {
      throw new ProjectionSourceEventNotFoundError();
    }

    const receiptKey = scopedKey(
      this.scope,
      `projection-receipt:${commit.projector}`,
      stableJson([commit.streamId, commit.eventId]),
    );
    if (this.projectionReceipts.has(receiptKey)) {
      const current = this.projections.get(scopedKey(
        this.scope,
        `projection:${commit.projector}`,
        commit.streamId,
      ));
      if (current === undefined) {
        throw new Error("in-memory projection receipt has no projection state");
      }
      return { ...cloneProjectionSnapshot(current), applied: false };
    }

    const projectionKey = scopedKey(
      this.scope,
      `projection:${commit.projector}`,
      commit.streamId,
    );
    const current = this.projections.get(projectionKey);
    if ((current?.version ?? 0) !== commit.expectedVersion) {
      throw new ProjectionVersionConflictError();
    }

    const snapshot: ProjectionSnapshot = {
      state: parseJsonValue(commit.state, "ProjectionCommit.state"),
      version: commit.expectedVersion + 1,
      lastSeq: commit.eventSeq,
    };
    const result: ProjectionCommitResult = { ...snapshot, applied: true };
    this.projections.set(projectionKey, snapshot);
    this.projectionReceipts.add(receiptKey);
    return cloneProjectionCommitResult(result);
  }

  async activeRunIds(): Promise<readonly RunId[]> {
    const commandPrefix = scopedPrefix(this.scope, "command");
    return [...this.commandsById]
      .filter(([key]) => key.startsWith(commandPrefix))
      .map(([, command]) => command)
      .filter((command) => {
        const events = this.eventsByStream.get(
          scopedKey(this.scope, "stream", command.runId),
        ) ?? [];
        return !events.some((event) => isTerminalEvent(event.type));
      })
      .map((command) => command.runId);
  }

  async createSchedule(schedule: ScheduleRecord): Promise<ScheduleRecord> {
    const candidate = cloneSchedule(schedule);
    this.assertScheduleScope(candidate);
    const key = scopedKey(this.scope, "schedule", candidate.id);
    const existing = this.schedules.get(key);
    if (existing !== undefined) {
      if (stableJson(existing) === stableJson(candidate)) {
        return cloneSchedule(existing);
      }
      throw new ScheduleConflictError();
    }
    this.schedules.set(key, candidate);
    return cloneSchedule(candidate);
  }

  async listSchedules(): Promise<readonly ScheduleRecord[]> {
    const prefix = scopedPrefix(this.scope, "schedule");
    return [...this.schedules]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, schedule]) => cloneSchedule(schedule))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async cancelSchedule(scheduleId: ScheduleId, _cancelledAt: string): Promise<ScheduleRecord | undefined> {
    const key = scopedKey(this.scope, "schedule", scheduleId);
    const existing = this.schedules.get(key);
    if (existing === undefined) {
      return undefined;
    }
    const cancelled = cloneSchedule({ ...existing, status: "cancelled" });
    this.schedules.set(key, cancelled);
    return cloneSchedule(cancelled);
  }

  async claimScheduleOccurrence(
    occurrence: ScheduleOccurrence,
  ): Promise<ScheduleOccurrenceClaim> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    const schedule = this.schedules.get(scopedKey(this.scope, "schedule", candidate.scheduleId));
    if (schedule?.status !== "active") {
      return { claimed: false, reason: "schedule_inactive" };
    }
    const claimKey = scopedKey(
      this.scope,
      "schedule-occurrence-claim",
      stableJson([candidate.scheduleId, candidate.dueAt]),
    );
    const claimed = this.occurrenceClaims.get(claimKey);
    if (claimed !== undefined) {
      return {
        claimed: false,
        reason: "already_claimed",
        occurrence: cloneScheduleOccurrence(claimed),
      };
    }
    const idKey = scopedKey(this.scope, "schedule-occurrence", candidate.id);
    if (this.occurrences.has(idKey)) {
      throw new ScheduleConflictError();
    }
    for (const [key, existing] of this.occurrences) {
      if (
        key.startsWith(scopedPrefix(this.scope, "schedule-occurrence"))
        && (existing.runId === candidate.runId || existing.commandId === candidate.commandId)
      ) {
        throw new ScheduleConflictError();
      }
    }
    this.occurrences.set(idKey, candidate);
    this.occurrenceClaims.set(claimKey, candidate);
    return { claimed: true, occurrence: cloneScheduleOccurrence(candidate) };
  }

  async skipScheduleOccurrence(occurrence: ScheduleOccurrence): Promise<boolean> {
    const candidate = cloneScheduleOccurrence({ ...occurrence, status: "skipped" });
    this.assertScheduleScope(candidate);
    const schedule = this.schedules.get(scopedKey(this.scope, "schedule", candidate.scheduleId));
    if (schedule?.status !== "active") {
      return false;
    }
    const claimKey = scopedKey(
      this.scope,
      "schedule-occurrence-claim",
      stableJson([candidate.scheduleId, candidate.dueAt]),
    );
    if (this.occurrenceClaims.has(claimKey)) {
      return false;
    }
    const idKey = scopedKey(this.scope, "schedule-occurrence", candidate.id);
    if (this.occurrences.has(idKey)) {
      throw new ScheduleConflictError();
    }
    this.occurrences.set(idKey, candidate);
    this.occurrenceClaims.set(claimKey, candidate);
    return true;
  }

  async claimScheduleOccurrenceRecovery(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    const key = scopedKey(this.scope, "schedule-occurrence-recovery", candidate.id);
    const existing = this.occurrenceRecoveryLeases.get(key);
    const nowMs = Date.now();
    if (
      existing !== undefined
      && nowMs - existing.claimedAt < 60_000
    ) {
      return false;
    }
    this.occurrenceRecoveryLeases.set(key, { claimedAt: nowMs, ownerId });
    return true;
  }

  async renewScheduleOccurrenceRecovery(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    const key = scopedKey(this.scope, "schedule-occurrence-recovery", candidate.id);
    const existing = this.occurrenceRecoveryLeases.get(key);
    if (existing?.ownerId !== ownerId) {
      return false;
    }
    this.occurrenceRecoveryLeases.set(key, { claimedAt: Date.now(), ownerId });
    return true;
  }

  async claimScheduleOccurrenceExecution(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    const leaseKey = scopedKey(this.scope, "schedule-occurrence-recovery", candidate.id);
    const lease = this.occurrenceRecoveryLeases.get(leaseKey);
    if (
      lease === undefined
      || lease.ownerId !== ownerId
      || Date.now() - lease.claimedAt >= 60_000
    ) {
      return false;
    }
    const occurrenceKey = scopedKey(this.scope, "schedule-occurrence", candidate.id);
    const existing = this.occurrences.get(occurrenceKey);
    if (existing === undefined || existing.status === "started" || existing.status === "skipped") {
      return false;
    }
    this.occurrences.set(occurrenceKey, cloneScheduleOccurrence({ ...existing, status: "started" }));
    return true;
  }

  async recordScheduleNotification(
    notification: ScheduleNotification,
  ): Promise<ScheduleNotification> {
    const candidate = cloneScheduleNotification(notification);
    this.assertScheduleScope(candidate);
    const occurrence = this.occurrences.get(
      scopedKey(this.scope, "schedule-occurrence", candidate.occurrenceId),
    );
    if (
      occurrence === undefined
      || occurrence.scheduleId !== candidate.scheduleId
      || occurrence.runId !== candidate.runId
    ) {
      throw new ScheduleNotificationConflictError();
    }
    const schedule = this.schedules.get(scopedKey(this.scope, "schedule", candidate.scheduleId));
    if (
      schedule === undefined
      || stableJson(schedule.trigger) !== stableJson(candidate.trigger)
      || stableJson(schedule.run.notificationAudience) !== stableJson(candidate.audience)
    ) {
      throw new ScheduleNotificationConflictError();
    }
    const key = scopedKey(this.scope, "schedule-notification", candidate.id);
    const existing = this.notifications.get(key);
    if (existing !== undefined) {
      if (stableJson(existing) === stableJson(candidate)) {
        return cloneScheduleNotification(existing);
      }
      throw new ScheduleNotificationConflictError();
    }
    for (const [notificationKey, stored] of this.notifications) {
      if (
        notificationKey.startsWith(scopedPrefix(this.scope, "schedule-notification"))
        && stored.occurrenceId === candidate.occurrenceId
      ) {
        if (stableJson(stored) === stableJson(candidate)) {
          return cloneScheduleNotification(stored);
        }
        throw new ScheduleNotificationConflictError();
      }
    }
    this.notifications.set(key, candidate);
    return cloneScheduleNotification(candidate);
  }

  async listScheduleOccurrences(scheduleId: ScheduleId): Promise<readonly ScheduleOccurrence[]> {
    const prefix = scopedPrefix(this.scope, "schedule-occurrence");
    return [...this.occurrences]
      .filter(([key, occurrence]) => key.startsWith(prefix) && occurrence.scheduleId === scheduleId)
      .map(([, occurrence]) => cloneScheduleOccurrence(occurrence))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  async listScheduleNotifications(scheduleId: ScheduleId): Promise<readonly ScheduleNotification[]> {
    const prefix = scopedPrefix(this.scope, "schedule-notification");
    return [...this.notifications]
      .filter(([key, notification]) => key.startsWith(prefix) && notification.scheduleId === scheduleId)
      .map(([, notification]) => cloneScheduleNotification(notification))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async registerScheduleTrigger(trigger: ScheduleTrigger): Promise<void> {
    const key = scopedKey(this.scope, "schedule-trigger-registration", stableJson(trigger));
    this.triggerRegistrations.set(key, trigger);
  }

  async hasScheduleTriggerRegistration(trigger: ScheduleTrigger): Promise<boolean> {
    return this.triggerRegistrations.has(
      scopedKey(this.scope, "schedule-trigger-registration", stableJson(trigger)),
    );
  }

  private assertScheduleScope(value: ChannelScope): void {
    if (
      value.workspaceId !== this.scope.workspaceId
      || value.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }
  }
}

export class InMemoryEventStore implements EventStore {
  private readonly eventsByStream = new Map<string, CanonicalEvent[]>();
  private readonly eventsById = new Map<string, CanonicalEvent>();
  private readonly commandsById = new Map<string, StartRun>();
  private readonly channelSessions = new Map<string, ChannelSession>();
  private readonly projections = new Map<string, ProjectionSnapshot>();
  private readonly projectionReceipts = new Set<string>();
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly occurrences = new Map<string, ScheduleOccurrence>();
  private readonly occurrenceClaims = new Map<string, ScheduleOccurrence>();
  private readonly occurrenceRecoveryLeases = new Map<string, RecoveryLease>();
  private readonly notifications = new Map<string, ScheduleNotification>();
  private readonly triggerRegistrations = new Map<string, ScheduleTrigger>();

  scope(scope: ChannelScope): ScopedChannelStore {
    return new InMemoryScopedChannelStore(
      cloneScope(scope),
      this.eventsByStream,
      this.eventsById,
      this.commandsById,
      this.channelSessions,
      this.projections,
      this.projectionReceipts,
      this.schedules,
      this.occurrences,
      this.occurrenceClaims,
      this.occurrenceRecoveryLeases,
      this.notifications,
      this.triggerRegistrations,
    );
  }
}
