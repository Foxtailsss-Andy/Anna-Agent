import {
  parseCanonicalEvent,
  parseChannelScope,
  parseChannelSession,
  parseJsonValue,
  parseSchedule,
  parseScheduleNotification,
  parseScheduleOccurrence,
  parseStartRun,
} from "@anna/harness-v2";
import type {
  CanonicalEvent,
  ChannelScope,
  ChannelSession,
  ProjectionCommitResult,
  ProjectionSnapshot,
  ScheduleNotification,
  ScheduleOccurrence,
  ScheduleRecord,
  StartRun,
} from "@anna/harness-v2";

export function cloneEvent(event: CanonicalEvent): CanonicalEvent {
  return parseCanonicalEvent(event);
}

export function cloneScope(scope: ChannelScope): ChannelScope {
  return parseChannelScope(scope);
}

export function cloneSession(session: ChannelSession): ChannelSession {
  return parseChannelSession(session);
}

export function cloneStartRun(command: StartRun): StartRun {
  return parseStartRun(command);
}

export function cloneSchedule(schedule: ScheduleRecord): ScheduleRecord {
  return parseSchedule(schedule);
}

export function cloneScheduleOccurrence(occurrence: ScheduleOccurrence): ScheduleOccurrence {
  return parseScheduleOccurrence(occurrence);
}

export function cloneScheduleNotification(notification: ScheduleNotification): ScheduleNotification {
  return parseScheduleNotification(notification);
}

export function cloneProjectionSnapshot(snapshot: ProjectionSnapshot): ProjectionSnapshot {
  return {
    state: parseJsonValue(snapshot.state, "ProjectionSnapshot.state"),
    version: snapshot.version,
    lastSeq: snapshot.lastSeq,
  };
}

export function cloneProjectionCommitResult(
  result: ProjectionCommitResult,
): ProjectionCommitResult {
  return { ...cloneProjectionSnapshot(result), applied: result.applied };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function scopedKey(scope: ChannelScope, kind: string, id: string): string {
  return stableJson([scope.workspaceId, scope.channelId, kind, id]);
}

export function scopedPrefix(scope: ChannelScope, kind: string): string {
  return stableJson([scope.workspaceId, scope.channelId, kind]).slice(0, -1);
}
