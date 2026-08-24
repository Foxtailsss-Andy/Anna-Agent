import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import {
  evaluateReleaseGate,
  materializeRegressionCase,
  runDevSet,
  runSmokeSet,
  summarizeEvalSet,
  type EvalCaseResult,
} from "../src/index";

const evidenceDirectory = process.env.ANNA_EVAL_EVIDENCE_DIR;
const exportFixtureEvidence = evidenceDirectory === undefined ? test.skip : test;

exportFixtureEvidence("exports auditable Smoke, Dev, and regression fixture evidence", async () => {
  const root = resolve(evidenceDirectory!);
  const casesDirectory = join(root, "cases");
  await mkdir(casesDirectory, { recursive: true });

  const smoke = runSmokeSet();
  const dev = runDevSet();
  const allCases = [
    ...smoke.map((item) => serializeCase("smoke", item)),
    ...dev.map((item) => serializeCase("dev", item)),
  ];
  for (const item of allCases) {
    await writeFile(
      join(casesDirectory, `${item.caseId}.json`),
      `${JSON.stringify(item, null, 2)}\n`,
      "utf8",
    );
  }

  const badCase = dev.find((item) => item.caseId === "dev-16");
  expect(badCase).toBeDefined();
  if (badCase === undefined) {
    throw new Error("missing_fixed_regression_case:dev-16");
  }
  const regression = materializeRegressionCase({
    evidence: badCase.evidence,
    contract: badCase.contract,
    quality: badCase.quality,
  });
  await writeFile(
    join(root, "regression-dev-16.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      suite: "anna-harness-v2",
      evidenceMode: "fixture",
      productionEvidence: false,
      regression,
      firstTraceDivergence: firstTraceDivergence(badCase),
    }, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    join(root, "ground-truth.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      suite: "anna-harness-v2",
      evidenceMode: "fixture",
      productionEvidence: false,
      smoke: {
        setId: "smoke",
        caseCount: 4,
        requiredPassed: 4,
      },
      dev: {
        setId: "dev",
        caseCount: 16,
        requiredPassed: 15,
        requiredBlocked: 1,
        regressionCaseId: "dev-16",
        expectedRegressionClassification: "contract_failure",
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const report = {
    schemaVersion: 1,
    suite: "anna-harness-v2",
    evidenceMode: "fixture",
    provider: "fixture",
    productionEvidence: false,
    metricsSource: "fixture_only_not_production",
    smoke: reportSet("smoke", smoke),
    dev: reportSet("dev", dev),
    regression: {
      caseId: badCase.caseId,
      classification: regression.classification,
      evidencePath: "regression-dev-16.json",
      firstTraceDivergence: firstTraceDivergence(badCase),
    },
  };
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  expect(smoke).toHaveLength(4);
  expect(dev).toHaveLength(16);
  expect(report.smoke.passed).toBe(4);
  expect(report.dev.passed).toBe(15);
  expect(report.dev.blocked).toBe(1);
  expect(regression.classification).toBe("contract_failure");
});

function serializeCase(setId: string, item: EvalCaseResult) {
  const releaseGate = evaluateReleaseGate(item);
  return {
    schemaVersion: 1,
    suite: "anna-harness-v2",
    setId,
    caseId: item.caseId,
    evidenceMode: "fixture",
    provider: "fixture",
    productionEvidence: false,
    traceId: item.evidence.traceId,
    evidence: item.evidence,
    contract: item.contract,
    ...(item.quality === undefined ? {} : { quality: item.quality }),
    releaseGate,
    toolTrajectory: item.evidence.events
      .filter((event) => event.type.startsWith("tool."))
      .map((event) => ({ id: event.id, type: event.type, seq: event.seq })),
    terminal: item.evidence.events.at(-1)?.type ?? null,
    metrics: item.evidence.metrics === undefined
      ? null
      : { ...item.evidence.metrics, source: "fixture", productionComparable: false },
    firstTraceDivergence: firstTraceDivergence(item),
  };
}

function reportSet(setId: string, cases: readonly EvalCaseResult[]) {
  const summary = summarizeEvalSet(setId, cases);
  return {
    setId: summary.setId,
    total: summary.total,
    passed: summary.passed,
    blocked: summary.blocked,
    stability: summary.stability ?? null,
    quality: summary.quality ?? null,
    latencyMs: null,
    cost: null,
    metricsSource: "fixture_only_not_production",
    cases: cases.map((item) => ({
      caseId: item.caseId,
      traceId: item.evidence.traceId,
      releaseGate: evaluateReleaseGate(item),
      terminal: item.evidence.events.at(-1)?.type ?? null,
      toolTrajectory: item.evidence.events
        .filter((event) => event.type.startsWith("tool."))
        .map((event) => event.type),
      firstTraceDivergence: firstTraceDivergence(item),
    })),
  };
}

function firstTraceDivergence(item: EvalCaseResult): {
  readonly eventId: string;
  readonly type: string;
  readonly reason: string;
} | null {
  const rule = item.contract.failedRules.find((value) => value.startsWith("prohibited_effect:"));
  if (rule === undefined) return null;
  const event = item.evidence.events.find((candidate) => candidate.type === "tool.effect.succeeded");
  if (event === undefined) return null;
  return {
    eventId: event.id,
    type: event.type,
    reason: rule,
  };
}
