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

const workdirReadFileInputSchema = readOnlyInputSchema;

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

const chatEmitPageInputSchema: Schema<unknown> = strictObjectSchema(
  ["title", "html"],
  ["title", "html"],
);
const chatEmitDocumentInputSchema: Schema<unknown> = strictObjectSchema(
  ["title", "markdown"],
  ["title", "markdown"],
);

const productionToolCatalog: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "read_only",
    replayPolicy: "safe" as const,
    inputSchema: readOnlyInputSchema,
  }),
  Object.freeze({
    name: "workdir.read_file",
    replayPolicy: "safe" as const,
    inputSchema: workdirReadFileInputSchema,
  }),
  Object.freeze({
    name: "chat.emit_page",
    replayPolicy: "never" as const,
    inputSchema: chatEmitPageInputSchema,
  }),
  Object.freeze({
    name: "chat.emit_document",
    replayPolicy: "never" as const,
    inputSchema: chatEmitDocumentInputSchema,
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
  readonly workspaceRootFor?: (command: StartRun) => string | undefined;
  readonly webSearch?: ProductionWebSearchProvider;
  /** Product adapters may add a typed, allowlisted business tool surface. */
  readonly dynamicTools?: readonly ToolDefinition[];
  readonly dynamicToolCall?: (request: Parameters<ToolGateway["execute"]>[0], signal: AbortSignal) => Promise<ToolResult>;
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
  const catalog = [
    ...productionToolCatalog,
    ...(options.dynamicTools ?? []),
  ].filter((definition, index, definitions) =>
    allowedTools.has(definition.name)
    && definitions.findIndex((candidate) => candidate.name === definition.name) === index,
  );
  const events = options.eventStore.scope(scope);

  const gateway = createToolGateway({
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
        if (request.name !== "read_only" && request.name !== "workdir.read_file") {
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
              workspaceRoot: options.workspaceRootFor?.(options.command) ?? options.workspaceRoot,
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
          const dynamic = options.dynamicTools?.some((definition) => definition.name === request.name);
          if (dynamic && options.dynamicToolCall !== undefined) {
            return options.dynamicToolCall(request, signal);
          }
          return {
            status: "failed",
            output: { reason: "tool_not_enabled_in_live_vertical_slice" },
          };
        }
        const input = request.input as { path: string };
        try {
          const root = await realpath(options.workspaceRootFor?.(options.command) ?? options.workspaceRoot);
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
          if (!metadata.isFile() || metadata.size > (request.name === "workdir.read_file" ? 65_536 : 16_384)) {
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
  return {
    ...gateway,
    execute(request, signal) {
      if (request.effectKey !== undefined || !isLocalArtifactTool(request.name)) {
        return gateway.execute(request, signal);
      }
      return gateway.execute({
        ...request,
        effectKey: `product-local-write:${request.runId}:${request.name}:${request.toolCallId}`,
      }, signal);
    },
  };
}

function isLocalArtifactTool(name: string): boolean {
  return name === "chat.emit_page"
    || name === "chat.emit_document"
    || name.startsWith("create.emit_");
}

function strictObjectSchema(
  properties: readonly string[],
  required: readonly string[],
): Schema<unknown> {
  const allowed = new Set(properties);
  return Object.freeze({
    parse(input: unknown) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("tool input must be an object");
      }
      const value = input as Record<string, unknown>;
      if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("tool input contains an unknown field");
      if (required.some((key) => typeof value[key] !== "string" || (value[key] as string).trim() === "")) {
        throw new Error("tool input is missing a required field");
      }
      return value;
    },
  });
}
