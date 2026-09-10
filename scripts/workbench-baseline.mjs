import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRoot = join(repositoryRoot, "evals/workbench/wb00");
const codingEvidenceRoot = join(repositoryRoot, ".tmp-tests/wb00/coding");
const focusedTest = "apps/harness-service/test/workbench-baseline-omp.test.ts";
const focusedCommand = `npm run test --workspace=@anna/harness-service -- --run test/workbench-baseline-omp.test.ts`;
const focusedWorkspaceTest = "test/workbench-baseline-omp.test.ts";
const evalRoundId = process.env.ANNA_WB00_EVAL_ROUND_ID
  ?? `wb00-baseline-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
const outputRoot = resolve(process.env.ANNA_WB00_OUTPUT_DIR ?? join(baselineRoot, "runs", evalRoundId));
const evidenceRoot = join(outputRoot, "evidence");

// A round is an immutable evidence container. Create it exclusively before
// reading or running anything that could produce evidence; a reused round ID
// must fail without touching its existing files.
await mkdir(dirname(outputRoot), { recursive: true });
await mkdir(outputRoot);
await mkdir(evidenceRoot);
await mkdir(codingEvidenceRoot, { recursive: true });

const generatedAt = new Date().toISOString();
const dataset = JSON.parse(await readFile(join(baselineRoot, "dataset.json"), "utf8"));
const datasetBytes = await readFile(join(baselineRoot, "dataset.json"));
await writeFile(join(evidenceRoot, "dataset-snapshot.json"), datasetBytes, { flag: "wx" });
const runtimeManifestPath = join(repositoryRoot, "build/omp-runtime/darwin-arm64/manifest.json");
let runtimeManifestSha256 = "unavailable";
try {
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
  if (typeof runtimeManifest.sha256 === "string") runtimeManifestSha256 = runtimeManifest.sha256;
} catch {
  // The focused command records the missing runtime as a failed setup condition.
}
let ompVersion = "unavailable";
let bunVersion = "unavailable";
try {
  const runtimePackage = JSON.parse(await readFile(join(repositoryRoot, "packages/omp-loop-kernel/runtime/package.json"), "utf8"));
  const dependencyVersion = runtimePackage.dependencies?.["@oh-my-pi/pi-coding-agent"];
  if (typeof dependencyVersion === "string") ompVersion = dependencyVersion;
} catch {
  // Keep version unavailable when the pinned runtime package cannot be read.
}
try {
  const bun = await exec(join(repositoryRoot, "build/omp-runtime/darwin-arm64/bun"), ["--version"], { cwd: repositoryRoot });
  if (/^\d+\.\d+\.\d+$/.test(bun.stdout.trim())) bunVersion = bun.stdout.trim();
} catch {
  // Keep version unavailable when the prepared binary cannot be executed.
}

let sourceSha = "unavailable";
try {
  sourceSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
} catch {
  // Keep evidence valid when run outside a Git checkout.
}

let dirtyDiffMaterial = "unavailable";
let gitStatus = "unavailable";
try {
  const diff = (await exec("git", ["diff", "--no-ext-diff", "--binary"], { cwd: repositoryRoot })).stdout;
  gitStatus = (await exec("git", ["status", "--short", "--untracked-files=all"], { cwd: repositoryRoot })).stdout;
  dirtyDiffMaterial = `${diff}\n${gitStatus}`;
} catch {
  // Keep the digest unavailable when the checkout cannot provide Git facts.
}

let focusedExitCode = 1;
let focusedOutput = "";
try {
  const completed = await exec("npm", ["run", "test", "--workspace=@anna/harness-service", "--", "--run", focusedWorkspaceTest], {
    cwd: repositoryRoot,
    env: { ...process.env, ANNA_WB00_RECEIPT_DIR: evidenceRoot },
    maxBuffer: 20 * 1024 * 1024,
  });
  focusedExitCode = 0;
  focusedOutput = `${completed.stdout}${completed.stderr ?? ""}`;
} catch (error) {
  focusedExitCode = typeof error.code === "number" ? error.code : 1;
  focusedOutput = `${error.stdout ?? ""}${error.stderr ?? error.message ?? ""}`;
}
await writeFile(join(codingEvidenceRoot, "workbench-baseline-run.log"), focusedOutput, "utf8");
await writeFile(join(codingEvidenceRoot, "workbench-baseline-run.exit"), `${focusedExitCode}\n`, "utf8");

const statusByCase = {
  "L-01": { status: "blocked", evidenceModes: ["L"], blockingReason: "EXT-PROVIDER: no configured live model provider", actualOutcome: "No live provider attempt was made." },
  "L-02": { status: "blocked", evidenceModes: ["L"], blockingReason: "EXT-PROVIDER: no configured live model provider", actualOutcome: "No live provider attempt was made." },
  "L-03": { status: "blocked", evidenceModes: ["L"], blockingReason: "EXT-PROVIDER: no configured live model provider", actualOutcome: "No live provider attempt was made." },
  "L-04": { status: "blocked", evidenceModes: ["L"], blockingReason: "EXT-PROVIDER: no configured live model provider", actualOutcome: "Crew live question evidence remains unavailable." },
  "L-05": { status: "blocked", evidenceModes: ["L"], blockingReason: "EXT-PROVIDER: no configured live model provider", actualOutcome: "Crew live question evidence remains unavailable." },
  "L-06": { status: "blocked", evidenceModes: ["M"], blockingReason: "EXT-MCP-READ: no configured live Hiker/MCP connector", actualOutcome: "Cowork live connector readback remains unavailable." },
  "L-07": { status: "not_run", evidenceModes: ["D"], blockingReason: "No WB-00 CSV execution slot was run.", actualOutcome: "No attempt recorded; preserve the slot for a later ticket." },
  "L-08": { status: "not_run", evidenceModes: ["D"], blockingReason: "No WB-00 script repair execution slot was run.", actualOutcome: "No attempt recorded; preserve the slot for a later ticket." },
  "L-09": { status: "not_run", evidenceModes: ["D"], blockingReason: "No actual Create save and new-Session attempt was run in WB-00.", actualOutcome: "No attempt recorded; the fixed slot remains for a later live observation." },
  "L-10": { status: "not_run", evidenceModes: ["D"], blockingReason: "No actual Create save and new-Session attempt was run in WB-00.", actualOutcome: "No attempt recorded; the fixed slot remains for a later live observation." },
  "L-11": { status: "not_run", evidenceModes: ["D"], blockingReason: "Python Tool activation is a later WB-07 boundary.", actualOutcome: "No activation or execution attempt recorded." },
  "L-12": { status: "blocked", evidenceModes: ["L"], blockingReason: "EXT-PROVIDER: no configured live model provider", actualOutcome: "Crew Worker live delivery and review evidence remains unavailable." },
};

const slots = [];
for (const item of dataset.cases) {
  const baseline = statusByCase[item.caseId];
  for (let attemptIndex = 1; attemptIndex <= dataset.attemptsPerCase; attemptIndex += 1) {
    slots.push({
      caseId: item.caseId,
      attemptIndex,
      status: baseline.status,
      evidenceModes: baseline.evidenceModes,
      expectedOutcome: item.expectedEvidence,
      actualOutcome: baseline.actualOutcome,
      blockingReason: baseline.blockingReason,
      inputFixtureHash: `sha256:${sha256(item.inputFixture)}`,
      sourceWindow: item.sourceWindow,
      eventReceiptRefs: [],
      toolResultRefs: [],
      artifactHashes: [],
      validationResults: focusedExitCode === 0 ? ["focused_omp_baseline_passed"] : ["focused_omp_baseline_failed"],
      modelUsage: "unavailable",
      retryCount: 0,
      userInterventionCount: 0,
      baselineDelta: "initial WB-00 baseline",
    });
  }
}

const counts = { pass: 0, fail: 0, blocked: 0, not_run: 0 };
for (const slot of slots) counts[slot.status] += 1;

const ticketFiles = [
  focusedTest,
  "scripts/workbench-baseline.mjs",
  "scripts/workbench-baseline-verify.mjs",
  "scripts/workbench-baseline-integrity.test.mjs",
  "evals/workbench/wb00/dataset.json",
  "evals/workbench/wb00/fixtures/dataset-v1.json",
  "evals/workbench/wb00/README.md",
  "package.json",
  ".github/workflows/ci.yml",
];
const ticketFileDigests = {};
for (const relativePath of ticketFiles) {
  try {
    ticketFileDigests[relativePath] = `sha256:${sha256(await readFile(join(repositoryRoot, relativePath)))}`;
  } catch {
    ticketFileDigests[relativePath] = "unavailable";
  }
}

if (dirtyDiffMaterial !== "unavailable") {
  dirtyDiffMaterial += `\n${JSON.stringify(ticketFileDigests)}`;
}
const dirtyDiffDigest = dirtyDiffMaterial === "unavailable"
  ? "unavailable"
  : `sha256:${sha256(dirtyDiffMaterial)}`;

const observations = [
  {
    observationId: "OBS-CREATE-PROFILE-INTERSECTION",
    requirementIds: ["R-01", "R-02"],
    status: "fail",
    evidenceModes: ["D"],
    expectedOutcome: "Create can discover a general capability without a fixed artifact kind.",
    actualOutcome: "Public resolver removes tools outside the selected Skill; the current Create profile does not expose general workdir/web search tools.",
    receiptRefs: ["receipt-create-profile.json", "receipt-skill-intersection.json"],
  },
  {
    observationId: "OBS-OMP-ANSWER",
    requirementIds: ["R-01", "R-02"],
    status: "fail",
    evidenceModes: ["D"],
    expectedOutcome: "The OMP-backed control boundary accepts an answer signal.",
    actualOutcome: "OmpLoopKernel.answer() raises OmpKernelControlUnavailableError; ProductHost maps the live signal to 409 harness_signal_unavailable.",
    receiptRefs: ["receipt-omp-answer.json", "receipt-product-signal.json"],
  },
  {
    observationId: "OBS-OMP-PARALLEL-BARRIER",
    requirementIds: ["R-01", "R-02", "R-19"],
    status: focusedExitCode === 0 ? "pass" : "not_run",
    evidenceModes: ["D", "O"],
    expectedOutcome: "Two independent Runs overlap at the actual OMP provider transport barrier.",
    actualOutcome: focusedExitCode === 0 ? "Both synthetic Run IDs entered the same external transport barrier and completed through real OMP worker/EventStore/Gateway paths." : "Focused OMP baseline did not run to completion.",
    receiptRefs: focusedExitCode === 0 ? ["receipt-omp-parallel.json"] : [],
  },
];

const result = {
  schemaVersion: 1,
  specVersion: dataset.specVersion,
  wbTicket: "WB-00",
  requirementIds: ["R-01", "R-02", "R-17", "R-18", "R-19"],
  acceptanceIds: ["AC-18a"],
  evaluationBaselineId: dataset.evaluationBaselineId,
  evalRoundId,
  datasetVersion: dataset.datasetVersion,
  datasetSha256: `sha256:${sha256(datasetBytes)}`,
  datasetSnapshotPath: "dataset-snapshot.json",
  sourceSha,
  dirtyDiffDigest,
  ticketFileDigests,
  implementationBoundary: {
    evidenceOwner: "WB-00 baseline fixture",
    runtimeAuthority: "Anna Node Harness Host -> OMP Loop Kernel",
    externalTransport: "deterministic model transport boundary fixture",
    internalState: "real OMP worker, Runtime, EventStore and Gateway",
    productObservation: "separate product observation command; not inferred here",
  },
  runtime: {
    platform: "darwin-arm64",
    ompVersion,
    bunVersion,
    runtimeManifestSha256,
    dependencyLockSha256: "see OMP descriptor/runtime manifest; not duplicated here",
  },
  runtimeModelConfigFingerprint: "unavailable",
  engineeringModelFingerprint: "controller:gpt-6-astra/xhigh;coding:gpt-5.6-luna/xhigh",
  usage: "unavailable",
  generatedAt,
  testStartedAt: generatedAt,
  commands: [{ command: focusedCommand, exitCode: focusedExitCode, evidenceMode: "D+O" }],
  observations,
  slots,
  summary: {
    denominator: slots.length,
    successfulAttempts: counts.pass,
    counts,
    qualityGate: "AC-18a baseline only; final 33/36 gate is not applied here",
  },
};

await writeFile(join(evidenceRoot, "baseline-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(join(evidenceRoot, "runtime-lock.json"), `${JSON.stringify({
  schemaVersion: 1,
  platform: "darwin-arm64",
  ompVersion,
  bunVersion,
  runtimeManifestSha256,
  runtimeModelConfigFingerprint: "unavailable",
  usage: "unavailable",
}, null, 2)}\n`, "utf8");

const manifestEnv = {
  ...process.env,
  ANNA_EVIDENCE_CASE_ID: dataset.evaluationBaselineId,
  ANNA_EVIDENCE_GENERATED_AT: generatedAt,
  ANNA_EVIDENCE_MODE: "baseline",
  ANNA_EVIDENCE_PROVIDER: "unavailable",
  ANNA_EVIDENCE_GIT_HEAD: sourceSha === "unavailable" ? "" : sourceSha,
};
await exec(process.execPath, [join(repositoryRoot, "scripts/build-evidence-manifest.mjs"), evidenceRoot], {
  cwd: repositoryRoot,
  env: manifestEnv,
});
await exec(process.execPath, [join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), join(evidenceRoot, "manifest.json")], {
  cwd: repositoryRoot,
});

process.stdout.write(`${JSON.stringify({
  ok: focusedExitCode === 0,
  evidenceRoot,
  baseline: dataset.evaluationBaselineId,
  denominator: slots.length,
  counts,
  focusedExitCode,
})}\n`);
if (focusedExitCode !== 0) process.exitCode = focusedExitCode;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
