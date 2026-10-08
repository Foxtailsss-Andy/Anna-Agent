import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from "node:path";

import type {
  CanonicalEvent,
  ChannelScope,
  EventStore,
  StreamId,
} from "@anna/harness-v2";

import type { HarnessV2Runtime, V2SurfaceId } from "./index";
import {
  modelConfigKeys,
  productModelStatus,
  publicProductConfig,
  readProductConfig,
  writeProductConfig,
  type ProductConfig,
} from "./product-config";
import {
  ProductSessionStore,
  ProductTaskValidationError,
  productSurfaces,
  validatedProductTask,
  type ProductTask,
} from "./product-session";
import {
  WorkbenchSessionStore,
  type WorkbenchRunRecord,
  type WorkbenchSessionRecord,
} from "./workbench-session";
import { planProductV1Migration } from "./workbench-migration";
import { projectTrace } from "@anna/trace";
import {
  continuationPrompt,
  decideGoal,
  GOAL_DEFAULT_MAX_RUNS,
  GOAL_MAX_RUNS_LIMIT,
  parsePlan,
  planProgress,
  type GoalRunEvidence,
  type PlanSnapshot,
  type WorkbenchGoalRecord,
} from "./workbench-goal";
import { resolveWorkbenchWorkdir, workdirResourceId } from "./workbench-files";
import { registeredWorkbenchSkills } from "./workbench-skills";
import { sandboxSupport } from "./workbench-sandbox";
import type { McpManager } from "./workbench-mcp";
import { assertNoDuplicateJsonKeys, decideAssignee, validateAssigneeDecisionInput, type AssigneeDecisionInput, type JevTelemetryRecord, type JevTransport } from "./jev-decision";

const maxJsonBodyBytes = 1_024 * 1_024;
const terminalEvents = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "run.awaiting_input",
  "run.awaiting_approval",
]);

const businessPrefixes = [
  "/api/session",
  "/api/auth",
  "/api/crew",
  "/api/cowork/hiker/dashboard",
  "/api/cowork/reimbursements",
  "/api/associate",
  "/api/workdirs",
  "/api/admin",
] as const;

export interface ProductHostOptions {
  readonly runtime: HarnessV2Runtime;
  readonly eventStore: EventStore;
  readonly host?: string;
  readonly port?: number;
  readonly staticRoot?: string;
  readonly runtimeConfigPath?: string;
  readonly serviceToken: string;
  readonly sessionStore?: ProductSessionStore;
  readonly sessionStorePath?: string;
  readonly workbenchSessionStore?: WorkbenchSessionStore;
  readonly workbenchSessionStorePath?: string;
  readonly protectedPaths?: readonly string[];
  readonly businessOrigin?: string;
  readonly businessServiceToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly jevTransport?: JevTransport;
  readonly jevTelemetry?: (record: JevTelemetryRecord) => void;
  /** How often the Host checks active Session Goals for a settled Run. */
  readonly goalSupervisorIntervalMs?: number;
  /** Host MCP client, reported to the UI so permission prompts can name external write tools. */
  readonly mcp?: McpManager;
  /**
   * Default true: at start, Workbench Runs an earlier process left queued/running are
   * settled as `process_restarted` (the product has no Workbench resume route). Only a
   * composition that resumes such Runs explicitly through the harness `/v2` resume
   * route (kernel restore tests) turns this off.
   */
  readonly settleInterruptedRunsOnStart?: boolean;
}

export interface RunningProductHost {
  readonly url: string;
  close(): Promise<void>;
}

export class ProductHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ProductHttpError";
  }
}

export async function startProductHost(options: ProductHostOptions): Promise<RunningProductHost> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("Anna Product Host must bind to a loopback host");
  if (typeof options.serviceToken !== "string" || options.serviceToken.trim() === "") {
    throw new Error("Product Host service token is required");
  }
  const staticRoot = resolve(options.staticRoot ?? resolve(import.meta.dirname, "../../../dist"));
  const sessions = options.sessionStore ?? new ProductSessionStore(options.sessionStorePath);
  const workbenchSessions = options.workbenchSessionStore ?? new WorkbenchSessionStore(
    options.workbenchSessionStorePath
      ?? (options.sessionStore?.path === undefined
        ? options.sessionStorePath === undefined ? undefined : `${options.sessionStorePath}.v2.json`
        : `${options.sessionStore.path}.v2.json`),
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  if (options.businessOrigin !== undefined) {
    const parsedBusinessOrigin = new URL(options.businessOrigin);
    if (!['http:', 'https:'].includes(parsedBusinessOrigin.protocol) || !isLoopbackHost(parsedBusinessOrigin.hostname)) {
      throw new Error("Product business adapter must use a loopback HTTP(S) origin");
    }
  }
  const originHost = host === "::1" ? "[::1]" : host;
  let origin = "";
  let closed = false;
  const activeJevRequests = new Set<AbortController>();

  const workdirProtectedPaths = (): readonly string[] => [
    options.runtimeConfigPath,
    options.sessionStorePath,
    sessions.taskSnapshotPath,
    workbenchSessions.path,
    ...parseProtectedPaths(process.env.ANNA_HARNESS_PROTECTED_PATHS),
    ...parseProtectedPaths(process.env.ANNA_HARNESS_HOST_CONFIG_PATH),
    ...parseProtectedPaths(process.env.ANNA_HARNESS_HOST_EVENT_STORE_PATH),
    ...parseProtectedPaths(process.env.ANNA_HARNESS_SESSION_STORE_PATH),
    ...(options.protectedPaths ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "");

  // Session Goal supervision state (functions are declared below).
  const goalLocks = new Map<string, Promise<unknown>>();
  let supervising = false;
  const goalSupervisor = setInterval(() => {
    if (supervising || closed) return;
    supervising = true;
    void (async () => {
      for (const session of await workbenchSessions.listSessionsWithGoalStatus("active")) {
        if (closed) break;
        await advanceGoal(session.session_id).catch(() => undefined);
      }
    })().catch(() => undefined).finally(() => { supervising = false; });
  }, options.goalSupervisorIntervalMs ?? 1_000);
  goalSupervisor.unref?.();

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof ProductHttpError) {
        responseJson(response, error.statusCode, { code: error.code });
        return;
      }
      if (error instanceof ProductTaskValidationError) {
        responseJson(response, 400, { code: error.code, message: error.message });
        return;
      }
      if (error instanceof JsonBodyError) {
        responseJson(response, 400, { code: error.code });
        return;
      }
      responseJson(response, 500, { code: "product_host_internal_error" });
    });
  });

  // A Run that an earlier Host process left queued/running can never finish on its
  // own. Settle those before accepting requests (so no new Run can be mistaken for
  // one), letting their Sessions show a terminal state and their Goals settle.
  await settleInterruptedWorkbenchRuns();

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Product Host did not bind a TCP address");
  origin = `http://${originHost}:${address.port}`;

  let closePromise: Promise<void> | undefined;
  return {
    url: origin,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      clearInterval(goalSupervisor);
      for (const controller of activeJevRequests) controller.abort();
      closePromise = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      return closePromise;
    },
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closed) throw new ProductHttpError(503, "product_host_closed");
    const requestUrl = new URL(request.url ?? "/", "http://anna.local");
    const pathname = requestUrl.pathname;

    if (request.method === "GET" && pathname === "/health") {
      responseJson(response, 200, { status: "ok", protocol: "anna-harness-product/1", host: "node" });
      return;
    }
    if (pathname.startsWith("/_harness/")) {
      await handleHarnessRequest(request, response, pathname, requestUrl.searchParams);
      return;
    }
    if (pathname === "/api/workbench/migrations/product-v1" || pathname === "/api/workbench/tools"
      || pathname === "/api/workbench/sessions" || pathname.startsWith("/api/workbench/sessions/")
      || pathname === "/api/workbench/runs" || pathname.startsWith("/api/workbench/runs/")) {
      await handleWorkbenchRequest(request, response, pathname, requestUrl.searchParams);
      return;
    }
    if (shouldProxyProductRoute(pathname)) {
      await proxyBusiness(request, response, pathname, requestUrl.search);
      return;
    }
    if (request.method === "GET" && pathname === "/api/health") {
      responseJson(response, 200, { status: "ok" });
      return;
    }
    if (isHostRuntimeRoute(pathname)) {
      await handleHostRuntimeRoute(request, response, pathname);
      return;
    }
    if (shouldProxyBusiness(pathname)) {
      await proxyBusiness(request, response, pathname, requestUrl.search);
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      responseJson(response, 404, { code: "not_found" });
      return;
    }
    if (pathname === "/v2" || pathname.startsWith("/v2/")) {
      // Never answer an API path with the SPA document: the review inspector
      // must see an explicit JSON error, not parse HTML.
      responseJson(response, 404, { code: "review_api_not_served_by_product_host" });
      return;
    }
    if (request.method === "GET") {
      await serveStatic(response, staticRoot, pathname);
      return;
    }
    responseJson(response, 404, { code: "not_found" });
  }

  async function handleHarnessRequest(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (pathname === "/_harness/crew/assignee-decision" && request.method === "POST"
      && !hasServiceToken(request, options.serviceToken)) {
      sendJevTerminalAndClose(response, 401, "service_token_required");
      return;
    }
    assertServiceToken(request, options.serviceToken);
    if (pathname === "/_harness/capabilities" && request.method === "GET") {
      responseJson(response, 200, {
        protocol: "anna-harness-product/1",
        host: "node",
        surfaces: [...productSurfaces],
        business_adapter: options.businessOrigin === undefined ? "unconfigured" : "configured",
      });
      return;
    }
    if (pathname === "/_harness/crew/assignee-decision" && request.method === "POST") {
      await handleJevDecision(request, response);
      return;
    }
    if (pathname === "/_harness/runs" && request.method === "POST") {
      const task = validatedProductTask(await readJsonBody(request));
      const started = await startTask(task);
      responseJson(response, 202, { run_id: task.run_id, status: started });
      return;
    }
    const runMatch = pathname.match(/^\/_harness\/runs\/([^/]+)(?:\/(events|stop|continue|signal))?$/);
    if (runMatch === null) {
      responseJson(response, 404, { code: "not_found" });
      return;
    }
    const runId = decodeSegment(runMatch[1]);
    if (runMatch[2] === "events" && request.method === "GET") {
      if ((request.headers.accept ?? "").includes("text/event-stream")) {
        await streamCanonicalEvents(request, response, runId, query);
      } else {
        const session = await sessions.get(runId);
        if (session === undefined) throw new ProductHttpError(404, "run_not_found");
        const afterSeq = parseCursor(query.get("after_seq"));
        const events = (await readTaskEvents(session.task)).filter((event) => event.seq > afterSeq);
        responseJson(response, 200, { run_id: runId, events });
      }
      return;
    }
    if (runMatch[2] === "stop" && request.method === "POST") {
      await stopTask(request, response, runId);
      return;
    }
    if (runMatch[2] === "continue" && request.method === "POST") {
      await continueTask(request, response, runId);
      return;
    }
    if (runMatch[2] === "signal" && request.method === "POST") {
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["kind", "payload"]);
      await signalTask(response, runId, body);
      return;
    }
    if (runMatch[2] === undefined && request.method === "GET") {
      const detail = await readProductRun(runId);
      if (detail === undefined) throw new ProductHttpError(404, "run_not_found");
      responseJson(response, 200, {
        run_id: runId,
        status: detail.status,
        ...(detail.result === undefined ? {} : { result: detail.result }),
        events: detail.events,
      });
      return;
    }
    responseJson(response, 404, { code: "not_found" });
  }

  async function handleJevDecision(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (activeJevRequests.size >= 4) {
      sendJevTerminalAndClose(response, 429, "jev_busy");
      return;
    }
    const controller = new AbortController();
    activeJevRequests.add(controller);
    const startedAt = new Date().toISOString();
    let deadline = false;
    let disconnected = false;
    const timer = setTimeout(() => {
      deadline = true;
      controller.abort();
      request.resume();
    }, 4_000);
    const abortRequest = () => {
      disconnected = true;
      controller.abort();
    };
    request.once("aborted", abortRequest);
    response.once("close", abortRequest);
    try {
      const declaredLength = request.headers["content-length"];
      if (typeof declaredLength === "string" && Number(declaredLength) > 32 * 1024) {
        sendJevTerminalAndClose(response, 413, "input_too_large");
        return;
      }
      let input: AssigneeDecisionInput;
      let bodyTooLarge = false;
      try {
        input = await abortable(readJsonBody(request, 32 * 1024, true, () => { bodyTooLarge = true; }), controller.signal) as AssigneeDecisionInput;
      } catch (error) {
        if (deadline) {
          sendJevTerminalAndClose(response, 408, "jev_timeout");
          return;
        }
        if (closed) {
          request.resume();
          sendJevTerminalAndClose(response, 503, "product_host_closed");
          return;
        }
        if (bodyTooLarge) {
          request.resume();
          sendJevTerminalAndClose(response, 413, "input_too_large");
          return;
        }
        if (error instanceof JsonBodyError && error.code === "body_too_large") {
          throw new ProductHttpError(413, "input_too_large");
        }
        if (error instanceof Error && error.message === "body_too_large") {
          throw new ProductHttpError(413, "input_too_large");
        }
        throw new ProductHttpError(400, "invalid_request");
      }
      try {
        validateAssigneeDecisionInput(input);
      } catch (error) {
        if (error instanceof Error && error.message === "input_too_large") {
          sendJevTerminalAndClose(response, 413, "input_too_large");
          return;
        }
        throw new ProductHttpError(400, "invalid_request");
      }
      const result = await decideAssignee(input, {
        enabled: process.env.ANNA_JEV_ENABLED,
        apiKeyFile: process.env.ANNA_JEV_API_KEY_FILE,
        transport: options.jevTransport,
        signal: controller.signal,
        startedAt,
        telemetry: options.jevTelemetry,
      });
      if (closed) {
        sendJevTerminalAndClose(response, 503, "product_host_closed");
        return;
      }
      if (!disconnected && !response.destroyed) responseJson(response, 200, result);
    } finally {
      clearTimeout(timer);
      request.off("aborted", abortRequest);
      response.off("close", abortRequest);
      activeJevRequests.delete(controller);
    }
  }

  function sendJevTerminalAndClose(response: ServerResponse, statusCode: number, code: string): void {
    if (response.destroyed) return;
    const socket = response.socket;
    response.setHeader("connection", "close");
    response.once("finish", () => socket?.destroy());
    responseJson(response, statusCode, { code });
  }

  async function handleHostRuntimeRoute(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const hostConfig = await readProductConfig(options.runtimeConfigPath);
    if (pathname === "/api/admin/runtime/status" && request.method === "GET") {
      const business = await fetchBusinessJson(request, "/api/admin/runtime/status", "");
      const businessStatus = isRecord(business) ? business : {};
      const businessConfig = isRecord(businessStatus.config) ? businessStatus.config : {};
      responseJson(response, 200, {
        ...businessStatus,
        model: productModelStatus(hostConfig),
        config: {
          ...businessConfig,
          runtime_config_path: options.runtimeConfigPath,
          model_endpoint_configured: typeof hostConfig.model_endpoint === "string" && hostConfig.model_endpoint.trim() !== "",
          model_api_key_configured: typeof hostConfig.model_api_key === "string" && hostConfig.model_api_key.trim() !== "",
        },
      });
      return;
    }
    if (pathname === "/api/admin/runtime/config" && request.method === "GET") {
      const business = await fetchBusinessJson(request, pathname, "");
      responseJson(response, 200, publicProductConfig(
        options.runtimeConfigPath,
        hostConfig,
        isRecord(business) ? business : undefined,
      ));
      return;
    }
    if (pathname === "/api/admin/runtime/config" && request.method === "PUT") {
      const body = asRecord(await readJsonBody(request));
      const hostPatch: ProductConfig = {};
      const businessPatch: ProductConfig = {};
      for (const [key, value] of Object.entries(body)) {
        if (modelConfigKeys.has(key)) hostPatch[key] = value;
        else businessPatch[key] = value;
      }
      validateHostConfigPatch(hostPatch);
      if (Object.keys(hostPatch).length > 0) await writeProductConfig(options.runtimeConfigPath, hostPatch);
      if (Object.keys(businessPatch).length > 0) {
        await putBusinessJson(request, pathname, businessPatch);
      }
      const nextHost = await readProductConfig(options.runtimeConfigPath);
      const business = await fetchBusinessJson(request, pathname, "");
      responseJson(response, 200, publicProductConfig(
        options.runtimeConfigPath,
        nextHost,
        isRecord(business) ? business : undefined,
      ));
      return;
    }
    const profileId = pathname.match(/^\/api\/admin\/runtime\/model-profiles\/([^/]+)$/);
    if (pathname === "/api/admin/runtime/model-profiles" && request.method === "POST") {
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["id", "label", "provider", "endpoint", "model_name", "api_key"]);
      const id = requiredSettingString(body.id, "id");
      if (id === "default") throw new ProductHttpError(422, "invalid_profile_id");
      const endpoint = requiredSettingString(body.endpoint, "endpoint");
      assertSafeModelEndpoint(endpoint);
      const modelName = requiredSettingString(body.model_name, "model_name");
      const current = await readProductConfig(options.runtimeConfigPath);
      const profiles = Array.isArray(current.model_profiles) ? current.model_profiles.filter(isRecord) : [];
      if (profiles.some((profile) => profile.id === id)) throw new ProductHttpError(409, "profile_id_exists");
      profiles.push({
        id,
        label: typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : modelName,
        provider: typeof body.provider === "string" && body.provider.trim() !== "" ? body.provider.trim() : "openai-compatible",
        endpoint,
        model_name: modelName,
        ...(typeof body.api_key === "string" && body.api_key.trim() !== "" ? { api_key: body.api_key } : {}),
      });
      await writeProductConfig(options.runtimeConfigPath, { model_profiles: profiles });
      responseJson(response, 200, publicProductConfig(options.runtimeConfigPath, await readProductConfig(options.runtimeConfigPath)));
      return;
    }
    if (profileId !== null && request.method === "DELETE") {
      const id = decodeSegment(profileId[1]);
      const current = await readProductConfig(options.runtimeConfigPath);
      const profiles = Array.isArray(current.model_profiles) ? current.model_profiles.filter(isRecord) : [];
      const remaining = profiles.filter((profile) => profile.id !== id);
      if (remaining.length === profiles.length) throw new ProductHttpError(404, "profile_not_found");
      await writeProductConfig(options.runtimeConfigPath, { model_profiles: remaining });
      responseJson(response, 200, publicProductConfig(options.runtimeConfigPath, await readProductConfig(options.runtimeConfigPath)));
      return;
    }
    if (pathname === "/api/admin/runtime/validate" && request.method === "POST") {
      const model = productModelStatus(hostConfig);
      if (model.configured !== true) throw new ProductHttpError(409, "model_not_configured");
      responseJson(response, 200, {
        status: "configured",
        model,
        kernel: "omp",
      });
      return;
    }
    responseJson(response, 404, { code: "not_found" });
  }

  async function handleWorkbenchRequest(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (pathname === "/api/workbench/migrations/product-v1" && request.method === "POST") {
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["dry_run"]);
      if (typeof body.dry_run !== "boolean") throw new ProductHttpError(400, "invalid_dry_run");
      const scope = await resolveWorkbenchScope(request);
      let plan;
      try {
        const source = await sessions.readSourceStrict();
        plan = await planProductV1Migration(source, scope, async (projectId) => {
          try {
            return await resolveWorkbenchScope(request, projectId);
          } catch (error) {
            if (error instanceof ProductHttpError && error.statusCode === 404) return undefined;
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof ProductHttpError) throw error;
        if (error instanceof Error && error.message.startsWith("migration_")) {
          throw new ProductHttpError(409, "migration_conflict");
        }
        throw new ProductHttpError(422, "migration_source_invalid");
      }
      let sessionsAdded: number;
      let runsAdded: number;
      try {
        if (body.dry_run) {
          const preview = await workbenchSessions.previewMigration(plan);
          sessionsAdded = preview.sessions_added;
          runsAdded = preview.runs_added;
        } else {
          const applied = await workbenchSessions.applyMigration(plan);
          sessionsAdded = applied.sessions_added;
          runsAdded = applied.runs_added;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("migration_")) {
          throw new ProductHttpError(409, "migration_conflict");
        }
        throw error;
      }
      responseJson(response, 200, {
        schema_version: 2,
        dry_run: body.dry_run,
        scope_source_sha256: plan.scope_source_sha256,
        scope_source_bytes: plan.scope_source_bytes,
        matched_records: plan.matched_records,
        sessions_added: sessionsAdded,
        runs_added: runsAdded,
        sessions: plan.sessions.map((session) => ({
          session_id: session.session_id,
          channel_id: session.channel_id,
          surface: session.surface,
          ...(session.project_id === undefined ? {} : { project_id: session.project_id }),
          created_at: session.created_at,
          updated_at: session.updated_at,
        })),
        runs: plan.runs.map((run) => ({
          run_id: run.run_id,
          session_id: run.session_id,
          source_event_id: run.source_event_id,
          ...(run.source_event_derived === undefined ? {} : { source_event_derived: run.source_event_derived }),
          conversation_id: run.conversation_id,
          created_at: run.created_at,
          updated_at: run.updated_at,
        })),
      });
      return;
    }
    if (pathname === "/api/workbench/tools" && request.method === "GET") {
      await resolveWorkbenchScope(request);
      const support = sandboxSupport();
      const tools = options.mcp?.tools() ?? [];
      responseJson(response, 200, {
        sandbox: support.available
          ? { available: true, kind: "macos-seatbelt", network: "denied" }
          : { available: false, reason: support.reason },
        mcp_servers: (options.mcp?.status() ?? []).map((server) => ({
          server_id: server.server_id,
          state: server.state,
          transport: server.transport,
          tool_count: server.tool_count,
          ...(server.error === undefined ? {} : { error: server.error }),
          tools: tools.filter((tool) => tool.server_id === server.server_id)
            .map((tool) => ({ capability_id: tool.capability_id, tool_name: tool.tool_name, read_only: tool.read_only })),
        })),
      });
      return;
    }
    if (pathname === "/api/workbench/sessions" && request.method === "POST") {
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["project_id", "surface"]);
      const surface = body.surface === undefined ? "chat" : requiredSurface(body.surface);
      const projectId = optionalId(body.project_id, "project_id");
      const scope = await resolveWorkbenchScope(request, projectId);
      const timestamp = now();
      const session: WorkbenchSessionRecord = {
        schema_version: 2,
        session_id: randomUUID(),
        workspace_id: scope.workspace_id,
        actor_user_id: scope.actor_user_id,
        channel_id: scope.channel_id,
        surface,
        created_at: timestamp,
        updated_at: timestamp,
        ...(projectId === undefined ? {} : { project_id: projectId }),
      };
      await workbenchSessions.createSession(session);
      responseJson(response, 201, await workbenchSessionProjection(session));
      return;
    }
    if (pathname === "/api/workbench/sessions" && request.method === "GET") {
      const projectId = optionalId(query.get("project_id"), "project_id");
      const scope = await resolveWorkbenchScope(request, projectId);
      const records = await workbenchSessions.listSessions({
        workspace_id: scope.workspace_id,
        actor_user_id: scope.actor_user_id,
        ...(projectId === undefined ? {} : { project_id: projectId }),
      });
      const visibleRecords: WorkbenchSessionRecord[] = [];
      for (const session of records) {
        if (session.project_id === undefined) {
          visibleRecords.push(session);
          continue;
        }
        try {
          const projectScope = await resolveWorkbenchScope(request, session.project_id);
          if (projectScope.workspace_id === session.workspace_id
            && projectScope.actor_user_id === session.actor_user_id
            && projectScope.project_id === session.project_id) {
            visibleRecords.push(session);
          }
        } catch (error) {
          if (error instanceof ProductHttpError && error.statusCode === 404) continue;
          throw error;
        }
      }
      responseJson(response, 200, {
        sessions: await Promise.all(visibleRecords.map((session) => workbenchSessionProjection(session))),
      });
      return;
    }
    const sessionMatch = pathname.match(/^\/api\/workbench\/sessions\/([^/]+)$/);
    if (sessionMatch !== null && request.method === "GET") {
      const scope = await resolveWorkbenchScope(request);
      const session = await workbenchSessions.getSession(decodeSegment(sessionMatch[1]));
      if (session === undefined) throw new ProductHttpError(404, "session_not_found");
      await authorizeWorkbenchSession(request, session, scope);
      responseJson(response, 200, await workbenchSessionProjection(session));
      return;
    }
    const sessionRunsMatch = pathname.match(/^\/api\/workbench\/sessions\/([^/]+)\/runs$/);
    if (sessionRunsMatch !== null && request.method === "POST") {
      const scope = await resolveWorkbenchScope(request);
      const session = await workbenchSessions.getSession(decodeSegment(sessionRunsMatch[1]));
      if (session === undefined) throw new ProductHttpError(404, "session_not_found");
      const authorizedScope = await authorizeWorkbenchSession(request, session, scope);
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, [
        "prompt", "source_event_id", "surface", "parent_run_id", "resource_refs", "requested_artifact",
        "skill_id", "agent_id", "model_profile_id", "permission_mode",
      ]);
      const prompt = requiredSettingString(body.prompt, "prompt");
      const sourceEventId = requiredSettingString(body.source_event_id, "source_event_id");
      const surface = body.surface === undefined ? session.surface : requiredSurface(body.surface);
      const parentRunId = optionalId(body.parent_run_id, "parent_run_id");
      const resourceRefs = body.resource_refs === undefined ? [] : requiredResourceRefs(body.resource_refs);
      try {
        workdirResourceId(resourceRefs);
      } catch {
        throw new ProductHttpError(422, "resource_refs_not_supported");
      }
      const requestedArtifact = requestedArtifactKind(body.requested_artifact);
      const permissionMode = requestedPermissionMode(body.permission_mode, resourceRefs);
      const requestedSkillId = optionalId(body.skill_id, "skill_id");
      const skillSource = requestedSkillId === undefined
        ? undefined
        : registeredWorkbenchSkills.find((skill) => {
            const canonical = skill.id.slice("skill:".length);
            return skill.id === requestedSkillId
              || canonical === requestedSkillId
              || canonical.replaceAll("/", "-") === requestedSkillId;
          });
      const skillId = skillSource?.id;
      const agentId = optionalId(body.agent_id, "agent_id");
      const modelProfileId = optionalId(body.model_profile_id, "model_profile_id");
      if (requestedSkillId !== undefined && skillSource === undefined) {
        throw new ProductHttpError(409, "skill_not_registered");
      }
      if (modelProfileId !== undefined && modelProfileId !== "default") {
        const config = await readProductConfig(options.runtimeConfigPath);
        const profiles = Array.isArray(config.model_profiles) ? config.model_profiles.filter(isRecord) : [];
        if (!profiles.some((profile) => profile.id === modelProfileId)) {
          throw new ProductHttpError(409, "model_profile_unavailable");
        }
      }
      if (parentRunId !== undefined) {
        const parent = await workbenchSessions.getRun(parentRunId);
        if (parent === undefined || parent.session_id !== session.session_id) {
          throw new ProductHttpError(404, "parent_run_not_found");
        }
      }
      const timestamp = now();
      const run: WorkbenchRunRecord = {
        schema_version: 2,
        run_id: randomUUID(),
        session_id: session.session_id,
        workspace_id: authorizedScope.workspace_id,
        actor_user_id: authorizedScope.actor_user_id,
        channel_id: session.channel_id,
        surface,
        prompt,
        source_event_id: sourceEventId,
        resource_refs: resourceRefs,
        conversation_id: session.session_id,
        created_at: timestamp,
        updated_at: timestamp,
        admission_status: "pending",
        ...(session.project_id === undefined ? {} : { project_id: session.project_id }),
        ...(parentRunId === undefined ? {} : { parent_run_id: parentRunId }),
        ...(skillId === undefined ? {} : { skill_id: skillId }),
        ...(agentId === undefined ? {} : { agent_id: agentId }),
        ...(modelProfileId === undefined ? {} : { model_profile_id: modelProfileId }),
        ...(requestedArtifact === undefined ? {} : { requested_artifact: requestedArtifact }),
        ...(permissionMode === "contained-write" ? { permission_mode: permissionMode } : {}),
      };
      const lookup = await workbenchSessions.createOrGetRun(run);
      if (lookup.kind === "conflict") throw new ProductHttpError(409, "run_conflict");
      if (lookup.kind === "existing") {
        const canonical = await readWorkbenchEvents(lookup.run, productTaskForWorkbenchRun(lookup.run));
        if (canonical.canonical) {
          responseJson(response, 202, {
            schema_version: 2,
            run_id: lookup.run.run_id,
            session_id: session.session_id,
            source_event_id: lookup.run.source_event_id,
            status: statusFromEvents(canonical.events),
          });
          return;
        }
        if (lookup.run.admission_status === "failed") {
          throw new ProductHttpError(409, lookup.run.admission_error ?? "run_admission_failed");
        }
        if (lookup.run.admission_status === "pending") {
          const admission = workbenchSessions.waitForRunAdmission(lookup.run.run_id);
          if (admission === undefined) {
            throw new ProductHttpError(409, "run_admission_pending");
          }
          const outcome = await admission;
          if (!outcome.ok) throw new ProductHttpError(outcome.statusCode, outcome.code);
          responseJson(response, 202, {
            schema_version: 2,
            run_id: lookup.run.run_id,
            session_id: session.session_id,
            source_event_id: lookup.run.source_event_id,
            status: "queued",
          });
          return;
        }
      }
      if (lookup.kind === "created") await admitWorkbenchRun(lookup.run);
      const status = lookup.kind === "created"
        ? "queued"
        : (await readWorkbenchRun(lookup.run))?.status ?? "queued";
      responseJson(response, 202, {
        schema_version: 2,
        run_id: lookup.run.run_id,
        session_id: session.session_id,
        source_event_id: lookup.run.source_event_id,
        status,
      });
      return;
    }
    const goalMatch = pathname.match(/^\/api\/workbench\/sessions\/([^/]+)\/goal(?:\/(pause|resume|stop|complete))?$/);
    if (goalMatch !== null && request.method === "POST") {
      const scope = await resolveWorkbenchScope(request);
      const session = await workbenchSessions.getSession(decodeSegment(goalMatch[1]));
      if (session === undefined) throw new ProductHttpError(404, "session_not_found");
      const authorizedScope = await authorizeWorkbenchSession(request, session, scope);
      const body = asRecord(await readJsonBody(request));
      if (goalMatch[2] === undefined) {
        const created = await createGoal(session, authorizedScope, body);
        responseJson(response, created.created ? 201 : 200, { goal: publicGoal(created.goal), run_id: created.runId });
        return;
      }
      const goal = await controlGoal(session.session_id, goalMatch[2] as "pause" | "resume" | "stop" | "complete", body);
      responseJson(response, 200, { goal: publicGoal(goal.goal), ...(goal.runId === undefined ? {} : { run_id: goal.runId }) });
      return;
    }
    const runControlMatch = pathname.match(/^\/api\/workbench\/runs\/([^/]+)\/(steer|trace)$/);
    if (runControlMatch !== null && (runControlMatch[2] === "steer" ? request.method === "POST" : request.method === "GET")) {
      const scope = await resolveWorkbenchScope(request);
      const run = await workbenchSessions.getRun(decodeSegment(runControlMatch[1]));
      if (run === undefined) throw new ProductHttpError(404, "run_not_found");
      const session = await workbenchSessions.getSession(run.session_id);
      if (session === undefined) throw new ProductHttpError(404, "run_not_found");
      try {
        await authorizeWorkbenchSession(request, session, scope);
      } catch (error) {
        if (error instanceof ProductHttpError && error.statusCode === 401) throw error;
        throw new ProductHttpError(404, "run_not_found");
      }
      const detail = await readWorkbenchRun(run);
      if (runControlMatch[2] === "trace") {
        responseJson(response, 200, projectTrace(detail?.events ?? [], {
          runId: run.run_id,
          surface: run.surface,
          scope: { workspaceId: run.workspace_id, channelId: run.channel_id } as ChannelScope,
          conversationId: run.session_id,
        }));
        return;
      }
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["text"]);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text === "" || text.length > 8_000) throw new ProductHttpError(400, "invalid_steer_text");
      const status = detail?.status ?? "queued";
      if (terminalEvents.has(`run.${status}`)) {
        responseJson(response, 202, { run_id: run.run_id, status, accepted: false });
        return;
      }
      if (options.runtime.steer === undefined) throw new ProductHttpError(409, "harness_signal_unavailable");
      // OMP consumes a steer at its next turn boundary; acknowledge delivery
      // without holding the request open for the whole model turn.
      const delivery = options.runtime.steer(run.workspace_id, run.channel_id, run.run_id, text)
        .then(() => "consumed" as const, () => "rejected" as const);
      const outcome = await Promise.race([delivery, new Promise<"pending">((resolvePending) => setTimeout(() => resolvePending("pending"), 1_500))]);
      if (outcome === "rejected") throw new ProductHttpError(409, "harness_signal_unavailable");
      responseJson(response, 202, { run_id: run.run_id, status, accepted: true, consumed: outcome === "consumed" });
      return;
    }
    const runStopMatch = pathname.match(/^\/api\/workbench\/runs\/([^/]+)\/stop$/);
    if (runStopMatch !== null && request.method === "POST") {
      const scope = await resolveWorkbenchScope(request);
      const run = await workbenchSessions.getRun(decodeSegment(runStopMatch[1]));
      if (run === undefined) throw new ProductHttpError(404, "run_not_found");
      const session = await workbenchSessions.getSession(run.session_id);
      if (session === undefined) throw new ProductHttpError(404, "run_not_found");
      await authorizeWorkbenchSession(request, session, scope);
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["reason"]);
      if (body.reason !== undefined && typeof body.reason !== "string") {
        throw new ProductHttpError(400, "invalid_stop_request");
      }
      if (options.runtime.stop === undefined) {
        throw new ProductHttpError(503, "harness_control_unavailable");
      }
      const reason = typeof body.reason === "string" && body.reason.trim() !== ""
        ? body.reason
        : "Stopped by user";
      const result = await options.runtime.stop(
        run.workspace_id,
        run.channel_id,
        run.run_id,
        reason,
      );
      const detail = await readWorkbenchRun(run);
      responseJson(response, 202, {
        run_id: run.run_id,
        status: result?.status ?? detail?.status ?? "cancelled",
      });
      return;
    }
    const runMatch = pathname.match(/^\/api\/workbench\/runs\/([^/]+)(?:\/events)?$/);
    if (runMatch !== null && request.method === "GET") {
      await resolveWorkbenchScope(request);
      const run = await workbenchSessions.getRun(decodeSegment(runMatch[1]));
      if (run === undefined) throw new ProductHttpError(404, "run_not_found");
      const session = await workbenchSessions.getSession(run.session_id);
      if (session === undefined) throw new ProductHttpError(404, "run_not_found");
      try {
        await authorizeWorkbenchSession(request, session);
      } catch (error) {
        if (error instanceof ProductHttpError && error.statusCode === 401) throw error;
        throw new ProductHttpError(404, "run_not_found");
      }
      const detail = await readWorkbenchRun(run);
      if (detail === undefined) throw new ProductHttpError(404, "run_not_found");
      if (pathname.endsWith("/events")) {
        const afterSeq = parseCursor(query.get("after_seq"));
        responseJson(response, 200, {
          run_id: run.run_id,
          events: detail.events.filter((event) => event.seq > afterSeq).map(publicWorkbenchEvent),
          watermark: watermarkFor(detail.events, run.run_id),
        });
      } else {
        responseJson(response, 200, publicWorkbenchRun(run, detail, options.runtime.liveOutput?.(run.run_id)));
      }
      return;
    }
    responseJson(response, 404, { code: "not_found" });
  }

  async function resolveWorkbenchScope(
    request: IncomingMessage,
    projectId?: string,
  ): Promise<{ workspace_id: string; actor_user_id: string; channel_id: string; project_id?: string }> {
    if (options.businessOrigin === undefined) throw new ProductHttpError(503, "business_service_unavailable");
    const authorization = request.headers.authorization;
    try {
      const upstream = await fetchImpl(`${options.businessOrigin}/_business/workbench/scope`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(typeof authorization === "string" ? { authorization } : {}),
          ...(options.businessServiceToken === undefined ? {} : { "x-anna-service-token": options.businessServiceToken }),
        },
        body: JSON.stringify(projectId === undefined ? {} : { project_id: projectId }),
      });
      if (!upstream.ok) {
        if (upstream.status === 401) throw new ProductHttpError(401, "authentication_required");
        if (upstream.status === 404 || upstream.status === 403) throw new ProductHttpError(404, "scope_not_found");
        throw new ProductHttpError(503, "business_service_unavailable");
      }
      const body = await upstream.json() as Record<string, unknown>;
      if (typeof body.workspace_id !== "string" || typeof body.actor_user_id !== "string" || typeof body.channel_id !== "string") {
        throw new ProductHttpError(503, "business_scope_invalid");
      }
      return {
        workspace_id: body.workspace_id,
        actor_user_id: body.actor_user_id,
        channel_id: body.channel_id,
        ...(typeof body.project_id === "string" ? { project_id: body.project_id } : {}),
      };
    } catch (error) {
      if (error instanceof ProductHttpError) throw error;
      throw new ProductHttpError(503, "business_service_unavailable");
    }
  }

  async function authorizeWorkbenchSession(
    request: IncomingMessage,
    session: WorkbenchSessionRecord,
    resolvedScope?: { workspace_id: string; actor_user_id: string; channel_id: string; project_id?: string },
  ): Promise<{ workspace_id: string; actor_user_id: string; channel_id: string; project_id?: string }> {
    const scope = resolvedScope ?? await resolveWorkbenchScope(request);
    if (scope.workspace_id !== session.workspace_id || scope.actor_user_id !== session.actor_user_id) {
      throw new ProductHttpError(404, "session_not_found");
    }
    if (session.project_id === undefined) return scope;
    try {
      return await resolveWorkbenchScope(request, session.project_id);
    } catch (error) {
      if (error instanceof ProductHttpError && (error.statusCode === 403 || error.statusCode === 404)) {
        throw new ProductHttpError(404, "session_not_found");
      }
      throw error;
    }
  }

  async function admitWorkbenchRun(run: WorkbenchRunRecord): Promise<void> {
    workbenchSessions.beginRunAdmission(run.run_id);
    try {
      await startWorkbenchRun(run);
      workbenchSessions.completeRunAdmission(run.run_id, { ok: true });
    } catch (error) {
      const failure = error instanceof ProductHttpError
        ? { statusCode: error.statusCode, code: error.code }
        : { statusCode: 503, code: "harness_unavailable" };
      workbenchSessions.completeRunAdmission(run.run_id, { ok: false, ...failure });
      throw error;
    } finally {
      workbenchSessions.endRunAdmission(run.run_id);
    }
  }

  async function settleInterruptedWorkbenchRuns(): Promise<void> {
    const settle = options.runtime.settleInterrupted;
    if (settle === undefined || options.settleInterruptedRunsOnStart === false) return;
    let settled = 0;
    for (const scope of await workbenchSessions.peekRunScopes()) {
      try {
        settled += (await settle(scope.workspace_id, scope.channel_id)).length;
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          type: "workbench.interrupted_runs.settle_failed",
          error: error instanceof Error ? error.message : "unknown",
        })}\n`);
      }
    }
    if (settled > 0) {
      process.stderr.write(`${JSON.stringify({ type: "workbench.interrupted_runs.settled", count: settled })}\n`);
    }
  }

  // ---------------------------------------------------------------- Session Goal

  function withGoalLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = goalLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    goalLocks.set(sessionId, settled);
    void settled.then(() => {
      if (goalLocks.get(sessionId) === settled) goalLocks.delete(sessionId);
    });
    return next;
  }

  async function submitGoalRun(
    session: WorkbenchSessionRecord,
    goal: WorkbenchGoalRecord,
    prompt: string,
    trigger: "user" | "goal_continuation",
  ): Promise<WorkbenchRunRecord> {
    const index = goal.run_ids.length + 1;
    const timestamp = now();
    const candidate: WorkbenchRunRecord = {
      schema_version: 2,
      run_id: randomUUID(),
      session_id: session.session_id,
      workspace_id: session.workspace_id,
      actor_user_id: session.actor_user_id,
      channel_id: session.channel_id,
      surface: session.surface,
      prompt,
      source_event_id: `goal:${goal.goal_id}:${index}`,
      resource_refs: goal.resource_refs,
      conversation_id: session.session_id,
      created_at: timestamp,
      updated_at: timestamp,
      admission_status: "pending",
      goal_id: goal.goal_id,
      trigger,
      ...(session.project_id === undefined ? {} : { project_id: session.project_id }),
      ...(goal.permission_mode === "contained-write" ? { permission_mode: goal.permission_mode } : {}),
    };
    const lookup = await workbenchSessions.createOrGetRun(candidate);
    if (lookup.kind === "conflict") throw new ProductHttpError(409, "run_conflict");
    // Reference the Run from the Goal before admission so a crash cannot orphan it.
    await workbenchSessions.updateSession(session.session_id, (current) => current.goal?.goal_id !== goal.goal_id
      ? current
      : {
          ...current,
          goal: {
            ...current.goal,
            run_ids: current.goal.run_ids.includes(lookup.run.run_id) ? current.goal.run_ids : [...current.goal.run_ids, lookup.run.run_id],
            updated_at: now(),
          },
        });
    if (lookup.kind === "created") {
      // Admission failures are recorded on the Run and settle the Goal on the next tick.
      await admitWorkbenchRun(lookup.run).catch(() => undefined);
    } else {
      const canonical = await readWorkbenchEvents(lookup.run, productTaskForWorkbenchRun(lookup.run));
      if (!canonical.canonical && lookup.run.admission_status !== "failed"
        && workbenchSessions.waitForRunAdmission(lookup.run.run_id) === undefined) {
        await admitWorkbenchRun(lookup.run).catch(() => undefined);
      }
    }
    return lookup.run;
  }

  async function createGoal(
    session: WorkbenchSessionRecord,
    scope: { workspace_id: string; actor_user_id: string },
    body: Record<string, unknown>,
  ): Promise<{ goal: WorkbenchGoalRecord; runId: string; created: boolean }> {
    assertAllowedKeys(body, ["objective", "source_event_id", "max_runs", "permission_mode", "resource_refs"]);
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (objective === "" || objective.length > 8_000) throw new ProductHttpError(400, "invalid_objective");
    const sourceEventId = requiredSettingString(body.source_event_id, "source_event_id");
    const maxRuns = body.max_runs === undefined ? GOAL_DEFAULT_MAX_RUNS : body.max_runs;
    if (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > GOAL_MAX_RUNS_LIMIT) {
      throw new ProductHttpError(400, "invalid_max_runs");
    }
    const resourceRefs = body.resource_refs === undefined ? [] : requiredResourceRefs(body.resource_refs);
    try {
      workdirResourceId(resourceRefs);
    } catch {
      throw new ProductHttpError(422, "resource_refs_not_supported");
    }
    const permissionMode = requestedPermissionMode(body.permission_mode, resourceRefs);
    if (scope.workspace_id !== session.workspace_id || scope.actor_user_id !== session.actor_user_id) {
      throw new ProductHttpError(404, "session_not_found");
    }
    return withGoalLock(session.session_id, async () => {
      const current = await workbenchSessions.getSession(session.session_id);
      if (current === undefined) throw new ProductHttpError(404, "session_not_found");
      if (current.goal?.source_event_id === sourceEventId) {
        return { goal: current.goal, runId: current.goal.run_ids[0] ?? "", created: false };
      }
      if (current.goal !== undefined && ["active", "paused", "awaiting_review"].includes(current.goal.status)) {
        throw new ProductHttpError(409, "goal_already_active");
      }
      const timestamp = now();
      const goal: WorkbenchGoalRecord = {
        goal_id: randomUUID(),
        objective,
        status: "active",
        max_runs: maxRuns,
        run_ids: [],
        permission_mode: permissionMode,
        resource_refs: resourceRefs,
        source_event_id: sourceEventId,
        created_at: timestamp,
        updated_at: timestamp,
      };
      await workbenchSessions.updateSession(current.session_id, (record) => ({ ...record, goal }));
      const run = await submitGoalRun(current, goal, objective, "user");
      const saved = (await workbenchSessions.getSession(current.session_id))?.goal ?? goal;
      return { goal: saved, runId: run.run_id, created: true };
    });
  }

  async function goalEvidence(goal: WorkbenchGoalRecord): Promise<GoalRunEvidence & { latest?: WorkbenchRunRecord }> {
    const latestId = goal.run_ids.at(-1);
    const latest = latestId === undefined ? undefined : await workbenchSessions.getRun(latestId);
    if (latest === undefined) return { hasFinalText: false };
    if (latest.admission_status === "failed") return { latest, admissionError: latest.admission_error ?? "run_admission_failed", hasFinalText: false };
    const detail = await readWorkbenchRun(latest);
    const events = detail?.events ?? [];
    const terminal = events.find((event) => terminalEvents.has(event.type));
    // The plan is cumulative evidence: a continuation that did not touch the
    // plan keeps the previous Run's plan (and so its open items).
    let plan: PlanSnapshot | undefined = planFromEvents(events);
    for (const runId of [...goal.run_ids].reverse().slice(1)) {
      if (plan !== undefined) break;
      const prior = await workbenchSessions.getRun(runId);
      if (prior !== undefined) plan = planFromEvents((await readWorkbenchRun(prior))?.events ?? []);
    }
    const failurePayload = terminal?.type === "run.failed" ? recordValue(terminal.payload) : undefined;
    return {
      latest,
      ...(terminal === undefined ? {} : { terminalStatus: terminal.type.slice("run.".length) }),
      ...(typeof failurePayload?.reason === "string"
        ? { failureReason: failurePayload.reason }
        : typeof failurePayload?.errorType === "string" ? { failureReason: failurePayload.errorType } : {}),
      ...(plan === undefined ? {} : { plan }),
      hasFinalText: messagesForWorkbenchRun(latest, events).some((message) => message.role === "assistant"),
    };
  }

  async function advanceGoal(sessionId: string): Promise<void> {
    await withGoalLock(sessionId, async () => {
      const session = await workbenchSessions.getSession(sessionId);
      const goal = session?.goal;
      if (session === undefined || goal === undefined || goal.status !== "active") return;
      const evidence = await goalEvidence(goal);
      const progress = planProgress(evidence.plan);
      const decision = decideGoal(goal, evidence);
      if (decision.kind === "wait") {
        if (progress !== undefined && (goal.plan_progress?.completed !== progress.completed || goal.plan_progress?.total !== progress.total)) {
          await workbenchSessions.updateSession(sessionId, (record) => record.goal?.goal_id !== goal.goal_id ? record : {
            ...record,
            goal: { ...record.goal, plan_progress: { completed: progress.completed, total: progress.total }, updated_at: now() },
          });
        }
        return;
      }
      const patch: Partial<WorkbenchGoalRecord> = {
        last_reason: decision.reason,
        ...(progress === undefined ? {} : { plan_progress: { completed: progress.completed, total: progress.total } }),
        updated_at: now(),
        ...(decision.kind === "settle" ? { status: decision.status } : {}),
      };
      const updated = await workbenchSessions.updateSession(sessionId, (record) => record.goal?.goal_id !== goal.goal_id ? record : {
        ...record,
        goal: { ...record.goal, ...patch },
      });
      if (decision.kind === "continue" && updated.goal !== undefined) {
        await submitGoalRun(updated, updated.goal, continuationPrompt(updated.goal, evidence.plan, decision.reason), "goal_continuation");
      }
    });
  }

  async function controlGoal(
    sessionId: string,
    action: "pause" | "resume" | "stop" | "complete",
    body: Record<string, unknown>,
  ): Promise<{ goal: WorkbenchGoalRecord; runId?: string }> {
    assertAllowedKeys(body, action === "resume" ? ["max_runs"] : []);
    return withGoalLock(sessionId, async () => {
      const session = await workbenchSessions.getSession(sessionId);
      const goal = session?.goal;
      if (session === undefined || goal === undefined) throw new ProductHttpError(404, "goal_not_found");
      const save = (patch: Partial<WorkbenchGoalRecord>) => workbenchSessions.updateSession(sessionId, (record) => ({
        ...record,
        goal: { ...record.goal!, ...patch, updated_at: now() },
      }));
      if (action === "pause") {
        if (goal.status !== "active") throw new ProductHttpError(409, "goal_not_active");
        return { goal: (await save({ status: "paused", last_reason: "user_paused" })).goal! };
      }
      if (action === "complete") {
        if (goal.status !== "awaiting_review") throw new ProductHttpError(409, "goal_not_awaiting_review");
        return { goal: (await save({ status: "completed", last_reason: "user_confirmed" })).goal! };
      }
      if (action === "stop") {
        if (!["active", "paused", "awaiting_review", "budget_exhausted", "failed"].includes(goal.status)) {
          throw new ProductHttpError(409, "goal_not_stoppable");
        }
        const saved = await save({ status: "stopped", last_reason: "user_stopped" });
        const latest = goal.run_ids.at(-1) === undefined ? undefined : await workbenchSessions.getRun(goal.run_ids.at(-1)!);
        if (latest !== undefined && options.runtime.stop !== undefined) {
          const status = (await readWorkbenchRun(latest))?.status;
          if (status !== undefined && !terminalEvents.has(`run.${status}`) && status !== "not_started") {
            await options.runtime.stop(latest.workspace_id, latest.channel_id, latest.run_id, "Goal stopped by user").catch(() => undefined);
          }
        }
        return { goal: saved.goal! };
      }
      // resume
      if (!["paused", "failed", "budget_exhausted"].includes(goal.status)) throw new ProductHttpError(409, "goal_not_resumable");
      let maxRuns = goal.max_runs;
      if (body.max_runs !== undefined) {
        if (typeof body.max_runs !== "number" || !Number.isInteger(body.max_runs) || body.max_runs < 1 || body.max_runs > GOAL_MAX_RUNS_LIMIT) {
          throw new ProductHttpError(400, "invalid_max_runs");
        }
        maxRuns = body.max_runs;
      }
      if (goal.run_ids.length >= maxRuns) throw new ProductHttpError(409, "goal_budget_exhausted");
      const resumed = await save({ status: "active", max_runs: maxRuns, last_reason: "user_resumed" });
      const evidence = await goalEvidence(resumed.goal!);
      const latestTerminal = evidence.latest === undefined || evidence.admissionError !== undefined || evidence.terminalStatus !== undefined;
      if (!latestTerminal) return { goal: resumed.goal! };
      const run = await submitGoalRun(resumed, resumed.goal!, continuationPrompt(resumed.goal!, evidence.plan, "user_resumed"), "goal_continuation");
      return { goal: (await workbenchSessions.getSession(sessionId))?.goal ?? resumed.goal!, runId: run.run_id };
    });
  }

  async function startWorkbenchRun(run: WorkbenchRunRecord): Promise<void> {
    try {
      const task = await workbenchTaskForRun(run);
      await sessions.save(task, run.created_at);
      await options.runtime.start(run.surface as V2SurfaceId, {
        workspace_id: run.workspace_id,
        channel_id: run.channel_id,
        command_id: `workbench:${run.run_id}`,
        run_id: run.run_id,
        source_event_id: run.source_event_id,
        goal: run.prompt,
      });
      await workbenchSessions.markRunAdmission(run.run_id, "started");
    } catch (error) {
      const failureCode = error instanceof ProductHttpError
        ? error.code
        : error instanceof Error && error.message === "model_not_configured"
          ? "model_not_configured"
          : "run_admission_failed";
      await workbenchSessions.markRunAdmission(run.run_id, "failed", failureCode);
      if (error instanceof Error && error.message === "model_not_configured") {
        throw new ProductHttpError(409, "model_not_configured");
      }
      throw new ProductHttpError(503, "harness_unavailable");
    }
  }

  async function readWorkbenchRun(run: WorkbenchRunRecord): Promise<{
    readonly status: string;
    readonly events: CanonicalEvent[];
    readonly result?: Record<string, unknown>;
  } | undefined> {
    const task = (await sessions.get(run.run_id))?.task ?? productTaskForWorkbenchRun(run);
    const { events, canonical } = await readWorkbenchEvents(run, task);
    const result = resultFromEvents(events, task);
    return {
      status: canonical ? statusFromEvents(events) : "not_started",
      events,
      ...(result === undefined ? {} : { result }),
    };
  }

  async function workbenchTaskForRun(run: WorkbenchRunRecord): Promise<ProductTask> {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    const priorRuns = (await workbenchSessions.listRuns(run.session_id))
      .filter((item) => item.run_id !== run.run_id)
      .filter((item) => item.created_at < run.created_at
        || (item.created_at === run.created_at && item.run_id < run.run_id));
    for (const prior of priorRuns) {
      history.push({ role: "user", content: prior.prompt });
      const priorTask = productTaskForWorkbenchRun(prior);
      const { events } = await readWorkbenchEvents(prior, priorTask);
      for (const event of events) {
        if (event.type !== "omp.transcript.message") continue;
        const message = recordValue(recordValue(event.payload).message);
        if (message.role !== "assistant") continue;
        const content = textFromMessage(message);
        if (content !== undefined) history.push({ role: "assistant", content });
      }
    }
    const base = productTaskForWorkbenchRun(run);
    const goal = run.goal_id === undefined ? undefined : (await workbenchSessions.getSession(run.session_id))?.goal;
    const goalContext = goal === undefined || goal.goal_id !== run.goal_id
      ? undefined
      : {
          goal_id: goal.goal_id,
          objective: goal.objective,
          run_index: Math.max(1, goal.run_ids.indexOf(run.run_id) + 1 || goal.run_ids.length + 1),
          max_runs: goal.max_runs,
        };
    const context = {
      ...(base.context ?? {}),
      ...(history.length === 0 ? {} : { conversation_history: history }),
      ...(goalContext === undefined ? {} : { goal: goalContext }),
    };
    const task: ProductTask = {
      ...base,
      ...(Object.keys(context).length === 0 ? {} : { context }),
    };
    if (options.businessOrigin === undefined) return task;
    try {
      const workdirPath = await resolveWorkbenchWorkdir({
        origin: options.businessOrigin,
        serviceToken: options.businessServiceToken,
        workspaceId: run.workspace_id,
        actorUserId: run.actor_user_id,
        resourceRefs: run.resource_refs,
        fetchImpl,
        protectedPaths: workdirProtectedPaths(),
      });
      return workdirPath === undefined ? task : { ...task, workdir_path: workdirPath };
    } catch (error) {
      if (error instanceof Error && error.message === "workdir_not_found") {
        throw new ProductHttpError(400, "workdir_not_found");
      }
      if (error instanceof Error && error.message === "workdir_protected_path") {
        throw new ProductHttpError(400, "workdir_protected_path");
      }
      throw new ProductHttpError(503, "business_workdir_unavailable");
    }
  }

  async function workbenchSessionProjection(session: WorkbenchSessionRecord): Promise<Record<string, unknown>> {
    const runs = await workbenchSessions.listRuns(session.session_id);
    const details = await Promise.all(runs.map(async (run) => ({ run, detail: await readWorkbenchRun(run) })));
    const messages = details.flatMap((item) => messagesForWorkbenchRun(item.run, item.detail?.events ?? []));
    const { goal, ...record } = session;
    return {
      ...record,
      ...(goal === undefined ? {} : { goal: publicGoal(goal) }),
      runs: details.map((item) => publicWorkbenchRun(item.run, item.detail, options.runtime.liveOutput?.(item.run.run_id))),
      messages,
      watermark: {
        session_id: session.session_id,
        runs: details.map((item) => watermarkFor(item.detail?.events ?? [], item.run.run_id)),
      },
    };
  }

  async function startTask(task: ProductTask): Promise<string> {
    task = await admitTaskWorkdir(validatedProductTask(task));
    task = await withConversationContext(task);
    task = validatedProductTask(task);
    const existing = await sessions.get(task.run_id);
    if (existing !== undefined) {
      if (stableJson(existing.task) !== stableJson(task)) throw new ProductHttpError(409, "run_conflict");
      const detail = await readProductRun(task.run_id);
      return detail?.status ?? "queued";
    }
    await sessions.save(task, now());
    try {
      const result = await options.runtime.start(task.surface as V2SurfaceId, {
        workspace_id: task.workspace_id,
        channel_id: channelIdFor(task),
        command_id: `product:${task.run_id}`,
        run_id: task.run_id,
        source_event_id: task.source_event_id ?? `product:source:${task.run_id}`,
        goal: task.prompt,
      });
      return result.status;
    } catch (error) {
      if (isConflict(error)) throw new ProductHttpError(409, "run_conflict");
      if (error instanceof Error && error.message === "model_not_configured") {
        throw new ProductHttpError(409, "model_not_configured");
      }
      throw new ProductHttpError(503, "harness_unavailable");
    }
  }

  async function admitTaskWorkdir(task: ProductTask): Promise<ProductTask> {
    let workdirPath = task.workdir_path;
    const workdirId = typeof task.context?.workdir_id === "string"
      ? task.context.workdir_id.trim()
      : "";
    if (workdirPath !== undefined) {
      workdirPath = await admitWorkdirPath(workdirPath);
    }
    if (workdirId !== "" && options.businessOrigin !== undefined) {
      try {
        workdirPath = await resolveWorkbenchWorkdir({
          origin: options.businessOrigin,
          serviceToken: options.businessServiceToken,
          workspaceId: task.workspace_id,
          actorUserId: task.actor_user_id,
          resourceRefs: [`workdir:${workdirId}`],
          ...(workdirPath === undefined ? {} : { boundRoot: workdirPath }),
          fetchImpl,
          protectedPaths: workdirProtectedPaths(),
        });
        if (workdirPath === undefined) {
          throw new ProductHttpError(400, "workdir_not_found");
        }
      } catch (error) {
        if (error instanceof ProductHttpError) throw error;
        if (error instanceof Error && (
          error.message === "workdir_not_found"
          || error.message === "workdir_protected_path"
          || error.message === "workdir_binding_changed"
        )) {
          throw new ProductHttpError(400, error.message);
        }
        throw new ProductHttpError(503, "business_workdir_unavailable");
      }
    }
    if (workdirPath === undefined) return task;
    return { ...task, workdir_path: workdirPath };
  }

  async function admitWorkdirPath(input: string): Promise<string> {
    const requested = resolve(input);
    let canonical: string;
    try {
      canonical = await realpath(requested);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error("workdir is not a directory");
    } catch {
      throw new ProductHttpError(400, "workdir_unavailable");
    }
    for (const protectedPath of workdirProtectedPaths()) {
      const protectedCanonical = await canonicalPath(protectedPath);
      if (containsPath(canonical, protectedCanonical) || containsPath(protectedCanonical, canonical)) {
        throw new ProductHttpError(400, "workdir_protected_path");
      }
    }
    return canonical;
  }

  async function withConversationContext(task: ProductTask): Promise<ProductTask> {
    if (task.conversation_id === undefined) return task;
    const prior: Array<{ role: "user" | "assistant"; content: string }> = [];
    const matchingRecords = (await sessions.list()).filter((record) =>
      record.task.run_id !== task.run_id
      && record.task.workspace_id === task.workspace_id
      && record.task.actor_user_id === task.actor_user_id
      && record.task.conversation_id === task.conversation_id
      && channelIdFor(record.task) === channelIdFor(task)
      && record.task.surface === task.surface,
    ).sort((left, right) =>
      left.created_at.localeCompare(right.created_at)
      || left.task.run_id.localeCompare(right.task.run_id),
    );
    for (const record of matchingRecords) {
      const events = await readTaskEvents(record.task);
      prior.push(...conversationHistoryFromEvents(events));
    }
    if (prior.length === 0) return task;
    return {
      ...task,
      context: {
        ...(task.context ?? {}),
        conversation_history: prior.slice(-16),
      },
    };
  }

  async function stopTask(request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> {
    const session = await sessions.get(runId);
    if (session === undefined) throw new ProductHttpError(404, "run_not_found");
    let reason = "Stopped by user";
    if (request.method === "POST") {
      const body = asRecord(await readJsonBody(request));
      assertAllowedKeys(body, ["reason"]);
      if (body.reason !== undefined && typeof body.reason !== "string") throw new ProductHttpError(400, "invalid_stop_request");
      reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason : reason;
    }
    if (options.runtime.stop === undefined) throw new ProductHttpError(503, "harness_control_unavailable");
    const result = await options.runtime.stop(
      session.task.workspace_id,
      channelIdFor(session.task),
      runId,
      reason,
    );
    const detail = await readProductRun(runId);
    responseJson(response, 202, {
      run_id: runId,
      status: result?.status ?? detail?.status ?? "cancelled",
    });
  }

  async function continueTask(request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> {
    assertEmptyObject(await readJsonBody(request));
    const session = await sessions.get(runId);
    if (session === undefined) throw new ProductHttpError(404, "run_not_found");
    const detail = await readProductRun(runId);
    if (detail === undefined) throw new ProductHttpError(404, "run_not_found");
    if (detail.status !== "awaiting_input") {
      responseJson(response, 202, { run_id: runId, status: detail.status });
      return;
    }
    if (options.runtime.resume === undefined) throw new ProductHttpError(409, "continuation_unavailable");
    const result = await options.runtime.resume(session.task.surface as V2SurfaceId, runId, {
      workspace_id: session.task.workspace_id,
      channel_id: channelIdFor(session.task),
    });
    responseJson(response, 202, { run_id: runId, status: result.status });
  }

  async function signalTask(
    response: ServerResponse,
    runId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const session = await sessions.get(runId);
    if (session === undefined) throw new ProductHttpError(404, "run_not_found");
    const kind = body.kind;
    if (kind !== "steer" && kind !== "answer") {
      throw new ProductHttpError(409, "harness_signal_unavailable");
    }
    const payload = asRecord(body.payload);
    const content = typeof payload.text === "string" ? payload.text : payload.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ProductHttpError(400, "invalid_signal_payload");
    }
    const detail = await readProductRun(runId);
    if (detail === undefined) throw new ProductHttpError(404, "run_not_found");
    if (terminalEvents.has(detail.events.at(-1)?.type ?? "")) {
      responseJson(response, 202, { run_id: runId, status: detail.status, accepted: false });
      return;
    }
    const control = kind === "steer" ? options.runtime.steer : options.runtime.answer;
    if (control === undefined) throw new ProductHttpError(409, "harness_signal_unavailable");
    try {
      await control(session.task.workspace_id, channelIdFor(session.task), runId, content);
    } catch {
      throw new ProductHttpError(409, "harness_signal_unavailable");
    }
    responseJson(response, 202, { run_id: runId, status: detail.status, accepted: true });
  }

  async function readProductRun(runId: string): Promise<{
    readonly status: string;
    readonly events: CanonicalEvent[];
    readonly result?: Record<string, unknown>;
  } | undefined> {
    const session = await sessions.get(runId);
    if (session === undefined) return undefined;
    const events = await readTaskEvents(session.task);
    const result = resultFromEvents(events, session.task);
    return {
      status: statusFromEvents(events),
      events,
      ...(result === undefined ? {} : { result }),
    };
  }

  async function readTaskEvents(task: ProductTask): Promise<CanonicalEvent[]> {
    const scope = scopeFor(task);
    if (options.runtime.readEvents !== undefined) {
      return [...await options.runtime.readEvents(task.workspace_id, channelIdFor(task), task.run_id, -1)];
    }
    const events: CanonicalEvent[] = [];
    for await (const event of options.eventStore.scope(scope).read(task.run_id as StreamId)) events.push(event);
    return events;
  }

  async function readWorkbenchEvents(
    run: WorkbenchRunRecord,
    task: ProductTask,
  ): Promise<{ readonly events: CanonicalEvent[]; readonly canonical: boolean }> {
    const command = await options.eventStore.scope(scopeFor(task)).getRunCommand(run.run_id as never);
    if (command === undefined) return { events: [], canonical: false };
    return { events: await readTaskEvents(task), canonical: true };
  }

  async function streamCanonicalEvents(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    query: URLSearchParams,
  ): Promise<void> {
    const session = await sessions.get(runId);
    if (session === undefined) throw new ProductHttpError(404, "run_not_found");
    const cursor = parseCursor(query.get("after_seq"));
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    await pollEvents(request, response, session.task, cursor, (event) => `event: canonical\ndata: ${JSON.stringify(event)}\n\n`);
  }

  async function pollEvents(
    request: IncomingMessage,
    response: ServerResponse,
    task: ProductTask,
    afterSeq: number,
    encode: (event: CanonicalEvent, events: CanonicalEvent[]) => string,
  ): Promise<void> {
    let cursor = afterSeq;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (!response.destroyed) response.end();
    };
    request.once("close", finish);
    const poll = async (): Promise<void> => {
      if (finished) return;
      try {
        const events = await readTaskEvents(task);
        for (const event of events) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          if (!response.destroyed) response.write(encode(event, events));
          if (terminalEvents.has(event.type)) {
            finish();
            return;
          }
        }
        if (terminalEvents.has(events.at(-1)?.type ?? "")) {
          finish();
          return;
        }
        timer = setTimeout(() => void poll(), 50);
      } catch {
        finish();
      }
    };
    await poll();
  }

  async function proxyBusiness(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    search: string,
  ): Promise<void> {
    if (options.businessOrigin === undefined) throw new ProductHttpError(503, "business_service_unavailable");
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readRawBody(request);
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${options.businessOrigin}${pathname}${search}`, {
        method: request.method,
        headers: forwardedHeaders(request, options.businessServiceToken),
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new ProductHttpError(503, "business_service_unavailable");
    }
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(upstream.headers.get("cache-control") === null ? {} : { "cache-control": upstream.headers.get("cache-control")! }),
    });
    if (upstream.body === null) {
      response.end();
      return;
    }
    for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) response.write(chunk);
    response.end();
  }

  async function fetchBusinessJson(
    request: IncomingMessage,
    pathname: string,
    search: string,
  ): Promise<unknown | undefined> {
    if (options.businessOrigin === undefined) return undefined;
    try {
      const upstream = await fetchImpl(`${options.businessOrigin}${pathname}${search}`, {
        method: "GET",
        headers: forwardedHeaders(request, options.businessServiceToken),
      });
      if (!upstream.ok) return undefined;
      return await upstream.json();
    } catch {
      return undefined;
    }
  }

  async function putBusinessJson(
    request: IncomingMessage,
    pathname: string,
    body: ProductConfig,
  ): Promise<void> {
    if (options.businessOrigin === undefined) throw new ProductHttpError(503, "business_service_unavailable");
    try {
      const upstream = await fetchImpl(`${options.businessOrigin}${pathname}`, {
        method: "PUT",
        headers: forwardedHeaders(request, options.businessServiceToken),
        body: JSON.stringify(body),
      });
      if (!upstream.ok) throw new ProductHttpError(upstream.status, "business_config_update_failed");
    } catch (error) {
      if (error instanceof ProductHttpError) throw error;
      throw new ProductHttpError(503, "business_service_unavailable");
    }
  }
}

export const startProductHarnessService = startProductHost;

function productTaskForWorkbenchRun(run: WorkbenchRunRecord): ProductTask {
  return {
    schema_version: 2,
    run_id: run.run_id,
    workspace_id: run.workspace_id,
    actor_user_id: run.actor_user_id,
    surface: run.surface as ProductTask["surface"],
    prompt: run.prompt,
    channel_id: run.channel_id,
    conversation_id: run.conversation_id,
    session_id: run.session_id,
    ...(run.project_id === undefined ? {} : { project_id: run.project_id }),
    ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
    resource_refs: run.resource_refs,
    ...(run.model_profile_id === undefined ? {} : { model_profile_id: run.model_profile_id }),
    ...(run.permission_mode === "contained-write" ? { permission_mode: run.permission_mode } : {}),
    ...((run.skill_id === undefined && run.agent_id === undefined)
      ? {}
      : {
          context: {
            ...(run.skill_id === undefined ? {} : { skill_id: run.skill_id }),
            ...(run.agent_id === undefined ? {} : { agent_id: run.agent_id }),
          },
        }),
    ...(run.requested_artifact === undefined ? {} : { requested_artifact: run.requested_artifact }),
    source_event_id: run.source_event_id,
  };
}

function publicWorkbenchRun(
  run: WorkbenchRunRecord,
  detail: { readonly status: string; readonly events: readonly CanonicalEvent[]; readonly result?: Record<string, unknown> } | undefined,
  live?: { readonly text: string; readonly reasoningChars: number; readonly requestIndex: number; readonly updatedAt: string },
): Record<string, unknown> {
  const events = detail?.events ?? [];
  const activity = runActivity(events);
  const terminal = events.some((event) => terminalEvents.has(event.type));
  // A request's text is persisted when its assistant transcript message exists
  // (one per model request). Hiding live text earlier — at omp.model.response —
  // left a visible gap before the message appeared in the session projection.
  const persistedAssistantMessages = events.filter((event) => event.type === "omp.transcript.message"
    && recordValue(recordValue(event.payload).message).role === "assistant").length;
  const liveOutput = live === undefined || terminal || persistedAssistantMessages >= live.requestIndex
    || (live.text === "" && live.reasoningChars === 0)
    ? undefined
    : { text: live.text, reasoning_chars: live.reasoningChars, request_index: live.requestIndex, updated_at: live.updatedAt };
  return {
    permission_mode: run.permission_mode ?? "readonly",
    ...(run.goal_id === undefined ? {} : { goal_id: run.goal_id }),
    trigger: run.trigger ?? "user",
    ...(liveOutput === undefined ? {} : { live_output: liveOutput }),
    ...(activity.plan === undefined ? {} : { plan: activity.plan }),
    ...(activity.tools.length === 0 ? {} : { tools: activity.tools }),
    ...(activity.sandbox === undefined ? {} : { sandbox: activity.sandbox }),
    ...(activity.usage === undefined ? {} : { usage: activity.usage }),
    schema_version: 2,
    run_id: run.run_id,
    session_id: run.session_id,
    surface: run.surface,
    prompt: run.prompt,
    source_event_id: run.source_event_id,
    ...(run.source_event_derived === undefined ? {} : { source_event_derived: run.source_event_derived }),
    ...(run.conversation_source === undefined ? {} : { conversation_source: run.conversation_source }),
    ...(run.project_id === undefined ? {} : { project_id: run.project_id }),
    ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
    ...(run.skill_id === undefined ? {} : { skill_id: run.skill_id }),
    ...(run.agent_id === undefined ? {} : { agent_id: run.agent_id }),
    ...(run.model_profile_id === undefined ? {} : { model_profile_id: run.model_profile_id }),
    status: detail?.status ?? "queued",
    ...(run.admission_status === undefined ? {} : { admission_status: run.admission_status }),
    ...(run.admission_error === undefined ? {} : { admission_error: run.admission_error }),
    created_at: run.created_at,
    updated_at: run.updated_at,
    ...(detail?.result === undefined ? {} : { result: detail.result }),
    watermark: watermarkFor(detail?.events ?? [], run.run_id),
  };
}

function messagesForWorkbenchRun(
  run: WorkbenchRunRecord,
  events: readonly CanonicalEvent[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{
    run_id: run.run_id,
    event_id: run.source_event_id,
    seq: -1,
    role: "user",
    content: run.prompt,
    source_event_id: run.source_event_id,
  }];
  for (const event of events) {
    if (event.type !== "omp.transcript.message") continue;
    const payload = recordValue(event.payload);
    const message = recordValue(payload.message);
    if (message.role !== "assistant") continue;
    const content = textFromMessage(message);
    if (content === undefined) continue;
    messages.push({
      run_id: run.run_id,
      event_id: event.id,
      seq: event.seq,
      role: "assistant",
      content,
    });
  }
  return messages;
}

function publicWorkbenchEvent(event: CanonicalEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    run_id: event.streamId,
    event_id: event.id,
    type: event.type,
    seq: event.seq,
    timestamp: event.timestamp,
  };
  const payload = isRecord(event.payload) ? event.payload as Record<string, any> : undefined;
  if (event.type === "omp.transcript.message") {
    const message = recordValue(recordValue(event.payload).message);
    if (message.role === "assistant") {
      const content = textFromMessage(message);
      if (content !== undefined) body.message = { role: "assistant", content };
    }
  } else if (event.type.startsWith("run.")) {
    body.status = event.type.slice("run.".length);
    if (event.type === "run.failed" && payload !== undefined) {
      const reason = payload.reason;
      // Runtime-level failures (e.g. `process_restarted`) carry `errorType`.
      const errorCode = payload.error_code ?? payload.errorType;
      if (typeof reason === "string") body.reason = reason;
      if (typeof errorCode === "string") body.error_code = errorCode;
    }
    if (event.type === "run.model.requested" && payload !== undefined) {
      if (Array.isArray(payload.toolDefinitions)) {
        body.tool_definition_names = payload.toolDefinitions
          .filter(isRecord)
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === "string");
      }
      if (Array.isArray(payload.toolDefinitionHashes)) {
        body.tool_definition_hashes = payload.toolDefinitionHashes
          .filter((hash): hash is string => typeof hash === "string");
      }
    }
  } else if (event.type === "capability.loaded" && payload !== undefined) {
    body.catalog_hash = typeof payload.catalogHash === "string" ? payload.catalogHash : undefined;
    body.load_tool_call_id = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    body.load_dispatch_event_id = typeof payload.dispatchEventId === "string" ? payload.dispatchEventId : undefined;
    if (Array.isArray(payload.capabilities)) {
      body.capability_ids = payload.capabilities
        .filter(isRecord)
        .map((capability) => capability.id)
        .filter((id): id is string => typeof id === "string");
      body.capability_hashes = payload.capabilities
        .filter(isRecord)
        .map((capability) => capability.hash)
        .filter((hash): hash is string => typeof hash === "string");
    }
  } else if (event.type === "omp.tool.dispatch" && payload !== undefined) {
    body.tool_name = typeof payload.tool === "string" ? payload.tool : undefined;
    body.input_digest = typeof payload.inputDigest === "string" ? payload.inputDigest : undefined;
  } else if (event.type === "omp.tool.response" && payload !== undefined) {
    const result = isRecord(payload.result) ? payload.result : undefined;
    body.tool_status = typeof result?.status === "string" ? result.status : undefined;
  }
  return body;
}

function requestedPermissionMode(value: unknown, resourceRefs: readonly string[]): "readonly" | "contained-write" {
  if (value === undefined || value === "readonly") return "readonly";
  if (value !== "contained-write") throw new ProductHttpError(400, "invalid_permission_mode");
  if (resourceRefs.length !== 1 || !resourceRefs[0]!.startsWith("workdir:")) {
    throw new ProductHttpError(422, "permission_requires_workdir");
  }
  return "contained-write";
}

function publicGoal(goal: WorkbenchGoalRecord): Record<string, unknown> {
  const { source_event_id: _source, resource_refs: _refs, ...rest } = goal;
  return { ...rest, runs_used: goal.run_ids.length };
}

function planFromEvents(events: readonly CanonicalEvent[]): PlanSnapshot | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "omp.transcript.message") continue;
    const message = recordValue(recordValue(event.payload).message);
    if (message.role !== "toolResult" || message.toolName !== "todo" || message.status === "failed") continue;
    const plan = parsePlan(message.details);
    if (plan !== undefined) return plan;
  }
  return undefined;
}

interface RunActivity {
  readonly plan?: PlanSnapshot & { readonly updated_seq: number };
  readonly tools: Array<Record<string, unknown>>;
  readonly sandbox?: Record<string, unknown>;
  readonly usage?: { input_tokens?: number; output_tokens?: number };
}

/** Host-derived run activity: plan, tool timeline, the sandbox descriptor reported by a real exec, and provider-reported usage. */
function runActivity(events: readonly CanonicalEvent[]): RunActivity {
  const tools = new Map<string, Record<string, unknown>>();
  let plan: RunActivity["plan"];
  let sandbox: Record<string, unknown> | undefined;
  let usage: RunActivity["usage"];
  for (const event of events) {
    const payload = recordValue(event.payload);
    if (event.type === "omp.tool.dispatch" && typeof payload.toolCallId === "string") {
      tools.set(payload.toolCallId, {
        call_id: payload.toolCallId,
        name: typeof payload.tool === "string" ? payload.tool : "unknown",
        status: "running",
        started_at: event.timestamp,
      });
    } else if (event.type === "omp.tool.response" && typeof payload.toolCallId === "string") {
      const entry = tools.get(payload.toolCallId);
      if (entry === undefined) continue;
      const result = recordValue(payload.result);
      const output = recordValue(result.output);
      entry.status = typeof result.status === "string" ? result.status : "unknown";
      entry.ended_at = event.timestamp;
      const summary = toolSummary(String(entry.name), entry.status as string, output);
      if (summary !== undefined) entry.summary = summary;
      if (entry.name === "sandbox.exec" && isRecord(output.sandbox)) sandbox = output.sandbox;
    } else if (event.type === "omp.transcript.message") {
      const message = recordValue(payload.message);
      if (message.role === "toolResult" && message.toolName === "todo" && typeof message.toolCallId === "string") {
        const parsed = parsePlan(message.details);
        if (parsed !== undefined && message.status !== "failed") plan = { ...parsed, updated_seq: event.seq };
        tools.set(message.toolCallId, {
          call_id: message.toolCallId,
          name: "todo",
          status: message.status === "failed" ? "failed" : "succeeded",
          started_at: event.timestamp,
          ended_at: event.timestamp,
          summary: parsed === undefined ? "计划工具" : `计划 ${planProgress(parsed)?.completed ?? 0}/${planProgress(parsed)?.total ?? 0}`,
        });
      }
    } else if (event.type === "run.usage.updated") {
      const cumulative = recordValue(payload.cumulative);
      usage = {
        ...(typeof cumulative.input === "number" ? { input_tokens: cumulative.input } : {}),
        ...(typeof cumulative.output === "number" ? { output_tokens: cumulative.output } : {}),
      };
    }
  }
  return {
    ...(plan === undefined ? {} : { plan }),
    tools: [...tools.values()],
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
  };
}

function toolSummary(name: string, status: string, output: Record<string, any>): string | undefined {
  if (status !== "succeeded" && typeof output.reason === "string") {
    if (name === "sandbox.exec" && typeof output.exit_code === "number") {
      return `exit ${output.exit_code} · ${Math.round(Number(output.duration_ms) || 0)} ms`;
    }
    return output.reason.slice(0, 120);
  }
  if (name === "sandbox.exec") {
    if (output.timed_out === true) return "超时，已终止";
    if (typeof output.exit_code === "number") return `exit ${output.exit_code} · ${Math.round(Number(output.duration_ms) || 0)} ms`;
  }
  if ((name === "workdir.write_file" || name === "workdir.edit_file") && typeof output.path === "string") {
    return `${name === "workdir.write_file" ? (output.created === false ? "覆盖" : "写入") : "修改"} ${output.path}${typeof output.bytes === "number" ? ` (${output.bytes} B)` : ""}`;
  }
  if (name === "workdir.read_file" && typeof output.path === "string") return `读取 ${output.path}`;
  if (name === "workdir.list" && Array.isArray(output.entries)) return `${output.entries.length} 项`;
  if (name === "workdir.search" && Array.isArray(output.matches)) return `${output.matches.length} 处匹配`;
  if (name === "crew.propose_changes" && typeof output.message_id === "string") {
    return `协调提案待确认 · 新任务 ${Number(output.new_task_count) || 0} · 指派 ${Number(output.assignment_count) || 0}`;
  }
  if (name.startsWith("mcp.") && output.is_error === true) return "MCP 工具报告错误";
  return undefined;
}

function watermarkFor(events: readonly CanonicalEvent[], runId: string): Record<string, unknown> {
  const last = events.at(-1);
  return {
    run_id: runId,
    ...(last === undefined ? {} : { event_id: last.id, seq: last.seq }),
  };
}

function textFromMessage(message: Record<string, unknown>): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text.trim() === "" ? undefined : text;
}

function requiredSurface(value: unknown): ProductTask["surface"] {
  if (typeof value !== "string" || !(productSurfaces as readonly string[]).includes(value)) {
    throw new ProductHttpError(400, "invalid_surface");
  }
  return value as ProductTask["surface"];
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new ProductHttpError(400, `invalid_${name}`);
  return value;
}

function requiredResourceRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ProductHttpError(400, "invalid_resource_refs");
  }
  return value as string[];
}

function requestedArtifactKind(value: unknown): string | undefined {
  const artifact = optionalId(value, "requested_artifact");
  if (artifact === undefined) return undefined;
  if (!(new Set(["skill", "prompt", "python_tool"])).has(artifact)) {
    throw new ProductHttpError(400, "invalid_requested_artifact");
  }
  return artifact;
}

export function statusFromEvents(events: readonly CanonicalEvent[]): string {
  const terminal = events.filter((event) => terminalEvents.has(event.type)).at(-1);
  if (terminal !== undefined) return terminal.type.slice("run.".length);
  return events.some((event) => event.type === "run.started" || event.type === "run.progress") ? "running" : "queued";
}

function resultFromEvents(
  events: readonly CanonicalEvent[],
  task?: ProductTask,
): Record<string, unknown> | undefined {
  const successfulToolCalls = new Set(events
    .filter((event) => event.type === "omp.tool.response")
    .filter((event) => recordValue(recordValue(event.payload).result).status === "succeeded")
    .map((event) => {
      const payload = recordValue(event.payload);
      return typeof payload.tool_call_id === "string"
        ? payload.tool_call_id
        : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    })
    .filter((value): value is string => value !== undefined));
  const dispatchedToolNames = new Map<string, string>();
  for (const event of events.filter((item) => item.type === "omp.tool.dispatch")) {
    const payload = recordValue(event.payload);
    const toolCallId = typeof payload.tool_call_id === "string"
      ? payload.tool_call_id
      : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    const name = typeof payload.tool === "string"
      ? payload.tool
      : typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    if (toolCallId !== undefined && name !== undefined) dispatchedToolNames.set(toolCallId, name);
  }
  const allowedBusinessTools = productToolCatalogNames(task);
  const allowedToolCall = (name: unknown, id: unknown): name is string => {
    if (typeof name !== "string") return false;
    if (typeof id !== "string" || !successfulToolCalls.has(id)) return false;
    const canonical = canonicalToolName(name);
    if (task?.surface === "create" && canonical.startsWith("create.emit_")) {
      return true;
    }
    if (task?.surface === "chat" && canonical === "workdir.read_file") return task.workdir_path !== undefined;
    return allowedBusinessTools.has(canonical)
      || (task?.surface === "chat"
        && (canonical === "chat.emit_page" || canonical === "chat.emit_document")
        && allowedBusinessTools.has(canonical));
  };
  const messages = events
    .filter((event) => event.type === "omp.transcript.message")
    .map((event) => recordValue(recordValue(event.payload).message))
    .filter((message): message is Record<string, unknown> => message.role === "assistant");
  const text = messages
    .map((message) => (Array.isArray(message.content) ? message.content : [])
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join(""))
    .filter((value) => value.trim() !== "")
    .at(-1);
  const toolCalls = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])
    .filter((block): block is Record<string, unknown> => isRecord(block)
      && block.type === "toolCall"
      && allowedToolCall(block.name, block.id))
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : `tool-${events.length}`,
      type: "function",
      function: {
        name: typeof block.name === "string" ? block.name : "",
        arguments: JSON.stringify(isRecord(block.arguments) ? block.arguments : {}),
      },
    })));
  const artifactsById = new Map<string, Record<string, unknown>>();
  for (const event of events.filter((item) => item.type === "omp.tool.response")) {
    const payload = recordValue(event.payload);
    const toolCallId = typeof payload.tool_call_id === "string"
      ? payload.tool_call_id
      : typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    const result = recordValue(payload.result);
    const artifact = recordValue(recordValue(result.output).artifact);
    const toolName = toolCallId === undefined ? undefined : dispatchedToolNames.get(toolCallId);
    if (allowedToolCall(toolName, toolCallId) && isArtifactRecord(artifact)) {
      artifactsById.set(artifact.id, artifact);
    }
  }
  const artifacts = [...artifactsById.values()];
  const usage = events
    .filter((event) => event.type === "run.usage.updated")
    .map((event) => recordValue(recordValue(event.payload).cumulative))
    .at(-1);
  const toolsUsed = [...new Set([...dispatchedToolNames.entries()]
    .filter(([id, name]) => allowedToolCall(name, id))
    .map(([, name]) => name))];
  if (text === undefined && toolCalls.length === 0 && usage === undefined && toolsUsed.length === 0 && artifacts.length === 0) return undefined;
  return {
    ...(text === undefined ? {} : { assistant_message: text, answer: text }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls, finish_reason: "tool_calls" }),
    ...(toolCalls.length === 0 && text !== undefined ? { finish_reason: "stop" } : {}),
    ...(usage?.input === undefined ? {} : { input_tokens: usage.input }),
    ...(usage?.output === undefined ? {} : { output_tokens: usage.output }),
    ...(toolsUsed.length === 0 ? {} : { tools_used: toolsUsed }),
    ...(artifacts.length === 0 ? {} : { artifacts, artifact: artifacts.at(-1) }),
  };
}

function isArtifactRecord(value: Record<string, unknown>): value is Record<string, unknown> & {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
} {
  return typeof value.id === "string"
    && typeof value.kind === "string"
    && typeof value.title === "string"
    && typeof value.content === "string";
}

function scopeFor(task: ProductTask): ChannelScope {
  return {
    workspaceId: task.workspace_id as ChannelScope["workspaceId"],
    channelId: channelIdFor(task) as ChannelScope["channelId"],
  };
}

function channelIdFor(task: ProductTask): string {
  return task.channel_id ?? task.conversation_id ?? `product:${task.surface}:${task.workspace_id}`;
}

function shouldProxyBusiness(pathname: string): boolean {
  return businessPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function shouldProxyProductRoute(pathname: string): boolean {
  return pathname === "/api/chat"
    || pathname.startsWith("/api/chat/")
    || pathname === "/api/create"
    || pathname.startsWith("/api/create/")
    || pathname === "/api/crew"
    || pathname.startsWith("/api/crew/")
    || pathname === "/api/cowork/hiker/assistant/runs/stream"
    || pathname.startsWith("/api/cowork/reimbursements/");
}

function isHostRuntimeRoute(pathname: string): boolean {
  return pathname === "/api/admin/runtime/status"
    || pathname === "/api/admin/runtime/config"
    || pathname === "/api/admin/runtime/validate"
    || pathname === "/api/admin/runtime/model-profiles"
    || /^\/api\/admin\/runtime\/model-profiles\/[^/]+$/.test(pathname);
}

function assertServiceToken(request: IncomingMessage, expected: string): void {
  if (!hasServiceToken(request, expected)) throw new ProductHttpError(401, "service_token_required");
}

function hasServiceToken(request: IncomingMessage, expected: string): boolean {
  const token = request.headers["x-anna-service-token"];
  return typeof token === "string" && token === expected;
}

function forwardedHeaders(request: IncomingMessage, serviceToken?: string): Headers {
  const headers = new Headers();
  for (const name of ["authorization", "content-type", "accept", "x-anna-workspace-id", "x-anna-user-id"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  if (serviceToken !== undefined) headers.set("x-anna-service-token", serviceToken);
  return headers;
}

async function serveStatic(response: ServerResponse, root: string, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(root, requested);
  if (!target.startsWith(`${root}/`) && target !== root) {
    responseJson(response, 400, { code: "invalid_static_path" });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": contentType(extname(target)) });
    createReadStream(target).pipe(response);
    return;
  } catch {
    if (pathname !== "/" && !pathname.includes(".")) {
      await serveStatic(response, root, "/");
      return;
    }
    responseJson(response, 404, { code: "not_found" });
  }
}

class JsonBodyError extends Error {
  constructor(readonly code: "invalid_json" | "body_too_large") {
    super(code);
    this.name = "JsonBodyError";
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = maxJsonBodyBytes,
  rejectDuplicateKeys = false,
  onTooLarge?: () => void,
): Promise<unknown> {
  const raw = await readRawBody(request, maxBytes, onTooLarge);
  if (raw.length === 0) return {};
  try {
    if (rejectDuplicateKeys) assertNoDuplicateJsonKeys(raw.toString("utf8"));
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new JsonBodyError("invalid_json");
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readRawBody(request: IncomingMessage, maxBytes = maxJsonBodyBytes, onTooLarge?: () => void): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += next.byteLength;
    if (size > maxBytes) {
      onTooLarge?.();
      throw new JsonBodyError("body_too_large");
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

function responseJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function assertAllowedKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(body).some((key) => !keys.has(key))) throw new ProductHttpError(400, "invalid_request");
}

function validateHostConfigPatch(patch: ProductConfig): void {
  if (patch.model_provider !== undefined
    && (typeof patch.model_provider !== "string" || patch.model_provider.trim() !== "openai-compatible")) {
    throw new ProductHttpError(400, "invalid_model_provider");
  }
  if (patch.model_endpoint !== undefined) {
    if (typeof patch.model_endpoint !== "string") throw new ProductHttpError(400, "invalid_model_endpoint");
    if (patch.model_endpoint.trim() !== "") assertSafeModelEndpoint(patch.model_endpoint);
  }
  if (patch.model_name !== undefined
    && (typeof patch.model_name !== "string" || patch.model_name.trim() === "")) {
    throw new ProductHttpError(400, "invalid_model_name");
  }
  if (patch.model_api_key !== undefined && typeof patch.model_api_key !== "string") {
    throw new ProductHttpError(400, "invalid_model_api_key");
  }
  if (patch.model_profiles !== undefined
    && (!Array.isArray(patch.model_profiles) || patch.model_profiles.some((item) => !isRecord(item)))) {
    throw new ProductHttpError(400, "invalid_model_profiles");
  }
}

function requiredSettingString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ProductHttpError(400, `invalid_${name}`);
  return value.trim();
}

function assertSafeModelEndpoint(value: string): void {
  try {
    const endpoint = new URL(value.trim());
    if (endpoint.protocol !== "https:"
      || endpoint.username !== ""
      || endpoint.password !== ""
      || endpoint.search !== ""
      || endpoint.hash !== "") throw new Error("unsafe endpoint");
  } catch {
    throw new ProductHttpError(400, "invalid_model_endpoint");
  }
}

function assertEmptyObject(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) throw new ProductHttpError(400, "invalid_stop_request");
}

function parseCursor(value: string | null): number {
  const result = value === null ? -1 : Number(value);
  if (!Number.isSafeInteger(result) || result < -1) throw new ProductHttpError(400, "invalid_event_cursor");
  return result;
}

function decodeSegment(value: string): string {
  try {
    const result = decodeURIComponent(value);
    if (!result || result.includes("/") || result.includes("\\")) throw new Error("invalid path");
    return result;
  } catch {
    throw new ProductHttpError(400, "invalid_run_path");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProductHttpError(400, "invalid_request");
  return value;
}

function recordValue(value: unknown): Record<string, any> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalToolName(name: string): string {
  return name.replace(/__/g, ".");
}

function productToolCatalogNames(task?: ProductTask): Set<string> {
  const raw = task?.context?.tool_catalog;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
      const record = item as { name?: unknown };
      return typeof record.name === "string" ? canonicalToolName(record.name) : undefined;
    })
    .filter((name): name is string => name !== undefined));
}

function conversationHistoryFromEvents(
  events: readonly CanonicalEvent[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const event of events) {
    if (event.type !== "omp.transcript.message") continue;
    const message = recordValue(recordValue(event.payload).message);
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = typeof message.content === "string"
      ? message.content
      : content
        .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
    if (text.trim() !== "") history.push({ role: message.role, content: text });
  }
  return history;
}

function contentType(extension: string): string {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  }[extension.toLowerCase()] ?? "application/octet-stream";
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && /conflict|already/i.test(error.message);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function parseProtectedPaths(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(delimiter).filter((item) => item.trim() !== "");
}

async function canonicalPath(input: string): Promise<string> {
  let candidate = resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(candidate);
      return suffix.reduceRight((current, segment) => join(current, segment), existing);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return candidate;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function containsPath(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (childRelative !== ".."
      && !childRelative.startsWith(".." + sep)
      && !childRelative.startsWith(sep));
}
