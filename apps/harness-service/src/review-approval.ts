import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const reviewApprovalActions = [
  "confirm_memory_candidate",
  "approve_lane",
  "approve_effect",
] as const;

type ReviewApprovalAction = typeof reviewApprovalActions[number];

interface ReviewApprovalRequest {
  readonly recordType: "request";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly ownerId: string;
  readonly action: ReviewApprovalAction;
  readonly subject: Record<string, unknown>;
  readonly createdAt: string;
}

interface ReviewApprovalDecision {
  readonly recordType: "decision";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly ownerId: string;
  readonly approved: boolean;
  readonly actorId: string;
  readonly decidedAt: string;
}

type ReviewApprovalRecord = ReviewApprovalRequest | ReviewApprovalDecision;

interface ReviewApprovalState {
  readonly requests: Map<string, ReviewApprovalRequest>;
  readonly decisions: Map<string, ReviewApprovalDecision>;
}

export interface ReviewApprovalServiceOptions {
  readonly ownerId: string;
  readonly storePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly decisionTimeoutMs?: number;
}

export interface RunningReviewApprovalService {
  readonly url: string;
  readonly storePath: string;
  close(): Promise<void>;
}

interface PendingWaiter {
  readonly resolve: (decision: ReviewApprovalDecision) => void;
  readonly reject: (error: Error) => void;
}

class DurableReviewApprovalLog {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async read(): Promise<ReviewApprovalState> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }

    const state = emptyState();
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line) as ReviewApprovalRecord;
      if (record.recordType === "request") {
        state.requests.set(record.fingerprint, record);
      } else if (record.recordType === "decision") {
        state.decisions.set(record.fingerprint, record);
      } else {
        throw new Error("Review approval store contains an unknown record type");
      }
    }
    return state;
  }

  append(record: ReviewApprovalRecord): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(this.path, "a");
      try {
        await file.writeFile(JSON.stringify(record) + "\n", "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }
}

export async function startReviewApprovalService(
  options: ReviewApprovalServiceOptions,
): Promise<RunningReviewApprovalService> {
  const ownerId = nonEmpty(options.ownerId, "ownerId");
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("Review approval service must bind to a loopback host");
  }
  if (!Number.isSafeInteger(options.decisionTimeoutMs ?? 300_000)
    || (options.decisionTimeoutMs ?? 300_000) < 1) {
    throw new Error("Review approval decision timeout must be a positive integer");
  }

  const log = new DurableReviewApprovalLog(resolve(options.storePath));
  const pendingWaiters = new Map<string, PendingWaiter>();
  const inFlight = new Map<string, Promise<ReviewApprovalDecision>>();
  const server = createServer((request, response) => {
    if (!matchesReviewApprovalRoute(request)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    void handleReviewApprovalRequest(
      request,
      response,
      log,
      ownerId,
      pendingWaiters,
      inFlight,
      options.decisionTimeoutMs ?? 300_000,
    ).catch((error) => responseJson(
      response,
      error instanceof ReviewApprovalTimeoutError ? 408 : 500,
      error instanceof ReviewApprovalTimeoutError
        ? { code: "owner_decision_timeout", request_id: error.requestId }
        : { code: "review_approval_store_failed" },
    ));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Review approval service did not bind a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    storePath: log.path,
    close: () => {
      for (const waiter of pendingWaiters.values()) {
        waiter.reject(new Error("review approval service closed"));
      }
      pendingWaiters.clear();
      return new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

function matchesReviewApprovalRoute(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return pathname === "/status"
    || pathname === "/requests"
    || pathname === "/decisions"
    || /^\/requests\/[^/]+\/decision$/.test(pathname);
}

async function handleReviewApprovalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  log: DurableReviewApprovalLog,
  ownerId: string,
  pendingWaiters: Map<string, PendingWaiter>,
  inFlight: Map<string, Promise<ReviewApprovalDecision>>,
  decisionTimeoutMs: number,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/status") {
    const state = await log.read();
    responseJson(response, 200, {
      status: "ready",
      owner_id: ownerId,
      decision_endpoint: "ready",
      durability: "durable",
      pending_requests: [...state.requests.keys()].filter((key) => !state.decisions.has(key)).length,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/requests") {
    if (!ownerHeaderMatches(request, ownerId)) {
      responseJson(response, 403, { code: "owner_identity_mismatch" });
      return;
    }
    const state = await log.read();
    const requests = [...state.requests.values()]
      .filter((item) => !state.decisions.has(item.fingerprint))
      .map((item) => ({
        request_id: item.requestId,
        owner_id: item.ownerId,
        action: item.action,
        subject: item.subject,
        created_at: item.createdAt,
      }));
    responseJson(response, 200, { requests });
    return;
  }

  if (request.method === "POST" && url.pathname === "/decisions") {
    const body = await readJsonBody(request);
    const parsed = parseDecisionRequest(body, ownerId);
    if (parsed.error !== undefined) {
      responseJson(response, parsed.status, { code: parsed.error });
      return;
    }
    if (!ownerHeaderMatches(request, ownerId)) {
      responseJson(response, 403, { code: "owner_identity_mismatch" });
      return;
    }
    const fingerprint = fingerprintFor(ownerId, parsed.action, parsed.subject);
    const existing = inFlight.get(fingerprint);
    const decision = existing ?? waitForDecision(
      log,
      ownerId,
      parsed.action,
      parsed.subject,
      fingerprint,
      pendingWaiters,
      decisionTimeoutMs,
    );
    if (existing === undefined) inFlight.set(fingerprint, decision);
    try {
      const result = await decision;
      responseJson(response, 200, { approved: result.approved, actorId: result.actorId });
    } finally {
      if (inFlight.get(fingerprint) === decision) inFlight.delete(fingerprint);
    }
    return;
  }

  const decisionMatch = url.pathname.match(/^\/requests\/([^/]+)\/decision$/);
  if (request.method === "POST" && decisionMatch) {
    if (!ownerHeaderMatches(request, ownerId)) {
      responseJson(response, 403, { code: "owner_identity_mismatch" });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body)
      || body.ownerId !== ownerId
      || typeof body.approved !== "boolean"
      || (body.actorId !== undefined && body.actorId !== ownerId)) {
      responseJson(response, 400, { code: "invalid_owner_decision" });
      return;
    }
    const requestId = decodePathSegment(decisionMatch[1]);
    if (requestId === undefined) {
      responseJson(response, 400, { code: "invalid_request_id" });
      return;
    }
    const state = await log.read();
    const pending = [...state.requests.values()].find((item) => item.requestId === requestId);
    if (pending === undefined) {
      responseJson(response, 404, { code: "review_request_not_found" });
      return;
    }
    const current = state.decisions.get(pending.fingerprint);
    if (current !== undefined) {
      responseJson(response, 200, decisionResponse(current));
      return;
    }
    const decision: ReviewApprovalDecision = {
      recordType: "decision",
      requestId,
      fingerprint: pending.fingerprint,
      ownerId,
      approved: body.approved,
      actorId: ownerId,
      decidedAt: new Date().toISOString(),
    };
    await log.append(decision);
    pendingWaiters.get(requestId)?.resolve(decision);
    responseJson(response, 200, decisionResponse(decision));
    return;
  }

  response.statusCode = 404;
  response.end();
}

async function waitForDecision(
  log: DurableReviewApprovalLog,
  ownerId: string,
  action: ReviewApprovalAction,
  subject: Record<string, unknown>,
  fingerprint: string,
  pendingWaiters: Map<string, PendingWaiter>,
  decisionTimeoutMs: number,
): Promise<ReviewApprovalDecision> {
  const state = await log.read();
  const existing = state.decisions.get(fingerprint);
  if (existing !== undefined) return existing;

  const pending = state.requests.get(fingerprint);
  const request: ReviewApprovalRequest = pending ?? {
    recordType: "request",
    requestId: `review-request:${randomUUID()}`,
    fingerprint,
    ownerId,
    action,
    subject,
    createdAt: new Date().toISOString(),
  };
  const decisionPromise = new Promise<ReviewApprovalDecision>((resolveDecision, rejectDecision) => {
    const timer = setTimeout(() => {
      pendingWaiters.delete(request.requestId);
      rejectDecision(new ReviewApprovalTimeoutError(request.requestId));
    }, decisionTimeoutMs);
    pendingWaiters.set(request.requestId, {
      resolve: (decision) => {
        clearTimeout(timer);
        pendingWaiters.delete(request.requestId);
        resolveDecision(decision);
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingWaiters.delete(request.requestId);
        rejectDecision(error);
      },
    });
  });
  if (pending === undefined) {
    try {
      await log.append(request);
    } catch (error) {
      pendingWaiters.get(request.requestId)?.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  const latest = await log.read();
  const decided = latest.decisions.get(fingerprint);
  if (decided !== undefined) pendingWaiters.get(request.requestId)?.resolve(decided);
  return decisionPromise;
}

class ReviewApprovalTimeoutError extends Error {
  constructor(readonly requestId: string) {
    super("review approval decision timed out");
  }
}

function parseDecisionRequest(
  input: unknown,
  ownerId: string,
): { action: ReviewApprovalAction; subject: Record<string, unknown>; error?: undefined; status?: undefined }
  | { error: string; status: 400 | 403 } {
  if (!isRecord(input) || input.ownerId !== ownerId) {
    return { error: "owner_identity_mismatch", status: 403 };
  }
  if (!isReviewApprovalAction(input.action)) {
    return { error: "invalid_review_approval_action", status: 400 };
  }
  const subject = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "ownerId" && key !== "action"),
  );
  if (!validSubject(input.action, subject)) {
    return { error: "invalid_review_approval_subject", status: 400 };
  }
  return { action: input.action, subject };
}

function validSubject(action: ReviewApprovalAction, subject: Record<string, unknown>): boolean {
  if (action === "approve_effect") {
    return typeof subject.effectKey === "string" && subject.effectKey.trim() !== "";
  }
  if (typeof subject.traceId !== "string" || subject.traceId.trim() === "") return false;
  const item = subject[action === "approve_lane" ? "lane" : "candidate"];
  return isRecord(item) && typeof item.id === "string" && item.id.trim() !== "";
}

function isReviewApprovalAction(value: unknown): value is ReviewApprovalAction {
  return typeof value === "string"
    && (reviewApprovalActions as readonly string[]).includes(value);
}

function fingerprintFor(
  ownerId: string,
  action: ReviewApprovalAction,
  subject: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(stableJson({ ownerId, action, subject }), "utf8")
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptyState(): ReviewApprovalState {
  return { requests: new Map(), decisions: new Map() };
}

function decisionResponse(decision: ReviewApprovalDecision): Record<string, unknown> {
  return {
    request_id: decision.requestId,
    approved: decision.approved,
    actorId: decision.actorId,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 256 * 1024) throw new Error("review approval body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid review approval JSON");
  }
}

function ownerHeaderMatches(request: IncomingMessage, ownerId: string): boolean {
  return ownerHeaderValue(request.headers["x-anna-owner-id"]) === ownerId;
}

function ownerHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function responseJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
