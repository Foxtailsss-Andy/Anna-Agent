import { randomUUID } from "node:crypto";

import {
  parseCanonicalEvent,
  parseSchedule,
  parseStartRun,
  type CanonicalEvent,
  type CommandId,
  type EventId,
  type NotificationId,
  type OccurrenceId,
  type PermissionScopeId,
  type RunId,
  type ScheduleId,
  type ScheduleOccurrence,
  type ScheduleRecord,
  type ScheduleRun,
  type Scheduler,
  type SchedulerRuntimeStatus,
  type ScopedChannelStore,
  type StreamId,
} from "@anna/harness-v2";

export const schedulerStreamId = "scheduler" as StreamId;

function parseInstant(value: string, name: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new Error(`${name} must be a parseable timestamp`);
  }
  return instant;
}

export class ManualClock {
  private instant: number;

  constructor(timestamp: string) {
    this.instant = parseInstant(timestamp, "ManualClock.timestamp");
  }

  now(): string {
    return new Date(this.instant).toISOString();
  }

  advanceBy(milliseconds: number): string {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("ManualClock advance must be a non-negative integer");
    }
    this.instant += milliseconds;
    return this.now();
  }

  set(timestamp: string): string {
    const next = parseInstant(timestamp, "ManualClock.timestamp");
    if (next < this.instant) {
      throw new Error("ManualClock cannot move backwards");
    }
    this.instant = next;
    return this.now();
  }
}

export interface SchedulerServiceOptions {
  readonly now?: () => string;
  readonly createRun: (run: ScheduleRun) => Promise<unknown>;
  readonly policy: {
    readonly permissionScopes: readonly PermissionScopeId[];
    readonly allowedTools: readonly string[];
  };
}

export class SchedulerService implements Scheduler {
  private readonly now: () => string;
  private readonly processingOccurrences = new Set<string>();
  private readonly recoveryOwnerId = `scheduler:${randomUUID()}`;

  constructor(
    private readonly store: ScopedChannelStore,
    private readonly options: SchedulerServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async schedule(record: ScheduleRecord): Promise<ScheduleRecord> {
    const parsed = parseSchedule(record);
    this.assertPolicy(parsed);
    if (
      (parsed.trigger.kind === "connector_event" || parsed.trigger.kind === "monitor")
      && !await this.store.hasScheduleTriggerRegistration(parsed.trigger)
    ) {
      throw new Error(`Schedule trigger is not registered: ${parsed.trigger.kind}`);
    }
    const schedule = await this.store.createSchedule(parsed);
    await this.appendLifecycleOnce(
      `schedule:${schedule.id}:created` as EventId,
      "schedule.created",
      { scheduleId: schedule.id, trigger: schedule.trigger, dueAt: schedule.dueAt },
      schedule,
    );
    return schedule;
  }

  list(): Promise<readonly ScheduleRecord[]> {
    return this.store.listSchedules();
  }

  async cancel(scheduleId: ScheduleId): Promise<ScheduleRecord | undefined> {
    const timestamp = this.now();
    const schedule = await this.store.cancelSchedule(scheduleId, timestamp);
    if (schedule !== undefined) {
      await this.appendLifecycleOnce(
        `schedule:${schedule.id}:cancelled` as EventId,
        "schedule.cancelled",
        { scheduleId: schedule.id },
        schedule,
      );
    }
    return schedule;
  }

  async tick(): Promise<void> {
    await this.processDue(false);
  }

  async recover(): Promise<void> {
    await this.processDue(true);
  }

  runtimeStatus(): SchedulerRuntimeStatus {
    return {
      executionMode: "local",
      runsWhileAppClosed: false,
      recoveryMode: "explicit",
    };
  }

  private async processDue(recovering: boolean): Promise<void> {
    const now = this.now();
    const nowMs = parseInstant(now, "Scheduler.now");
    const schedules = await this.store.listSchedules();
    for (const schedule of schedules) {
      if (schedule.status !== "active") {
        continue;
      }
      const dueAt = this.latestDueAt(schedule, nowMs);
      if (dueAt === undefined) {
        continue;
      }
      const occurrence = this.occurrenceFor(schedule, dueAt, now);
      if (recovering && schedule.catchUpPolicy === "skip") {
        const skipped = await this.store.skipScheduleOccurrence(occurrence);
        if (!skipped) {
          const existing = (await this.store.listScheduleOccurrences(schedule.id))
            .find((item) => item.dueAt === dueAt);
          if (existing?.status !== "skipped") {
            continue;
          }
        }
        await this.appendLifecycleOnce(
          `schedule:${schedule.id}:occurrence:${dueAt}:skipped` as EventId,
          "schedule.occurrence.skipped",
          { scheduleId: schedule.id, dueAt, trigger: schedule.trigger },
          schedule,
        );
        continue;
      }
      const claim = await this.store.claimScheduleOccurrence(occurrence);
      let claimedOccurrence: ScheduleOccurrence;
      if (claim.claimed) {
        claimedOccurrence = claim.occurrence;
      } else {
        if (
          !recovering
          || claim.reason !== "already_claimed"
          || claim.occurrence.status === "skipped"
        ) {
          continue;
        }
        const notifications = await this.store.listScheduleNotifications(schedule.id);
        if (notifications.some((notification) => notification.occurrenceId === claim.occurrence.id)) {
          continue;
        }
        claimedOccurrence = claim.occurrence;
      }
      const processingKey = `${schedule.id}:${claimedOccurrence.dueAt}`;
      if (this.processingOccurrences.has(processingKey)) {
        continue;
      }
      if (!await this.store.claimScheduleOccurrenceRecovery(
        claimedOccurrence,
        this.recoveryOwnerId,
      )) {
        continue;
      }
      if (!await this.store.claimScheduleOccurrenceExecution(
        claimedOccurrence,
        this.recoveryOwnerId,
      )) {
        continue;
      }
      this.processingOccurrences.add(processingKey);
      let leaseLost = false;
      const leaseRenewal = setInterval(() => {
        void this.store.renewScheduleOccurrenceRecovery(
          claimedOccurrence,
          this.recoveryOwnerId,
        ).then((renewed) => {
          if (!renewed) {
            leaseLost = true;
          }
        }).catch(() => {
          leaseLost = true;
        });
      }, 15_000);
      try {
        const run = parseStartRun({
          ...schedule.run,
          commandId: claimedOccurrence.commandId,
          runId: claimedOccurrence.runId,
        });
        const proactiveRun: ScheduleRun = {
          ...run,
          trigger: schedule.trigger,
          notificationAudience: schedule.run.notificationAudience,
        };
        await this.options.createRun(proactiveRun);
        if (leaseLost) {
          throw new Error("Schedule occurrence execution lease lost");
        }
        await this.appendLifecycleOnce(
          `schedule:${schedule.id}:occurrence:${dueAt}:claimed` as EventId,
          "schedule.occurrence.claimed",
          { scheduleId: schedule.id, occurrenceId: claimedOccurrence.id, dueAt },
          schedule,
        );
        await this.store.recordScheduleNotification({
          id: `notification:${schedule.id}:${dueAt}` as NotificationId,
          workspaceId: schedule.workspaceId,
          channelId: schedule.channelId,
          scheduleId: schedule.id,
          occurrenceId: claimedOccurrence.id,
          runId: claimedOccurrence.runId,
          trigger: schedule.trigger,
          audience: schedule.run.notificationAudience,
          createdAt: now,
        });
        await this.appendLifecycleOnce(
          `schedule:${schedule.id}:occurrence:${dueAt}:notification` as EventId,
          "schedule.notification.created",
          { scheduleId: schedule.id, occurrenceId: claimedOccurrence.id, runId: claimedOccurrence.runId },
          schedule,
        );
      } finally {
        clearInterval(leaseRenewal);
        this.processingOccurrences.delete(processingKey);
      }
    }
  }

  private occurrenceFor(
    schedule: ScheduleRecord,
    dueAt: string,
    claimedAt: string,
  ): ScheduleOccurrence {
    return {
      workspaceId: schedule.workspaceId,
      channelId: schedule.channelId,
      id: `occurrence:${schedule.id}:${dueAt}` as OccurrenceId,
      scheduleId: schedule.id,
      dueAt,
      runId: `scheduled-run:${schedule.id}:${dueAt}` as RunId,
      commandId: `scheduled-command:${schedule.id}:${dueAt}` as CommandId,
      claimedAt,
    };
  }

  private latestDueAt(schedule: ScheduleRecord, nowMs: number): string | undefined {
    const firstDueMs = parseInstant(schedule.dueAt, "ScheduleRecord.dueAt");
    if (firstDueMs > nowMs) {
      return undefined;
    }
    if (schedule.recurrence === undefined) {
      return schedule.dueAt;
    }
    const elapsedIntervals = Math.floor((nowMs - firstDueMs) / schedule.recurrence.intervalMs);
    return new Date(firstDueMs + elapsedIntervals * schedule.recurrence.intervalMs).toISOString();
  }

  private assertPolicy(schedule: ScheduleRecord): void {
    if (!this.options.policy.permissionScopes.includes(schedule.run.permissionScope)) {
      throw new Error(`Schedule permission scope is not allowed: ${schedule.run.permissionScope}`);
    }
    for (const tool of schedule.run.runProfileSnapshot.allowedTools) {
      if (!this.options.policy.allowedTools.includes(tool)) {
        throw new Error(`Schedule tool is not allowed: ${tool}`);
      }
    }
  }

  private async appendLifecycleOnce(
    id: EventId,
    type: string,
    payload: CanonicalEvent["payload"],
    scope: ScheduleRecord,
  ): Promise<void> {
    await this.store.appendIdempotent(parseCanonicalEvent({
      id,
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      streamId: schedulerStreamId,
      seq: 0,
      type,
      timestamp: this.now(),
      schemaVersion: 1,
      payload,
    }));
  }
}
