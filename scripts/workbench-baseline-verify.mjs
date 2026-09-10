import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRoot = resolve(process.argv[2] ?? join(repositoryRoot, "evals/workbench/wb00"));
let runRoot = process.env.ANNA_WB00_RUN_DIR === undefined ? undefined : resolve(process.env.ANNA_WB00_RUN_DIR);
if (runRoot === undefined) {
  try {
    const runs = (await readdir(join(baselineRoot, "runs"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    runRoot = runs.length === 0 ? undefined : join(baselineRoot, "runs", runs.at(-1));
  } catch {
    runRoot = undefined;
  }
}
const evidenceRoot = runRoot === undefined ? join(baselineRoot, "evidence") : join(runRoot, "evidence");
const resultPath = join(evidenceRoot, "baseline-result.json");

const result = JSON.parse(await readFile(resultPath, "utf8"));
const failures = [];

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

const EXPECTED_CASE_COUNT = 12;
const EXPECTED_ATTEMPTS_PER_CASE = 3;
const EXPECTED_DENOMINATOR = 36;
const EXPECTED_STATUSES = ["pass", "fail", "blocked", "not_run"];
const LEGACY_DATASET_VERSION = "wb00-dataset-v1";
let dataset = {};
let datasetBytes;
let datasetSource = "missing";
const datasetSnapshotPath = join(evidenceRoot, "dataset-snapshot.json");
try {
  datasetBytes = await readFile(datasetSnapshotPath);
  dataset = JSON.parse(datasetBytes.toString("utf8"));
  datasetSource = "round";
} catch (error) {
  if (error.code !== "ENOENT") failures.push(`dataset snapshot unreadable:${error.message}`);
  try {
    const fallbackPath = join(baselineRoot, "fixtures/dataset-v1.json");
    datasetBytes = await readFile(fallbackPath);
    dataset = JSON.parse(datasetBytes.toString("utf8"));
    datasetSource = "legacy-fallback";
  } catch (fallbackError) {
    failures.push(`dataset snapshot missing:${fallbackError.message}`);
  }
}
const expectedDatasetSha256 = datasetBytes === undefined
  ? "unavailable"
  : `sha256:${createHash("sha256").update(datasetBytes).digest("hex")}`;
requireCondition(result.datasetSha256 === expectedDatasetSha256, "result.datasetSha256");
if (datasetSource === "round") {
  requireCondition(result.datasetSnapshotPath === "dataset-snapshot.json", "result.datasetSnapshotPath");
} else if (datasetSource === "legacy-fallback") {
  requireCondition(result.datasetVersion === LEGACY_DATASET_VERSION, "legacy dataset version");
}
const caseIds = Array.isArray(dataset.cases) ? dataset.cases.map((item) => item.caseId) : [];
const slots = Array.isArray(result.slots) ? result.slots : [];
const declaredStatuses = Array.isArray(dataset.slotPolicy?.statusValues) ? dataset.slotPolicy.statusValues : [];
const allowedStatuses = new Set(EXPECTED_STATUSES);
const expectedSlotKeys = new Set();

requireCondition(dataset.schemaVersion === 1, "dataset.schemaVersion");
requireCondition(result.schemaVersion === 1, "result.schemaVersion");
requireCondition(result.specVersion === dataset.specVersion, "result.specVersion");
requireCondition(result.datasetVersion === dataset.datasetVersion, "result.datasetVersion");
requireCondition(result.evaluationBaselineId === dataset.evaluationBaselineId, "result.evaluationBaselineId");
requireCondition(typeof result.evalRoundId === "string" && result.evalRoundId.length > 0, "result.evalRoundId");
requireCondition(dataset.attemptsPerCase === EXPECTED_ATTEMPTS_PER_CASE, "dataset attemptsPerCase");
requireCondition(dataset.fixedDenominator === EXPECTED_DENOMINATOR, "dataset fixedDenominator");
requireCondition(JSON.stringify(declaredStatuses) === JSON.stringify(EXPECTED_STATUSES), "dataset status values");
requireCondition(caseIds.length === EXPECTED_CASE_COUNT && new Set(caseIds).size === EXPECTED_CASE_COUNT, "dataset must contain 12 unique cases");
const scoringKeys = { pass: "success", fail: "failure", blocked: "blocked", not_run: "not_run" };
for (const scoringKey of Object.values(scoringKeys)) {
  requireCondition(typeof dataset.scoring?.[scoringKey] === "string" && dataset.scoring[scoringKey].length > 0, `dataset scoring:${scoringKey}`);
}
for (const item of dataset.cases ?? []) {
  requireCondition(typeof item.caseId === "string" && item.caseId.length > 0, "dataset case id");
  requireCondition(typeof item.surface === "string" && item.surface.length > 0, `dataset surface:${item.caseId}`);
  requireCondition(typeof item.task === "string" && item.task.length > 0, `dataset task:${item.caseId}`);
  requireCondition(typeof item.inputFixture === "string" && item.inputFixture.length > 0, `dataset input fixture:${item.caseId}`);
  requireCondition(typeof item.sourceWindow === "string" && item.sourceWindow.length > 0, `dataset source window:${item.caseId}`);
  requireCondition(typeof item.expectedEvidence === "string" && item.expectedEvidence.length > 0, `dataset expected evidence:${item.caseId}`);
}
requireCondition(slots.length === EXPECTED_DENOMINATOR, "result slot denominator");
requireCondition(Array.isArray(result.commands) && result.commands.length > 0, "result.commands");
requireCondition(typeof result.sourceSha === "string" && result.sourceSha.length > 0, "result.sourceSha");
requireCondition(typeof result.dirtyDiffDigest === "string" && (result.dirtyDiffDigest === "unavailable" || /^sha256:[0-9a-f]{64}$/.test(result.dirtyDiffDigest)), "result.dirtyDiffDigest");
requireCondition(result.runtime?.ompVersion === "18.0.11" || result.runtime?.ompVersion === "unavailable", "result.runtime.ompVersion");
requireCondition(result.runtime?.bunVersion === "1.3.14" || result.runtime?.bunVersion === "unavailable", "result.runtime.bunVersion");
requireCondition(result.runtime?.runtimeManifestSha256 === "unavailable" || /^sha256:[0-9a-f]{64}$/.test(result.runtime?.runtimeManifestSha256 ?? ""), "result.runtime.runtimeManifestSha256");
requireCondition(result.runtimeModelConfigFingerprint === "unavailable" || typeof result.runtimeModelConfigFingerprint === "string", "runtime model fingerprint");
requireCondition(result.engineeringModelFingerprint === "controller:gpt-6-astra/xhigh;coding:gpt-5.6-luna/xhigh", "engineering model fingerprint");

for (const caseId of caseIds) {
  for (let attemptIndex = 1; attemptIndex <= dataset.attemptsPerCase; attemptIndex += 1) {
    expectedSlotKeys.add(`${caseId}:${attemptIndex}`);
  }
}

const actualSlotKeys = new Set();
const datasetByCase = new Map((dataset.cases ?? []).map((item) => [item.caseId, item]));
for (const slot of slots) {
  const key = `${slot.caseId}:${slot.attemptIndex}`;
  requireCondition(!actualSlotKeys.has(key), `duplicate slot:${key}`);
  actualSlotKeys.add(key);
  requireCondition(expectedSlotKeys.has(key), `unexpected slot:${key}`);
  requireCondition(allowedStatuses.has(slot.status), `invalid status:${key}`);
  requireCondition(Array.isArray(slot.evidenceModes) && slot.evidenceModes.length > 0, `evidence modes:${key}`);
  requireCondition(typeof slot.expectedOutcome === "string" && slot.expectedOutcome.length > 0, `expected outcome:${key}`);
  requireCondition(typeof slot.actualOutcome === "string" && slot.actualOutcome.length > 0, `actual outcome:${key}`);
  const expectedInputHash = datasetByCase.has(slot.caseId)
    ? `sha256:${createHash("sha256").update(datasetByCase.get(slot.caseId).inputFixture).digest("hex")}`
    : "unavailable";
  requireCondition(slot.inputFixtureHash === expectedInputHash, `input fixture hash:${key}`);
  const datasetCase = datasetByCase.get(slot.caseId);
  requireCondition(slot.sourceWindow === datasetCase?.sourceWindow, `source window:${key}`);
  requireCondition(slot.expectedOutcome === datasetCase?.expectedEvidence, `expected outcome matches dataset:${key}`);
  requireCondition(Number.isInteger(slot.retryCount) && slot.retryCount >= 0, `retry_count:${key}`);
  if (["blocked", "not_run"].includes(slot.status)) {
    requireCondition(typeof slot.blockingReason === "string" && slot.blockingReason.length > 0, `blocking reason:${key}`);
  }
}
requireCondition(actualSlotKeys.size === expectedSlotKeys.size, "all fixed slots must be retained");

const counts = Object.fromEntries([...allowedStatuses].map((status) => [status, 0]));
for (const slot of slots) counts[slot.status] = (counts[slot.status] ?? 0) + 1;
for (const status of allowedStatuses) {
  requireCondition(result.summary?.counts?.[status] === counts[status], `summary count:${status}`);
}
requireCondition(result.summary?.denominator === EXPECTED_DENOMINATOR, "summary denominator");
requireCondition(result.summary?.successfulAttempts === counts.pass, "summary successful attempts");
requireCondition(Array.isArray(result.observations), "result.observations");
for (const observation of result.observations ?? []) {
  requireCondition(typeof observation.observationId === "string" && observation.observationId.length > 0, "observation id");
  requireCondition(["pass", "fail", "blocked", "not_run"].includes(observation.status), `observation status:${observation.observationId}`);
  for (const receipt of observation.receiptRefs ?? []) {
    try {
      await stat(join(evidenceRoot, receipt));
    } catch {
      failures.push(`observation receipt missing:${receipt}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, failures })}\n`);
  process.exitCode = 1;
} else {
  const manifest = join(evidenceRoot, "manifest.json");
  try {
    await exec(process.execPath, [join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), manifest], {
      cwd: repositoryRoot,
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, failures: ["evidence_manifest_invalid", error.message] })}\n`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    process.stdout.write(`${JSON.stringify({ ok: true, denominator: slots.length, counts })}\n`);
  }
}
