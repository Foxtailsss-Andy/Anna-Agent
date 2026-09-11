import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkbenchSessionRecord {
  readonly schema_version: 2;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly actor_user_id: string;
  readonly channel_id: string;
  readonly project_id?: string;
  readonly surface: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface WorkbenchRunRecord {
  readonly schema_version: 2;
  readonly run_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly actor_user_id: string;
  readonly channel_id: string;
  readonly project_id?: string;
  readonly parent_run_id?: string;
  readonly surface: string;
  readonly prompt: string;
  readonly source_event_id: string;
  readonly source_event_derived?: boolean;
  readonly resource_refs: readonly string[];
  readonly skill_id?: string;
  readonly agent_id?: string;
  readonly model_profile_id?: string;
  readonly requested_artifact?: string;
  readonly conversation_id: string;
  readonly conversation_source?: "conversation" | "run_id_fallback";
  readonly created_at: string;
  readonly updated_at: string;
  readonly admission_status?: "pending" | "started" | "failed";
  readonly admission_error?: string;
}

interface WorkbenchState {
  readonly schema_version: 2;
  readonly sessions: WorkbenchSessionRecord[];
  readonly runs: WorkbenchRunRecord[];
}

export type WorkbenchRunLookup =
  | { readonly kind: "created"; readonly run: WorkbenchRunRecord }
  | { readonly kind: "existing"; readonly run: WorkbenchRunRecord }
  | { readonly kind: "conflict" };

export type WorkbenchAdmissionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly statusCode: number; readonly code: string };

interface PendingAdmission {
  readonly promise: Promise<WorkbenchAdmissionOutcome>;
  readonly resolve: (outcome: WorkbenchAdmissionOutcome) => void;
}

export interface WorkbenchMigrationRecords {
  readonly sessions: readonly WorkbenchSessionRecord[];
  readonly runs: readonly WorkbenchRunRecord[];
}

export interface WorkbenchMigrationResult {
  readonly sessions_added: number;
  readonly runs_added: number;
}

/**
 * Versioned v2 metadata sidecar. Canonical events remain in the EventStore;
 * this file only owns the stable Session/Run identity and source mapping.
 */
export class WorkbenchSessionStore {
  readonly path?: string;
  private state: WorkbenchState | undefined;
  private loadPromise: Promise<void> | undefined;
  private write: Promise<void> = Promise.resolve();
  private readonly pendingAdmissions = new Map<string, PendingAdmission>();

  constructor(path?: string) {
    this.path = path;
  }

  async createSession(
    session: WorkbenchSessionRecord,
  ): Promise<WorkbenchSessionRecord> {
    await this.ensureLoaded();
    return this.mutate((state) => {
      if (state.sessions.some((item) => item.session_id === session.session_id)) {
        throw new Error("session_id_exists");
      }
      state.sessions.push(session);
      return session;
    });
  }

  async getSession(sessionId: string): Promise<WorkbenchSessionRecord | undefined> {
    await this.ensureLoaded();
    return this.state!.sessions.find((item) => item.session_id === sessionId);
  }

  async listSessions(filter: {
    workspace_id: string;
    actor_user_id: string;
    project_id?: string;
  }): Promise<readonly WorkbenchSessionRecord[]> {
    await this.ensureLoaded();
    return this.state!.sessions
      .filter((item) => item.workspace_id === filter.workspace_id)
      .filter((item) => item.actor_user_id === filter.actor_user_id)
      .filter((item) => filter.project_id === undefined || item.project_id === filter.project_id)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async createOrGetRun(
    run: WorkbenchRunRecord,
  ): Promise<WorkbenchRunLookup> {
    await this.ensureLoaded();
    let createdAdmission = false;
    try {
      return await this.mutate((state) => {
        const bySource = state.runs.find((item) =>
          item.session_id === run.session_id && item.source_event_id === run.source_event_id,
        );
        const byId = state.runs.find((item) => item.run_id === run.run_id);
        const existing = bySource ?? byId;
        if (existing !== undefined) {
          return sameRunIdentity(existing, run)
            ? { kind: "existing", run: existing }
            : { kind: "conflict" };
        }
        state.runs.push(run);
        this.beginRunAdmission(run.run_id);
        createdAdmission = true;
        return { kind: "created", run };
      });
    } catch (error) {
      if (createdAdmission) this.cancelRunAdmission(run.run_id);
      throw error;
    }
  }

  async getRun(runId: string): Promise<WorkbenchRunRecord | undefined> {
    await this.ensureLoaded();
    return this.state!.runs.find((item) => item.run_id === runId);
  }

  async markRunAdmission(
    runId: string,
    status: "started" | "failed",
    error?: string,
  ): Promise<void> {
    await this.ensureLoaded();
    await this.mutate((state) => {
      const index = state.runs.findIndex((item) => item.run_id === runId);
      if (index < 0) throw new Error("run_not_found");
      const current = state.runs[index]!;
      state.runs[index] = {
        ...current,
        admission_status: status,
        ...(error === undefined ? {} : { admission_error: error }),
      };
    });
  }

  beginRunAdmission(runId: string): Promise<WorkbenchAdmissionOutcome> {
    const existing = this.pendingAdmissions.get(runId);
    if (existing !== undefined) return existing.promise;
    let resolve!: (outcome: WorkbenchAdmissionOutcome) => void;
    const promise = new Promise<WorkbenchAdmissionOutcome>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.pendingAdmissions.set(runId, { promise, resolve });
    return promise;
  }

  completeRunAdmission(runId: string, outcome: WorkbenchAdmissionOutcome): void {
    this.pendingAdmissions.get(runId)?.resolve(outcome);
  }

  cancelRunAdmission(runId: string): void {
    this.pendingAdmissions.delete(runId);
  }

  waitForRunAdmission(runId: string): Promise<WorkbenchAdmissionOutcome> | undefined {
    return this.pendingAdmissions.get(runId)?.promise;
  }

  endRunAdmission(runId: string): void {
    this.pendingAdmissions.delete(runId);
  }

  async listRuns(sessionId: string): Promise<readonly WorkbenchRunRecord[]> {
    await this.ensureLoaded();
    return this.state!.runs
      .filter((item) => item.session_id === sessionId)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async applyMigration(records: WorkbenchMigrationRecords): Promise<WorkbenchMigrationResult> {
    await this.ensureLoaded();
    return this.mutate((state) => {
      const delta = migrationDelta(state, records);
      state.sessions.push(...delta.sessions);
      state.runs.push(...delta.runs);
      return { sessions_added: delta.sessions.length, runs_added: delta.runs.length };
    });
  }

  async previewMigration(records: WorkbenchMigrationRecords): Promise<WorkbenchMigrationResult> {
    await this.ensureLoaded();
    const delta = migrationDelta(this.state!, records);
    return { sessions_added: delta.sessions.length, runs_added: delta.runs.length };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state !== undefined) return;
    this.loadPromise ??= this.load().catch((error: unknown) => {
      this.loadPromise = undefined;
      throw error;
    });
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    const empty: WorkbenchState = { schema_version: 2, sessions: [], runs: [] };
    if (this.path === undefined) {
      this.state = empty;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isRecord(parsed) || parsed.schema_version !== 2
        || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.runs)) {
        throw new Error("invalid_workbench_sidecar");
      }
      if (parsed.sessions.some((item) => !isSessionRecord(item))
        || parsed.runs.some((item) => !isRunRecord(item))) {
        throw new Error("invalid_workbench_sidecar_record");
      }
      this.state = {
        schema_version: 2,
        sessions: parsed.sessions as WorkbenchSessionRecord[],
        runs: parsed.runs as WorkbenchRunRecord[],
      };
    } catch (error) {
      if (isMissingFile(error)) {
        this.state = empty;
        return;
      }
      throw error;
    }
  }

  private async mutate<T>(mutation: (state: WorkbenchState) => T): Promise<T> {
    let result!: T;
    const operation = this.write.then(async () => {
      const current = this.state!;
      const candidate: WorkbenchState = {
        schema_version: 2,
        sessions: [...current.sessions],
        runs: [...current.runs],
      };
      result = mutation(candidate);
      await this.persist(candidate);
      this.state = candidate;
    });
    this.write = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private async persist(state: WorkbenchState): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function sameRunIdentity(left: WorkbenchRunRecord, right: WorkbenchRunRecord): boolean {
  return left.session_id === right.session_id
    && left.workspace_id === right.workspace_id
    && left.actor_user_id === right.actor_user_id
    && left.prompt === right.prompt
    && left.surface === right.surface
    && left.project_id === right.project_id
    && left.parent_run_id === right.parent_run_id
    && left.skill_id === right.skill_id
    && left.agent_id === right.agent_id
    && left.model_profile_id === right.model_profile_id
    && left.requested_artifact === right.requested_artifact
    && JSON.stringify(left.resource_refs) === JSON.stringify(right.resource_refs);
}

function sameSessionRecord(left: WorkbenchSessionRecord, right: WorkbenchSessionRecord): boolean {
  return left.session_id === right.session_id
    && left.workspace_id === right.workspace_id
    && left.actor_user_id === right.actor_user_id
    && left.channel_id === right.channel_id
    && left.project_id === right.project_id
    && left.surface === right.surface
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at;
}

function sameMigratedRun(left: WorkbenchRunRecord, right: WorkbenchRunRecord): boolean {
  return sameRunIdentity(left, right)
    && left.run_id === right.run_id
    && left.channel_id === right.channel_id
    && left.source_event_id === right.source_event_id
    && left.source_event_derived === right.source_event_derived
    && left.conversation_id === right.conversation_id
    && left.conversation_source === right.conversation_source
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at
    && left.admission_status === right.admission_status
    && left.admission_error === right.admission_error;
}

function migrationDelta(
  state: WorkbenchState,
  records: WorkbenchMigrationRecords,
): { readonly sessions: WorkbenchSessionRecord[]; readonly runs: WorkbenchRunRecord[] } {
  const sessionsById = new Map(state.sessions.map((item) => [item.session_id, item]));
  const runsById = new Map(state.runs.map((item) => [item.run_id, item]));
  const runsBySource = new Map(state.runs.map((item) => [`${item.session_id}\u0000${item.source_event_id}`, item]));
  const sessions: WorkbenchSessionRecord[] = [];
  const runs: WorkbenchRunRecord[] = [];
  for (const session of records.sessions) {
    const existing = sessionsById.get(session.session_id);
    if (existing !== undefined) {
      if (!sameSessionRecord(existing, session)) throw new Error("migration_session_conflict");
      continue;
    }
    sessionsById.set(session.session_id, session);
    sessions.push(session);
  }
  for (const run of records.runs) {
    if (!sessionsById.has(run.session_id)) throw new Error("migration_run_session_missing");
    const existing = runsById.get(run.run_id);
    if (existing !== undefined) {
      if (!sameMigratedRun(existing, run)) throw new Error("migration_run_conflict");
      continue;
    }
    const sourceKey = `${run.session_id}\u0000${run.source_event_id}`;
    const sameSource = runsBySource.get(sourceKey);
    if (sameSource !== undefined && sameSource.run_id !== run.run_id) {
      throw new Error("migration_source_conflict");
    }
    runsById.set(run.run_id, run);
    runsBySource.set(sourceKey, run);
    runs.push(run);
  }
  return { sessions, runs };
}

function isSessionRecord(value: unknown): value is WorkbenchSessionRecord {
  return isRecord(value)
    && value.schema_version === 2
    && typeof value.session_id === "string"
    && typeof value.workspace_id === "string"
    && typeof value.actor_user_id === "string"
    && typeof value.channel_id === "string"
    && typeof value.surface === "string"
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string"
    && (value.admission_status === undefined || value.admission_status === "pending" || value.admission_status === "started" || value.admission_status === "failed")
    && (value.admission_error === undefined || typeof value.admission_error === "string")
    && (value.project_id === undefined || typeof value.project_id === "string");
}

function isRunRecord(value: unknown): value is WorkbenchRunRecord {
  return isRecord(value)
    && value.schema_version === 2
    && typeof value.run_id === "string"
    && typeof value.session_id === "string"
    && typeof value.workspace_id === "string"
    && typeof value.actor_user_id === "string"
    && typeof value.channel_id === "string"
    && typeof value.surface === "string"
    && typeof value.prompt === "string"
    && typeof value.source_event_id === "string"
    && (value.source_event_derived === undefined || typeof value.source_event_derived === "boolean")
    && Array.isArray(value.resource_refs)
    && value.resource_refs.every((item) => typeof item === "string")
    && (value.skill_id === undefined || typeof value.skill_id === "string")
    && (value.agent_id === undefined || typeof value.agent_id === "string")
    && (value.model_profile_id === undefined || typeof value.model_profile_id === "string")
    && typeof value.conversation_id === "string"
    && (value.conversation_source === undefined || value.conversation_source === "conversation" || value.conversation_source === "run_id_fallback")
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string"
    && (value.project_id === undefined || typeof value.project_id === "string")
    && (value.parent_run_id === undefined || typeof value.parent_run_id === "string")
    && (value.requested_artifact === undefined || typeof value.requested_artifact === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
