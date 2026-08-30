import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  loadSkillCatalogEntry,
  resolveRunProfile,
  type RunProfileId,
  type EventStore,
  type LoopKernel,
  type MemoryReadMode,
  type ToolResult,
  type StartRun,
  type ToolGateway,
  type WorkerProfileId,
} from "@anna/harness-v2";
import { SqliteEventStore } from "@anna/event-store";
import {
  createOpenAICompatiblePiLoopKernel,
  loadPiKernelDescriptor,
  type PiContextPreparation,
  type PiKernelDescriptorV1,
} from "@anna/pi-loop-kernel";

import {
  createDurableHarnessV2Runtime,
  type DurableHarnessV2RuntimeOptions,
} from "./runtime";
import type { HarnessV2Runtime, V2SurfaceId } from "./index";
import {
  createHostMemoryContextLoader,
  type HostMemoryContextLoader,
} from "./host-memory-context";
import { expectedPiKernelSourceSha256 } from "./pi-kernel-build-identity";
import {
  assertKernelSelectionAdmitted,
  KernelSelectionError,
} from "./kernel-selection";

export {
  createProductionToolGateway,
  type ProductionToolGatewayOptions,
} from "./production-tools";
import { createProductionToolGateway } from "./production-tools";

export interface LiveHarnessV2RuntimeOptions {
  readonly runtimeConfigPath?: string;
  readonly eventStorePath?: string;
  readonly skillPath?: string;
  readonly surfaces?: readonly V2SurfaceId[];
  readonly workspaceRoot?: string;
  readonly reviewApprovalOrigin?: string;
  readonly reviewOwnerId?: string;
  readonly createKernel?: LiveHarnessV2KernelFactory;
}

export interface LiveHarnessV2KernelOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly modelName: string;
  readonly workerProfileId: WorkerProfileId;
  readonly toolGatewayFor: (command: StartRun) => ToolGateway;
  readonly prepareContext: PiContextPreparation;
}

export type LiveHarnessV2KernelFactory = (
  options: LiveHarnessV2KernelOptions,
) => LoopKernel;

export interface LiveHarnessV2Runtime {
  readonly runtime: HarnessV2Runtime;
  readonly eventStore: EventStore;
  readonly createActivation?: {
    readonly workspaceRoot: string;
    readonly approvalOrigin: string;
    readonly ownerId: string;
  };
  close(): void;
}

interface RuntimeConfig {
  readonly model_provider?: unknown;
  readonly model_name?: unknown;
  readonly model_api_key?: unknown;
  readonly model_endpoint?: unknown;
  readonly web_search_endpoint?: unknown;
  readonly web_search_api_key?: unknown;
  readonly harness_v2_kernel?: unknown;
}

export interface WebSearchProviderOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

export type WebSearchProvider = (
  query: string,
  signal: AbortSignal,
) => Promise<ToolResult>;

export function createWebSearchProvider(
  options: WebSearchProviderOptions,
): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (query, signal): Promise<ToolResult> => {
    const normalizedQuery = query.trim();
    if (normalizedQuery === "") {
      return { status: "failed", output: { reason: "invalid_web_search_query" } };
    }
    try {
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(options.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({ query: normalizedQuery, max_results: 5 }),
        signal,
      });
      if (!response.ok) {
        return { status: "failed", output: { reason: "web_search_provider_failed" } };
      }
      const payload: unknown = await response.json();
      const results = normalizeWebSearchResults(payload);
      if (results === undefined) {
        return { status: "failed", output: { reason: "invalid_web_search_response" } };
      }
      return {
        status: "succeeded",
        output: { query: normalizedQuery, results },
      };
    } catch {
      return { status: "failed", output: { reason: "web_search_provider_unavailable" } };
    }
  };
}

export async function createLiveHarnessV2Runtime(
  options: LiveHarnessV2RuntimeOptions = {},
): Promise<LiveHarnessV2Runtime> {
  const runtimeConfigPath = resolve(
    options.runtimeConfigPath ?? process.env.ANNA_RUNTIME_CONFIG_PATH ?? ".anna/runtime.json",
  );
  const config = parseRuntimeConfig(JSON.parse(await readFile(runtimeConfigPath, "utf8")));
  const kernelDescriptor = await loadPiKernelDescriptor(
    process.env.NODE_ENV === "production"
      ? {
          mode: "packaged",
          metadataPath: resolve(import.meta.dirname, "pi-kernel-descriptor.json"),
          ...(expectedPiKernelSourceSha256 === undefined
            ? {}
            : { expectedSourceSha256: expectedPiKernelSourceSha256 }),
        }
      : { mode: "development" },
  );
  const surfaces = options.surfaces ?? ["create", "cowork", "hub"];
  const webSearch = config.web_search_endpoint === undefined
    ? undefined
    : createWebSearchProvider({
        endpoint: config.web_search_endpoint,
        ...(config.web_search_api_key === undefined
          ? {}
          : { apiKey: config.web_search_api_key }),
  });
  const profile = await createLiveProfile(
    config.model_name,
    options.skillPath,
    webSearch !== undefined,
    "general",
    "channel",
    kernelDescriptor,
  );
  const createProfile = await createLiveProfile(
    config.model_name,
    undefined,
    webSearch !== undefined,
    "create",
    "channel",
    kernelDescriptor,
  );
  const reviewGateConfigured = await probeReviewGate(
    options.reviewApprovalOrigin ?? process.env.ANNA_T07_LIVE_APPROVAL_ORIGIN,
    options.reviewOwnerId ?? process.env.ANNA_T07_LIVE_OWNER_ID,
  );
  const approvalOrigin = options.reviewApprovalOrigin ?? process.env.ANNA_T07_LIVE_APPROVAL_ORIGIN;
  const ownerId = options.reviewOwnerId ?? process.env.ANNA_T07_LIVE_OWNER_ID;
  const eventStorePath = resolve(
    options.eventStorePath
      ?? process.env.ANNA_HARNESS_V2_EVENT_STORE_PATH
      ?? ".anna/state/harness-v2.sqlite3",
  );
  await mkdir(dirname(eventStorePath), { recursive: true });
  const eventStore = new SqliteEventStore(eventStorePath);
  const prepareContext: HostMemoryContextLoader = createHostMemoryContextLoader({ eventStore });
  const workspaceRoot = resolve(
    options.workspaceRoot
      ?? process.env.ANNA_HARNESS_V2_WORKSPACE_ROOT
      ?? ".anna/workspace",
  );
  const createRunToolGateway = (command: StartRun) => createProductionToolGateway({
    eventStore,
    command,
    workspaceRoot,
    ...(webSearch === undefined ? {} : { webSearch }),
  });
  const kernel = options.createKernel?.({
    endpoint: config.model_endpoint,
    apiKey: config.model_api_key,
    modelName: config.model_name,
    toolGatewayFor: createRunToolGateway,
    workerProfileId: profile.workerProfileId,
    prepareContext,
  }) ?? createOpenAICompatiblePiLoopKernel({
    endpoint: config.model_endpoint,
    apiKey: config.model_api_key,
    modelName: config.model_name,
    createToolGateway: createRunToolGateway,
    prepareContext,
    workerProfileId: profile.workerProfileId,
  });
  const runtimeOptions: DurableHarnessV2RuntimeOptions = {
    eventStore,
    kernel,
    profile,
    surfaceProfiles: {
      create: createProfile,
      cowork: profile,
      hub: profile,
    },
    surfaces,
    evidenceMode: "live",
    webSearchConfigured: webSearch !== undefined,
    reviewGateConfigured,
    validateStartCommand: () => assertKernelSelectionAdmitted(config.harness_v2_kernel),
    validateResumeCommand: (command) =>
      assertPersistedKernelIdentity(command, kernelDescriptor),
  };
  const runtime = createDurableHarnessV2Runtime(runtimeOptions);

  return {
    runtime,
    eventStore,
    ...(approvalOrigin === undefined || ownerId === undefined || ownerId.trim() === ""
      ? {}
      : { createActivation: { workspaceRoot, approvalOrigin, ownerId } }),
    close: () => eventStore.close(),
  };
}

function assertPersistedKernelIdentity(
  command: StartRun,
  available: PiKernelDescriptorV1,
): void {
  const persisted = command.runProfileSnapshot.kernel;
  if (persisted !== undefined && !samePiKernelDescriptor(persisted, available)) {
    throw new KernelSelectionError({
      code: "kernel_unavailable",
      requested_adapter: "pi",
      reason: "kernel_identity_mismatch",
    });
  }
}

function samePiKernelDescriptor(
  left: PiKernelDescriptorV1,
  right: PiKernelDescriptorV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function probeReviewGate(
  origin: string | undefined,
  ownerId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (origin === undefined || ownerId === undefined || ownerId.trim() === "") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return false;
  }
  try {
    const response = await fetchImpl(`${parsed.toString().replace(/\/$/, "")}/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isRecord(body)
      && body.status === "ready"
      && body.owner_id === ownerId
      && body.decision_endpoint === "ready"
      && body.durability === "durable";
  } catch {
    return false;
  }
}

function parseRuntimeConfig(input: unknown): {
  readonly model_name: string;
  readonly model_api_key: string;
  readonly model_endpoint: string;
  readonly web_search_endpoint?: string;
  readonly web_search_api_key?: string;
  readonly harness_v2_kernel?: unknown;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("live Runtime config must be a JSON object");
  }
  const config = input as RuntimeConfig;
  if (config.model_provider !== "openai-compatible") {
    throw new Error("live Runtime config requires an openai-compatible provider");
  }
  const modelName = requiredConfigString(config.model_name, "model_name");
  const apiKey = requiredConfigString(config.model_api_key, "model_api_key");
  const endpoint = requiredConfigString(config.model_endpoint, "model_endpoint");
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("live Runtime config model_endpoint must be an absolute URL");
  }
  if (parsedEndpoint.protocol !== "https:") {
    throw new Error("live Runtime config model_endpoint must use HTTPS");
  }
  const webSearchEndpoint = optionalConfigString(config.web_search_endpoint, "web_search_endpoint");
  const webSearchApiKey = optionalConfigString(config.web_search_api_key, "web_search_api_key");
  return {
    model_name: modelName,
    model_api_key: apiKey,
    model_endpoint: endpoint,
    harness_v2_kernel: config.harness_v2_kernel,
    ...(webSearchEndpoint === undefined ? {} : { web_search_endpoint: webSearchEndpoint }),
    ...(webSearchApiKey === undefined ? {} : { web_search_api_key: webSearchApiKey }),
  };
}

export async function createLiveProfile(
  modelName: string,
  configuredSkillPath?: string,
  webSearchEnabled = false,
  surface: "general" | "create" = "general",
  memoryRead: MemoryReadMode = "none",
  kernel?: PiKernelDescriptorV1,
) {
  const defaultSkillPath = resolve(
    import.meta.dirname,
    surface === "create"
      ? "../../../skills/harness-v2/create-assistant/SKILL.md"
      : "../../../skills/harness-v2/general-assistant/SKILL.md",
  );
  const skillPath = resolve(
    surface === "create"
      ? defaultSkillPath
      : configuredSkillPath
        ?? process.env.ANNA_HARNESS_V2_SKILL_PATH
        ?? defaultSkillPath,
  );
  const document = await readFile(skillPath, "utf8");
  const skill = loadSkillCatalogEntry({
    id: surface === "create"
      ? "skill:create/create-assistant"
      : "skill:chat/general-assistant",
    document,
    provenance: { source: "anna-repository", uri: "file://" + skillPath },
  });
  const model = {
    provider: "anna-openai-compatible",
    name: modelName,
    reasoning: "low" as const,
  };
  const toolNames = surface === "create"
    ? ["create_artifact", ...(webSearchEnabled ? ["web_search"] : [])]
    : ["read_only", ...(webSearchEnabled ? ["web_search"] : [])];
  const artifactContract = {
    kind: surface === "create" ? "create-skill" : "run-result",
    requiredFor: ["completed" as const],
    verification: "tests" as const,
  };

  return resolveRunProfile({
    catalog: [skill],
    channelPolicy: {
      toolPolicy: { allowedTools: toolNames },
      allowedSkillIds: [skill.id],
      allowedModels: [model],
      budgetLimits: { wallTimeMs: 30_000, turns: 3 },
      memoryPolicy: { allowedReadModes: [memoryRead], allowedWriteModes: ["disabled"] },
    },
    workerProfile: {
      id: (surface === "create"
        ? "worker:harness-v2-create"
        : "worker:harness-v2-live") as WorkerProfileId,
      version: "1.0.0",
      instructions: surface === "create"
        ? "Create one reviewable Skill artifact with the approved Tool. "
          + "Do not claim activation."
        : "Complete the requested Anna Run goal with the approved Skill.",
      allowedSkillIds: [skill.id],
      allowedTools: toolNames,
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: { wallTimeMs: 30_000, turns: 3 },
      artifactContract,
    },
    runProfile: {
      id: (surface === "create"
        ? "profile:harness-v2-create"
        : "profile:harness-v2-live") as RunProfileId,
      version: "1.0.0",
      model,
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal", "constraints", "provenance"] }],
      toolPolicy: { allowedTools: toolNames },
      budget: { wallTimeMs: 30_000, turns: 3 },
      memoryPolicy: { read: memoryRead, write: "disabled" },
      evalPolicy: { contract: "required", quality: "disabled" },
      artifactContract,
      terminalRules: {
        allowedOutcomes: ["completed", "failed", "timed_out", "cancelled"],
        stopCondition: "artifact_or_terminal",
      },
      ...(kernel === undefined ? {} : { kernel }),
    },
  });
}

function normalizeWebSearchResults(
  input: unknown,
): Array<{ title: string; url: string; snippet: string }> | undefined {
  if (!isRecord(input) || !Array.isArray(input.results)) {
    return undefined;
  }
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of input.results.slice(0, 5)) {
    if (!isRecord(item)
      || typeof item.title !== "string"
      || typeof item.url !== "string"
      || typeof item.snippet !== "string") {
      return undefined;
    }
    results.push({ title: item.title, url: item.url, snippet: item.snippet });
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalConfigString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredConfigString(value, name);
}

function requiredConfigString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("live Runtime config " + name + " is required");
  }
  return value;
}
