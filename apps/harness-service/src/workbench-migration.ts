import { createHash } from "node:crypto";

import type {
  ProductSessionRecord,
  ProductSessionSourceSnapshot,
} from "./product-session";
import type {
  WorkbenchRunRecord,
  WorkbenchSessionRecord,
} from "./workbench-session";

export interface MigrationScope {
  readonly workspace_id: string;
  readonly actor_user_id: string;
  readonly channel_id: string;
  readonly project_id?: string;
}

export interface ProductV1MigrationPlan {
  readonly scope_source_sha256: string;
  readonly scope_source_bytes: number;
  readonly matched_records: number;
  readonly sessions: readonly WorkbenchSessionRecord[];
  readonly runs: readonly WorkbenchRunRecord[];
}

export type ResolveMigrationProject = (projectId: string) => Promise<MigrationScope | undefined>;

export async function planProductV1Migration(
  source: ProductSessionSourceSnapshot,
  scope: MigrationScope,
  resolveProject: ResolveMigrationProject,
): Promise<ProductV1MigrationPlan> {
  const candidates = source.records.filter((record) =>
    record.task.workspace_id === scope.workspace_id
    && record.task.actor_user_id === scope.actor_user_id,
  );
  const migrated: Array<{
    readonly record: ProductSessionRecord;
    readonly channel_id: string;
    readonly conversation_id: string;
    readonly conversation_source: "conversation" | "run_id_fallback";
    readonly project_id?: string;
    readonly source_event_id: string;
    readonly source_event_derived: boolean;
  }> = [];
  for (const record of candidates) {
    const task = record.task;
    const projectId = projectIdFor(task);
    if (projectId !== undefined) {
      const projectScope = await resolveProject(projectId);
      if (projectScope === undefined
        || projectScope.workspace_id !== scope.workspace_id
        || projectScope.actor_user_id !== scope.actor_user_id
        || projectScope.project_id !== projectId) {
        continue;
      }
    }
    const conversationId = task.conversation_id ?? task.run_id;
    const conversationSource = task.conversation_id === undefined ? "run_id_fallback" : "conversation";
    const channelId = task.channel_id ?? task.conversation_id ?? `product:${task.surface}:${task.workspace_id}`;
    const sourceEventId = task.source_event_id ?? `product:source:${task.run_id}`;
    migrated.push({
      record,
      channel_id: channelId,
      conversation_id: conversationId,
      ...(projectId === undefined ? {} : { project_id: projectId }),
      source_event_id: sourceEventId,
      source_event_derived: task.source_event_id === undefined,
      conversation_source: conversationSource,
    });
  }
  const scopeSource = stableJson(migrated.map((item) => item.record));

  const groups = new Map<string, typeof migrated>();
  for (const item of migrated) {
    const key = sessionKey(
      scope.workspace_id,
      scope.actor_user_id,
      item.channel_id,
      item.conversation_source,
      item.conversation_id,
    );
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const sessions: WorkbenchSessionRecord[] = [];
  const runs: WorkbenchRunRecord[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort(compareRecords);
    const first = ordered[0]!;
    const projectIds = new Set(group.map((item) => item.project_id).filter((value): value is string => value !== undefined));
    if (projectIds.size > 1) throw new Error(`migration_project_conflict:${key}`);
    const sessionId = sessionIdForKey(key);
    sessions.push({
      schema_version: 2,
      session_id: sessionId,
      workspace_id: scope.workspace_id,
      actor_user_id: scope.actor_user_id,
      channel_id: first.channel_id,
      surface: first.record.task.surface,
      created_at: ordered.reduce((value, item) => value < item.record.created_at ? value : item.record.created_at, first.record.created_at),
      updated_at: ordered.reduce((value, item) => value > item.record.updated_at ? value : item.record.updated_at, first.record.updated_at),
      ...(projectIds.size === 1 ? { project_id: [...projectIds][0] } : {}),
    });
    for (const item of ordered) {
      runs.push({
        schema_version: 2,
        run_id: item.record.task.run_id,
        session_id: sessionId,
        workspace_id: scope.workspace_id,
        actor_user_id: scope.actor_user_id,
        channel_id: item.channel_id,
        surface: item.record.task.surface,
        prompt: item.record.task.prompt,
        source_event_id: item.source_event_id,
        ...(item.source_event_derived ? { source_event_derived: true } : {}),
        resource_refs: item.record.task.resource_refs ?? [],
        ...(item.record.task.requested_artifact === undefined ? {} : { requested_artifact: item.record.task.requested_artifact }),
        conversation_id: item.conversation_id,
        conversation_source: item.conversation_source,
        created_at: item.record.created_at,
        updated_at: item.record.updated_at,
        ...(item.project_id === undefined ? {} : { project_id: item.project_id }),
        ...(item.record.task.parent_run_id === undefined ? {} : { parent_run_id: item.record.task.parent_run_id }),
      });
    }
  }
  return {
    scope_source_sha256: createHash("sha256").update(scopeSource).digest("hex"),
    scope_source_bytes: Buffer.byteLength(scopeSource),
    matched_records: migrated.length,
    sessions,
    runs,
  };
}

export function sessionIdForKey(key: string): string {
  return `session:v2:${createHash("sha256").update(key).digest("hex")}`;
}

function sessionKey(
  workspaceId: string,
  actorUserId: string,
  channelId: string,
  conversationSource: "conversation" | "run_id_fallback",
  conversationId: string,
): string {
  return JSON.stringify([workspaceId, actorUserId, channelId, conversationSource, conversationId]);
}

function projectIdFor(task: ProductSessionRecord["task"]): string | undefined {
  const contextProjectId = task.context !== undefined && typeof task.context.project_id === "string"
    ? task.context.project_id
    : undefined;
  const channelProjectId = task.channel_id?.startsWith("crew_channel:")
    ? task.channel_id.slice("crew_channel:".length)
    : undefined;
  if (contextProjectId !== undefined && channelProjectId !== undefined && contextProjectId !== channelProjectId) {
    throw new Error(`migration_project_conflict:${task.run_id}`);
  }
  return contextProjectId ?? channelProjectId ?? task.project_id;
}

function compareRecords(
  left: { readonly record: ProductSessionRecord },
  right: { readonly record: ProductSessionRecord },
): number {
  return left.record.created_at.localeCompare(right.record.created_at)
    || left.record.task.run_id.localeCompare(right.record.task.run_id);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
