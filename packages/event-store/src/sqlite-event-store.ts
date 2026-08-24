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
  stableJson,
} from "./codec";
import { isTerminalEvent } from "./lifecycle";
import {
  databaseJournalMode,
  databaseSchemaVersion,
  openSqliteDatabase,
  type SqliteDatabase,
} from "./sqlite/migrations";

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`SQLite ${name} must be a safe integer`);
  }
  return value as number;
}

function finiteNumberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SQLite ${name} must be a finite number`);
  }
  return value;
}

function stringColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`SQLite ${name} must be a string`);
  }
  return value;
}

function storedEvent(row: Record<string, unknown>): CanonicalEvent {
  return parseCanonicalEvent(JSON.parse(stringColumn(row, "event_json")));
}

function storedCommand(row: Record<string, unknown>): StartRun {
  return parseStartRun(JSON.parse(stringColumn(row, "payload_json")));
}

function storedChannelSession(row: Record<string, unknown>): ChannelSession {
  return parseChannelSession(JSON.parse(stringColumn(row, "payload_json")));
}

function storedProjection(row: Record<string, unknown>): ProjectionSnapshot {
  return {
    state: parseJsonValue(
      JSON.parse(stringColumn(row, "state_json")),
      "ProjectionSnapshot.state",
    ),
    version: numberColumn(row, "version"),
    lastSeq: numberColumn(row, "last_seq"),
  };
}

function storedSchedule(row: Record<string, unknown>): ScheduleRecord {
  return parseSchedule(JSON.parse(stringColumn(row, "payload_json")));
}

function storedScheduleOccurrence(row: Record<string, unknown>): ScheduleOccurrence {
  return parseScheduleOccurrence(JSON.parse(stringColumn(row, "payload_json")));
}

function storedScheduleNotification(row: Record<string, unknown>): ScheduleNotification {
  return parseScheduleNotification(JSON.parse(stringColumn(row, "payload_json")));
}

class SqliteScopedChannelStore implements ScopedChannelStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly scope: ChannelScope,
  ) {}

  private transaction<Result>(action: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async append(event: CanonicalEvent): Promise<void> {
    const candidate = cloneEvent(event);
    if (
      candidate.workspaceId !== this.scope.workspaceId ||
      candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }

    this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT event_json FROM events
        WHERE workspace_id = ? AND channel_id = ? AND event_id = ?
      `).get(candidate.workspaceId, candidate.channelId, candidate.id);
      if (existing !== undefined) {
        if (stableJson(storedEvent(existing)) === stableJson(candidate)) {
          return;
        }
        throw new EventConflictError();
      }

      const head = this.database.prepare(`
        SELECT version, terminal_event_id FROM stream_heads
        WHERE workspace_id = ? AND channel_id = ? AND stream_id = ?
      `).get(candidate.workspaceId, candidate.channelId, candidate.streamId);
      const version = head === undefined ? 0 : numberColumn(head, "version");
      if (candidate.seq !== version) {
        throw new EventSequenceConflictError();
      }
      if (head !== undefined && head.terminal_event_id !== null) {
        throw new TerminalEventConflictError();
      }

      this.database.prepare(`
        INSERT INTO events (
          workspace_id, channel_id, stream_id, seq, event_id, type,
          timestamp, schema_version, payload_json, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.streamId,
        candidate.seq,
        candidate.id,
        candidate.type,
        candidate.timestamp,
        candidate.schemaVersion,
        JSON.stringify(candidate.payload),
        JSON.stringify(candidate),
      );
      this.database.prepare(`
        INSERT INTO stream_heads (
          workspace_id, channel_id, stream_id, version, terminal_event_id
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, channel_id, stream_id) DO UPDATE SET
          version = excluded.version,
          terminal_event_id = COALESCE(stream_heads.terminal_event_id, excluded.terminal_event_id)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.streamId,
        candidate.seq + 1,
        isTerminalEvent(candidate.type) ? candidate.id : null,
      );
    });
  }

  async appendIdempotent(event: CanonicalEvent): Promise<boolean> {
    const candidate = cloneEvent(event);
    if (
      candidate.workspaceId !== this.scope.workspaceId
      || candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT event_json FROM events
        WHERE workspace_id = ? AND channel_id = ? AND event_id = ?
      `).get(candidate.workspaceId, candidate.channelId, candidate.id);
      if (existing !== undefined) {
        const stored = storedEvent(existing);
        if (
          stableJson({ ...stored, seq: 0, timestamp: "" })
          !== stableJson({ ...candidate, seq: 0, timestamp: "" })
        ) {
          throw new EventConflictError();
        }
        return false;
      }
      const head = this.database.prepare(`
        SELECT version, terminal_event_id FROM stream_heads
        WHERE workspace_id = ? AND channel_id = ? AND stream_id = ?
      `).get(candidate.workspaceId, candidate.channelId, candidate.streamId);
      const version = head === undefined ? 0 : numberColumn(head, "version");
      if (head !== undefined && head.terminal_event_id !== null) {
        throw new TerminalEventConflictError();
      }
      const storedCandidate = candidate.seq === version ? candidate : { ...candidate, seq: version };
      this.database.prepare(`
        INSERT INTO events (
          workspace_id, channel_id, stream_id, seq, event_id, type,
          timestamp, schema_version, payload_json, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        storedCandidate.workspaceId,
        storedCandidate.channelId,
        storedCandidate.streamId,
        storedCandidate.seq,
        storedCandidate.id,
        storedCandidate.type,
        storedCandidate.timestamp,
        storedCandidate.schemaVersion,
        JSON.stringify(storedCandidate.payload),
        JSON.stringify(storedCandidate),
      );
      this.database.prepare(`
        INSERT INTO stream_heads (
          workspace_id, channel_id, stream_id, version, terminal_event_id
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, channel_id, stream_id) DO UPDATE SET
          version = excluded.version,
          terminal_event_id = COALESCE(stream_heads.terminal_event_id, excluded.terminal_event_id)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.streamId,
        storedCandidate.seq + 1,
        isTerminalEvent(storedCandidate.type) ? storedCandidate.id : null,
      );
      return true;
    });
  }

  async *read(
    streamId: CanonicalEvent["streamId"],
    afterSeq?: number,
  ): AsyncIterable<CanonicalEvent> {
    const rows = this.database.prepare(`
      SELECT event_json FROM events
      WHERE workspace_id = ? AND channel_id = ? AND stream_id = ?
        AND seq > ?
      ORDER BY seq ASC
    `).all(
      this.scope.workspaceId,
      this.scope.channelId,
      streamId,
      afterSeq ?? -1,
    );
    for (const row of rows) {
      yield cloneEvent(storedEvent(row));
    }
  }

  async listRunCommands(): Promise<readonly StartRun[]> {
    const rows = this.database.prepare(`
      SELECT payload_json FROM commands
      WHERE workspace_id = ? AND channel_id = ?
      ORDER BY run_id ASC
    `).all(this.scope.workspaceId, this.scope.channelId);
    return rows.map((row) => cloneStartRun(storedCommand(row)));
  }

  async listRunStreamIds(runId: RunId): Promise<readonly StreamId[]> {
    const streamIds = new Set<StreamId>();
    const commands = this.database.prepare(`
      SELECT payload_json FROM commands
      WHERE workspace_id = ? AND channel_id = ?
    `).all(this.scope.workspaceId, this.scope.channelId);
    for (const row of commands) {
      const command = storedCommand(row);
      if (command.parentRunId === runId) {
        streamIds.add(command.runId as unknown as StreamId);
      }
    }
    const rows = this.database.prepare(`
      SELECT stream_id, event_json FROM events
      WHERE workspace_id = ? AND channel_id = ?
    `).all(this.scope.workspaceId, this.scope.channelId);
    for (const row of rows) {
      const event = storedEvent(row);
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
    return [...streamIds].sort();
  }

  async claimStart(command: StartRun): Promise<StartRun> {
    const candidate = cloneStartRun(command);
    if (
      candidate.workspaceId !== this.scope.workspaceId
      || candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }

    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT payload_json FROM commands
        WHERE workspace_id = ? AND channel_id = ? AND command_id = ?
      `).get(candidate.workspaceId, candidate.channelId, candidate.commandId);
      if (existing !== undefined) {
        const stored = storedCommand(existing);
        if (stableJson(stored) === stableJson(candidate)) {
          return cloneStartRun(stored);
        }
        throw new CommandConflictError();
      }

      const run = this.database.prepare(`
        SELECT command_id FROM commands
        WHERE workspace_id = ? AND channel_id = ? AND run_id = ?
      `).get(candidate.workspaceId, candidate.channelId, candidate.runId);
      if (run !== undefined) {
        throw new CommandConflictError();
      }

      this.database.prepare(`
        INSERT INTO commands (workspace_id, channel_id, command_id, run_id, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.commandId,
        candidate.runId,
        JSON.stringify(candidate),
      );
      return cloneStartRun(candidate);
    });
  }

  async getCommand(commandId: StartRun["commandId"]): Promise<StartRun | undefined> {
    const row = this.database.prepare(`
      SELECT payload_json FROM commands
      WHERE workspace_id = ? AND channel_id = ? AND command_id = ?
    `).get(this.scope.workspaceId, this.scope.channelId, commandId);
    return row === undefined ? undefined : cloneStartRun(storedCommand(row));
  }

  async getRunCommand(runId: RunId): Promise<StartRun | undefined> {
    const row = this.database.prepare(`
      SELECT payload_json FROM commands
      WHERE workspace_id = ? AND channel_id = ? AND run_id = ?
    `).get(this.scope.workspaceId, this.scope.channelId, runId);
    return row === undefined ? undefined : cloneStartRun(storedCommand(row));
  }

  async claimChannelSession(session: ChannelSession): Promise<ChannelSession> {
    const candidate = cloneSession(session);
    if (
      candidate.workspaceId !== this.scope.workspaceId
      || candidate.channelId !== this.scope.channelId
    ) {
      throw new EventScopeMismatchError();
    }

    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT payload_json FROM channel_sessions
        WHERE workspace_id = ? AND channel_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId);
      if (existing !== undefined) {
        const stored = storedChannelSession(existing);
        if (stableJson(stored) === stableJson(candidate)) {
          return cloneSession(stored);
        }
        throw new ChannelSessionConflictError();
      }
      this.database.prepare(`
        INSERT INTO channel_sessions (workspace_id, channel_id, session_id, payload_json)
        VALUES (?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.id,
        JSON.stringify(candidate),
      );
      return cloneSession(candidate);
    });
  }

  async getChannelSession(): Promise<ChannelSession | undefined> {
    const row = this.database.prepare(`
      SELECT payload_json FROM channel_sessions
      WHERE workspace_id = ? AND channel_id = ?
    `).get(this.scope.workspaceId, this.scope.channelId);
    return row === undefined ? undefined : cloneSession(storedChannelSession(row));
  }

  async loadProjection(
    projector: string,
    streamId: CanonicalEvent["streamId"],
  ): Promise<ProjectionSnapshot | undefined> {
    const row = this.database.prepare(`
      SELECT state_json, version, last_seq FROM projections
      WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
    `).get(this.scope.workspaceId, this.scope.channelId, projector, streamId);
    return row === undefined ? undefined : cloneProjectionSnapshot(storedProjection(row));
  }

  async commitProjection(
    commit: ProjectionCommit,
  ): Promise<ProjectionCommitResult> {
    const state = parseJsonValue(commit.state, "ProjectionCommit.state");
    return this.transaction(() => {
      const source = this.database.prepare(`
        SELECT seq FROM events
        WHERE workspace_id = ? AND channel_id = ? AND stream_id = ? AND event_id = ?
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        commit.streamId,
        commit.eventId,
      );
      if (source === undefined || numberColumn(source, "seq") !== commit.eventSeq) {
        throw new ProjectionSourceEventNotFoundError();
      }

      const receipt = this.database.prepare(`
        SELECT event_seq FROM projection_receipts
        WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ? AND event_id = ?
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        commit.projector,
        commit.streamId,
        commit.eventId,
      );
      if (receipt !== undefined) {
        const current = this.database.prepare(`
          SELECT state_json, version, last_seq FROM projections
          WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
        `).get(
          this.scope.workspaceId,
          this.scope.channelId,
          commit.projector,
          commit.streamId,
        );
        if (current === undefined) {
          throw new Error("SQLite projection receipt has no projection state");
        }
        return { ...cloneProjectionSnapshot(storedProjection(current)), applied: false };
      }

      const current = this.database.prepare(`
        SELECT state_json, version, last_seq FROM projections
        WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ?
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        commit.projector,
        commit.streamId,
      );
      const version = current === undefined ? 0 : numberColumn(current, "version");
      if (version !== commit.expectedVersion) {
        throw new ProjectionVersionConflictError();
      }

      const snapshot: ProjectionSnapshot = {
        state,
        version: version + 1,
        lastSeq: commit.eventSeq,
      };
      if (current === undefined) {
        this.database.prepare(`
          INSERT INTO projections (
            workspace_id, channel_id, projector, stream_id, state_json, version, last_seq
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.scope.workspaceId,
          this.scope.channelId,
          commit.projector,
          commit.streamId,
          JSON.stringify(snapshot.state),
          snapshot.version,
          snapshot.lastSeq,
        );
      } else {
        this.database.prepare(`
          UPDATE projections
          SET state_json = ?, version = ?, last_seq = ?
          WHERE workspace_id = ? AND channel_id = ? AND projector = ? AND stream_id = ? AND version = ?
        `).run(
          JSON.stringify(snapshot.state),
          snapshot.version,
          snapshot.lastSeq,
          this.scope.workspaceId,
          this.scope.channelId,
          commit.projector,
          commit.streamId,
          commit.expectedVersion,
        );
      }
      this.database.prepare(`
        INSERT INTO projection_receipts (
          workspace_id, channel_id, projector, stream_id, event_id, event_seq
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        this.scope.workspaceId,
        this.scope.channelId,
        commit.projector,
        commit.streamId,
        commit.eventId,
        commit.eventSeq,
      );
      return cloneProjectionCommitResult({ ...snapshot, applied: true });
    });
  }

  async activeRunIds(): Promise<readonly RunId[]> {
    return this.database.prepare(`
      SELECT commands.run_id FROM commands
      LEFT JOIN stream_heads ON
        stream_heads.workspace_id = commands.workspace_id
        AND stream_heads.channel_id = commands.channel_id
        AND stream_heads.stream_id = commands.run_id
      WHERE commands.workspace_id = ? AND commands.channel_id = ?
        AND (stream_heads.terminal_event_id IS NULL)
    `).all(this.scope.workspaceId, this.scope.channelId).map((row) => (
      stringColumn(row, "run_id") as RunId
    ));
  }

  async createSchedule(schedule: ScheduleRecord): Promise<ScheduleRecord> {
    const candidate = cloneSchedule(schedule);
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT payload_json FROM schedules
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.id);
      if (existing !== undefined) {
        const stored = storedSchedule(existing);
        if (stableJson(stored) === stableJson(candidate)) {
          return cloneSchedule(stored);
        }
        throw new ScheduleConflictError();
      }
      this.database.prepare(`
        INSERT INTO schedules (workspace_id, channel_id, schedule_id, status, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.id,
        candidate.status,
        JSON.stringify(candidate),
      );
      return cloneSchedule(candidate);
    });
  }

  async listSchedules(): Promise<readonly ScheduleRecord[]> {
    return this.database.prepare(`
      SELECT payload_json FROM schedules
      WHERE workspace_id = ? AND channel_id = ?
      ORDER BY schedule_id ASC
    `).all(this.scope.workspaceId, this.scope.channelId).map((row) =>
      cloneSchedule(storedSchedule(row)));
  }

  async cancelSchedule(scheduleId: ScheduleId, _cancelledAt: string): Promise<ScheduleRecord | undefined> {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT payload_json FROM schedules
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, scheduleId);
      if (row === undefined) {
        return undefined;
      }
      const cancelled = cloneSchedule({ ...storedSchedule(row), status: "cancelled" });
      this.database.prepare(`
        UPDATE schedules SET status = ?, payload_json = ?
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      `).run(
        cancelled.status,
        JSON.stringify(cancelled),
        this.scope.workspaceId,
        this.scope.channelId,
        scheduleId,
      );
      return cloneSchedule(cancelled);
    });
  }

  async claimScheduleOccurrence(
    occurrence: ScheduleOccurrence,
  ): Promise<ScheduleOccurrenceClaim> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const schedule = this.database.prepare(`
        SELECT status FROM schedules
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.scheduleId);
      if (schedule === undefined || schedule.status !== "active") {
        return { claimed: false, reason: "schedule_inactive" };
      }
      const existing = this.database.prepare(`
        SELECT payload_json FROM schedule_occurrences
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ? AND due_at = ?
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.scheduleId,
        candidate.dueAt,
      );
      if (existing !== undefined) {
        const stored = storedScheduleOccurrence(existing);
        return {
          claimed: false,
          reason: "already_claimed",
          occurrence: cloneScheduleOccurrence(stored),
        };
      }
      const conflictingIdentity = this.database.prepare(`
        SELECT occurrence_id FROM schedule_occurrences
        WHERE workspace_id = ? AND channel_id = ?
          AND (occurrence_id = ? OR run_id = ? OR command_id = ?)
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.id,
        candidate.runId,
        candidate.commandId,
      );
      if (conflictingIdentity !== undefined) {
        throw new ScheduleConflictError();
      }
      this.database.prepare(`
        INSERT INTO schedule_occurrences (
          workspace_id, channel_id, occurrence_id, schedule_id,
          due_at, run_id, command_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.id,
        candidate.scheduleId,
        candidate.dueAt,
        candidate.runId,
        candidate.commandId,
        JSON.stringify(candidate),
      );
      return { claimed: true, occurrence: cloneScheduleOccurrence(candidate) };
    });
  }

  async skipScheduleOccurrence(occurrence: ScheduleOccurrence): Promise<boolean> {
    const candidate = cloneScheduleOccurrence({ ...occurrence, status: "skipped" });
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const schedule = this.database.prepare(`
        SELECT status FROM schedules
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.scheduleId);
      if (schedule === undefined || schedule.status !== "active") {
        return false;
      }
      const existing = this.database.prepare(`
        SELECT payload_json FROM schedule_occurrences
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ? AND due_at = ?
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.scheduleId,
        candidate.dueAt,
      );
      if (existing !== undefined) {
        return false;
      }
      const conflictingIdentity = this.database.prepare(`
        SELECT occurrence_id FROM schedule_occurrences
        WHERE workspace_id = ? AND channel_id = ?
          AND (occurrence_id = ? OR run_id = ? OR command_id = ?)
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.id,
        candidate.runId,
        candidate.commandId,
      );
      if (conflictingIdentity !== undefined) {
        throw new ScheduleConflictError();
      }
      this.database.prepare(`
        INSERT INTO schedule_occurrences (
          workspace_id, channel_id, occurrence_id, schedule_id,
          due_at, run_id, command_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.id,
        candidate.scheduleId,
        candidate.dueAt,
        candidate.runId,
        candidate.commandId,
        JSON.stringify(candidate),
      );
      return true;
    });
  }

  async claimScheduleOccurrenceRecovery(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT owner_id,
          (julianday('now') - julianday(claimed_at)) * 86400000 AS age_ms
        FROM schedule_occurrence_recovery_leases
        WHERE workspace_id = ? AND channel_id = ? AND occurrence_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.id);
      if (
        existing !== undefined
        && finiteNumberColumn(existing, "age_ms") < 60_000
      ) {
        return false;
      }
      this.database.prepare(`
        INSERT INTO schedule_occurrence_recovery_leases (
          workspace_id, channel_id, occurrence_id, claimed_at, owner_id
        ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
        ON CONFLICT (workspace_id, channel_id, occurrence_id) DO UPDATE SET
          claimed_at = excluded.claimed_at,
          owner_id = excluded.owner_id
      `).run(this.scope.workspaceId, this.scope.channelId, candidate.id, ownerId);
      return true;
    });
  }

  async renewScheduleOccurrenceRecovery(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE schedule_occurrence_recovery_leases
        SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE workspace_id = ? AND channel_id = ? AND occurrence_id = ? AND owner_id = ?
      `).run(
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.id,
        ownerId,
      );
      return Number(result.changes ?? 0) === 1;
    });
  }

  async claimScheduleOccurrenceExecution(
    occurrence: ScheduleOccurrence,
    ownerId: string,
  ): Promise<boolean> {
    const candidate = cloneScheduleOccurrence(occurrence);
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const lease = this.database.prepare(`
        SELECT owner_id,
          (julianday('now') - julianday(claimed_at)) * 86400000 AS age_ms
        FROM schedule_occurrence_recovery_leases
        WHERE workspace_id = ? AND channel_id = ? AND occurrence_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.id);
      if (
        lease === undefined
        || stringColumn(lease, "owner_id") !== ownerId
        || finiteNumberColumn(lease, "age_ms") >= 60_000
      ) {
        return false;
      }
      const row = this.database.prepare(`
        SELECT payload_json FROM schedule_occurrences
        WHERE workspace_id = ? AND channel_id = ? AND occurrence_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.id);
      if (row === undefined) {
        return false;
      }
      const existing = storedScheduleOccurrence(row);
      if (existing.status === "started" || existing.status === "skipped") {
        return false;
      }
      const started = cloneScheduleOccurrence({ ...existing, status: "started" });
      const result = this.database.prepare(`
        UPDATE schedule_occurrences SET payload_json = ?
        WHERE workspace_id = ? AND channel_id = ? AND occurrence_id = ?
      `).run(
        JSON.stringify(started),
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.id,
      );
      return Number(result.changes ?? 0) === 1;
    });
  }

  async recordScheduleNotification(
    notification: ScheduleNotification,
  ): Promise<ScheduleNotification> {
    const candidate = cloneScheduleNotification(notification);
    this.assertScheduleScope(candidate);
    return this.transaction(() => {
      const occurrence = this.database.prepare(`
        SELECT schedule_id, run_id FROM schedule_occurrences
        WHERE workspace_id = ? AND channel_id = ? AND occurrence_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.occurrenceId);
      if (
        occurrence === undefined
        || occurrence.schedule_id !== candidate.scheduleId
        || occurrence.run_id !== candidate.runId
      ) {
        throw new ScheduleNotificationConflictError();
      }
      const schedule = this.database.prepare(`
        SELECT payload_json FROM schedules
        WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      `).get(this.scope.workspaceId, this.scope.channelId, candidate.scheduleId);
      if (schedule === undefined) {
        throw new ScheduleNotificationConflictError();
      }
      const stored = storedSchedule(schedule);
      if (
        stableJson(stored.trigger) !== stableJson(candidate.trigger)
        || stableJson(stored.run.notificationAudience) !== stableJson(candidate.audience)
      ) {
        throw new ScheduleNotificationConflictError();
      }
      const existing = this.database.prepare(`
        SELECT payload_json FROM schedule_notifications
        WHERE workspace_id = ? AND channel_id = ?
          AND (notification_id = ? OR occurrence_id = ?)
      `).get(
        this.scope.workspaceId,
        this.scope.channelId,
        candidate.id,
        candidate.occurrenceId,
      );
      if (existing !== undefined) {
        const stored = storedScheduleNotification(existing);
        if (stableJson(stored) === stableJson(candidate)) {
          return cloneScheduleNotification(stored);
        }
        throw new ScheduleNotificationConflictError();
      }
      this.database.prepare(`
        INSERT INTO schedule_notifications (
          workspace_id, channel_id, notification_id, schedule_id,
          occurrence_id, run_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.workspaceId,
        candidate.channelId,
        candidate.id,
        candidate.scheduleId,
        candidate.occurrenceId,
        candidate.runId,
        JSON.stringify(candidate),
      );
      return cloneScheduleNotification(candidate);
    });
  }

  async listScheduleOccurrences(scheduleId: ScheduleId): Promise<readonly ScheduleOccurrence[]> {
    return this.database.prepare(`
      SELECT payload_json FROM schedule_occurrences
      WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      ORDER BY due_at ASC
    `).all(this.scope.workspaceId, this.scope.channelId, scheduleId).map((row) =>
      cloneScheduleOccurrence(storedScheduleOccurrence(row)));
  }

  async listScheduleNotifications(scheduleId: ScheduleId): Promise<readonly ScheduleNotification[]> {
    return this.database.prepare(`
      SELECT payload_json FROM schedule_notifications
      WHERE workspace_id = ? AND channel_id = ? AND schedule_id = ?
      ORDER BY notification_id ASC
    `).all(this.scope.workspaceId, this.scope.channelId, scheduleId).map((row) =>
      cloneScheduleNotification(storedScheduleNotification(row)));
  }

  async registerScheduleTrigger(trigger: ScheduleTrigger): Promise<void> {
    const key = stableJson(trigger);
    this.transaction(() => {
      this.database.prepare(`
        INSERT OR IGNORE INTO schedule_trigger_registrations (
          workspace_id, channel_id, registration_key, payload_json
        ) VALUES (?, ?, ?, ?)
      `).run(this.scope.workspaceId, this.scope.channelId, key, JSON.stringify(trigger));
    });
  }

  async hasScheduleTriggerRegistration(trigger: ScheduleTrigger): Promise<boolean> {
    return this.database.prepare(`
      SELECT registration_key FROM schedule_trigger_registrations
      WHERE workspace_id = ? AND channel_id = ? AND registration_key = ?
    `).get(this.scope.workspaceId, this.scope.channelId, stableJson(trigger)) !== undefined;
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

export class SqliteEventStore implements EventStore {
  private readonly database: SqliteDatabase;

  constructor(path: string) {
    this.database = openSqliteDatabase(path);
  }

  scope(scope: ChannelScope): ScopedChannelStore {
    return new SqliteScopedChannelStore(this.database, cloneScope(scope));
  }

  close(): void {
    this.database.close();
  }

  diagnosticJournalMode(): string {
    return databaseJournalMode(this.database);
  }

  diagnosticSchemaVersion(): number {
    return databaseSchemaVersion(this.database);
  }
}
