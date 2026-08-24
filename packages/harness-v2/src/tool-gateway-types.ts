import type { ChannelScope } from "./contracts";
import type {
  SandboxAdapter,
  ScopedChannelStore,
  ToolRequest,
} from "./interfaces";
import type { Schema } from "./schema";

export interface ToolDefinition {
  name: string;
  inputSchema: Schema<unknown>;
  replayPolicy?: "never" | "safe";
}

export interface ToolPolicy {
  decide(request: ToolRequest): Promise<"allow" | "deny" | "require_approval">;
}

export interface ToolGatewayOptions {
  catalog: readonly ToolDefinition[];
  scope: Readonly<ChannelScope>;
  workerProfileId: ToolRequest["workerProfileId"];
  policy: ToolPolicy;
  sandbox: SandboxAdapter;
  events: Pick<ScopedChannelStore, "append" | "read">;
  createEventId?: () => string;
  now?: () => string;
}

export interface BoundToolGatewayOptions extends ToolGatewayOptions {
  readonly scope: Readonly<ChannelScope>;
  readonly workerProfileId: ToolRequest["workerProfileId"];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function snapshotOptions(
  options: ToolGatewayOptions,
): BoundToolGatewayOptions {
  if (
    !isNonEmptyString(options.scope?.workspaceId) ||
    !isNonEmptyString(options.scope?.channelId)
  ) {
    throw new TypeError("ToolGateway scope must contain non-empty workspaceId and channelId");
  }
  if (!isNonEmptyString(options.workerProfileId)) {
    throw new TypeError("ToolGateway workerProfileId must be non-empty");
  }

  return {
    ...options,
    scope: Object.freeze({
      workspaceId: options.scope.workspaceId,
      channelId: options.scope.channelId,
    }),
    workerProfileId: options.workerProfileId,
  };
}
