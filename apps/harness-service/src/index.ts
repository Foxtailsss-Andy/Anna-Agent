import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRunFamilyHarnessState } from "@anna/event-store";
import type {
  CanonicalEvent,
  ChannelScope,
  EventStore,
  RunId,
  StreamId,
} from "@anna/harness-v2";
import { createLiveTraceCursor } from "@anna/trace";
import { projectCreateRun } from "./create-projection";
import { activateCreateSkill } from "./create-activation";
import { createHttpReviewApprovalProvider } from "@anna/harness-v2";
import { isKernelSelectionError } from "./kernel-selection";

const require = createRequire(import.meta.url);
const { version: serviceVersion } = require("../package.json") as {
  version: string;
};

export const unsupportedV2Surfaces = ["create", "cowork", "hub"] as const;

/** Product surfaces share the same durable Runtime; legacy v2 routes remain additive. */
export type V2SurfaceId = typeof unsupportedV2Surfaces[number]
  | "preview"
  | "chat"
  | "hiker"
  | "reimbursement"
  | "crew";
type V2RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "awaiting_input"
  | "awaiting_approval"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface HarnessV2Runtime {
  readonly evidenceMode: "test" | "live";
  readonly surfaces: readonly V2SurfaceId[];
  readonly webSearchConfigured?: boolean;
  readonly reviewGateConfigured?: boolean;
  start(
    surfaceId: V2SurfaceId,
    body: unknown,
  ): Promise<{ runId: string; status: V2RunStatus }>;
  readonly resume?: (
    surfaceId: V2SurfaceId,
    runId: string,
    body: unknown,
  ) => Promise<{ runId: string; status: V2RunStatus }>;
  readonly stop?: (
    workspaceId: string,
    channelId: string,
    runId: string,
    reason?: string,
  ) => Promise<{ status: V2RunStatus } | undefined>;
  readonly steer?: (
    workspaceId: string,
    channelId: string,
    runId: string,
    content: string,
  ) => Promise<void>;
  readonly answer?: (
    workspaceId: string,
    channelId: string,
    runId: string,
    content: string,
  ) => Promise<void>;
  readonly readEvents?: (
    workspaceId: string,
    channelId: string,
    runId: string,
    fromSeq?: number,
  ) => Promise<readonly CanonicalEvent[]>;
}

export interface HarnessServiceOptions {
  readonly runtime?: HarnessV2Runtime;
  readonly eventStore?: EventStore;
  readonly host?: string;
  readonly port?: number;
  readonly instanceId?: string;
  readonly requireScopeHeaders?: boolean;
  readonly createActivation?: {
    readonly workspaceRoot: string;
    readonly approvalOrigin: string;
    readonly ownerId: string;
  };
}

class JsonBodyError extends Error {
  readonly code: "invalid_json" | "body_too_large";

  constructor(code: JsonBodyError["code"]) {
    super(code);
    this.code = code;
  }
}

const maxJsonBodyBytes = 1_024 * 1_024;

function v2Capabilities(runtime?: HarnessV2Runtime) {
  const runtimeSurfaces = new Set(runtime?.surfaces ?? []);
  const reviewGateReady = runtime?.reviewGateConfigured === true;
  return {
    api_version: "harness-v2",
    status: "partial",
    review_gate: reviewGateReady
      ? {
          status: "ready",
          reason: "owner_approval_bridge_ready",
          owner: "verified",
          provider: "verified",
          live_evidence: "pending",
        }
      : {
          status: "blocked",
          reason: "real_review_approval_bridge_not_implemented",
          owner: "unverified",
          provider: "unverified",
          live_evidence: "unverified",
        },
    completed_prerequisites: ["desktop_decision_to_resume"],
    unsupported_capabilities: {
      web_search: {
        status: runtime?.webSearchConfigured === true ? "available" : "unsupported",
        reason: runtime?.webSearchConfigured === true
          ? "provider_connector_configured"
          : "provider_connector_not_implemented",
      },
    },
    surfaces: unsupportedV2Surfaces.map((id) => {
      if (!runtimeSurfaces.has(id) || runtime === undefined) {
        return {
          id,
          status: "unsupported",
          legacy_status: "available",
          reason: "v2_bridge_not_implemented",
          required_before_enable: [
            "production_runtime_consumer",
            "real_provider_evidence",
          ],
        };
      }

      return runtime.evidenceMode === "live"
        ? {
            id,
            status: "available",
            legacy_status: "available",
            reason: "runtime_injected",
            required_before_enable: [],
          }
        : {
            id,
            status: "test_only",
            legacy_status: "available",
            reason: "injected_runtime_is_not_live_evidence",
            required_before_enable: ["real_provider_evidence"],
          };
    }),
  };
}

export interface RunningHarnessService {
  url: string;
  close(): Promise<void>;
}

export async function startHarnessService(
  options: HarnessServiceOptions = {},
): Promise<RunningHarnessService> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("Harness v2 service must bind to a loopback host");
  }
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        ...(options.instanceId === undefined
          ? {}
          : { instanceId: options.instanceId, protocol: "harness-v2" }),
      }));
      return;
    }

    if (request.method === "GET" && request.url === "/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        version: serviceVersion,
        ...(options.instanceId === undefined ? {} : { protocol: "harness-v2" }),
      }));
      return;
    }

    if (request.method === "GET" && request.url === "/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(v2Capabilities(options.runtime)));
      return;
    }

    const createActivationMatch = request.url?.match(
      /^\/v2\/runs\/([^/]+)\/create\/activate(?:\?(.*))?$/,
    );
    if (request.method === "POST" && createActivationMatch) {
      void handleCreateProjection(request, response, options, createActivationMatch, true);
      return;
    }

    const createProjectionMatch = request.url?.match(
      /^\/v2\/runs\/([^/]+)\/create(?:\?(.*))?$/,
    );
    if (request.method === "GET" && createProjectionMatch) {
      void handleCreateProjection(request, response, options, createProjectionMatch, false);
      return;
    }

    const channelEventsMatch = request.url?.match(
      /^\/v2\/channels\/([^/]+)\/([^/]+)\/events(?:\?(.*))?$/,
    );
    if (request.method === "GET" && channelEventsMatch) {
      void handleChannelEvents(request, response, options, channelEventsMatch);
      return;
    }

    const traceMatch = request.url?.match(/^\/v2\/runs\/([^/]+)\/trace(?:\?(.*))?$/);
    if (request.method === "GET" && traceMatch) {
      void handleRunTrace(request, response, options, traceMatch);
      return;
    }

    const eventMatch = request.url?.match(/^\/v2\/runs\/([^/]+)\/events(?:\?(.*))?$/);
    if (request.method === "GET" && eventMatch) {
      void handleRuntimeEvents(request, response, options.runtime, eventMatch[1], eventMatch[2]);
      return;
    }

    const resumeMatch = request.url?.match(/^\/v2\/surfaces\/([^/]+)\/runs\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      const surfaceId = resumeMatch[1] as V2SurfaceId;
      if (!isLegacyV2Surface(surfaceId)) {
        responseJson(response, 404, { code: "unknown_v2_surface" });
        return;
      }
      if (options.runtime?.surfaces.includes(surfaceId)) {
        void handleRuntimeResume(request, response, options.runtime, surfaceId, resumeMatch[2]);
        return;
      }
      responseJson(response, 409, {
        code: "legacy_surface_not_migrated",
        surface_id: surfaceId,
        status: "unsupported",
        reason: "v2_bridge_not_implemented",
        message: "The v2 Runtime bridge is not available for this surface.",
      });
      return;
    }

    const surfaceMatch = request.url?.match(/^\/v2\/surfaces\/([^/]+)\/runs$/);
    if (request.method === "POST" && surfaceMatch) {
      const surfaceId = surfaceMatch[1] as V2SurfaceId;
      if (!isLegacyV2Surface(surfaceId)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "unknown_v2_surface" }));
        return;
      }

      if (options.runtime?.surfaces.includes(surfaceId)) {
        void handleRuntimeStart(request, response, options.runtime, surfaceId);
        return;
      }

      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: "legacy_surface_not_migrated",
        surface_id: surfaceMatch[1],
        status: "unsupported",
        reason: "v2_bridge_not_implemented",
        message: "The v2 Runtime bridge is not available for this surface.",
      }));
      return;
    }

    const createListMatch = request.url?.match(/^\/v2\/create\/runs(?:\?(.*))?$/);
    if (request.method === "GET" && createListMatch) {
      void handleCreateList(request, response, options, createListMatch);
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Harness service did not bind a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleCreateProjection(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessServiceOptions,
  match: RegExpMatchArray,
  activate: boolean,
): Promise<void> {
  if (options.eventStore === undefined) {
    responseJson(response, 503, { code: "v2_event_store_unavailable" });
    return;
  }

  const runId = decodePathSegment(match[1]);
  const query = new URLSearchParams(match[2] ?? "");
  const workspaceId = query.get("workspace_id");
  const channelId = query.get("channel_id");
  if (
    runId === undefined
    || runId.trim() === ""
    || workspaceId === null
    || workspaceId.trim() === ""
    || channelId === null
    || channelId.trim() === ""
  ) {
    responseJson(response, 400, { code: "invalid_create_scope" });
    return;
  }
  if (!scopeHeadersMatch(request, workspaceId, channelId, options.requireScopeHeaders)) {
    responseJson(response, 403, { code: "v2_scope_mismatch" });
    return;
  }

  const store = options.eventStore.scope(asChannelScope(workspaceId, channelId));
  const events = await readCreateEvents(store, runId);
  if (events.length === 0) {
    responseJson(response, 404, { code: "v2_run_not_found" });
    return;
  }
  if (activate) {
    await activateCreateProjection(request, response, store, runId, events, options);
    return;
  }
  responseJson(response, 200, projectCreateRun(runId, events));
}

async function readCreateEvents(
  store: ReturnType<EventStore["scope"]>,
  runId: string,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.read(runId as StreamId)) events.push(event);
  for await (const event of store.read(`create-activation:${runId}` as StreamId)) events.push(event);
  return events;
}

async function handleCreateList(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessServiceOptions,
  match: RegExpMatchArray,
): Promise<void> {
  if (options.eventStore === undefined) {
    responseJson(response, 503, { code: "v2_event_store_unavailable" });
    return;
  }

  const query = new URLSearchParams(match[1] ?? "");
  const workspaceId = query.get("workspace_id");
  const channelId = query.get("channel_id");
  if (
    workspaceId === null
    || workspaceId.trim() === ""
    || channelId === null
    || channelId.trim() === ""
  ) {
    responseJson(response, 400, { code: "invalid_create_scope" });
    return;
  }
  if (!scopeHeadersMatch(request, workspaceId, channelId, options.requireScopeHeaders)) {
    responseJson(response, 403, { code: "v2_scope_mismatch" });
    return;
  }

  const store = options.eventStore.scope(asChannelScope(workspaceId, channelId));
  const runs: Array<Record<string, unknown> & { latestEventAt: string }> = [];
  for (const command of await store.listRunCommands()) {
    if (command.surfaceId !== "create") continue;
    const events = await readCreateEvents(store, command.runId);
    const latestEventAt = events.at(-1)?.timestamp ?? "";
    runs.push({
      ...projectCreateRun(command.runId, events),
      prompt: command.goal,
      commandId: command.commandId,
      sourceEventId: command.source.eventId,
      latestEventAt,
    });
  }
  runs.sort((left, right) => right.latestEventAt.localeCompare(left.latestEventAt));
  responseJson(response, 200, {
    runs: runs.map(({ latestEventAt: _latestEventAt, ...run }) => run),
  });
}

async function activateCreateProjection(
  request: IncomingMessage,
  response: ServerResponse,
  store: ReturnType<EventStore["scope"]>,
  runId: string,
  events: CanonicalEvent[],
  options: HarnessServiceOptions,
): Promise<void> {
  const activation = options.createActivation;
  if (activation === undefined) {
    responseJson(response, 409, {
      code: "create_activation_not_implemented",
      status: "unsupported",
    });
    return;
  }
  if (request.headers["x-anna-owner-id"] !== activation.ownerId) {
    responseJson(response, 403, { code: "create_activation_owner_mismatch" });
    return;
  }
  const projection = projectCreateRun(runId, events);
  if (projection.status === "saved") {
    responseJson(response, 200, projection);
    return;
  }
  if (projection.status !== "ready_for_review" || projection.artifact === undefined || projection.validation?.valid !== true) {
    responseJson(response, 409, {
      code: "create_activation_not_ready",
      status: "blocked",
      reason: projection.activation.status === "blocked"
        ? projection.activation.reason
        : "create_activation_not_ready",
    });
    return;
  }

  let approval: Awaited<ReturnType<ReturnType<typeof createHttpReviewApprovalProvider>["approveEffect"]>>;
  try {
    approval = await createHttpReviewApprovalProvider({
      origin: activation.approvalOrigin,
      ownerId: activation.ownerId,
    }).approveEffect(`create.activate:${runId}:${projection.artifact.hash}`);
  } catch {
    responseJson(response, 503, { code: "create_activation_approval_unavailable" });
    return;
  }
  if (!approval.approved || approval.actorId !== activation.ownerId) {
    responseJson(response, 409, {
      code: "create_activation_denied",
      status: "blocked",
      actorId: approval.actorId,
    });
    return;
  }

  const result = await activateCreateSkill({
    workspaceRoot: activation.workspaceRoot,
    artifact: projection.artifact,
  });
  if ("error" in result) {
    responseJson(response, 409, { code: result.error, status: "blocked" });
    return;
  }

  const activationStreamId = `create-activation:${runId}` as StreamId;
  const activationSeq = events
    .filter((event) => event.streamId === activationStreamId)
    .reduce((next, event) => Math.max(next, event.seq + 1), 0);
  const activationEvent: CanonicalEvent = {
    id: crypto.randomUUID() as CanonicalEvent["id"],
    workspaceId: events[0]!.workspaceId,
    channelId: events[0]!.channelId,
    streamId: activationStreamId,
    seq: activationSeq,
    type: "create.artifact.activated",
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    payload: {
      artifact: projection.artifact,
      actorId: approval.actorId,
      targetPath: result.targetPath,
    } as unknown as CanonicalEvent["payload"],
  };
  try {
    await store.append(activationEvent);
  } catch {
    await unlink(resolve(activation.workspaceRoot, result.targetPath)).catch(() => undefined);
    responseJson(response, 500, { code: "create_activation_event_persist_failed" });
    return;
  }
  responseJson(response, 200, projectCreateRun(runId, [...events, activationEvent]));
}

async function handleChannelEvents(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessServiceOptions,
  match: RegExpMatchArray,
): Promise<void> {
  if (options.eventStore === undefined) {
    responseJson(response, 503, { code: "v2_event_store_unavailable" });
    return;
  }

  const workspaceId = decodePathSegment(match[1]);
  const channelId = decodePathSegment(match[2]);
  if (workspaceId === undefined || channelId === undefined) {
    responseJson(response, 400, { code: "invalid_channel_path" });
    return;
  }
  const query = new URLSearchParams(match[3] ?? "");
  const streamId = query.get("streamId");
  const afterSeqValue = query.get("afterSeq");
  const afterSeq = afterSeqValue === null ? -1 : Number(afterSeqValue);
  if (
    streamId === null
    || streamId.trim() === ""
    || !Number.isSafeInteger(afterSeq)
    || afterSeq < -1
  ) {
    responseJson(response, 400, { code: "invalid_channel_cursor" });
    return;
  }
  if (!scopeHeadersMatch(request, workspaceId, channelId, options.requireScopeHeaders)) {
    responseJson(response, 403, { code: "v2_scope_mismatch" });
    return;
  }

  const scope = asChannelScope(workspaceId, channelId);
  const store = options.eventStore.scope(scope);
  const events: CanonicalEvent[] = [];
  for await (const event of store.read(streamId as StreamId, afterSeq)) {
    events.push(event);
  }
  if (events.length === 0 && await store.getRunCommand(streamId as RunId) === undefined) {
    responseJson(response, 404, { code: "v2_channel_stream_not_found" });
    return;
  }
  const nextSeq = events.length === 0 ? afterSeq : events[events.length - 1]!.seq;
  responseJson(response, 200, {
    events,
    nextCursor: { streamId, seq: nextSeq },
  });
}

async function handleRunTrace(
  request: IncomingMessage,
  response: ServerResponse,
  options: HarnessServiceOptions,
  match: RegExpMatchArray,
): Promise<void> {
  if (options.eventStore === undefined) {
    responseJson(response, 503, { code: "v2_event_store_unavailable" });
    return;
  }

  const runId = decodePathSegment(match[1]);
  if (runId === undefined || runId.trim() === "") {
    responseJson(response, 400, { code: "invalid_run_path" });
    return;
  }
  const query = new URLSearchParams(match[2] ?? "");
  const workspaceId = query.get("workspaceId");
  const channelId = query.get("channelId");
  const surface = query.get("surface");
  if (
    workspaceId === null
    || workspaceId.trim() === ""
    || channelId === null
    || channelId.trim() === ""
    || surface === null
    || surface.trim() === ""
  ) {
    responseJson(response, 400, { code: "invalid_trace_scope" });
    return;
  }
  if (!scopeHeadersMatch(request, workspaceId, channelId, options.requireScopeHeaders)) {
    responseJson(response, 403, { code: "v2_scope_mismatch" });
    return;
  }

  const scope = asChannelScope(workspaceId, channelId);
  const store = options.eventStore.scope(scope);
  const streamIds = await store.listRunStreamIds(runId as RunId);
  if (streamIds.length === 0) {
    responseJson(response, 404, { code: "v2_run_not_found" });
    return;
  }
  const snapshot = await createLiveTraceCursor({
    events: store,
    runId,
    scope,
    surface,
    streamId: runId as StreamId,
  }).read();
  const harnessState = await projectRunFamilyHarnessState(store, runId);
  responseJson(response, 200, {
    document: snapshot.document,
    cursors: snapshot.cursors,
    harnessState,
  });
}

function asChannelScope(workspaceId: string, channelId: string): ChannelScope {
  return {
    workspaceId: workspaceId as ChannelScope["workspaceId"],
    channelId: channelId as ChannelScope["channelId"],
  };
}

function scopeHeadersMatch(
  request: IncomingMessage,
  workspaceId: string,
  channelId: string,
  required = false,
): boolean {
  if (!required) return true;
  return request.headers["x-anna-workspace-id"] === workspaceId
    && request.headers["x-anna-channel-id"] === channelId;
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLegacyV2Surface(
  surfaceId: V2SurfaceId,
): surfaceId is typeof unsupportedV2Surfaces[number] {
  return (unsupportedV2Surfaces as readonly string[]).includes(surfaceId);
}

async function handleRuntimeEvents(
  _request: IncomingMessage,
  response: ServerResponse,
  runtime: HarnessV2Runtime | undefined,
  runId: string,
  queryString: string | undefined,
): Promise<void> {
  if (runtime?.readEvents === undefined) {
    responseJson(response, 404, { code: "v2_event_reader_unavailable" });
    return;
  }

  const query = new URLSearchParams(queryString ?? "");
  const workspaceId = query.get("workspace_id");
  const channelId = query.get("channel_id");
  const fromSeqValue = query.get("from_seq");
  const fromSeq = fromSeqValue === null ? -1 : Number(fromSeqValue);
  if (
    workspaceId === null
    || channelId === null
    || !Number.isSafeInteger(fromSeq)
    || fromSeq < -1
  ) {
    responseJson(response, 400, { code: "invalid_event_cursor" });
    return;
  }

  try {
    const events = await runtime.readEvents(workspaceId, channelId, runId, fromSeq);
    responseJson(response, 200, { run_id: runId, events });
  } catch {
    responseJson(response, 404, { code: "v2_run_not_found" });
  }
}

async function handleRuntimeStart(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: HarnessV2Runtime,
  surfaceId: V2SurfaceId,
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = await runtime.start(surfaceId, body);
    responseJson(response, 202, {
      surface_id: surfaceId,
      run_id: result.runId,
      status: result.status,
    });
  } catch (error) {
    if (error instanceof JsonBodyError) {
      responseJson(response, 400, { code: error.code });
      return;
    }
    if (isKernelSelectionError(error)) {
      responseJson(response, 503, error.body);
      return;
    }
    responseJson(response, 500, { code: "v2_runtime_failed" });
  }
}

async function handleRuntimeResume(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: HarnessV2Runtime,
  surfaceId: V2SurfaceId,
  encodedRunId: string,
): Promise<void> {
  const runId = decodePathSegment(encodedRunId);
  if (runId === undefined || runId.trim() === "") {
    responseJson(response, 400, { code: "invalid_run_path" });
    return;
  }
  if (runtime.resume === undefined) {
    responseJson(response, 409, {
      code: "v2_runtime_resume_unavailable",
      status: "unsupported",
    });
    return;
  }
  try {
    const body = await readJsonBody(request);
    const result = await runtime.resume(surfaceId, runId, body);
    responseJson(response, 202, {
      surface_id: surfaceId,
      run_id: result.runId,
      status: result.status,
    });
  } catch (error) {
    if (error instanceof JsonBodyError) {
      responseJson(response, 400, { code: error.code });
      return;
    }
    if (isKernelSelectionError(error)) {
      responseJson(response, 503, error.body);
      return;
    }
    responseJson(response, 500, { code: "v2_runtime_failed" });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxJsonBodyBytes) {
      throw new JsonBodyError("body_too_large");
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new JsonBodyError("invalid_json");
  }
}

function responseJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export {
  ProductSessionStore,
  ProductTaskValidationError,
  productSurfaces,
  validatedProductTask,
  type ProductPermissionMode,
  type ProductSurface,
  type ProductTask,
} from "./product-session";
export {
  ProductHttpError,
  startProductHarnessService,
  startProductHost,
  statusFromEvents,
  type ProductHostOptions,
  type RunningProductHost,
} from "./product-facade";
