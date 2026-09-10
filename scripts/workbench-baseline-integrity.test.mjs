import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const baselineRoot = join(repositoryRoot, "evals/workbench/wb00");
const generatorPath = join(repositoryRoot, "scripts/workbench-baseline.mjs");
const verifierPath = join(repositoryRoot, "scripts/workbench-baseline-verify.mjs");
const manifestBuilderPath = join(repositoryRoot, "scripts/build-evidence-manifest.mjs");
const legacyDatasetPath = join(baselineRoot, "fixtures/dataset-v1.json");

test("WB-00 baseline refuses an existing round before writing or running tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-wb00-integrity-round-"));
  try {
    const round = join(root, "existing-round");
    await mkdir(round);
    const markerPath = join(round, "marker.txt");
    await writeFile(markerPath, "preserve-me\n", "utf8");

    const result = await runNode(generatorPath, [], { ANNA_WB00_OUTPUT_DIR: round });

    assert.notEqual(result.code, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /EEXIST|already exists/i);
    assert.equal(await readFile(markerPath, "utf8"), "preserve-me\n");
    assert.deepEqual(await readdir(round), ["marker.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WB-00 verifier accepts a round-owned complete dataset snapshot", async () => {
  const fixture = await copyHistoricalRound("wb00-baseline-20260910-r3");
  try {
    const result = await verifyRound(fixture);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"ok":true/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-00 verifier rejects task, expected evidence, source window, and scoring drift", async () => {
  const driftCases = [
    ["task", (dataset) => { dataset.cases.find((item) => item.caseId === "L-04").task = "drifted task"; }],
    ["expectedEvidence", (dataset) => { dataset.cases.find((item) => item.caseId === "L-04").expectedEvidence = "drifted evidence"; }],
    ["sourceWindow", (dataset) => { dataset.cases.find((item) => item.caseId === "L-04").sourceWindow = "drifted window"; }],
    ["scoring", (dataset) => { dataset.scoring.success = "drifted scoring"; }],
  ];

  for (const [field, mutate] of driftCases) {
    const fixture = await copyHistoricalRound("wb00-baseline-20260910-r3");
    try {
      const dataset = JSON.parse(await readFile(fixture.snapshotPath, "utf8"));
      mutate(dataset);
      await writeFile(fixture.snapshotPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
      const result = await verifyRound(fixture);
      assert.notEqual(result.code, 0, `${field} drift unexpectedly passed`);
      assert.match(`${result.stdout}\n${result.stderr}`, /result\.datasetSha256/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("WB-00 historical r3 and r4 verify through their version-and-hash-bound v1 fallback", async () => {
  for (const roundId of ["wb00-baseline-20260910-r3", "wb00-baseline-20260910-r4"]) {
    const runRoot = join(baselineRoot, "runs", roundId);
    const result = await runNode(verifierPath, [baselineRoot], { ANNA_WB00_RUN_DIR: runRoot });
    assert.equal(result.code, 0, `${roundId}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"ok":true/);
  }
});

test("WB-00 L-04/L-05/L-06/L-12 expose static synthetic comparison fixtures", async () => {
  const dataset = JSON.parse(await readFile(join(baselineRoot, "dataset.json"), "utf8"));
  const cases = new Map(dataset.cases.map((item) => [item.caseId, item]));
  for (const caseId of ["L-04", "L-05", "L-06", "L-12"]) {
    const item = cases.get(caseId);
    assert.ok(item?.fixture, `${caseId} fixture missing`);
    assert.equal(item.fixture.provenance?.kind, "synthetic_fixture", `${caseId} provenance`);
    assert.equal(item.fixture.provenance?.fixtureId?.startsWith("wb00-"), true, `${caseId} fixture id`);
  }
  assert.equal(cases.get("L-04").fixture.tasks[0].status, "delayed");
  assert.equal(cases.get("L-05").fixture.technicalProposal.body.includes("SQLite WAL"), true);
  assert.equal(cases.get("L-06").fixture.after.value - cases.get("L-06").fixture.before.value, 13500);
  assert.equal(cases.get("L-12").fixture.review.comment.includes("source column"), true);
});

async function copyHistoricalRound(roundId) {
  const root = await mkdtemp(join(tmpdir(), "anna-wb00-integrity-snapshot-"));
  const roundRoot = join(root, "runs", roundId);
  const evidenceRoot = join(roundRoot, "evidence");
  await mkdir(roundRoot, { recursive: true });
  await cp(join(baselineRoot, "runs", roundId, "evidence"), evidenceRoot, { recursive: true });
  const legacyBytes = await readFile(legacyDatasetPath);
  const resultPath = join(evidenceRoot, "baseline-result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  result.datasetSnapshotPath = "dataset-snapshot.json";
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const snapshotPath = join(evidenceRoot, "dataset-snapshot.json");
  await writeFile(snapshotPath, legacyBytes, { flag: "wx" });
  const manifest = await runNode(manifestBuilderPath, [evidenceRoot], {
    ANNA_EVIDENCE_CASE_ID: result.evaluationBaselineId,
    ANNA_EVIDENCE_MODE: "baseline",
    ANNA_EVIDENCE_PROVIDER: "unavailable",
    ANNA_EVIDENCE_GIT_HEAD: result.sourceSha,
  });
  assert.equal(manifest.code, 0, `${manifest.stdout}\n${manifest.stderr}`);
  return { root, roundRoot, evidenceRoot, snapshotPath };
}

async function verifyRound(fixture) {
  return runNode(verifierPath, [fixture.root], { ANNA_WB00_RUN_DIR: fixture.roundRoot });
}

function runNode(script, args, extraEnv = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolveResult({ code: null, stdout, stderr: `${stderr}\nprocess timeout` });
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code: signal === null ? code : null, stdout, stderr });
    });
  });
}
