import { DatabaseSync } from "node:sqlite";

import { UnsupportedSchemaVersionError } from "../errors";

export type SqliteDatabase = Pick<DatabaseSync, "close" | "exec" | "prepare">;

export const CURRENT_SCHEMA_VERSION = 5;

function migrationVersion(database: SqliteDatabase): number {
  const row = database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get();
  return Number(row?.version ?? 0);
}

function migrateToVersionOne(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE events (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, stream_id, seq),
      UNIQUE (workspace_id, channel_id, event_id)
    );
    CREATE TABLE stream_heads (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      terminal_event_id TEXT,
      PRIMARY KEY (workspace_id, channel_id, stream_id)
    );
    CREATE TABLE commands (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, command_id),
      UNIQUE (workspace_id, channel_id, run_id)
    );
    CREATE TABLE channel_sessions (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id)
    );
    CREATE TABLE projections (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      projector TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, projector, stream_id)
    );
    CREATE TABLE projection_receipts (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      projector TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, projector, stream_id, event_id),
      FOREIGN KEY (workspace_id, channel_id, event_id)
        REFERENCES events (workspace_id, channel_id, event_id)
    );
  `);
}

function migrateToVersionTwo(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE schedules (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, schedule_id)
    );
    CREATE TABLE schedule_occurrences (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      run_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, occurrence_id),
      UNIQUE (workspace_id, channel_id, schedule_id, due_at),
      UNIQUE (workspace_id, channel_id, run_id),
      UNIQUE (workspace_id, channel_id, command_id),
      FOREIGN KEY (workspace_id, channel_id, schedule_id)
        REFERENCES schedules (workspace_id, channel_id, schedule_id)
    );
    CREATE TABLE schedule_notifications (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      notification_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, notification_id),
      UNIQUE (workspace_id, channel_id, occurrence_id),
      FOREIGN KEY (workspace_id, channel_id, occurrence_id)
        REFERENCES schedule_occurrences (workspace_id, channel_id, occurrence_id)
    );
  `);
}

function migrateToVersionThree(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE schedule_trigger_registrations (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      registration_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, registration_key)
    );
  `);
}

function migrateToVersionFour(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE schedule_occurrence_recovery_leases (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, occurrence_id)
    );
  `);
}

function migrateToVersionFive(database: SqliteDatabase): void {
  database.exec(`
    ALTER TABLE schedule_occurrence_recovery_leases
      ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
    UPDATE schedule_occurrence_recovery_leases
      SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  `);
}

export function openSqliteDatabase(path: string): SqliteDatabase {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
    );
    let version = migrationVersion(database);
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(version, CURRENT_SCHEMA_VERSION);
    }
    if (version < 1) {
      migrateToVersionOne(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
        1,
      );
      version = 1;
    }
    if (version < 2) {
      migrateToVersionTwo(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(2);
      version = 2;
    }
    if (version < 3) {
      migrateToVersionThree(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(3);
      version = 3;
    }
    if (version < 4) {
      migrateToVersionFour(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(4);
      version = 4;
    }
    if (version < 5) {
      migrateToVersionFive(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(5);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  return database;
}

export function databaseJournalMode(database: SqliteDatabase): string {
  const row = database.prepare("PRAGMA journal_mode").get();
  return String(row?.journal_mode ?? "").toLowerCase();
}

export function databaseSchemaVersion(database: SqliteDatabase): number {
  return migrationVersion(database);
}
