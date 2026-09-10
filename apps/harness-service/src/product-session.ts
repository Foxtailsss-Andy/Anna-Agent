import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseJsonValue, type JsonValue } from "@anna/harness-v2";

export const productSurfaces = [
  "chat",
  "create",
  "hiker",
  "reimbursement",
  "crew",
] as const;

export type ProductSurface = typeof productSurfaces[number];
export type ProductPermissionMode = "readonly" | "ask" | "contained-write" | "full";

export interface ProductTask {
  readonly run_id: string;
  readonly schema_version?: 2;
  readonly workspace_id: string;
  readonly actor_user_id: string;
  readonly surface: ProductSurface;
  readonly prompt: string;
  readonly channel_id?: string;
  readonly conversation_id?: string;
  readonly session_id?: string;
  readonly project_id?: string;
  readonly parent_run_id?: string;
  readonly resource_refs?: readonly string[];
  readonly requested_artifact?: string;
  readonly system_prompt?: string;
  readonly context?: Record<string, JsonValue>;
  readonly workdir_path?: string;
  readonly permission_mode?: ProductPermissionMode;
  readonly model_profile_id?: string;
  readonly source_event_id?: string;
}

export interface ProductSessionRecord {
  readonly task: ProductTask;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProductSessionSourceSnapshot {
  readonly path?: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly records: readonly ProductSessionRecord[];
}

export class ProductSessionStoreFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductSessionStoreFormatError";
  }
}

const taskKeys = new Set([
  "run_id",
  "schema_version",
  "workspace_id",
  "actor_user_id",
  "surface",
  "prompt",
  "channel_id",
  "conversation_id",
  "session_id",
  "project_id",
  "parent_run_id",
  "resource_refs",
  "requested_artifact",
  "system_prompt",
  "context",
  "workdir_path",
  "permission_mode",
  "model_profile_id",
  "source_event_id",
]);

const permissions = new Set<ProductPermissionMode>([
  "readonly",
  "ask",
  "contained-write",
  "full",
]);

export class ProductTaskValidationError extends Error {
  readonly code = "invalid_product_task" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProductTaskValidationError";
  }
}

export function validatedProductTask(input: unknown): ProductTask {
  if (!isRecord(input)) throw new ProductTaskValidationError("ProductTask must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!taskKeys.has(key)) throw new ProductTaskValidationError(`ProductTask field is not allowed: ${key}`);
  }

  const runId = requiredString(input.run_id, "run_id");
  if (input.schema_version !== undefined && input.schema_version !== 2) {
    throw new ProductTaskValidationError("schema_version must be 2");
  }
  const workspaceId = requiredString(input.workspace_id, "workspace_id");
  const actorUserId = requiredString(input.actor_user_id, "actor_user_id");
  const surface = requiredString(input.surface, "surface");
  if (!(productSurfaces as readonly string[]).includes(surface)) {
    throw new ProductTaskValidationError("surface is not an admitted Product surface");
  }
  const prompt = requiredString(input.prompt, "prompt");
  const task: ProductTask = {
    run_id: runId,
    ...(input.schema_version === undefined ? {} : { schema_version: 2 as const }),
    workspace_id: workspaceId,
    actor_user_id: actorUserId,
    surface: surface as ProductSurface,
    prompt,
    ...(optionalString(input.channel_id) === undefined ? {} : { channel_id: input.channel_id as string }),
    ...(optionalString(input.conversation_id) === undefined ? {} : { conversation_id: input.conversation_id as string }),
    ...(optionalString(input.session_id) === undefined ? {} : { session_id: input.session_id as string }),
    ...(optionalString(input.project_id) === undefined ? {} : { project_id: input.project_id as string }),
    ...(optionalString(input.parent_run_id) === undefined ? {} : { parent_run_id: input.parent_run_id as string }),
    ...(input.resource_refs === undefined ? {} : { resource_refs: resourceRefs(input.resource_refs) }),
    ...(optionalString(input.requested_artifact) === undefined ? {} : { requested_artifact: input.requested_artifact as string }),
    ...(optionalString(input.system_prompt) === undefined ? {} : { system_prompt: input.system_prompt as string }),
    ...(input.context === undefined ? {} : { context: contextRecord(input.context) }),
    ...(optionalString(input.workdir_path) === undefined ? {} : { workdir_path: input.workdir_path as string }),
    ...(input.permission_mode === undefined ? {} : { permission_mode: permission(input.permission_mode) }),
    ...(optionalString(input.model_profile_id) === undefined ? {} : { model_profile_id: input.model_profile_id as string }),
    ...(optionalString(input.source_event_id) === undefined ? {} : { source_event_id: input.source_event_id as string }),
  };
  return task;
}

export class ProductSessionStore {
  private readonly records = new Map<string, ProductSessionRecord>();
  readonly taskSnapshotPath?: string;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private write: Promise<void> = Promise.resolve();

  constructor(readonly path?: string) {
    this.taskSnapshotPath = path === undefined ? undefined : `${path}.tasks.v2.json`;
  }

  async get(runId: string): Promise<ProductSessionRecord | undefined> {
    await this.load();
    return this.records.get(runId);
  }

  async list(): Promise<readonly ProductSessionRecord[]> {
    await this.load();
    return [...this.records.values()].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at),
    );
  }

  async readSourceStrict(): Promise<ProductSessionSourceSnapshot> {
    return readProductSessionSource(this.path);
  }

  /** Read the in-process task mapping after the Host has admitted it. */
  peek(runId: string): ProductSessionRecord | undefined {
    return this.records.get(runId);
  }

  async save(task: ProductTask, now = new Date().toISOString()): Promise<ProductSessionRecord> {
    await this.load();
    const existing = this.records.get(task.run_id);
    if (existing !== undefined) {
      if (stableJson(existing.task) !== stableJson(task)) {
        throw new ProductTaskValidationError("run_id is already bound to a different ProductTask");
      }
      return existing;
    }
    const record: ProductSessionRecord = {
      task,
      created_at: now,
      updated_at: now,
    };
    let result!: ProductSessionRecord;
    const operation = this.write.then(async () => {
      const existing = this.records.get(task.run_id);
      if (existing !== undefined) {
        if (stableJson(existing.task) !== stableJson(task)) {
          throw new ProductTaskValidationError("run_id is already bound to a different ProductTask");
        }
        result = existing;
        return;
      }
      const candidate = new Map(this.records);
      candidate.set(task.run_id, record);
      await this.persist(candidate);
      this.records.clear();
      for (const [runId, item] of candidate) this.records.set(runId, item);
      result = record;
    });
    this.write = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadInternal().catch((error) => {
      this.loadPromise = undefined;
      throw error;
    });
    await this.loadPromise;
  }

  private async loadInternal(): Promise<void> {
    const source = await readProductSessionSource(this.path);
    const candidate = new Map<string, ProductSessionRecord>();
    for (const record of source.records) candidate.set(record.task.run_id, record);
    if (this.taskSnapshotPath !== undefined) {
      const sidecar = await readProductSessionSnapshot(this.taskSnapshotPath);
      for (const record of sidecar) {
        const existing = candidate.get(record.task.run_id);
        if (existing !== undefined && stableJson(existing) !== stableJson(record)) {
          throw new ProductSessionStoreFormatError(`conflicting ProductTask snapshot for ${record.task.run_id}`);
        }
        candidate.set(record.task.run_id, record);
      }
    }
    this.records.clear();
    for (const [runId, record] of candidate) this.records.set(runId, record);
    this.loaded = true;
  }

  private async persist(records: ReadonlyMap<string, ProductSessionRecord>): Promise<void> {
    if (this.taskSnapshotPath === undefined) return;
    await mkdir(dirname(this.taskSnapshotPath), { recursive: true });
    const temporary = `${this.taskSnapshotPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await writeFile(
      temporary,
      `${JSON.stringify({ schema_version: 2, records: [...records.values()] })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.taskSnapshotPath);
  }
}

export async function readProductSessionSource(
  path?: string,
): Promise<ProductSessionSourceSnapshot> {
  if (path === undefined) {
    return {
      sha256: createHash("sha256").update("").digest("hex"),
      bytes: 0,
      records: [],
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        path,
        sha256: createHash("sha256").update("").digest("hex"),
        bytes: 0,
        records: [],
      };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProductSessionStoreFormatError("legacy ProductSessionStore source is not valid JSON");
  }
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    records: parseProductSessionRecords(value, "legacy ProductSessionStore source"),
  };
}

async function readProductSessionSnapshot(path: string): Promise<readonly ProductSessionRecord[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return [];
    if (error instanceof SyntaxError) {
      throw new ProductSessionStoreFormatError("ProductSessionStore task snapshot is not valid JSON");
    }
    throw error;
  }
  if (!isRecord(value) || value.schema_version !== 2 || !Array.isArray(value.records)) {
    throw new ProductSessionStoreFormatError("invalid ProductSessionStore task snapshot");
  }
  return parseProductSessionRecords(value.records, "ProductSessionStore task snapshot");
}

function parseProductSessionRecords(value: unknown, source: string): ProductSessionRecord[] {
  if (!Array.isArray(value)) throw new ProductSessionStoreFormatError(`${source} must be an array`);
  const records: ProductSessionRecord[] = [];
  const runIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isRecord(item.task)) {
      throw new ProductSessionStoreFormatError(`${source} record ${index} is invalid`);
    }
    let task: ProductTask;
    try {
      task = validatedProductTask(item.task);
    } catch (error) {
      throw new ProductSessionStoreFormatError(`${source} record ${index} task is invalid: ${error instanceof Error ? error.message : "unknown"}`);
    }
    const createdAt = strictTimestamp(item.created_at, `${source} record ${index}.created_at`);
    const updatedAt = strictTimestamp(item.updated_at, `${source} record ${index}.updated_at`);
    if (runIds.has(task.run_id)) {
      throw new ProductSessionStoreFormatError(`${source} contains duplicate run_id ${task.run_id}`);
    }
    runIds.add(task.run_id);
    records.push({ task, created_at: createdAt, updated_at: updatedAt });
  }
  return records;
}

function strictTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProductSessionStoreFormatError(`${name} must be a non-empty string`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function contextRecord(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) throw new ProductTaskValidationError("context must be a JSON object");
  const parsed = parseJsonValue(value, "ProductTask.context");
  if (!isRecord(parsed)) throw new ProductTaskValidationError("context must be a JSON object");
  rejectSensitiveKeys(parsed);
  return parsed;
}

function rejectSensitiveKeys(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSensitiveKeys(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api[_-]?key|access[_-]?token|authorization|credential|password|secret)/i.test(key)) {
      throw new ProductTaskValidationError("context contains a credential-like field");
    }
    rejectSensitiveKeys(item);
  }
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (result === undefined) throw new ProductTaskValidationError(`${name} must be a non-empty string`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (value.length > 262_144) throw new ProductTaskValidationError("ProductTask string exceeds the size limit");
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 && character !== "\n" && character !== "\r" && character !== "\t")) {
    throw new ProductTaskValidationError("ProductTask string contains a control character");
  }
  return value;
}

function permission(value: unknown): ProductPermissionMode {
  if (typeof value !== "string" || !permissions.has(value as ProductPermissionMode)) {
    throw new ProductTaskValidationError("permission_mode is not allowed");
  }
  return value as ProductPermissionMode;
}

function resourceRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ProductTaskValidationError("resource_refs must be an array of non-empty strings");
  }
  if (value.length > 100) throw new ProductTaskValidationError("resource_refs exceeds the size limit");
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
