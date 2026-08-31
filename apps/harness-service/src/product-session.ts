import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  readonly workspace_id: string;
  readonly actor_user_id: string;
  readonly surface: ProductSurface;
  readonly prompt: string;
  readonly channel_id?: string;
  readonly conversation_id?: string;
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

const taskKeys = new Set([
  "run_id",
  "workspace_id",
  "actor_user_id",
  "surface",
  "prompt",
  "channel_id",
  "conversation_id",
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
  const workspaceId = requiredString(input.workspace_id, "workspace_id");
  const actorUserId = requiredString(input.actor_user_id, "actor_user_id");
  const surface = requiredString(input.surface, "surface");
  if (!(productSurfaces as readonly string[]).includes(surface)) {
    throw new ProductTaskValidationError("surface is not an admitted Product surface");
  }
  const prompt = requiredString(input.prompt, "prompt");
  const task: ProductTask = {
    run_id: runId,
    workspace_id: workspaceId,
    actor_user_id: actorUserId,
    surface: surface as ProductSurface,
    prompt,
    ...(optionalString(input.channel_id) === undefined ? {} : { channel_id: input.channel_id as string }),
    ...(optionalString(input.conversation_id) === undefined ? {} : { conversation_id: input.conversation_id as string }),
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
  private loaded = false;
  private write: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string) {}

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
    this.records.set(task.run_id, record);
    await this.persist();
    return record;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.path === undefined) return;
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(value)) return;
      for (const item of value) {
        if (!isRecord(item) || !isRecord(item.task)) continue;
        try {
          const task = validatedProductTask(item.task);
          const createdAt = requiredString(item.created_at, "created_at");
          const updatedAt = requiredString(item.updated_at, "updated_at");
          this.records.set(task.run_id, { task, created_at: createdAt, updated_at: updatedAt });
        } catch {
          // Invalid stale records are ignored; the canonical Run/Event store remains authoritative.
        }
      }
    } catch {
      // A first launch has no session file.
    }
  }

  private async persist(): Promise<void> {
    if (this.path === undefined) return;
    this.write = this.write.then(async () => {
      await mkdir(dirname(this.path!), { recursive: true });
      await writeFile(
        this.path!,
        JSON.stringify([...this.records.values()]) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    });
    await this.write;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
