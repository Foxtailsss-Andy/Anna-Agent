import { readFile } from "node:fs/promises";

export const JEV_REQUESTED_MODEL = "jev-1.13.0" as const;
export const JEV_QUESTION_VERSION = "crew-assignee-v1" as const;
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;

export type AssigneeCandidate = {
  id: string;
  role: string;
  kind: "human" | "agent";
};

export type AssigneeDecisionInput = {
  schema_version: 1;
  decision_id: string;
  workspace_id: string;
  actor_user_id: string;
  project_id: string;
  task_id: string;
  input_hash: string;
  question_version: typeof JEV_QUESTION_VERSION;
  state: {
    project_goal: string;
    task: {
      title: string;
      description: string;
      role_required: string;
      acceptance_criteria: string | null;
    };
    candidates: AssigneeCandidate[];
  };
};

export type AssigneeDecisionResult = {
  schema_version: 1;
  decision_id: string;
  status: "suggested" | "abstained" | "unavailable";
  member_id: string | null;
  reason_code: string;
  source: "jev" | "none";
  meta: {
    question_version: typeof JEV_QUESTION_VERSION;
    requested_model: typeof JEV_REQUESTED_MODEL;
    returned_model: string | null;
    provider_request_id: string | null;
    started_at: string;
    ended_at: string;
    elapsed_ms: number;
    input_tokens: number | null;
    output_tokens: number | null;
    confidence: number | null;
    probabilities: Record<string, number> | null;
    provider_calls: number;
    retry_count: 0;
    error_code: string | null;
  };
};

export type JevTelemetryRecord = {
  decision_id: string;
  input_hash: string;
  status: AssigneeDecisionResult["status"];
  reason_code: string;
  source: AssigneeDecisionResult["source"];
  meta: AssigneeDecisionResult["meta"];
  raw_choice: string | null;
  raw_probabilities: Record<string, number> | null;
  final_member_id: string | null;
};

export type JevTransport = (request: {
  endpoint: typeof JEV_ENDPOINT;
  apiKey: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<Response>;

export type JevDecisionOptions = {
  enabled?: string | undefined;
  apiKeyFile?: string | undefined;
  transport?: JevTransport | undefined;
  now?: () => string;
  startedAt?: string | undefined;
  signal?: AbortSignal | undefined;
  telemetry?: ((record: JevTelemetryRecord) => void) | undefined;
};

const defaultTransport: JevTransport = ({ endpoint, apiKey, body, signal }) => fetch(endpoint, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(body),
  signal,
  redirect: "error",
});

export async function decideAssignee(
  input: AssigneeDecisionInput,
  options: JevDecisionOptions = {},
): Promise<AssigneeDecisionResult> {
  validateAssigneeDecisionInput(input);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = options.startedAt ?? now();
  let providerDispatched = false;
  const unavailable = (errorCode: string, details: Partial<AssigneeDecisionResult["meta"]> = {}): AssigneeDecisionResult => {
    const endedAt = now();
    const result: AssigneeDecisionResult = {
      schema_version: 1,
      decision_id: input.decision_id,
      status: "unavailable",
      member_id: null,
      reason_code: errorCode,
      source: "none",
      meta: {
        question_version: JEV_QUESTION_VERSION,
        requested_model: JEV_REQUESTED_MODEL,
        returned_model: details.returned_model ?? null,
        provider_request_id: details.provider_request_id ?? null,
        started_at: startedAt,
        ended_at: endedAt,
        elapsed_ms: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        input_tokens: details.input_tokens ?? null,
        output_tokens: details.output_tokens ?? null,
        confidence: details.confidence ?? null,
        probabilities: details.probabilities ?? null,
        provider_calls: details.provider_calls ?? (providerDispatched ? 1 : 0),
        retry_count: 0,
        error_code: errorCode,
      },
    };
    emitTelemetry(options.telemetry, input, result);
    return result;
  };

  if (input.state.candidates.length === 0) {
    const endedAt = now();
    const result: AssigneeDecisionResult = {
      schema_version: 1,
      decision_id: input.decision_id,
      status: "abstained",
      member_id: null,
      reason_code: "no_candidates",
      source: "none",
      meta: {
        question_version: JEV_QUESTION_VERSION,
        requested_model: JEV_REQUESTED_MODEL,
        returned_model: null,
        provider_request_id: null,
        started_at: startedAt,
        ended_at: endedAt,
        elapsed_ms: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        input_tokens: null,
        output_tokens: null,
        confidence: null,
        probabilities: null,
        provider_calls: 0,
        retry_count: 0,
        error_code: null,
      },
    };
    emitTelemetry(options.telemetry, input, result);
    return result;
  }

  if (options.enabled !== "1") return unavailable("jev_unavailable");
  if (options.apiKeyFile === undefined || options.apiKeyFile.trim() === "") {
    return unavailable("jev_unavailable");
  }

  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : mergeSignals(options.signal, controller.signal);
  let apiKey: string;
  try {
    apiKey = (await readFile(options.apiKeyFile, { encoding: "utf8", signal })).trim();
  } catch {
    return unavailable(signal.aborted ? "jev_timeout" : "jev_unavailable");
  }
  if (apiKey === "") return unavailable("jev_unavailable");

  const transport = options.transport ?? defaultTransport;
  const request = providerRequestBody(input);
  let response: Response;
  try {
    if (signal.aborted) return unavailable("jev_timeout");
    providerDispatched = true;
    response = await transportWithSignal(transport, { endpoint: JEV_ENDPOINT, apiKey, body: request.body, signal }, signal);
  } catch (error) {
    if (signal.aborted) return unavailable("jev_timeout");
    return unavailable(error instanceof Error && error.name === "AbortError" ? "jev_timeout" : "jev_network_error");
  }

  const responseRequestId = providerRequestIdFromHeaders(response.headers);
  if (response.status === 401 || response.status === 403) {
    cancelProviderBody(response);
    return unavailable("jev_auth_failed", { provider_request_id: responseRequestId });
  }
  if (response.status === 429) {
    cancelProviderBody(response);
    return unavailable("jev_rate_limited", { provider_request_id: responseRequestId });
  }
  if (response.status >= 500) {
    cancelProviderBody(response);
    return unavailable("jev_unavailable", { provider_request_id: responseRequestId });
  }
  if (!response.ok) {
    cancelProviderBody(response);
    return unavailable("jev_unavailable", { provider_request_id: responseRequestId });
  }

  let rawResponse: string;
  try {
    rawResponse = await readResponseText(response, 64 * 1024, signal);
  } catch {
    return unavailable(signal.aborted ? "jev_timeout" : "invalid_response", { provider_request_id: responseRequestId });
  }
  if (signal.aborted) return unavailable("jev_timeout", { provider_request_id: responseRequestId });
  let parsed: unknown;
  try {
    assertNoDuplicateJsonKeys(rawResponse);
    parsed = JSON.parse(rawResponse) as unknown;
  } catch {
    return unavailable("invalid_response", { provider_request_id: responseRequestId });
  }
  if (signal.aborted) return unavailable("jev_timeout", { provider_request_id: responseRequestId });
  const answer = parseChoiceResponse(parsed, request.localCandidateIds, responseRequestId);
  if (answer === undefined) return unavailable("invalid_response", { ...responseMetadata(parsed), ...(responseRequestId === null ? {} : { provider_request_id: responseRequestId }) });
  const endedAt = now();
  const elapsedMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const selectedIndex = answer.choice === "abstain" ? -1 : Number(answer.choice.slice(1)) - 1;
  const selected = selectedIndex < 0 ? undefined : input.state.candidates[selectedIndex];
  const indistinguishable = selected !== undefined && input.state.candidates.some((candidate, index) => (
    index !== selectedIndex && candidate.role === selected.role && candidate.kind === selected.kind
  ));
  const result: AssigneeDecisionResult = {
    schema_version: 1,
    decision_id: input.decision_id,
    status: answer.choice === "abstain" || indistinguishable ? "abstained" : "suggested",
    member_id: answer.choice === "abstain" || indistinguishable ? null : selected?.id ?? null,
    reason_code: answer.choice === "abstain"
      ? "model_abstain"
      : indistinguishable ? "insufficient_information" : "model_choice",
    source: "jev",
    meta: {
      question_version: JEV_QUESTION_VERSION,
      requested_model: JEV_REQUESTED_MODEL,
      returned_model: answer.returnedModel,
      provider_request_id: answer.providerRequestId,
      started_at: startedAt,
      ended_at: endedAt,
      elapsed_ms: elapsedMs,
      input_tokens: answer.inputTokens,
      output_tokens: answer.outputTokens,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      provider_calls: 1,
      retry_count: 0,
      error_code: null,
    },
  };
  emitTelemetry(options.telemetry, input, result, answer.choice, answer.probabilities);
  return result;
}

function cancelProviderBody(response: Response): void {
  if (response.body === null) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Provider cleanup must not change the normalized result.
  }
}

function emitTelemetry(
  sink: JevDecisionOptions["telemetry"],
  input: AssigneeDecisionInput,
  result: AssigneeDecisionResult,
  rawChoice: string | null = null,
  rawProbabilities: Record<string, number> | null = null,
): void {
  if (sink === undefined) return;
  try {
    sink({
      decision_id: input.decision_id,
      input_hash: input.input_hash,
      status: result.status,
      reason_code: result.reason_code,
      source: result.source,
      meta: result.meta,
      raw_choice: rawChoice,
      raw_probabilities: rawProbabilities,
      final_member_id: result.member_id,
    });
  } catch {
    // Telemetry must never change the decision result.
  }
}

async function transportWithSignal(
  transport: JevTransport,
  request: Parameters<JevTransport>[0],
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void transport(request).then(
      (response) => {
        signal.removeEventListener("abort", abort);
        if (settled || signal.aborted) {
          cancelProviderBody(response);
          return;
        }
        settled = true;
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

export function validateAssigneeDecisionInput(value: unknown): asserts value is AssigneeDecisionInput {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schema_version", "decision_id", "workspace_id", "actor_user_id", "project_id", "task_id", "input_hash", "question_version", "state",
  ])
    || value.schema_version !== 1
    || !validId(value.decision_id, true)
    || !validId(value.workspace_id)
    || !validId(value.actor_user_id)
    || !validId(value.project_id)
    || !validId(value.task_id)
    || typeof value.input_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.input_hash)
    || value.question_version !== JEV_QUESTION_VERSION
    || !isRecord(value.state)
    || !hasOnlyKeys(value.state, ["project_goal", "task", "candidates"])
    || typeof value.state.project_goal !== "string"
    || !isRecord(value.state.task)
    || !hasOnlyKeys(value.state.task, ["title", "description", "role_required", "acceptance_criteria"])
    || typeof value.state.task.title !== "string"
    || typeof value.state.task.description !== "string"
    || typeof value.state.task.role_required !== "string"
    || (value.state.task.acceptance_criteria !== null && typeof value.state.task.acceptance_criteria !== "string")
    || !Array.isArray(value.state.candidates)
    || value.state.candidates.length > 20
    || value.state.candidates.some((candidate) => !isRecord(candidate)
      || !hasOnlyKeys(candidate, ["id", "role", "kind"])
      || !validId(candidate.id)
      || typeof candidate.role !== "string"
      || (candidate.kind !== "human" && candidate.kind !== "agent"))
    || new Set(value.state.candidates.map((candidate) => (candidate as AssigneeCandidate).id)).size !== value.state.candidates.length) {
    throw new Error("invalid_jev_request");
  }
  if (byteLength(JSON.stringify(providerRequestBody(value as AssigneeDecisionInput).body.state)) > 16 * 1024) {
    throw new Error("input_too_large");
  }
}

function providerRequestBody(input: AssigneeDecisionInput): { body: Record<string, unknown>; localCandidateIds: readonly string[] } {
  const criteria: Record<string, string> = Object.create(null) as Record<string, string>;
  const localCandidateIds = input.state.candidates.map((_candidate, index) => `c${index + 1}`);
  for (const [index, localId] of localCandidateIds.entries()) criteria[localId] = `Select candidate ${index + 1}.`;
  criteria.abstain = "Abstain when the available task and candidate information does not distinguish a suitable assignee.";
  return {
    body: {
      state: {
        ...input.state,
        candidates: input.state.candidates.map((candidate, index) => ({ ...candidate, id: localCandidateIds[index] })),
      },
      model: JEV_REQUESTED_MODEL,
      questions: {
        assignee: {
          type: "choice",
          instructions: "Choose one candidate only when the provided task and candidate fields support that choice; otherwise choose abstain.",
          criteria,
        },
      },
    },
    localCandidateIds,
  };
}

function parseChoiceResponse(value: unknown, localCandidateIds: readonly string[], responseRequestId: string | null): {
  choice: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  returnedModel: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
} | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["model", "answers", "usage", "request_id", "id"]) || !isRecord(value.answers)
    || !hasOnlyKeys(value.answers, ["assignee"])) return undefined;
  const answer = value.answers.assignee;
  if (!isRecord(answer) || !hasOnlyKeys(answer, ["type", "choice", "probabilities", "confidence"])
    || answer.type !== "choice" || typeof answer.choice !== "string") return undefined;
  const closed = new Set([...localCandidateIds, "abstain"]);
  if (!closed.has(answer.choice)) return undefined;
  let probabilities: Record<string, number> | null = null;
  if (answer.probabilities !== undefined) {
    if (!isRecord(answer.probabilities)) return undefined;
    if (!hasOnlyKeys(answer.probabilities, [...closed])) return undefined;
    probabilities = {};
    for (const option of Object.keys(answer.probabilities)) {
      const probability = answer.probabilities[option];
      if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
      probabilities[option] = probability;
    }
  }
  const confidence = answer.confidence === undefined ? null : answer.confidence;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return undefined;
  const usage = value.usage === undefined ? {} : value.usage;
  if (!isRecord(usage) || !hasOnlyKeys(usage, ["input_tokens", "output_tokens"])) return undefined;
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  if (usage.input_tokens !== undefined && inputTokens === undefined) return undefined;
  if (usage.output_tokens !== undefined && outputTokens === undefined) return undefined;
  const returnedModel = value.model === undefined ? null : value.model;
  if (returnedModel !== null && (typeof returnedModel !== "string" || returnedModel.length > 128)) return undefined;
  const providerRequestId = value.request_id ?? value.id ?? responseRequestId;
  if (providerRequestId !== null && (typeof providerRequestId !== "string" || providerRequestId.length > 128)) return undefined;
  return {
    choice: answer.choice,
    probabilities,
    confidence,
    returnedModel,
    providerRequestId,
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
  };
}

function providerRequestIdFromHeaders(headers: Headers): string | null {
  for (const name of ["x-request-id", "request-id"]) {
    const value = headers.get(name);
    if (value !== null && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  }
  return null;
}

function responseMetadata(value: unknown): Partial<AssigneeDecisionResult["meta"]> {
  if (!isRecord(value)) return {};
  const metadata: Partial<AssigneeDecisionResult["meta"]> = {};
  if (typeof value.model === "string" && value.model.length <= 128) metadata.returned_model = value.model;
  const providerRequestId = value.request_id ?? value.id;
  if (typeof providerRequestId === "string" && providerRequestId.length <= 128) metadata.provider_request_id = providerRequestId;
  if (isRecord(value.usage)) {
    const inputTokens = tokenCount(value.usage.input_tokens);
    const outputTokens = tokenCount(value.usage.output_tokens);
    if (inputTokens !== undefined) metadata.input_tokens = inputTokens;
    if (outputTokens !== undefined) metadata.output_tokens = outputTokens;
  }
  return metadata;
}

function tokenCount(value: unknown): number | undefined {
  return value === undefined ? undefined : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readResponseText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (response.body === null) {
    const text = await response.text();
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (byteLength(text) > maxBytes) throw new Error("response_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reachedEof = false;
  try {
    while (true) {
      const next = await readWithSignal(reader, signal);
      if (next.done) {
        reachedEof = true;
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        cancelReader(reader);
        throw new Error("response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    if (!reachedEof) cancelReader(reader);
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, size));
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  return await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const abort = () => {
      cancelReader(reader);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

const canceledReaders = new WeakSet<ReadableStreamDefaultReader<Uint8Array>>();

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  if (canceledReaders.has(reader)) return;
  canceledReaders.add(reader);
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not alter the normalized provider error.
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function mergeSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (left.aborted || right.aborted) controller.abort();
  else {
    left.addEventListener("abort", abort, { once: true });
    right.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const parseValue = (): void => {
    skipSpace();
    const character = raw[index];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') { parseString(); return; }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/.test(raw[index] ?? "")) index += 1;
    if (start === index) throw new Error("invalid_json");
  };
  const parseObject = (): void => {
    index += 1;
    skipSpace();
    const keys = new Set<string>();
    if (raw[index] === "}") { index += 1; return; }
    while (true) {
      skipSpace();
      if (raw[index] !== '"') throw new Error("invalid_json");
      const key = parseString();
      if (keys.has(key)) throw new Error("duplicate_json_key");
      keys.add(key);
      skipSpace();
      if (raw[index++] !== ":") throw new Error("invalid_json");
      parseValue();
      skipSpace();
      if (raw[index] === "}") { index += 1; return; }
      if (raw[index++] !== ",") throw new Error("invalid_json");
    }
  };
  const parseArray = (): void => {
    index += 1;
    skipSpace();
    if (raw[index] === "]") { index += 1; return; }
    while (true) {
      parseValue();
      skipSpace();
      if (raw[index] === "]") { index += 1; return; }
      if (raw[index++] !== ",") throw new Error("invalid_json");
    }
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      const character = raw[index++];
      if (character === "\\") index += 1;
      else if (character === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    throw new Error("invalid_json");
  };
  const skipSpace = () => { while (/\s/.test(raw[index] ?? "")) index += 1; };
  parseValue();
  skipSpace();
  if (index !== raw.length) throw new Error("invalid_json");
}

function validId(value: unknown, uuid = false): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return !uuid || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
