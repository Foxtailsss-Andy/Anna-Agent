import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  createToolGateway,
  type EventStore,
  type Schema,
  type StartRun,
  type ToolDefinition,
  type ToolGateway,
  type ToolResult,
} from "@anna/harness-v2";

import { createSkillArtifact } from "./create-artifact";

const readOnlyInputSchema: Schema<unknown> = Object.freeze({
  parse(input: unknown) {
    const value = input as Record<string, unknown>;
    if (
      typeof input !== "object"
      || input === null
      || Array.isArray(input)
      || Object.keys(input).length !== 1
      || typeof value.path !== "string"
      || value.path.trim() === ""
    ) {
      throw new Error("read_only input requires exactly one non-empty path");
    }

    return { path: value.path };
  },
});

const createArtifactInputSchema: Schema<unknown> = Object.freeze({
  parse(input: unknown) {
    if (
      typeof input !== "object"
      || input === null
      || Array.isArray(input)
      || Object.keys(input).length !== 3
      || (input as Record<string, unknown>).kind !== "skill"
      || typeof (input as Record<string, unknown>).skill_id !== "string"
      || typeof (input as Record<string, unknown>).preview !== "string"
    ) {
      throw new Error("create_artifact input requires exactly a Skill artifact");
    }

    return {
      kind: "skill",
      skill_id: (input as Record<string, unknown>).skill_id as string,
      preview: (input as Record<string, unknown>).preview as string,
    };
  },
});

const webSearchInputSchema: Schema<unknown> = Object.freeze({
  parse(input: unknown) {
    if (
      typeof input !== "object"
      || input === null
      || Array.isArray(input)
      || Object.keys(input).length !== 1
      || typeof (input as Record<string, unknown>).query !== "string"
    ) {
      throw new Error("web_search input requires exactly a query");
    }

    return { query: (input as Record<string, unknown>).query as string };
  },
});

const productionToolCatalog: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "read_only",
    replayPolicy: "safe" as const,
    inputSchema: readOnlyInputSchema,
  }),
  Object.freeze({
    name: "create_artifact",
    replayPolicy: "never" as const,
    inputSchema: createArtifactInputSchema,
  }),
  Object.freeze({
    name: "web_search",
    replayPolicy: "safe" as const,
    inputSchema: webSearchInputSchema,
  }),
]);

export type ProductionWebSearchProvider = (
  query: string,
  signal: AbortSignal,
) => Promise<ToolResult>;

export interface ProductionToolGatewayOptions {
  readonly eventStore: EventStore;
  readonly command: StartRun;
  readonly workspaceRoot: string;
  readonly webSearch?: ProductionWebSearchProvider;
  readonly now?: () => string;
  readonly createEventId?: () => string;
}

/**
 * Binds the production ToolGateway to one admitted Run. Tool policy is derived
 * from the immutable profile snapshot; callers cannot widen it by changing a
 * Tool request.
 */
export function createProductionToolGateway(
  options: ProductionToolGatewayOptions,
): ToolGateway {
  const boundRunId = options.command.runId;
  const boundParentRunId = options.command.parentRunId;
  const boundParentEventId = options.command.parentEventId;
  const boundLaneId = options.command.laneId;
  const boundWorkerProfileId = options.command.runProfileSnapshot.workerProfileId;
  const scope = {
    workspaceId: options.command.workspaceId,
    channelId: options.command.channelId,
  };
  const allowedTools = new Set(options.command.runProfileSnapshot.allowedTools);
  const catalog = productionToolCatalog.filter((definition) => allowedTools.has(definition.name));
  const events = options.eventStore.scope(scope);

  return createToolGateway({
    catalog,
    scope,
    workerProfileId: boundWorkerProfileId,
    policy: {
      async decide(request) {
        const sameRun = request.runId === boundRunId
          && request.parentRunId === boundParentRunId
          && request.parentEventId === boundParentEventId
          && request.laneId === boundLaneId;
        return sameRun && allowedTools.has(request.name) ? "allow" : "deny";
      },
    },
    sandbox: {
      async execute(request, signal): Promise<ToolResult> {
        if (request.name !== "read_only") {
          if (request.name === "create_artifact") {
            if (signal.aborted) {
              return {
                status: "failed",
                output: { reason: "cancelled" },
              };
            }
            const input = request.input as {
              kind: "skill";
              skill_id: string;
              preview: string;
            };
            return createSkillArtifact({
              workspaceRoot: options.workspaceRoot,
              runId: request.runId,
              input,
            });
          }
          if (request.name === "web_search") {
            if (options.webSearch === undefined) {
              return {
                status: "failed",
                output: { reason: "web_search_provider_not_configured" },
              };
            }
            const input = request.input as { query: string };
            return options.webSearch(input.query, signal);
          }
          return {
            status: "failed",
            output: { reason: "tool_not_enabled_in_live_vertical_slice" },
          };
        }
        const input = request.input as { path: string };
        try {
          const root = await realpath(options.workspaceRoot);
          const target = resolve(root, input.path);
          const targetRelative = relative(root, target);
          if (
            targetRelative === ""
            || targetRelative.startsWith("..")
            || targetRelative.startsWith("/")
          ) {
            return { status: "failed", output: { reason: "read_only_path_outside_workspace" } };
          }
          const resolvedTarget = await realpath(target);
          const resolvedRelative = relative(root, resolvedTarget);
          if (resolvedRelative.startsWith("..") || resolvedRelative.startsWith("/")) {
            return { status: "failed", output: { reason: "read_only_path_outside_workspace" } };
          }
          const metadata = await stat(resolvedTarget);
          if (!metadata.isFile() || metadata.size > 16_384) {
            return { status: "failed", output: { reason: "read_only_file_not_bounded" } };
          }
          return {
            status: "succeeded",
            output: {
              path: resolvedRelative,
              content: await readFile(resolvedTarget, "utf8"),
            },
          };
        } catch {
          return { status: "failed", output: { reason: "read_only_source_unavailable" } };
        }
      },
    },
    events,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createEventId === undefined ? {} : { createEventId: options.createEventId }),
  });
}
