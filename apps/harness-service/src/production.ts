import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  loadSkillCatalogEntry,
  resolveRunProfile,
  type RunProfileId,
  type EventStore,
  type LoopKernel,
  type MemoryReadMode,
  type ResolvedRunProfile,
  type SkillCatalogEntry,
  type ToolResult,
  type ToolRequest,
  type ToolDefinition as HarnessToolDefinition,
  type Schema,
  type StartRun,
  type ToolGateway,
  type WorkerProfileId,
  type JsonValue,
  parseOmpKernelDescriptor,
  type KernelDescriptorV1,
  type OmpKernelDescriptorV1,
} from "@anna/harness-v2";
import { acquireHarnessHostOwnership, SqliteEventStore } from "@anna/event-store";
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
import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import {
  currentOmpImplementation,
  verifyOmpKernelIdentity,
} from "../../../packages/omp-loop-kernel/src/kernel-identity";
import type { OmpHostModelTransport } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import type { Message, ToolDefinition as OmpToolDefinition } from "../../../packages/omp-loop-kernel/src/protocol";
import { createOmpModelTransport } from "./omp-model-transport";
import type { ProductTask } from "./product-session";

export interface LiveHarnessV2RuntimeOptions {
  readonly runtimeConfigPath?: string;
  readonly eventStorePath?: string;
  readonly skillPath?: string;
  readonly surfaces?: readonly V2SurfaceId[];
  readonly workspaceRoot?: string;
  readonly reviewApprovalOrigin?: string;
  readonly reviewOwnerId?: string;
  readonly createKernel?: LiveHarnessV2KernelFactory;
  readonly ompRuntimeRoot?: string;
  readonly ompModelTransport?: OmpHostModelTransport;
  /** Product mode must run the verified OMP runtime instead of silently selecting Pi. */
  readonly requireOmp?: boolean;
  /** Let the original shell boot while Settings supplies the first model config. */
  readonly allowUnconfigured?: boolean;
  /** Product Host-owned task metadata, snapshotted before the OMP worker starts. */
  readonly productTaskFor?: (runId: string) => ProductTask | undefined | Promise<ProductTask | undefined>;
  readonly productTaskPeek?: (runId: string) => ProductTask | undefined;
  readonly businessOrigin?: string;
  readonly businessServiceToken?: string;
  readonly businessFetchImpl?: typeof fetch;
  readonly modelProfiles?: Readonly<Record<string, {
    readonly model_name: string;
    readonly endpoint?: string;
    readonly api_key?: string;
  }>>;
  readonly agentDirectives?: Readonly<Record<string, string>>;
}

export interface ProductModelConfig {
  readonly model_name: string;
  readonly endpoint: string;
  readonly api_key: string;
}

export interface SelectedProductModelConfig {
  readonly profile_id: string;
  readonly config: ProductModelConfig;
}

export function selectProductModelConfig(
  defaultConfig: ProductModelConfig,
  modelProfiles: LiveHarnessV2RuntimeOptions["modelProfiles"],
  task?: ProductTask,
): SelectedProductModelConfig {
  const profileId = task?.model_profile_id
    ?? (typeof task?.context?.model_profile_id === "string" ? task.context.model_profile_id : undefined);
  const selected = profileId === undefined ? undefined : modelProfiles?.[profileId];
  if (profileId === undefined || selected === undefined || selected.model_name.trim() === "") {
    return { profile_id: "default", config: defaultConfig };
  }
  return {
    profile_id: profileId,
    config: {
      model_name: selected.model_name.trim(),
      endpoint: selected.endpoint ?? defaultConfig.endpoint,
      api_key: selected.api_key ?? defaultConfig.api_key,
    },
  };
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
  close(): void | Promise<void>;
}

export async function createOmpKernelDescriptor(
  runtimeRoot: string,
): Promise<OmpKernelDescriptorV1> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("OMP runtime unavailable on this platform");
  }
  const manifest = JSON.parse(await readFile(resolve(runtimeRoot, "manifest.json"), "utf8")) as {
    sha256?: unknown;
  };
  if (typeof manifest.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error("OMP runtime manifest identity unavailable");
  }
  const implementation = currentOmpImplementation();
  return parseOmpKernelDescriptor({
    schemaVersion: 1,
    adapterId: "omp",
    protocolVersion: "anna-omp/1",
    adapterSource: {
      packageName: "@anna/omp-loop-kernel",
      sha256: implementation.sourceSha256,
    },
    upstream: {
      packageName: "@oh-my-pi/pi-coding-agent",
      version: "18.0.11",
      sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2",
      integrity: "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==",
    },
    runtime: {
      platform: "darwin",
      arch: "arm64",
      bunVersion: "1.3.14",
      bunSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
      nativeSha256: "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b",
      dependencyLockSha256: implementation.dependencyLockSha256,
      runtimeManifestSha256: manifest.sha256.slice("sha256:".length),
    },
  });
}

interface RuntimeConfig {
  readonly model_provider?: unknown;
  readonly model_name?: unknown;
  readonly model_api_key?: unknown;
  readonly model_endpoint?: unknown;
  readonly web_search_endpoint?: unknown;
  readonly web_search_api_key?: unknown;
  readonly harness_v2_kernel?: unknown;
  readonly harness_v2_omp_runtime_root?: unknown;
  readonly harness_v2_omp_descriptor?: unknown;
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
  let config: ReturnType<typeof parseRuntimeConfig>;
  try {
    config = parseRuntimeConfig(
      JSON.parse(await readFile(runtimeConfigPath, "utf8")),
      options.allowUnconfigured === true,
    );
  } catch (error) {
    if (options.allowUnconfigured !== true) throw error;
    config = unconfiguredRuntimeConfig();
  }
  if (options.requireOmp === true) {
    const runtimeRoot = options.ompRuntimeRoot
      ?? config.harness_v2_omp_runtime_root
      ?? process.env.ANNA_HARNESS_OMP_RUNTIME_ROOT;
    if (typeof runtimeRoot !== "string" || runtimeRoot.trim() === "") {
      throw new Error("verified OMP runtime is required for Product Host");
    }
    const descriptor = config.harness_v2_kernel === "omp" && config.harness_v2_omp_descriptor !== undefined
      ? parseOmpKernelDescriptor(config.harness_v2_omp_descriptor)
      : await createOmpKernelDescriptor(resolve(runtimeRoot));
    config = {
      ...config,
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: resolve(runtimeRoot),
      harness_v2_omp_descriptor: descriptor,
    };
  }
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
  let ompDescriptor: ReturnType<typeof parseOmpKernelDescriptor> | undefined;
  let ompRuntimeRoot: string | undefined;
  if (config.harness_v2_omp_descriptor !== undefined) {
    try {
      if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("OMP platform unavailable");
      ompDescriptor = parseOmpKernelDescriptor(config.harness_v2_omp_descriptor);
      const configuredRoot = options.ompRuntimeRoot ?? config.harness_v2_omp_runtime_root;
      if (typeof configuredRoot !== "string" || configuredRoot.trim() === "") throw new Error("OMP runtime unavailable");
      ompRuntimeRoot = resolve(configuredRoot);
      await verifyOmpKernelIdentity(ompRuntimeRoot, ompDescriptor);
    } catch (error) {
      if (options.requireOmp === true) throw error;
      ompDescriptor = undefined;
      ompRuntimeRoot = undefined;
    }
  }
  if (options.requireOmp === true && (ompDescriptor === undefined || ompRuntimeRoot === undefined)) {
    throw new Error("verified OMP runtime is required for Product Host");
  }
  const surfaces = options.surfaces ?? ["create", "cowork", "hub"];
  const webSearch = config.web_search_endpoint === undefined
    ? undefined
    : createWebSearchProvider({
        endpoint: config.web_search_endpoint,
        ...(config.web_search_api_key === undefined
          ? {}
          : { apiKey: config.web_search_api_key }),
  });
  const selectedKernelDescriptor = config.harness_v2_kernel === "omp"
    ? ompDescriptor ?? kernelDescriptor
    : kernelDescriptor;
  const profile = await createLiveProfile(
    config.model_name,
    options.skillPath,
    webSearch !== undefined,
    "general",
    "channel",
    selectedKernelDescriptor,
    options.requireOmp === true,
  );
  const createProfile = await createLiveProfile(
    config.model_name,
    undefined,
    webSearch !== undefined,
    "create",
    "channel",
    selectedKernelDescriptor,
    options.requireOmp === true,
  );
  const chatProfile = await createLiveProfile(
    config.model_name,
    options.skillPath,
    webSearch !== undefined,
    "chat",
    "channel",
    selectedKernelDescriptor,
    options.requireOmp === true,
  );
  const hikerProfile = await createLiveProfile(
    config.model_name,
    options.skillPath,
    webSearch !== undefined,
    "hiker",
    "channel",
    selectedKernelDescriptor,
    options.requireOmp === true,
  );
  const reimbursementProfile = await createLiveProfile(
    config.model_name,
    options.skillPath,
    webSearch !== undefined,
    "reimbursement",
    "channel",
    selectedKernelDescriptor,
    options.requireOmp === true,
  );
  const crewProfile = await createLiveProfile(
    config.model_name,
    options.skillPath,
    webSearch !== undefined,
    "crew",
    "channel",
    selectedKernelDescriptor,
    options.requireOmp === true,
  );
  const defaultModelConfig: ProductModelConfig = {
    model_name: config.model_name,
    endpoint: config.model_endpoint,
    api_key: config.model_api_key,
  };
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
  const ownership = await acquireHarnessHostOwnership(eventStorePath);
  let openedEventStore: SqliteEventStore | undefined;
  try {
    await mkdir(dirname(ownership.eventStorePath), { recursive: true });
  const eventStore = new SqliteEventStore(ownership.eventStorePath);
  openedEventStore = eventStore;
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
    workspaceRootFor: () => options.productTaskPeek?.(String(command.runId))?.workdir_path,
    dynamicTools: dynamicGatewayTools(command, options.productTaskPeek?.(String(command.runId))),
    dynamicToolCall: (request, signal) => canonicalToolName(request.name).startsWith("create.emit_")
      ? callLocalProductTool(request)
      : canonicalToolName(request.name) === "workdir.read_file"
        ? callLocalProductTool(request)
        : options.businessOrigin === undefined
          ? callLocalProductTool(request)
          : callBusinessTool({
          origin: options.businessOrigin!,
          serviceToken: options.businessServiceToken,
          command,
          request,
          signal,
          productTaskFor: options.productTaskFor,
          productTaskPeek: options.productTaskPeek,
          fetchImpl: options.businessFetchImpl,
        }),
    ...(webSearch === undefined ? {} : { webSearch }),
  });
  const piKernel = options.createKernel?.({
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
  const ompKernels = new Map<string, OmpLoopKernel>();
  const createOmpKernel = (selected: SelectedProductModelConfig): OmpLoopKernel | undefined => {
    if (ompDescriptor === undefined || ompRuntimeRoot === undefined) return undefined;
    const existing = ompKernels.get(selected.profile_id);
    if (existing !== undefined) return existing;
    const kernel = new OmpLoopKernel({
      runtimeRoot: ompRuntimeRoot,
      expectedManifestDigest: `sha256:${ompDescriptor.runtime.runtimeManifestSha256}`,
      workspaceRoot,
      prepareContext,
      createToolGateway: createRunToolGateway,
      toolDefinitionsFor: (command) => ompToolDefinitions(
        command,
        options.productTaskPeek?.(String(command.runId)),
      ),
      ...(options.productTaskFor === undefined
        ? {}
        : {
            initialMessagesFor: async (command: StartRun) => initialMessagesFor(
              command,
              options.productTaskFor,
              options.agentDirectives,
              options.modelProfiles,
            ),
          }),
      modelTransport: options.ompModelTransport ?? createOmpModelTransport({
        endpoint: selected.config.endpoint,
        apiKey: selected.config.api_key,
        modelName: selected.config.model_name,
      }),
    });
    ompKernels.set(selected.profile_id, kernel);
    return kernel;
  };
  const defaultOmpKernel = createOmpKernel({ profile_id: "default", config: defaultModelConfig });
  const modelConfigFor = (command: StartRun): SelectedProductModelConfig => selectProductModelConfig(
    defaultModelConfig,
    options.modelProfiles,
    options.productTaskPeek?.(String(command.runId)),
  );
  const ompKernelFor = (command: StartRun): OmpLoopKernel | undefined =>
    createOmpKernel(modelConfigFor(command)) ?? defaultOmpKernel;
  const owners = new Map<string, { command: StartRun; kernel: LoopKernel }>();
  const ownerFor = (runId: string, scope?: { workspaceId: string; channelId: string }): LoopKernel => {
    const matches = [...owners.values()].filter(owner => owner.command.runId === runId
      && (!scope || owner.command.workspaceId === scope.workspaceId && owner.command.channelId === scope.channelId));
    if (matches.length !== 1) throw new Error("Run control requires one active scoped owner");
    return matches[0].kernel;
  };
  const kernel: LoopKernel = {
    async start(command, sink, signal) {
      const selected = command.runProfileSnapshot.kernel?.adapterId === "omp" ? ompKernelFor(command) : piKernel;
      if (!selected) throw new Error("OMP runtime unavailable");
      const key = JSON.stringify([command.workspaceId, command.channelId, command.runId]);
      if (owners.has(key)) throw new Error("Run already has an active owner");
      owners.set(key, { command, kernel: selected });
      try { return await selected.start(command, sink, signal); }
      finally { owners.delete(key); }
    },
    steer: (runId, message) => ownerFor(runId, message).steer(runId, message),
    answer: (runId, answer) => ownerFor(runId).answer(runId, answer),
    abort: (runId, reason) => ownerFor(runId).abort(runId, reason),
  };
  const runtimeOptions: DurableHarnessV2RuntimeOptions = {
    eventStore,
    kernel,
    profile,
    surfaceProfiles: {
      create: createProfile,
      cowork: profile,
      hub: profile,
      chat: chatProfile,
      hiker: hikerProfile,
      reimbursement: reimbursementProfile,
      crew: crewProfile,
    },
    profileFor: (surfaceId, body, fallback) => {
      const runId = isRecord(body) && typeof body.run_id === "string" ? body.run_id : undefined;
      const task = runId === undefined ? undefined : options.productTaskPeek?.(runId);
      return narrowProductProfile(surfaceId, fallback, task, options.modelProfiles);
    },
    surfaces,
    evidenceMode: "live",
    webSearchConfigured: webSearch !== undefined,
    reviewGateConfigured,
    validateStartCommand: (command) => {
      if (!config.model_configured) throw new Error("model_not_configured");
      if (config.harness_v2_kernel === "omp" && ompKernelFor(command)) return;
      assertKernelSelectionAdmitted(config.harness_v2_kernel);
    },
    validateResumeCommand: (command) => {
      if (command.runProfileSnapshot.kernel?.adapterId === "omp") {
        if (ompKernelFor(command) === undefined || ompDescriptor === undefined) {
          throw new KernelSelectionError({
            code: "kernel_unavailable",
            requested_adapter: "omp",
            reason: "managed_runtime_unavailable",
          });
        }
        if (!sameOmpKernelDescriptor(command.runProfileSnapshot.kernel, ompDescriptor)) {
          throw new KernelSelectionError({
            code: "kernel_unavailable",
            requested_adapter: "omp",
            reason: "kernel_identity_mismatch",
          });
        }
        if (
          command.runProfileSnapshot.model.provider !== profile.model.provider
          || command.runProfileSnapshot.model.name !== modelConfigFor(command).config.model_name
        ) {
          throw new KernelSelectionError({
            code: "kernel_unavailable",
            requested_adapter: "omp",
            reason: "kernel_identity_mismatch",
          });
        }
        return;
      }
      assertPersistedKernelIdentity(command, kernelDescriptor);
    },
  };
  const runtime = createDurableHarnessV2Runtime(runtimeOptions);
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      let firstError: unknown;
      try {
        await runtime.close();
      } catch (error) {
        firstError = error;
      }
      try {
        await Promise.all([...ompKernels.values()].map((kernel) => kernel.close()));
      } catch (error) {
        firstError ??= error;
      }
      try {
        eventStore.close();
      } catch (error) {
        firstError ??= error;
      }
      try {
        ownership.close();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    })();
    return closePromise;
  };

  return {
    runtime,
    eventStore,
    ...(approvalOrigin === undefined || ownerId === undefined || ownerId.trim() === ""
      ? {}
      : { createActivation: { workspaceRoot, approvalOrigin, ownerId } }),
    close,
  };
  } catch (error) {
    openedEventStore?.close();
    ownership.close();
    throw error;
  }
}

function assertPersistedKernelIdentity(
  command: StartRun,
  available: PiKernelDescriptorV1,
): void {
  const persisted = command.runProfileSnapshot.kernel;
  if (persisted !== undefined && (persisted.adapterId !== "pi" || !samePiKernelDescriptor(persisted, available))) {
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

function sameOmpKernelDescriptor(
  left: OmpKernelDescriptorV1,
  right: OmpKernelDescriptorV1,
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

function parseRuntimeConfig(input: unknown, allowUnconfigured = false): {
  readonly model_name: string;
  readonly model_api_key: string;
  readonly model_endpoint: string;
  readonly model_configured: boolean;
  readonly web_search_endpoint?: string;
  readonly web_search_api_key?: string;
  readonly harness_v2_kernel?: unknown;
  readonly harness_v2_omp_runtime_root?: unknown;
  readonly harness_v2_omp_descriptor?: unknown;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("live Runtime config must be a JSON object");
  }
  const config = input as RuntimeConfig;
  if (config.model_provider !== "openai-compatible") {
    throw new Error("live Runtime config requires an openai-compatible provider");
  }
  const modelName = allowUnconfigured
    ? (typeof config.model_name === "string" && config.model_name.trim() !== ""
      ? config.model_name
      : "deepseek-v4-pro")
    : requiredConfigString(config.model_name, "model_name");
  const apiKey = allowUnconfigured
    ? (typeof config.model_api_key === "string" ? config.model_api_key : "")
    : requiredConfigString(config.model_api_key, "model_api_key");
  const endpoint = allowUnconfigured
    ? (typeof config.model_endpoint === "string" ? config.model_endpoint : "")
    : requiredConfigString(config.model_endpoint, "model_endpoint");
  let modelConfigured = apiKey.trim() !== "" && endpoint.trim() !== "";
  if (endpoint.trim() !== "") {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      if (!allowUnconfigured) throw new Error("live Runtime config model_endpoint must be an absolute URL");
      modelConfigured = false;
      parsedEndpoint = new URL("https://unconfigured.invalid/v1/chat/completions");
    }
    if (parsedEndpoint.protocol !== "https:") {
      if (!allowUnconfigured) throw new Error("live Runtime config model_endpoint must use HTTPS");
      modelConfigured = false;
    }
  }
  const runtimeEndpoint = modelConfigured ? endpoint : "https://unconfigured.invalid/v1/chat/completions";
  const webSearchEndpoint = optionalConfigString(config.web_search_endpoint, "web_search_endpoint");
  const webSearchApiKey = optionalConfigString(config.web_search_api_key, "web_search_api_key");
  return {
    model_name: modelName,
    model_api_key: apiKey,
    model_endpoint: runtimeEndpoint,
    model_configured: modelConfigured,
    harness_v2_kernel: config.harness_v2_kernel,
    harness_v2_omp_runtime_root: config.harness_v2_omp_runtime_root,
    harness_v2_omp_descriptor: config.harness_v2_omp_descriptor,
    ...(webSearchEndpoint === undefined ? {} : { web_search_endpoint: webSearchEndpoint }),
    ...(webSearchApiKey === undefined ? {} : { web_search_api_key: webSearchApiKey }),
  };
}

function unconfiguredRuntimeConfig(): ReturnType<typeof parseRuntimeConfig> {
  return {
    model_name: "deepseek-v4-pro",
    model_api_key: "",
    model_endpoint: "https://unconfigured.invalid/v1/chat/completions",
    model_configured: false,
  };
}

export async function createLiveProfile(
  modelName: string,
  configuredSkillPath?: string,
  webSearchEnabled = false,
  surface: "general" | "create" | "chat" | "hiker" | "reimbursement" | "crew" = "general",
  memoryRead: MemoryReadMode = "none",
  kernel?: KernelDescriptorV1,
  productMode = false,
) {
  const defaultSkillPath = resolve(
    import.meta.dirname,
    defaultSkillRelativePath(surface),
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
    id: skillIdForSurface(surface),
    document,
    provenance: { source: "anna-repository", uri: "file://" + skillPath },
  });
  const model = {
    provider: "anna-openai-compatible",
    name: modelName,
    reasoning: "high" as const,
  };
  const toolNames = toolNamesForSurface(surface, webSearchEnabled, productMode);
  const budget = productMode
    ? { wallTimeMs: 180_000, turns: 12, toolCalls: 64 }
    : { wallTimeMs: 30_000, turns: 3 };
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
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: [memoryRead], allowedWriteModes: ["disabled"] },
    },
    workerProfile: {
      id: (surface === "create"
        ? "worker:harness-v2-create"
        : productMode
          ? `worker:harness-v2-${surface}`
          : "worker:harness-v2-live") as WorkerProfileId,
      version: "1.0.0",
      instructions: surface === "create"
        ? "Create one reviewable artifact with the approved Tool. Do not claim activation."
        : "Complete the requested Anna Run goal with the approved Skill and admitted tools.",
      allowedSkillIds: [skill.id],
      allowedTools: toolNames,
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: budget,
      artifactContract,
    },
    runProfile: {
      id: (surface === "create"
        ? "profile:harness-v2-create"
        : productMode
          ? `profile:harness-v2-${surface}`
          : "profile:harness-v2-live") as RunProfileId,
      version: "1.0.0",
      model,
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal", "constraints", "provenance"] }],
      toolPolicy: { allowedTools: toolNames },
      budget,
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

function defaultSkillRelativePath(
  surface: "general" | "create" | "chat" | "hiker" | "reimbursement" | "crew",
): string {
  switch (surface) {
    case "create":
      return "../../../skills/harness-v2/create-assistant/SKILL.md";
    case "chat":
      return "../../../skills/chat/general-assistant/SKILL.md";
    case "hiker":
      return "../../../skills/hiker/global-customer/SKILL.md";
    case "reimbursement":
      return "../../../skills/reimbursement/travel-expense/SKILL.md";
    case "crew":
      return "../../../skills/crew/project-management/SKILL.md";
    case "general":
      return "../../../skills/harness-v2/general-assistant/SKILL.md";
  }
}

function skillIdForSurface(
  surface: "general" | "create" | "chat" | "hiker" | "reimbursement" | "crew",
): string {
  switch (surface) {
    case "create":
      return "skill:create/create-assistant";
    case "chat":
      return "skill:chat/general-assistant";
    case "hiker":
      return "skill:hiker/global-customer";
    case "reimbursement":
      return "skill:reimbursement/travel-expense";
    case "crew":
      return "skill:crew/project-management";
    case "general":
      return "skill:harness-v2/general-assistant";
  }
}

function narrowProductProfile(
  surfaceId: V2SurfaceId,
  profile: ResolvedRunProfile,
  task?: ProductTask,
  modelProfiles?: LiveHarnessV2RuntimeOptions["modelProfiles"],
): ResolvedRunProfile {
  const model = selectedProductModel(profile, task, modelProfiles);
  const catalog = productToolCatalog(task);
  const catalogProvided = Array.isArray(task?.context?.tool_catalog);
  const allowedTools = surfaceId === "chat"
    ? profile.allowedTools.filter((name) => {
      const canonical = canonicalToolName(name);
      if (canonical === "todo" || canonical === "web_search") return true;
      if (canonical === "workdir.read_file") return task?.workdir_path !== undefined;
      return catalogProvided && (canonical === "chat.emit_page" || canonical === "chat.emit_document")
        && catalog.has(canonical);
    })
    : (surfaceId !== "crew" && surfaceId !== "hiker" && surfaceId !== "reimbursement")
      ? profile.allowedTools
      : profile.allowedTools.filter((name) => {
        const canonical = canonicalToolName(name);
        return canonical === "read_only" || canonical === "todo" || canonical === "web_search"
          || catalog.has(canonical);
      });
  const taskSystemPrompt = task?.system_prompt?.trim();
  const workerInstructions = taskSystemPrompt === undefined
    ? profile.workerProfile.instructions
    : `${profile.workerProfile.instructions}\n\nHost-provided task system prompt (scoped instruction):\n${taskSystemPrompt}`;
  if (
    allowedTools.length === profile.allowedTools.length
    && model.name === profile.model.name
    && workerInstructions === profile.workerProfile.instructions
  ) return profile;
  const skillIds = profile.skills.map((skill) => skill.id);
  const workerProfile = profile.workerProfile;
  return resolveRunProfile({
    catalog: profile.skills as SkillCatalogEntry[],
    channelPolicy: {
      toolPolicy: { allowedTools },
      allowedSkillIds: skillIds,
      allowedModels: [model],
      budgetLimits: profile.budget,
      memoryPolicy: {
        allowedReadModes: [profile.memoryPolicy.read],
        allowedWriteModes: [profile.memoryPolicy.write],
      },
    },
    workerProfile: {
      id: workerProfile.id,
      version: workerProfile.version,
      instructions: workerInstructions,
      allowedSkillIds: skillIds,
      allowedTools,
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: profile.budget,
      artifactContract: profile.artifactContract,
    },
    runProfile: {
      id: profile.id,
      version: profile.version,
      model,
      skillIds,
      contextTransforms: profile.contextTransforms,
      toolPolicy: { allowedTools },
      budget: profile.budget,
      memoryPolicy: profile.memoryPolicy,
      evalPolicy: profile.evalPolicy,
      artifactContract: profile.artifactContract,
      terminalRules: profile.terminalRules,
      ...(profile.kernel === undefined ? {} : { kernel: profile.kernel }),
    },
  });
}

function selectedProductModel(
  profile: ResolvedRunProfile,
  task?: ProductTask,
  modelProfiles?: LiveHarnessV2RuntimeOptions["modelProfiles"],
): ResolvedRunProfile["model"] {
  const profileId = typeof task?.model_profile_id === "string"
    ? task.model_profile_id
    : typeof task?.context?.model_profile_id === "string"
    ? task.context.model_profile_id
    : undefined;
  const selected = profileId === undefined ? undefined : modelProfiles?.[profileId];
  if (selected === undefined || selected.model_name.trim() === "") return profile.model;
  return { ...profile.model, name: selected.model_name.trim() };
}

const HIKER_TOOL_NAMES = [
  "hiker.system.list_capabilities",
  "hiker.system.get_current_user_context",
  "hiker.master_data.search",
  "hiker.master_data.get_detail",
  "hiker.contract.list_contracts",
  "hiker.contract.get_contract_detail",
  "hiker.contract.get_business_chain",
  "hiker.report.get_dashboard_summary",
  "hiker.report.get_collection_summary",
  "hiker.report.get_invoice_summary",
  "hiker.report.get_po_receivable_summary",
] as const;

const CREW_TOOL_NAMES = [
  "crew.emit_project_plan",
  "crew.emit_assignments",
  "crew.emit_task_drafts",
] as const;

const REIMBURSEMENT_TOOL_NAMES = [
  "reimbursement.get_policy",
  "reimbursement.validate_draft",
  "reimbursement.create_draft",
  "reimbursement.get_status",
  "reimbursement.submit_intent",
] as const;

function providerToolName(name: string): string {
  return name;
}

function canonicalToolName(name: string): string {
  return name.replace(/__/g, ".");
}

function toolNamesForSurface(
  surface: "general" | "create" | "chat" | "hiker" | "reimbursement" | "crew",
  webSearchEnabled: boolean,
  productMode = false,
): string[] {
  const names = surface === "create"
    ? productMode
      ? ["todo", "create.emit_skill_draft", "create.emit_prompt_draft", "create.emit_python_tool_draft"]
      : ["create_artifact"]
    : surface === "chat"
      ? ["todo", "chat.emit_page", "chat.emit_document", "workdir.read_file"]
      : surface === "hiker"
        ? ["todo", ...HIKER_TOOL_NAMES.map(providerToolName)]
        : surface === "reimbursement"
          ? ["todo", ...REIMBURSEMENT_TOOL_NAMES.map(providerToolName)]
          : surface === "crew"
            ? ["read_only", "todo", ...CREW_TOOL_NAMES.map(providerToolName)]
            : ["read_only"];
  return webSearchEnabled ? [...names, "web_search"] : names;
}

interface ProductToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly effect?: string;
  readonly replay_policy?: string;
}

async function ompToolDefinitions(
  command: StartRun,
  task?: ProductTask,
): Promise<readonly OmpToolDefinition[]> {
  const catalog = productToolCatalog(task);
  return command.runProfileSnapshot.allowedTools.map((name): OmpToolDefinition => {
    const canonical = canonicalToolName(name);
    const builtin = builtinOmpToolDefinition(name, canonical);
    if (builtin !== undefined) return builtin;
    const entry = canonical.startsWith("create.emit_")
      ? createToolCatalogEntry(canonical)
      : catalog.get(canonical) ?? catalog.get(name);
    if (entry === undefined) {
      throw new Error(`business tool catalog does not offer admitted tool: ${canonical}`);
    }
    return {
      name,
      description: entry.description,
      parameters: entry.input_schema as OmpToolDefinition["parameters"],
    };
  });
}

function dynamicGatewayTools(
  command: StartRun,
  task?: ProductTask,
): readonly HarnessToolDefinition[] {
  const builtIn = new Set(["read_only", "create_artifact", "web_search"]);
  const catalog = productToolCatalog(task);
  return command.runProfileSnapshot.allowedTools
    .filter((name) => !builtIn.has(canonicalToolName(name)) && canonicalToolName(name) !== "todo")
    .map((name) => {
      const canonical = canonicalToolName(name);
      const entry = localProductToolCatalogEntry(canonical)
        ?? (canonical.startsWith("create.emit_")
        ? createToolCatalogEntry(canonical)
        : catalog.get(canonical) ?? catalog.get(name));
      if (entry === undefined) {
        throw new Error(`business tool catalog does not offer admitted tool: ${canonical}`);
      }
      return {
        name,
        replayPolicy: replayPolicyFor(entry),
        inputSchema: schemaFromJson(entry.input_schema),
      };
    });
}

function builtinOmpToolDefinition(
  name: string,
  canonical: string,
): OmpToolDefinition | undefined {
  if (canonical === "read_only") {
    return {
      name,
      description: "Read one admitted workspace file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    };
  }
  if (canonical === "workdir.read_file") {
    return {
      name,
      description: "Read one bounded text file from the admitted task workdir.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    };
  }
  if (canonical === "chat.emit_page") {
    return {
      name,
      description: "Submit a finished single-file HTML page as a formal deliverable.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, html: { type: "string" } },
        required: ["title", "html"],
        additionalProperties: false,
      },
    };
  }
  if (canonical === "chat.emit_document") {
    return {
      name,
      description: "Submit a finished Markdown document as a formal deliverable.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, markdown: { type: "string" } },
        required: ["title", "markdown"],
        additionalProperties: false,
      },
    };
  }
  if (canonical === "todo") {
    return {
      name,
      description: "Maintain the durable Todo plan for this Anna task.",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"],
          },
          list: {
            type: "array",
            items: {
              type: "object",
              properties: {
                phase: { type: "string" },
                items: { type: "array", items: { type: "string" }, "minItems": 1 },
              },
              required: ["phase", "items"],
              additionalProperties: false,
            },
          },
          task: { type: "string" },
          phase: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      },
    };
  }
  if (canonical === "web_search") {
    return {
      name,
      description: "Search the configured external source.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    };
  }
  return undefined;
}

function productToolCatalog(task?: ProductTask): Map<string, ProductToolCatalogEntry> {
  const raw = task?.context?.tool_catalog;
  if (!Array.isArray(raw)) return new Map();
  const catalog = new Map<string, ProductToolCatalogEntry>();
  for (const item of raw) {
    if (!isRecord(item)
      || typeof item.name !== "string"
      || typeof item.input_schema !== "object"
      || item.input_schema === null
      || Array.isArray(item.input_schema)) continue;
    const name = canonicalToolName(item.name);
    const inputSchema = item.input_schema as Record<string, unknown>;
    if (!isStrictJsonSchema(inputSchema)) continue;
    catalog.set(name, {
      name,
      description: typeof item.description === "string" ? item.description : `${name} business adapter`,
      input_schema: inputSchema,
      ...(typeof item.effect === "string" ? { effect: item.effect } : {}),
      ...(typeof item.replay_policy === "string" ? { replay_policy: item.replay_policy } : {}),
    });
  }
  return catalog;
}

function createToolCatalogEntry(name: string): ProductToolCatalogEntry {
  const schemas: Record<string, ProductToolCatalogEntry> = {
    "create.emit_skill_draft": {
      name,
      description: "Emit a generated Anna Skill draft for validation and review.",
      input_schema: {
        type: "object",
        properties: {
          skill_id: { type: "string" }, name: { type: "string" }, version: { type: "string" },
          description: { type: "string" }, allowed_tools: { type: "array", items: { type: "string" } },
          forbidden_tools: { type: "array", items: { type: "string" } }, body: { type: "string" },
        },
        required: ["skill_id", "name", "version", "description", "allowed_tools", "forbidden_tools", "body"],
        additionalProperties: false,
      },
      replay_policy: "never",
    },
    "create.emit_prompt_draft": {
      name,
      description: "Emit a generated Anna Prompt draft for review.",
      input_schema: {
        type: "object",
        properties: {
          prompt_id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
          body: { type: "string" }, variables: { type: "array", items: { type: "string" } },
        },
        required: ["prompt_id", "title", "description", "body", "variables"],
        additionalProperties: false,
      },
      replay_policy: "never",
    },
    "create.emit_python_tool_draft": {
      name,
      description: "Emit a generated Python tool draft for fixture evaluation.",
      input_schema: {
        type: "object",
        properties: {
          tool_id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
          code: { type: "string" }, fixture_input: { type: "string" },
        },
        required: ["tool_id", "name", "description", "code", "fixture_input"],
        additionalProperties: false,
      },
      replay_policy: "never",
    },
  };
  const entry = schemas[name];
  if (entry === undefined) throw new Error(`unknown Create tool: ${name}`);
  return entry;
}

function localProductToolCatalogEntry(name: string): ProductToolCatalogEntry | undefined {
  if (name === "workdir.read_file") {
    return {
      name,
      description: "Read one bounded text file from the admitted task workdir.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      effect: "read",
      replay_policy: "safe",
    };
  }
  if (name === "chat.emit_page") {
    return {
      name,
      description: "Submit a finished single-file HTML page as a formal deliverable.",
      input_schema: {
        type: "object",
        properties: { title: { type: "string" }, html: { type: "string" } },
        required: ["title", "html"],
        additionalProperties: false,
      },
      effect: "contained_write",
      replay_policy: "never",
    };
  }
  if (name === "chat.emit_document") {
    return {
      name,
      description: "Submit a finished Markdown document as a formal deliverable.",
      input_schema: {
        type: "object",
        properties: { title: { type: "string" }, markdown: { type: "string" } },
        required: ["title", "markdown"],
        additionalProperties: false,
      },
      effect: "contained_write",
      replay_policy: "never",
    };
  }
  return undefined;
}

function schemaFromJson(schema: Record<string, unknown>): Schema<unknown> {
  const properties = isRecord(schema.properties) ? new Set(Object.keys(schema.properties)) : new Set<string>();
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    parse(input: unknown) {
      if (!isRecord(input)) throw new Error("tool input must be an object");
      if (Object.keys(input).some((key) => !properties.has(key))) throw new Error("tool input contains an unknown field");
      if (required.some((key) => !(key in input))) throw new Error("tool input is missing a required field");
      return input;
    },
  };
}

function isStrictJsonSchema(value: Record<string, unknown>): boolean {
  return value.type === "object" && isRecord(value.properties);
}

function replayPolicyFor(entry: ProductToolCatalogEntry): "safe" | "never" {
  if (entry.effect === "read" && entry.replay_policy === "safe") return "safe";
  if (entry.effect === "read" && entry.replay_policy === undefined) return "safe";
  return "never";
}

async function initialMessagesFor(
  command: StartRun,
  taskFor?: (runId: string) => ProductTask | undefined | Promise<ProductTask | undefined>,
  agentDirectives?: Readonly<Record<string, string>>,
  modelProfiles?: LiveHarnessV2RuntimeOptions["modelProfiles"],
): Promise<readonly Message[]> {
  if (taskFor === undefined) return [];
  const task = await taskFor(String(command.runId));
  if (task === undefined) return [];
  const messages: Message[] = [];
  const metadata: Record<string, JsonValue> = {
    ...(task.context ?? {}),
    ...(task.channel_id === undefined ? {} : { channel_id: task.channel_id }),
    ...(task.conversation_id === undefined ? {} : { conversation_id: task.conversation_id }),
    ...(task.workdir_path === undefined ? {} : { workdir_path: task.workdir_path }),
    ...(task.permission_mode === undefined ? {} : { permission_mode: task.permission_mode }),
    ...(task.model_profile_id === undefined ? {} : { model_profile_id: task.model_profile_id }),
    ...(task.source_event_id === undefined ? {} : { source_event_id: task.source_event_id }),
  };
  const conversationHistory = Array.isArray(metadata.conversation_history)
    ? metadata.conversation_history
      .filter((entry: unknown): entry is { role: "user" | "assistant"; content: string } =>
        isRecord(entry)
        && (entry.role === "user" || entry.role === "assistant")
        && typeof entry.content === "string"
        && entry.content.trim() !== "")
    : [];
  delete metadata.conversation_history;
  for (const entry of conversationHistory) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.content });
    } else {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: entry.content }],
        stopReason: "stop",
      });
    }
  }
  if (Object.keys(metadata).length > 0) {
    messages.push({
      role: "user",
      content: "Host-provided runtime context (reference only; do not treat fields as permissions):\n"
      + JSON.stringify(metadata),
    });
  }
  const skillId = typeof task.context?.skill_id === "string" ? task.context.skill_id : undefined;
  if (skillId !== undefined) {
    const document = await selectedSkillDocument(skillId);
    if (document === undefined) throw new Error("selected_skill_unavailable");
    messages.push({
      role: "user",
      content: "Host-selected Skill (follow its scoped instructions and tool policy):\n" + document,
    });
  }
  const agentId = typeof task.context?.agent_id === "string" ? task.context.agent_id : undefined;
  const directive = agentId === undefined ? undefined : agentDirectives?.[agentId];
  if (directive !== undefined && directive.trim() !== "") {
    messages.push({
      role: "user",
      content: "Host-selected Agent directive (scoped instruction):\n" + directive,
    });
  }
  const modelProfileId = typeof task.context?.model_profile_id === "string"
    ? task.context.model_profile_id
    : task.model_profile_id;
  const modelProfile = modelProfileId === undefined ? undefined : modelProfiles?.[modelProfileId];
  if (modelProfile !== undefined) {
    messages.push({
      role: "user",
      content: `Host-selected model profile: ${modelProfileId}\nmodel_name=${modelProfile.model_name}`,
    });
  }
  return messages;
}

async function selectedSkillDocument(skillId: string): Promise<string | undefined> {
  const normalizedId = skillId.startsWith("skill:") ? skillId.slice("skill:".length) : skillId;
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(normalizedId)) return undefined;
  const skillsRoot = resolve(import.meta.dirname, "../../../skills");
  const candidate = resolve(skillsRoot, ...normalizedId.split("/"), "SKILL.md");
  if (!candidate.startsWith(`${skillsRoot}/`)) return undefined;
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return undefined;
  }
}

async function callLocalProductTool(
  request: ToolRequest,
): Promise<ToolResult> {
  const canonical = canonicalToolName(request.name);
  if (canonical.startsWith("create.emit_")) {
    return { status: "succeeded", output: { accepted: true } };
  }
  if (canonical === "chat.emit_page" || canonical === "chat.emit_document") {
    const input = request.input as Record<string, unknown>;
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const contentKey = canonical === "chat.emit_page" ? "html" : "markdown";
    const content = typeof input[contentKey] === "string" ? input[contentKey].trim() : "";
    if (title === "" || content === "") {
      return {
        status: "failed",
        output: { reason: `artifact_invalid_${contentKey}` },
      };
    }
    return {
      status: "succeeded",
      output: {
        accepted: true,
        artifact: {
          id: `art_${request.runId}_${request.toolCallId}`,
          kind: canonical === "chat.emit_page" ? "page" : "doc",
          title: title.slice(0, 60),
          content,
        },
      },
    };
  }
  return { status: "failed", output: { reason: "business_adapter_not_configured" } };
}

async function callBusinessTool(options: {
  origin: string;
  serviceToken?: string;
  command: StartRun;
  request: ToolRequest;
  signal: AbortSignal;
  productTaskFor?: (runId: string) => ProductTask | undefined | Promise<ProductTask | undefined>;
  productTaskPeek?: (runId: string) => ProductTask | undefined;
  fetchImpl?: typeof fetch;
}): Promise<ToolResult> {
  const canonical = canonicalToolName(options.request.name);
  const endpoint = canonical.startsWith("hiker.")
    ? "_business/hiker/tools/call"
    : canonical.startsWith("crew.")
      ? "_business/crew/tools/call"
      : canonical.startsWith("reimbursement.")
        ? "_business/reimbursement/tools/call"
        : canonical.startsWith("chat.")
          ? "_business/chat/tools/call"
        : undefined;
  if (endpoint === undefined) return { status: "failed", output: { reason: "business_tool_not_implemented" } };
  if (options.serviceToken === undefined || options.serviceToken.trim() === "") {
    return { status: "failed", output: { reason: "business_service_token_missing" } };
  }
  const task = options.productTaskPeek?.(String(options.command.runId))
    ?? await options.productTaskFor?.(String(options.command.runId));
  const actorUserId = task?.actor_user_id ?? String(options.command.workspaceId);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.origin.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      signal: options.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-anna-service-token": options.serviceToken,
      },
      body: JSON.stringify({
        workspace_id: String(options.command.workspaceId),
        actor_user_id: actorUserId,
        run_id: String(options.command.runId),
        name: canonical,
        arguments: options.request.input,
      }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) return { status: "failed", output: { reason: "business_tool_failed" } };
    return { status: "succeeded", output: isRecord(body) && body.result !== undefined ? body.result as JsonValue : body as unknown as JsonValue };
  } catch {
    return { status: "failed", output: { reason: "business_service_unavailable" } };
  }
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
