import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

import {
  RunManager,
  SqliteEventStore,
} from "@anna/event-store";
import type {
  CanonicalEvent,
  ChannelScope,
  EventStore,
  RunId,
  StreamId,
} from "@anna/harness-v2";

import type { OmpHostModelTransport } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import {
  createLiveHarnessV2Runtime,
  createOmpKernelDescriptor,
  type LiveHarnessV2Runtime,
} from "./production";

const previewProtocol = "anna-harness-preview/1" as const;
const maxJsonBodyBytes = 1_024 * 1_024;
const previewSurface = "preview" as const;
const terminalEventTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "run.awaiting_input",
  "run.awaiting_approval",
]);

export interface PreviewSettings {
  readonly model_name: string;
  readonly model_endpoint: string;
  readonly workspace_root: string;
  readonly has_api_key: boolean;
}

export interface PreviewStatus {
  readonly protocol: typeof previewProtocol;
  readonly kernel: "omp";
  readonly configured: boolean;
  readonly ready: boolean;
  readonly reason?: string;
}

export type PreviewRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface PreviewRunSummary {
  readonly run_id: string;
  readonly goal: string;
  readonly status: PreviewRunStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PreviewRuntime {
  start(
    surfaceId: typeof previewSurface,
    body: unknown,
  ): Promise<{ runId: string; status: string }>;
  readEvents?(
    workspaceId: string,
    channelId: string,
    runId: string,
    fromSeq?: number,
  ): Promise<readonly CanonicalEvent[]>;
  stop?(
    workspaceId: string,
    channelId: string,
    runId: string,
    reason?: string,
  ): Promise<{ status: string } | undefined>;
}

export interface PreviewRuntimeHandle {
  readonly runtime: PreviewRuntime;
  readonly eventStore: EventStore;
  close(): void | Promise<void>;
}

export interface PreviewRuntimeFactoryOptions {
  readonly settings: PreviewSettings;
  readonly model_api_key: string;
  readonly eventStorePath: string;
  readonly configPath: string;
  readonly scope: ChannelScope;
  readonly ompRuntimeRoot: string;
  readonly ompModelTransport?: OmpHostModelTransport;
}

export type PreviewRuntimeFactory = (
  options: PreviewRuntimeFactoryOptions,
) => Promise<PreviewRuntimeHandle>;

export interface PreviewHarnessServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly stateRoot?: string;
  readonly configPath?: string;
  readonly eventStorePath?: string;
  readonly workspaceRoot?: string;
  readonly staticRoot?: string;
  readonly ompRuntimeRoot?: string;
  readonly ompModelTransport?: OmpHostModelTransport;
  readonly createRuntime?: PreviewRuntimeFactory;
  readonly now?: () => string;
}

export interface RunningPreviewHarnessService {
  readonly url: string;
  close(): Promise<void>;
}

interface StoredPreviewSettings {
  readonly model_name: string;
  readonly model_endpoint: string;
  readonly workspace_root: string;
  readonly model_api_key?: string;
}

class PreviewHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "PreviewHttpError";
  }
}

class PreviewRuntimeUnavailableError extends Error {
  constructor(readonly reason: "omp_runtime_unavailable" | "runtime_unavailable") {
    super(reason);
    this.name = "PreviewRuntimeUnavailableError";
  }
}

class PreviewJsonBodyError extends Error {
  constructor(readonly code: "invalid_json" | "body_too_large") {
    super(code);
    this.name = "PreviewJsonBodyError";
  }
}

export async function startPreviewHarnessService(
  options: PreviewHarnessServiceOptions = {},
): Promise<RunningPreviewHarnessService> {
  const host = options.host ?? process.env.ANNA_PREVIEW_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("Harness Preview service must bind to a loopback host");
  }

  const stateRoot = resolve(
    options.stateRoot
      ?? process.env.ANNA_PREVIEW_STATE_ROOT
      ?? ".anna/preview",
  );
  const defaultWorkspaceRoot = resolve(
    options.workspaceRoot
      ?? process.env.ANNA_PREVIEW_WORKSPACE_ROOT
      ?? process.cwd(),
  );
  const settingsPath = join(stateRoot, "settings.json");
  const eventStorePath = resolve(
    options.eventStorePath
      ?? join(stateRoot, "events.sqlite3"),
  );
  const configPath = resolve(
    options.configPath
      ?? process.env.ANNA_PREVIEW_CONFIG_PATH
      ?? join(stateRoot, "runtime.json"),
  );
  const staticRoot = resolve(
    options.staticRoot
      ?? process.env.ANNA_PREVIEW_STATIC_ROOT
      ?? resolve(import.meta.dirname, "../../../dist"),
  );
  const ompRuntimeRoot = options.ompRuntimeRoot
    ?? process.env.ANNA_PREVIEW_OMP_RUNTIME_ROOT;
  const now = options.now ?? (() => new Date().toISOString());

  await mkdir(stateRoot, { recursive: true });
  let storedSettings = await readStoredSettings(settingsPath, defaultWorkspaceRoot);
  let runtimeHandle: PreviewRuntimeHandle | undefined;
  let runtimePromise: Promise<PreviewRuntimeHandle | undefined> | undefined;
  let runtimeReason: PreviewStatus["reason"];
  const stopping = new Map<string, Promise<void>>();

  const createRuntime = options.createRuntime ?? defaultPreviewRuntimeFactory;
  const scope = () => derivePreviewScope(storedSettings.workspace_root);
  const publicSettings = (): PreviewSettings => ({
    model_name: storedSettings.model_name,
    model_endpoint: storedSettings.model_endpoint,
    workspace_root: storedSettings.workspace_root,
    has_api_key: typeof storedSettings.model_api_key === "string"
      && storedSettings.model_api_key.length > 0,
  });

  const isConfigured = (): boolean => publicSettings().model_name.length > 0
    && publicSettings().model_endpoint.length > 0
    && publicSettings().has_api_key;

  const ensureRuntime = async (): Promise<PreviewRuntimeHandle | undefined> => {
    if (!isConfigured()) {
      runtimeReason = "model_configuration_missing";
      return undefined;
    }
    if (runtimeHandle !== undefined) return runtimeHandle;
    if (runtimePromise !== undefined) return runtimePromise;

    const requestedSettings = storedSettings;
    const requestedScope = derivePreviewScope(requestedSettings.workspace_root);
    runtimePromise = (async () => {
      try {
        if (options.createRuntime === undefined && ompRuntimeRoot === undefined) {
          throw new PreviewRuntimeUnavailableError("omp_runtime_unavailable");
        }
        const created = await createRuntime({
          settings: publicSettingsFor(requestedSettings),
          model_api_key: requestedSettings.model_api_key!,
          eventStorePath,
          configPath,
          scope: requestedScope,
          ompRuntimeRoot: ompRuntimeRoot ?? "",
          ...(options.ompModelTransport === undefined
            ? {}
            : { ompModelTransport: options.ompModelTransport }),
        });
        if (storedSettings !== requestedSettings) {
          await created.close();
          return undefined;
        }
        runtimeHandle = created;
        runtimeReason = undefined;
        return created;
      } catch (error) {
        runtimeReason = error instanceof PreviewRuntimeUnavailableError
          ? error.reason
          : "runtime_unavailable";
        return undefined;
      } finally {
        runtimePromise = undefined;
      }
    })();
    return runtimePromise;
  };

  const currentStore = async (): Promise<{
    store: EventStore;
    dispose: () => void;
  }> => {
    if (runtimeHandle !== undefined) {
      return { store: runtimeHandle.eventStore, dispose: () => undefined };
    }
    const store = new SqliteEventStore(eventStorePath);
    return { store, dispose: () => store.close() };
  };

  const readRun = async (
    runId: string,
  ): Promise<{ summary: PreviewRunSummary; events: CanonicalEvent[] } | undefined> => {
    const opened = await currentStore();
    try {
      const channelStore = opened.store.scope(scope());
      const command = await channelStore.getRunCommand(runId as RunId);
      if (command === undefined) return undefined;
      const events = await readEvents(channelStore, runId);
      const run = await new RunManager(channelStore).get(runId as RunId);
      return {
        summary: summarizeRun(
          command.goal,
          run?.status ?? "queued",
          events,
          now,
          runId,
        ),
        events,
      };
    } finally {
      opened.dispose();
    }
  };

  const listRuns = async (): Promise<PreviewRunSummary[]> => {
    const opened = await currentStore();
    try {
      const channelStore = opened.store.scope(scope());
      const runs: PreviewRunSummary[] = [];
      for (const command of await channelStore.listRunCommands()) {
        const events = await readEvents(channelStore, command.runId);
        const run = await new RunManager(channelStore).get(command.runId);
        runs.push(summarizeRun(
          command.goal,
          run?.status ?? "queued",
          events,
          now,
          command.runId,
        ));
      }
      return runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    } finally {
      opened.dispose();
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof PreviewHttpError) {
        responseJson(response, error.statusCode, { code: error.code });
        return;
      }
      if (error instanceof PreviewJsonBodyError) {
        responseJson(response, 400, { code: error.code });
        return;
      }
      responseJson(response, 500, { code: "preview_internal_error" });
    });
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    assertRequestHost(request, origin);
    const requestUrl = new URL(request.url ?? "/", "http://preview.local");
    const pathname = requestUrl.pathname;
    if (request.method === "GET" && pathname === "/health") {
      responseJson(response, 200, {
        status: "ok",
        protocol: previewProtocol,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/preview/status") {
      await ensureRuntime();
      const status: PreviewStatus = {
        protocol: previewProtocol,
        kernel: "omp",
        configured: isConfigured(),
        ready: runtimeHandle !== undefined,
        ...(runtimeHandle === undefined
          ? { reason: runtimeReason ?? "model_configuration_missing" }
          : {}),
      };
      responseJson(response, 200, status);
      return;
    }
    if (request.method === "GET" && pathname === "/api/preview/settings") {
      responseJson(response, 200, publicSettings());
      return;
    }
    if (request.method === "PUT" && pathname === "/api/preview/settings") {
      assertMutationRequest(request, origin);
      await handleSettingsUpdate(request, response);
      return;
    }
    if (request.method === "GET" && pathname === "/api/preview/runs") {
      responseJson(response, 200, { runs: await listRuns() });
      return;
    }

    const eventsMatch = pathname.match(/^\/api\/preview\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch !== null) {
      await handleEvents(request, response, decodePathSegment(eventsMatch[1]), requestUrl.searchParams);
      return;
    }
    const stopMatch = pathname.match(/^\/api\/preview\/runs\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch !== null) {
      assertMutationRequest(request, origin);
      await handleStop(request, response, decodePathSegment(stopMatch[1]));
      return;
    }
    const detailMatch = pathname.match(/^\/api\/preview\/runs\/([^/]+)$/);
    if (request.method === "GET" && detailMatch !== null) {
      const runId = decodePathSegment(detailMatch[1]);
      const result = await readRun(runId);
      if (result === undefined) throw new PreviewHttpError(404, "run_not_found");
      responseJson(response, 200, { run: result.summary, events: result.events });
      return;
    }
    if (request.method === "POST" && pathname === "/api/preview/runs") {
      assertMutationRequest(request, origin);
      await handleStart(request, response);
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      responseJson(response, 404, { code: "not_found" });
      return;
    }
    if (request.method === "GET") {
      await serveStatic(response, staticRoot, pathname);
      return;
    }
    responseJson(response, 404, { code: "not_found" });
  };

  let origin = "";
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? parsePort(process.env.ANNA_PREVIEW_PORT), host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Harness Preview service did not bind a TCP address");
  }
  origin = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;

  let closePromise: Promise<void> | undefined;
  return {
    url: origin,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        if (runtimePromise !== undefined) await runtimePromise;
        await runtimeHandle?.close();
        await Promise.allSettled([...stopping.values()]);
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
        runtimeHandle = undefined;
      })();
      return closePromise;
    },
  };

  async function handleSettingsUpdate(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const update = parseSettingsUpdate(body);
    const nextKey = update.model_api_key === undefined || update.model_api_key === ""
      ? storedSettings.model_api_key
      : update.model_api_key;
    const nextSettings: StoredPreviewSettings = {
      model_name: update.model_name,
      model_endpoint: update.model_endpoint,
      workspace_root: resolve(update.workspace_root),
      ...(nextKey === undefined ? {} : { model_api_key: nextKey }),
    };
    const active = await listRuns();
    if (active.some((run) => run.status === "queued" || run.status === "running")) {
      throw new PreviewHttpError(409, "active_run_settings_conflict");
    }
    await runtimeHandle?.close();
    runtimeHandle = undefined;
    runtimeReason = undefined;
    storedSettings = nextSettings;
    await writeFile(settingsPath, JSON.stringify(nextSettings) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await ensureRuntime();
    responseJson(response, 200, publicSettings());
  }

  async function handleStart(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = parseRunStart(await readJsonBody(request));
    if (!isConfigured()) throw new PreviewHttpError(409, "missing_configuration");
    const live = await ensureRuntime();
    if (live === undefined) {
      throw new PreviewHttpError(503, runtimeReason === "omp_runtime_unavailable"
        ? "omp_unavailable"
        : "runtime_unavailable");
    }
    const currentScope = scope();
    try {
      const result = await live.runtime.start(previewSurface, {
        workspace_id: currentScope.workspaceId,
        channel_id: currentScope.channelId,
        command_id: body.command_id,
        run_id: body.run_id,
        source_event_id: `preview:source:${body.command_id}`,
        goal: body.goal,
      });
      responseJson(response, 202, {
        run_id: result.runId,
        status: previewStatusFromRuntime(result.status),
      });
    } catch (error) {
      if (isKernelUnavailable(error)) {
        throw new PreviewHttpError(503, "omp_unavailable");
      }
      if (isConflict(error)) {
        throw new PreviewHttpError(409, "run_conflict");
      }
      throw new PreviewHttpError(503, "runtime_unavailable");
    }
  }

  async function handleStop(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
  ): Promise<void> {
    assertPathSegment(runId, "invalid_run_path");
    const body = await readJsonBody(request);
    assertExactKeys(body, [], "invalid_stop_request");
    const existing = await readRun(runId);
    if (existing === undefined) throw new PreviewHttpError(404, "run_not_found");
    if (isTerminalPreviewStatus(existing.summary.status)) {
      responseJson(response, 202, {
        run_id: runId,
        status: existing.summary.status,
      });
      return;
    }
    const key = `${scope().workspaceId}\u0000${scope().channelId}\u0000${runId}`;
    if (!stopping.has(key)) {
      const live = runtimeHandle;
      const currentScope = scope();
      if (live?.runtime.stop === undefined) {
        throw new PreviewHttpError(503, "runtime_unavailable");
      }
      const stoppingRun = Promise.resolve(live.runtime.stop(
        currentScope.workspaceId,
        currentScope.channelId,
        runId,
        "Stopped by user",
      )).then(() => undefined, () => undefined);
      stopping.set(key, stoppingRun);
      void stoppingRun.finally(() => {
        if (stopping.get(key) === stoppingRun) stopping.delete(key);
      });
    }
    responseJson(response, 202, { run_id: runId, status: "cancelling" });
  }

  async function handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    query: URLSearchParams,
  ): Promise<void> {
    assertPathSegment(runId, "invalid_run_path");
    const afterSeqValue = query.get("after_seq");
    const afterSeq = afterSeqValue === null ? -1 : Number(afterSeqValue);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
      throw new PreviewHttpError(400, "invalid_event_cursor");
    }
    const opened = await currentStore();
    const channelStore = opened.store.scope(scope());
    if (await channelStore.getRunCommand(runId as RunId) === undefined) {
      opened.dispose();
      throw new PreviewHttpError(404, "run_not_found");
    }
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    let cursor = afterSeq;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      opened.dispose();
      if (!response.destroyed) response.end();
    };
    request.once("close", finish);

    const poll = async (): Promise<void> => {
      if (finished) return;
      try {
        const events = await readEvents(channelStore, runId, cursor);
        for (const event of events) {
          if (finished) return;
          cursor = event.seq;
          response.write(`event: canonical\ndata: ${JSON.stringify(event)}\n\n`);
          if (terminalEventTypes.has(event.type)) {
            finish();
            return;
          }
        }
        if (!finished) {
          const latest = await readRunFromStore(channelStore, runId);
          if (latest !== undefined && isTerminalPreviewStatus(latest.summary.status)) {
            finish();
            return;
          }
          timer = setTimeout(() => void poll(), 50);
        }
      } catch {
        finish();
      }
    };
    await poll();
  }
}

async function defaultPreviewRuntimeFactory(
  options: PreviewRuntimeFactoryOptions,
): Promise<PreviewRuntimeHandle> {
  if (options.ompRuntimeRoot === "") {
    throw new PreviewRuntimeUnavailableError("omp_runtime_unavailable");
  }
  await mkdir(options.settings.workspace_root, { recursive: true });
  let descriptor: Awaited<ReturnType<typeof createOmpKernelDescriptor>>;
  try {
    descriptor = await createOmpKernelDescriptor(options.ompRuntimeRoot);
  } catch {
    throw new PreviewRuntimeUnavailableError("omp_runtime_unavailable");
  }
  const config = {
    model_provider: "openai-compatible",
    model_name: options.settings.model_name,
    model_api_key: options.model_api_key,
    model_endpoint: options.settings.model_endpoint,
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: options.ompRuntimeRoot,
    harness_v2_omp_descriptor: descriptor,
  };
  await mkdir(resolve(options.configPath, ".."), { recursive: true });
  await writeFile(options.configPath, JSON.stringify(config) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  let live: LiveHarnessV2Runtime;
  try {
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: options.configPath,
      eventStorePath: options.eventStorePath,
      workspaceRoot: options.settings.workspace_root,
      ompRuntimeRoot: options.ompRuntimeRoot,
      ompModelTransport: options.ompModelTransport,
      surfaces: [previewSurface],
    });
  } catch (error) {
    throw error instanceof PreviewRuntimeUnavailableError
      ? error
      : new PreviewRuntimeUnavailableError("runtime_unavailable");
  }
  return {
    runtime: live.runtime,
    eventStore: live.eventStore,
    close: live.close,
  };
}

async function readStoredSettings(
  path: string,
  defaultWorkspaceRoot: string,
): Promise<StoredPreviewSettings> {
  try {
    const input: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return defaultSettings(defaultWorkspaceRoot);
    }
    const value = input as Record<string, unknown>;
    return {
      model_name: typeof value.model_name === "string" ? value.model_name.trim() : "",
      model_endpoint: typeof value.model_endpoint === "string" && isSafeEndpoint(value.model_endpoint)
        ? value.model_endpoint.trim()
        : "",
      workspace_root: typeof value.workspace_root === "string" && value.workspace_root.trim() !== ""
        ? resolve(value.workspace_root)
        : defaultWorkspaceRoot,
      ...(typeof value.model_api_key === "string" && value.model_api_key.length > 0
        ? { model_api_key: value.model_api_key }
        : {}),
    };
  } catch {
    return defaultSettings(defaultWorkspaceRoot);
  }
}

function defaultSettings(workspaceRoot: string): StoredPreviewSettings {
  return {
    model_name: "",
    model_endpoint: "",
    workspace_root: workspaceRoot,
  };
}

function publicSettingsFor(settings: StoredPreviewSettings): PreviewSettings {
  return {
    model_name: settings.model_name,
    model_endpoint: settings.model_endpoint,
    workspace_root: settings.workspace_root,
    has_api_key: typeof settings.model_api_key === "string"
      && settings.model_api_key.length > 0,
  };
}

export function derivePreviewScope(workspaceRoot: string): ChannelScope {
  const digest = createHash("sha256").update(resolve(workspaceRoot), "utf8").digest("hex").slice(0, 32);
  return {
    workspaceId: `workspace:preview:${digest}` as ChannelScope["workspaceId"],
    channelId: `channel:preview:${digest}` as ChannelScope["channelId"],
  };
}

async function readEvents(
  store: ReturnType<EventStore["scope"]>,
  runId: string,
  afterSeq = -1,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.read(runId as StreamId, afterSeq)) events.push(event);
  return events;
}

async function readRunFromStore(
  store: ReturnType<EventStore["scope"]>,
  runId: string,
): Promise<{ summary: PreviewRunSummary; events: CanonicalEvent[] } | undefined> {
  const command = await store.getRunCommand(runId as RunId);
  if (command === undefined) return undefined;
  const events = await readEvents(store, runId);
  const run = await new RunManager(store).get(runId as RunId);
  return {
    summary: summarizeRun(command.goal, run?.status ?? "queued", events, () => new Date().toISOString(), runId),
    events,
  };
}

function summarizeRun(
  goal: string,
  status: string,
  events: readonly CanonicalEvent[],
  fallbackNow: () => string,
  runId: string,
): PreviewRunSummary {
  const createdAt = events[0]?.timestamp ?? fallbackNow();
  const updatedAt = events.at(-1)?.timestamp ?? createdAt;
  return {
    run_id: runId,
    goal,
    status: previewStatusFromRuntime(status),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function previewStatusFromRuntime(status: string): PreviewRunStatus {
  switch (status) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "timed_out":
    case "cancelled":
      return status;
    default:
      return "running";
  }
}

function isTerminalPreviewStatus(status: PreviewRunStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled";
}

function parseSettingsUpdate(input: unknown): {
  model_name: string;
  model_endpoint: string;
  workspace_root: string;
  model_api_key?: string;
} {
  assertExactKeys(input, ["model_name", "model_endpoint", "workspace_root", "model_api_key"], "invalid_settings");
  const body = input as Record<string, unknown>;
  const modelName = nonEmptyString(body.model_name, "invalid_settings");
  const modelEndpoint = nonEmptyString(body.model_endpoint, "invalid_settings");
  const workspaceRoot = nonEmptyString(body.workspace_root, "invalid_settings");
  let endpoint: URL;
  try {
    endpoint = new URL(modelEndpoint);
  } catch {
    throw new PreviewHttpError(400, "invalid_settings");
  }
  if (endpoint.protocol !== "https:") {
    throw new PreviewHttpError(400, "invalid_settings");
  }
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new PreviewHttpError(400, "invalid_settings");
  }
  if (body.model_api_key !== undefined && typeof body.model_api_key !== "string") {
    throw new PreviewHttpError(400, "invalid_settings");
  }
  return {
    model_name: modelName,
    model_endpoint: modelEndpoint,
    workspace_root: workspaceRoot,
    ...(body.model_api_key === undefined ? {} : { model_api_key: body.model_api_key as string }),
  };
}

function isSafeEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value.trim());
    return endpoint.protocol === "https:"
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.search === ""
      && endpoint.hash === "";
  } catch {
    return false;
  }
}

function parseRunStart(input: unknown): {
  run_id: string;
  command_id: string;
  goal: string;
} {
  assertExactKeys(input, ["run_id", "command_id", "goal"], "invalid_run_request");
  const body = input as Record<string, unknown>;
  return {
    run_id: nonEmptyString(body.run_id, "invalid_run_request"),
    command_id: nonEmptyString(body.command_id, "invalid_run_request"),
    goal: nonEmptyString(body.goal, "invalid_run_request"),
  };
}

function assertExactKeys(
  input: unknown,
  allowed: readonly string[],
  code: string,
): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PreviewHttpError(400, code);
  }
  const keys = Object.keys(input);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new PreviewHttpError(400, code);
  }
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PreviewHttpError(400, code);
  }
  return value.trim();
}

function assertPathSegment(value: string, code: string): void {
  if (value.trim() === "") throw new PreviewHttpError(400, code);
}

function assertMutationRequest(request: IncomingMessage, expectedOrigin: string): void {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
    throw new PreviewHttpError(400, "unsupported_content_type");
  }
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== expectedOrigin) {
    throw new PreviewHttpError(403, "csrf_origin_mismatch");
  }
}

function assertRequestHost(request: IncomingMessage, expectedOrigin: string): void {
  const hostHeader = request.headers.host;
  if (expectedOrigin === "" || typeof hostHeader !== "string") {
    throw new PreviewHttpError(403, "csrf_host_mismatch");
  }
  try {
    const actual = new URL(`http://${hostHeader}`);
    const expected = new URL(expectedOrigin);
    if (actual.hostname !== expected.hostname || actual.port !== expected.port) {
      throw new PreviewHttpError(403, "csrf_host_mismatch");
    }
  } catch (error) {
    if (error instanceof PreviewHttpError) throw error;
    throw new PreviewHttpError(403, "csrf_host_mismatch");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxJsonBodyBytes) throw new PreviewJsonBodyError("body_too_large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PreviewJsonBodyError("invalid_json");
  }
}

async function serveStatic(
  response: ServerResponse,
  staticRoot: string,
  pathname: string,
): Promise<void> {
  const root = resolve(staticRoot);
  const decoded = decodePathSegment(pathname);
  const requested = decoded === "/" ? "index.html" : decoded.slice(1);
  const candidate = resolve(root, requested);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith(".." + sep) || relativePath === "..") {
    responseJson(response, 404, { code: "not_found" });
    return;
  }
  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    if (extname(pathname) !== "") {
      responseJson(response, 404, { code: "not_found" });
      return;
    }
    filePath = join(root, "index.html");
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": contentTypeFor(filePath) });
    createReadStream(filePath).pipe(response);
  } catch {
    responseJson(response, 404, { code: "not_found" });
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function responseJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PreviewHttpError(400, "invalid_path");
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ANNA_PREVIEW_PORT must be a valid TCP port");
  }
  return port;
}

function isKernelUnavailable(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "body" in error
    && typeof (error as { body?: unknown }).body === "object"
    && (error as { body?: { code?: unknown } }).body?.code === "kernel_unavailable";
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && /conflict|already|present|closing/i.test(error.message);
}
