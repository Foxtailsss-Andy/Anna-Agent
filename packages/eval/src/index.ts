import { createHash } from "node:crypto";
import {
  parseArtifact,
  parseCanonicalEvent,
  type Artifact,
  type CanonicalEvent,
  type JsonValue,
} from "@anna/harness-v2";

export type EvalJsonValue = JsonValue;
export type EvalEvent = CanonicalEvent;

export type EvalArtifact = Artifact;

export interface EvalSpan {
  readonly spanId: string;
  readonly kind: string;
  readonly status: "ok" | "error" | "unset";
  readonly attributes?: Readonly<Record<string, EvalJsonValue>>;
}

export interface EvalTrace {
  readonly traceId: string;
  readonly spans: readonly EvalSpan[];
}

export interface EvalEvidence {
  readonly traceId: string;
  readonly events: readonly EvalEvent[];
  readonly artifacts: readonly EvalArtifact[];
  readonly trace?: EvalTrace;
  readonly metrics?: Readonly<{
    stability?: number;
    latencyMs?: number;
    cost?: number;
  }>;
}

export interface ContractEvalOptions {
  readonly version?: string;
  readonly requiredEventTypes?: readonly string[];
  readonly prohibitedEffectKeys?: readonly string[];
  readonly requiredArtifactKinds?: readonly string[];
  readonly requireTerminal?: boolean;
}

export type ContractFailureReason =
  | "invalid_evidence"
  | "missing_required_event"
  | "prohibited_side_effect"
  | "missing_required_artifact"
  | "missing_terminal_event"
  | "orphaned_trace";

export interface ContractEvalResult {
  readonly passed: boolean;
  readonly version: string;
  readonly reason?: ContractFailureReason;
  readonly failedRules: readonly string[];
  readonly checkedEventIds: readonly string[];
}

export interface EvalRubricCriterion {
  readonly id: string;
  readonly description: string;
  readonly weight: number;
}

export interface EvalRubric {
  readonly id: string;
  readonly version: string;
  readonly criteria: readonly EvalRubricCriterion[];
  readonly passingScore: number;
}

export interface QualityEvalOptions {
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly rubric: EvalRubric;
  readonly scores: Readonly<Record<string, number>>;
}

export interface QualityEvalResult {
  readonly passed: boolean;
  readonly score: number;
  readonly cacheKey: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly rubricId: string;
  readonly rubricVersion: string;
  readonly failedCriteria: readonly string[];
}

export type RegressionClassification =
  | "contract_failure"
  | "quality_failure"
  | "trace_failure"
  | "mixed_failure";

export interface RegressionCase {
  readonly id: string;
  readonly sourceTraceId: string;
  readonly classification: RegressionClassification;
  readonly sourceEventIds: readonly string[];
  readonly contract: ContractEvalResult;
  readonly quality?: QualityEvalResult;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly evidence: EvalEvidence;
  readonly contract: ContractEvalResult;
  readonly quality?: QualityEvalResult;
}

export interface EvalSetReport {
  readonly setId: string;
  readonly total: number;
  readonly passed: number;
  readonly blocked: number;
  readonly stability?: number;
  readonly quality?: number;
  readonly latencyMs?: number;
  readonly cost?: number;
  readonly cases: readonly EvalCaseResult[];
}

export interface ReleaseGateResult {
  readonly passed: boolean;
  readonly blockedBy: readonly ("contract" | "quality")[];
}

const terminalEventTypes = new Set([
  "run.completed",
  "run.awaiting_input",
  "run.awaiting_approval",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
]);

function isRecord(value: EvalJsonValue): value is { [key: string]: EvalJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: EvalJsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function eventBelongsToTrace(event: EvalEvent, traceId: string): boolean {
  if (event.streamId === traceId) {
    return true;
  }
  if (!isRecord(event.payload) || event.payload.runId !== traceId) {
    return false;
  }
  return event.streamId.startsWith(`tool:${traceId}:`)
    || event.streamId.startsWith("effect:");
}

function compareEvents(left: EvalEvent, right: EvalEvent): number {
  return Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.streamId.localeCompare(right.streamId)
    || left.seq - right.seq
    || left.id.localeCompare(right.id);
}

function orderedEvents(events: readonly EvalEvent[]): EvalEvent[] {
  return [...events].sort(compareEvents);
}

function validateEvidence(evidence: EvalEvidence): ContractFailureReason | undefined {
  if (evidence.traceId.length === 0 || evidence.events.length === 0) {
    return "invalid_evidence";
  }
  try {
    evidence.events.forEach((event) => parseCanonicalEvent(event));
    evidence.artifacts.forEach((artifact) => parseArtifact(artifact));
  } catch {
    return "invalid_evidence";
  }
  const firstEvent = evidence.events[0]!;
  if (evidence.events.some((event) =>
    event.workspaceId !== firstEvent.workspaceId
    || event.channelId !== firstEvent.channelId
    || (
      !eventBelongsToTrace(event, evidence.traceId)
    ))) {
    return "invalid_evidence";
  }
  if (evidence.artifacts.some((artifact) =>
    artifact.workspaceId !== firstEvent.workspaceId
    || artifact.channelId !== firstEvent.channelId
    || artifact.runId !== evidence.traceId)) {
    return "invalid_evidence";
  }
  const sequences = evidence.events.map((event) => `${event.streamId}:${event.seq}`);
  const eventIds = evidence.events.map((event) => event.id);
  if (
    new Set(sequences).size !== sequences.length
    || new Set(eventIds).size !== eventIds.length
  ) {
    return "invalid_evidence";
  }
  if (evidence.trace !== undefined && evidence.trace.traceId !== evidence.traceId) {
    return "invalid_evidence";
  }
  return undefined;
}

function eventPayload(event: EvalEvent): { [key: string]: EvalJsonValue } {
  return isRecord(event.payload) ? event.payload : {};
}

export function evaluateContract(
  evidence: EvalEvidence,
  options: ContractEvalOptions = {},
): ContractEvalResult {
  const checkedEventIds = orderedEvents(evidence.events)
    .map((event) => event.id);
  const invalidReason = validateEvidence(evidence);
  if (invalidReason !== undefined) {
    return {
      passed: false,
      version: options.version ?? "contract-1",
      reason: invalidReason,
      failedRules: [invalidReason],
      checkedEventIds,
    };
  }

  const events = orderedEvents(evidence.events);
  const eventTypes = new Set(events.map((event) => event.type));
  const failedRules: string[] = [];
  let reason: ContractFailureReason | undefined;

  for (const requiredType of options.requiredEventTypes ?? []) {
    if (!eventTypes.has(requiredType)) {
      failedRules.push(`required_event:${requiredType}`);
      reason ??= "missing_required_event";
    }
  }

  const prohibitedKeys = new Set(options.prohibitedEffectKeys ?? []);
  if (prohibitedKeys.size > 0) {
    for (const event of events) {
      if (!event.type.startsWith("tool.effect.")) {
        continue;
      }
      const effectKey = stringValue(eventPayload(event).effectKey)
        ?? stringValue(eventPayload(event).effect_key);
      if (effectKey !== undefined && prohibitedKeys.has(effectKey)) {
        failedRules.push(`prohibited_effect:${effectKey}`);
        reason ??= "prohibited_side_effect";
      }
    }
  }

  const artifactKinds = new Set(evidence.artifacts
    .filter((artifact) => artifact.validationStatus === "passed")
    .map((artifact) => artifact.kind));
  for (const requiredKind of options.requiredArtifactKinds ?? []) {
    if (!artifactKinds.has(requiredKind)) {
      failedRules.push(`required_artifact:${requiredKind}`);
      reason ??= "missing_required_artifact";
    }
  }

  if ((options.requireTerminal ?? true) && !events.some((event) => terminalEventTypes.has(event.type))) {
    failedRules.push("required_terminal_event");
    reason ??= "missing_terminal_event";
  }

  const orphanedSpan = evidence.trace?.spans.some((span) =>
    span.status === "error" && span.attributes?.["anna.orphaned"] === true,
  ) ?? false;
  if (orphanedSpan) {
    failedRules.push("orphaned_trace");
    reason ??= "orphaned_trace";
  }

  return {
    passed: failedRules.length === 0,
    version: options.version ?? "contract-1",
    ...(reason === undefined ? {} : { reason }),
    failedRules,
    checkedEventIds,
  };
}

function assertRubric(rubric: EvalRubric): void {
  if (rubric.id.length === 0 || rubric.version.length === 0 || rubric.criteria.length === 0) {
    throw new Error("Eval rubric must define an id, version, and criteria");
  }
  if (!(rubric.passingScore >= 0 && rubric.passingScore <= 1)) {
    throw new Error("Eval rubric passingScore must be between 0 and 1");
  }
  const ids = new Set<string>();
  for (const criterion of rubric.criteria) {
    if (criterion.id.length === 0 || criterion.description.length === 0 || !(criterion.weight > 0)) {
      throw new Error("Eval rubric criteria must define positive weights");
    }
    if (ids.has(criterion.id)) {
      throw new Error(`Eval rubric criterion is duplicated: ${criterion.id}`);
    }
    ids.add(criterion.id);
  }
}

function scoreFor(scores: Readonly<Record<string, number>>, id: string): number {
  const score = scores[id];
  if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`Quality Eval score is missing or invalid: ${id}`);
  }
  return score;
}

export function evaluateQuality(
  evidence: EvalEvidence,
  options: QualityEvalOptions,
): QualityEvalResult {
  const invalidReason = validateEvidence(evidence);
  if (invalidReason !== undefined) {
    throw new Error(`Quality Eval evidence is invalid: ${invalidReason}`);
  }
  assertRubric(options.rubric);
  const totalWeight = options.rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0);
  const weightedScore = options.rubric.criteria.reduce(
    (total, criterion) => total + scoreFor(options.scores, criterion.id) * criterion.weight,
    0,
  ) / totalWeight;
  const cacheInput = {
    evidence: {
      ...evidence,
      events: orderedEvents(evidence.events),
      artifacts: [...evidence.artifacts].sort((left, right) => left.id.localeCompare(right.id)),
    },
    promptVersion: options.promptVersion,
    modelVersion: options.modelVersion,
    rubric: options.rubric,
    scores: options.scores,
  };
  const cacheKey = `quality:${createHash("sha256").update(stableJson(cacheInput)).digest("hex")}`;
  const failedCriteria = options.rubric.criteria
    .filter((criterion) => scoreFor(options.scores, criterion.id) < options.rubric.passingScore)
    .map((criterion) => criterion.id);

  return {
    passed: weightedScore >= options.rubric.passingScore,
    score: weightedScore,
    cacheKey,
    promptVersion: options.promptVersion,
    modelVersion: options.modelVersion,
    rubricId: options.rubric.id,
    rubricVersion: options.rubric.version,
    failedCriteria,
  };
}

export function materializeRegressionCase(input: {
  readonly evidence: EvalEvidence;
  readonly contract: ContractEvalResult;
  readonly quality?: QualityEvalResult;
}): RegressionCase {
  const traceFailure = input.evidence.trace?.spans.some((span) =>
    span.status === "error" && span.attributes?.["anna.orphaned"] === true,
  ) ?? false;
  const contractFailure = input.contract.failedRules.some((rule) => rule !== "orphaned_trace");
  const qualityFailure = input.quality !== undefined && !input.quality.passed;
  const failureCount = Number(traceFailure) + Number(contractFailure) + Number(qualityFailure);
  if (failureCount === 0) {
    throw new Error("Regression Case requires a failed Eval");
  }
  const classification: RegressionClassification = failureCount > 1
    ? "mixed_failure"
    : traceFailure
      ? "trace_failure"
      : contractFailure
        ? "contract_failure"
        : "quality_failure";
  const sourceEventIds = orderedEvents(input.evidence.events)
    .map((event) => event.id);
  return {
    id: `regression:${input.evidence.traceId}:${classification}`,
    sourceTraceId: input.evidence.traceId,
    classification,
    sourceEventIds,
    contract: input.contract,
    ...(input.quality === undefined ? {} : { quality: input.quality }),
  };
}

function smokeEvidence(caseId: string, scenario = "completion"): EvalEvidence {
  const traceId = `smoke:${caseId}`;
  const middleEvents = scenario === "completion"
    ? [
      { type: "run.progress", payload: { phase: "model_response_started" } },
      { type: "run.progress", payload: { phase: "turn_finished", usage: { input: 8, output: 3 } } },
    ]
    : scenario === "artifact"
      ? [{ type: "artifact.validated", payload: { artifactId: `${caseId}:artifact`, validationStatus: "passed" } }]
      : scenario === "memory"
      ? [{ type: "memory.hit", payload: { runId: traceId, sourceRunId: "source-run", sourceEventIds: ["source-event"] } }]
      : scenario === "approval"
        ? [{ type: "tool.approval.requested", payload: { runId: traceId, approvalId: `${caseId}:approval` } }]
        : [];
  const terminalType = scenario === "approval" ? "run.awaiting_approval" : "run.completed";
  return {
    traceId,
    events: [
      parseCanonicalEvent({
        id: `${caseId}:started`,
        workspaceId: "workspace-eval-fixture",
        channelId: "channel-eval-fixture",
        streamId: `smoke:${caseId}`,
        seq: 0,
        type: "run.started",
        timestamp: "2026-08-20T00:00:00.000Z",
        schemaVersion: 1,
        payload: {},
      }),
      ...middleEvents.map((middle, index) => parseCanonicalEvent({
        id: `${caseId}:middle:${index}`,
        workspaceId: "workspace-eval-fixture",
        channelId: "channel-eval-fixture",
        streamId: traceId,
        seq: index + 1,
        type: middle.type,
        timestamp: `2026-08-20T00:00:0${index + 1}.500Z`,
        schemaVersion: 1,
        payload: middle.payload,
      })),
      parseCanonicalEvent({
        id: `${caseId}:completed`,
        workspaceId: "workspace-eval-fixture",
        channelId: "channel-eval-fixture",
        streamId: traceId,
        seq: middleEvents.length + 1,
        type: terminalType,
        timestamp: `2026-08-20T00:00:0${middleEvents.length + 1}.000Z`,
        schemaVersion: 1,
        payload: {},
      }),
    ],
    artifacts: [parseArtifact({
      id: `${caseId}:artifact`,
      workspaceId: "workspace-eval-fixture",
      channelId: "channel-eval-fixture",
      runId: `smoke:${caseId}`,
      kind: "smoke_artifact",
      uri: `artifact://${caseId}`,
      hash: `sha256:${caseId}`,
      version: "1",
      validationStatus: "passed",
      reviewState: "accepted",
    })],
    metrics: { stability: 1, latencyMs: 1000, cost: 0 },
  };
}

const fixtureRubric: EvalRubric = {
  id: "eval-fixture",
  version: "1",
  criteria: [{ id: "evidence", description: "Evidence is complete", weight: 1 }],
  passingScore: 0.8,
};

function evalCase(
  caseId: string,
  evidence: EvalEvidence,
  contractOptions: ContractEvalOptions = {},
): EvalCaseResult {
  return {
    caseId,
    evidence,
    contract: evaluateContract(evidence, {
      requiredArtifactKinds: ["smoke_artifact"],
      ...contractOptions,
    }),
    quality: evaluateQuality(evidence, {
      promptVersion: "fixture-prompt-1",
      modelVersion: "fixture-model-1",
      rubric: fixtureRubric,
      scores: { evidence: 1 },
    }),
  };
}

export function runSmokeSet(): readonly EvalCaseResult[] {
  return Object.freeze(["completion", "artifact", "memory", "approval"].map((caseId) =>
    evalCase(caseId, smokeEvidence(caseId, caseId)),
  ));
}

export function runDevSet(): readonly EvalCaseResult[] {
  const cases = Array.from({ length: 16 }, (_, index) => {
    const caseId = `dev-${String(index + 1).padStart(2, "0")}`;
    const evidence = smokeEvidence(caseId, ["completion", "artifact", "memory", "approval"][index % 4]);
    if (index === 15) {
      const prohibitedEvent = parseCanonicalEvent({
        id: `${caseId}:prohibited-effect`,
        workspaceId: "workspace-eval-fixture",
        channelId: "channel-eval-fixture",
        streamId: evidence.traceId,
        seq: 1,
        type: "tool.effect.succeeded",
        timestamp: "2026-08-20T00:00:01.000Z",
        schemaVersion: 1,
        payload: { effectKey: "prohibited" },
      });
      const shiftedEvents = evidence.events.slice(1).map((event) => parseCanonicalEvent({
        ...event,
        seq: event.seq + 1,
      }));
      return evalCase(caseId, {
        ...evidence,
        events: [
          evidence.events[0]!,
          prohibitedEvent,
          ...shiftedEvents,
        ],
      }, { prohibitedEffectKeys: ["prohibited"] });
    }
    return evalCase(caseId, evidence);
  });
  return Object.freeze(cases);
}

export function evaluateReleaseGate(input: {
  readonly contract: ContractEvalResult;
  readonly quality?: QualityEvalResult;
}): ReleaseGateResult {
  const blockedBy: ("contract" | "quality")[] = [];
  if (!input.contract.passed) {
    blockedBy.push("contract");
  }
  if (input.quality !== undefined && !input.quality.passed) {
    blockedBy.push("quality");
  }
  return { passed: blockedBy.length === 0, blockedBy };
}

export function summarizeEvalSet(
  setId: string,
  cases: readonly EvalCaseResult[],
): EvalSetReport {
  const passed = cases.filter((item) => item.contract.passed && (item.quality?.passed ?? true)).length;
  const metrics = cases.map((item) => item.evidence.metrics).filter((metric): metric is NonNullable<typeof metric> => metric !== undefined);
  const average = (key: "stability" | "latencyMs" | "cost"): number | undefined => {
    const values = metrics.map((metric) => metric[key]).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const qualityScores = cases.map((item) => item.quality?.score).filter((score): score is number => score !== undefined);
  return {
    setId,
    total: cases.length,
    passed,
    blocked: cases.length - passed,
    ...(average("stability") === undefined ? {} : { stability: average("stability") }),
    ...(qualityScores.length === 0 ? {} : { quality: qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length }),
    ...(average("latencyMs") === undefined ? {} : { latencyMs: average("latencyMs") }),
    ...(average("cost") === undefined ? {} : { cost: average("cost") }),
    cases,
  };
}
