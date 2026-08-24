import { expect, test } from "vitest";
import {
  parseArtifact,
  parseCanonicalEvent,
  type Artifact,
  type CanonicalEvent,
} from "@anna/harness-v2";

import {
  evaluateContract,
  evaluateReleaseGate,
  evaluateQuality,
  materializeRegressionCase,
  runDevSet,
  runSmokeSet,
  summarizeEvalSet,
  type EvalEvidence,
  type EvalRubric,
} from "../src/index";

function event(
  id: string,
  type: string,
  seq: number,
  payload: CanonicalEvent["payload"] = {},
): CanonicalEvent {
  return parseCanonicalEvent({
    id,
    workspaceId: "workspace-eval",
    channelId: "channel-eval",
    streamId: "run-eval-1",
    seq,
    type,
    timestamp: `2026-08-20T00:00:0${seq}.000Z`,
    schemaVersion: 1,
    payload,
  });
}

function artifact(
  validationStatus = "passed",
  runId = "run-eval-1",
): Artifact {
  return parseArtifact({
    id: "artifact-1",
    workspaceId: "workspace-eval",
    channelId: "channel-eval",
    runId,
    kind: "release_note",
    uri: "artifact://release-note",
    hash: "sha256:artifact",
    version: "1",
    validationStatus,
    reviewState: "accepted",
  });
}

const baseEvidence: EvalEvidence = {
  traceId: "run-eval-1",
  events: [
    event("event-1", "run.started", 0),
    event("event-2", "run.completed", 1),
  ],
  artifacts: [artifact()],
};

const rubric: EvalRubric = {
  id: "release-rubric",
  version: "1",
  criteria: [
    { id: "grounded", description: "Evidence is grounded", weight: 1 },
    { id: "complete", description: "Artifact is complete", weight: 1 },
  ],
  passingScore: 0.75,
};

test("Contract Eval blocks a prohibited side effect even when an Artifact is valid", () => {
  const result = evaluateContract({
    ...baseEvidence,
    events: [
      event("event-1", "run.started", 0),
      event("event-3", "tool.effect.succeeded", 1, {
        effectKey: "send-email",
        permissionMode: "full",
      }),
      event("event-2", "run.completed", 2),
    ],
  }, { prohibitedEffectKeys: ["send-email"] });

  expect(result).toMatchObject({ passed: false, reason: "prohibited_side_effect" });
});

test("Quality Eval cache identity changes when prompt, model, or rubric version changes", () => {
  const first = evaluateQuality(baseEvidence, {
    promptVersion: "prompt-1",
    modelVersion: "model-1",
    rubric,
    scores: { grounded: 1, complete: 1 },
  });
  const changed = evaluateQuality(baseEvidence, {
    promptVersion: "prompt-2",
    modelVersion: "model-1",
    rubric,
    scores: { grounded: 1, complete: 1 },
  });

  expect(first.passed).toBe(true);
  expect(changed.passed).toBe(true);
  expect(changed.cacheKey).not.toBe(first.cacheKey);
  expect(evaluateQuality(baseEvidence, {
    promptVersion: "prompt-1",
    modelVersion: "model-2",
    rubric,
    scores: { grounded: 1, complete: 1 },
  }).cacheKey).not.toBe(first.cacheKey);
  expect(evaluateQuality(baseEvidence, {
    promptVersion: "prompt-1",
    modelVersion: "model-1",
    rubric: { ...rubric, version: "2" },
    scores: { grounded: 1, complete: 1 },
  }).cacheKey).not.toBe(first.cacheKey);
});

test("Quality Eval cache identity is stable when canonical evidence arrives interleaved", () => {
  const toolEvent = parseCanonicalEvent({
    id: "tool-event-cache",
    workspaceId: "workspace-eval",
    channelId: "channel-eval",
    streamId: "tool:run-eval-1:cache",
    seq: 0,
    type: "tool.requested",
    timestamp: "2026-08-20T00:00:00.500Z",
    schemaVersion: 1,
    payload: { runId: "run-eval-1", toolCallId: "cache" },
  });
  const options = {
    promptVersion: "prompt-1",
    modelVersion: "model-1",
    rubric,
    scores: { grounded: 1, complete: 1 },
  };
  const ordered = evaluateQuality({ ...baseEvidence, events: [...baseEvidence.events, toolEvent] }, options);
  const reversed = evaluateQuality({ ...baseEvidence, events: [toolEvent, ...baseEvidence.events] }, options);

  expect(reversed.cacheKey).toBe(ordered.cacheKey);
});

test("Smoke Set has four deterministic cases and Dev Set has sixteen cases", () => {
  const smoke = runSmokeSet();
  const dev = runDevSet();

  expect(smoke).toHaveLength(4);
  expect(dev).toHaveLength(16);
  expect(smoke.every((item) => item.evidence.traceId.length > 0)).toBe(true);
  expect(dev.every((item) => item.contract.passed !== undefined)).toBe(true);
  expect(smoke.every((item) => evaluateReleaseGate(item).passed)).toBe(true);
  expect(dev.filter((item) => !evaluateReleaseGate(item).passed)).toHaveLength(1);

  const report = summarizeEvalSet("dev", dev);
  expect(report).toMatchObject({ total: 16, passed: 15, blocked: 1 });
  expect(report.stability).toBe(1);
  expect(report.quality).toBeDefined();
  expect(report.latencyMs).toBe(1000);
  expect(report.cost).toBe(0);
});

test("failed Trace materializes a regression case with canonical evidence and classification", () => {
  const failed = evaluateContract(baseEvidence, { requiredEventTypes: ["tool.requested"] });
  const regression = materializeRegressionCase({
    evidence: baseEvidence,
    contract: failed,
    quality: undefined,
  });

  expect(failed.passed).toBe(false);
  expect(regression).toMatchObject({
    sourceTraceId: "run-eval-1",
    classification: "contract_failure",
    sourceEventIds: ["event-1", "event-2"],
  });
});

test("release gate reports the blocking Eval layers", () => {
  const contract = evaluateContract(baseEvidence, { requiredEventTypes: ["tool.requested"] });
  const quality = evaluateQuality(baseEvidence, {
    promptVersion: "prompt-1",
    modelVersion: "model-1",
    rubric,
    scores: { grounded: 0, complete: 0 },
  });

  expect(evaluateReleaseGate({ contract, quality })).toEqual({
    passed: false,
    blockedBy: ["contract", "quality"],
  });
});

test("Contract Eval rejects cross-Run or failed Artifact evidence", () => {
  expect(evaluateContract({
    ...baseEvidence,
    artifacts: [artifact("passed", "run-other")],
  })).toMatchObject({ passed: false, reason: "invalid_evidence" });
  expect(evaluateContract({
    ...baseEvidence,
    artifacts: [artifact("failed")],
  }, { requiredArtifactKinds: ["release_note"] })).toMatchObject({
    passed: false,
    reason: "missing_required_artifact",
  });
});

test("Contract Eval accepts a Tool stream belonging to the same Run", () => {
  const toolEvent = parseCanonicalEvent({
    id: "tool-event-1",
    workspaceId: "workspace-eval",
    channelId: "channel-eval",
    streamId: "tool:run-eval-1:call-1",
    seq: 0,
    type: "tool.requested",
    timestamp: "2026-08-20T00:00:00.500Z",
    schemaVersion: 1,
    payload: { runId: "run-eval-1", toolCallId: "call-1" },
  });

  expect(evaluateContract({
    ...baseEvidence,
    events: [...baseEvidence.events, toolEvent],
  }, { requiredEventTypes: ["tool.requested"] })).toMatchObject({ passed: true });
});

test("Contract Eval rejects a cross-scope event that only spoofs the Run payload", () => {
  const foreignScopeEvent = parseCanonicalEvent({
    id: "foreign-scope-event",
    workspaceId: "workspace-other",
    channelId: "channel-eval",
    streamId: "tool:run-eval-1:foreign",
    seq: 0,
    type: "tool.requested",
    timestamp: "2026-08-20T00:00:00.500Z",
    schemaVersion: 1,
    payload: { runId: "run-eval-1", toolCallId: "foreign" },
  });

  expect(evaluateContract({
    ...baseEvidence,
    events: [...baseEvidence.events, foreignScopeEvent],
  })).toMatchObject({ passed: false, reason: "invalid_evidence" });
});

test("orphaned Trace is classified separately and passing evidence cannot create a regression", () => {
  const orphanedEvidence: EvalEvidence = {
    ...baseEvidence,
    trace: {
      traceId: baseEvidence.traceId,
      spans: [{
        spanId: "span-tool-1",
        kind: "tool",
        status: "error",
        attributes: { "anna.orphaned": true },
      }],
    },
  };
  const orphanedContract = evaluateContract(orphanedEvidence);
  expect(materializeRegressionCase({
    evidence: orphanedEvidence,
    contract: orphanedContract,
  }).classification).toBe("trace_failure");

  expect(() => materializeRegressionCase({
    evidence: baseEvidence,
    contract: evaluateContract(baseEvidence),
  })).toThrow("Regression Case requires a failed Eval");
});
