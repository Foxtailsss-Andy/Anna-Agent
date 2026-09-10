import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRound = "wb00-baseline-20260910-r5";
const baselineDataset = "wb00-dataset-v1.1";
const roundId = process.env.ANNA_WB02_EVAL_ROUND_ID
  ?? `wb02-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(roundId)) throw new Error("invalid_eval_round_id");

const roundRoot = join(repositoryRoot, "evals/workbench/wb02/runs", roundId);
const evidenceRoot = join(roundRoot, "evidence");
const runtimeReceiptRoot = join(evidenceRoot, "runtime-receipts");
const privateRoot = join(repositoryRoot, ".tmp-tests/wb02/evidence", roundId);
const requiredTsTest = "test/workbench-capability-loading.test.ts";
const requiredSkillTests = [
  "test/workbench-capability-skills.test.ts",
  "test/workbench-capability-skill-restore.test.ts",
];
const requiredPythonTest = "tests/contracts/test_workbench_capabilities.py";
const ownedPaths = [
  "scripts/workbench-capability-evidence.mjs",
  "scripts/workbench-capability-evidence.test.mjs",
  ".github/workflows/ci.yml",
  "package.json",
  "apps/harness-service/src/production.ts",
  "apps/harness-service/src/workbench-capabilities.ts",
  "apps/harness-service/src/workbench-skills.ts",
  "packages/harness-v2/src/index.ts",
  "packages/harness-v2/src/run-profile.ts",
  "packages/harness-v2/src/skill-catalog.ts",
  "apps/harness-service/test/workbench-capability-skills.test.ts",
  "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
];

// Round creation is intentionally exclusive. Do this before any evidence work
// so a reused ID cannot overwrite an earlier failed or partial round.
await mkdir(dirname(roundRoot), { recursive: true });
await mkdir(roundRoot);
await mkdir(evidenceRoot);
await mkdir(runtimeReceiptRoot, { mode: 0o700 });
await mkdir(privateRoot, { recursive: true });

const generatedAt = new Date().toISOString();

async function run(program, args, env = process.env) {
  const command = [program, ...args].join(" ");
  try {
    const result = await exec(program, args, {
      cwd: repositoryRoot,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { command, exitCode: 0, output: `${result.stdout}${result.stderr ?? ""}` };
  } catch (error) {
    return {
      command,
      exitCode: typeof error.code === "number" ? error.code : 1,
      output: `${error.stdout ?? ""}${error.stderr ?? error.message ?? ""}`,
    };
  }
}

function redact(output) {
  return output
    .replace(/\/(?:Users|private|tmp|var\/folders)\/[^\s\r\n]*/g, "<local-path>")
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9._-]+/gi, "<redacted>");
}

function testSummary(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    /(?:Test Files|Tests|passed|failed|PASS|FAIL)/i.test(line));
  return lines.slice(-6).join(" | ") || "no test summary emitted";
}

function snapshotHash(paths, hashes) {
  return `sha256:${createHash("sha256").update(JSON.stringify({ paths, hashes })).digest("hex")}`;
}

async function hashFiles(paths) {
  const files = [];
  for (const path of paths) {
    try {
      const bytes = await readFile(join(repositoryRoot, path));
      files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), present: true });
    } catch {
      files.push({ path, sha256: null, present: false });
    }
  }
  return files;
}

async function filesBelow(relativeRoot, predicate = () => true) {
  const absoluteRoot = join(repositoryRoot, relativeRoot);
  const output = [];
  async function visit(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const absolute = join(current, entry.name);
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(absolute, relativePath);
      else if (entry.isFile() && predicate(relativePath)) output.push(relativePath);
    }
  }
  await visit(absoluteRoot, relativeRoot);
  return output;
}

async function collectCapabilityTests() {
  const tsTests = (await filesBelow("apps/harness-service/test", (path) =>
    /^apps\/harness-service\/test\/workbench-capability-.*\.test\.ts$/.test(path))).map((path) =>
    path.slice("apps/harness-service/".length));
  const pythonTests = (await filesBelow("tests/contracts", (path) =>
    /(?:workbench[-_]capabilit|capabilit).*\.py$/.test(path)));
  return {
    tsTests: [...new Set(tsTests)].sort((left, right) => left.localeCompare(right)),
    pythonTests: [...new Set(pythonTests)].sort((left, right) => left.localeCompare(right)),
  };
}

async function collectSourcePaths() {
  const fixed = [
    "apps/harness-service/src/production.ts",
    "apps/harness-service/src/production-tools.ts",
    "apps/harness-service/src/product-session.ts",
    "apps/harness-service/src/product-facade.ts",
    "apps/harness-service/src/pi-kernel-build-identity.ts",
    "packages/harness-v2/src/capability-catalog.ts",
    "packages/harness-v2/src/index.ts",
    "packages/harness-v2/src/run-profile.ts",
    "apps/harness-service/test/workbench-session-fixture.ts",
    "packages/omp-loop-kernel/src/index.ts",
    "packages/omp-loop-kernel/src/kernel-identity.ts",
    "packages/omp-loop-kernel/src/kernel-source.ts",
    "packages/omp-loop-kernel/src/managed-launcher.ts",
    "packages/omp-loop-kernel/src/omp-loop-kernel.ts",
    "packages/omp-loop-kernel/src/protocol.ts",
    "packages/omp-loop-kernel/src/runtime-manifest.ts",
    "packages/omp-loop-kernel/src/worker-client.ts",
    "packages/omp-loop-kernel/runtime/protocol.ts",
    "packages/omp-loop-kernel/runtime/worker.ts",
    "services/api/app/routes/business.py",
    requiredPythonTest,
    "package.json",
    "package-lock.json",
    "apps/harness-service/package.json",
    "packages/omp-loop-kernel/package.json",
    "packages/omp-loop-kernel/runtime/package.json",
    "packages/omp-loop-kernel/runtime/package-lock.json",
    "uv.lock",
    ...ownedPaths,
  ];
  const harnessModules = await filesBelow("apps/harness-service/src", (path) =>
    /(?:workbench-|capabilit|run-profile).*\.ts$/.test(path));
  const harnessV2CapabilityModules = await filesBelow("packages/harness-v2/src", (path) =>
    /capabilit.*\.ts$/.test(path));
  const harnessTestFixtures = await filesBelow("apps/harness-service/test", (path) =>
    /workbench-capability-.*\.(?:ts|json|ya?ml|jsonl|csv)$/.test(path) && !/\.test\.ts$/.test(path));
  const contractFixtures = await filesBelow("tests/contracts", (path) =>
    /(?:fixture|workbench[-_]capabilit|capabilit).*\.(?:py|json|ya?ml|jsonl|csv)$/.test(path));
  const testFiles = await collectCapabilityTests();
  const registeredSkillDocuments = await filesBelow("skills", (path) => /\/SKILL\.md$/.test(path));
  return [...new Set([
    ...fixed,
    ...harnessModules,
    ...harnessV2CapabilityModules,
    ...harnessTestFixtures,
    ...contractFixtures,
    ...testFiles.tsTests.map((path) => `apps/harness-service/${path}`),
    ...testFiles.pythonTests,
    ...registeredSkillDocuments,
  ])].sort((left, right) => left.localeCompare(right));
}

async function gitHead() {
  const result = await run("git", ["rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.output.trim() : "unavailable";
}

async function gitFacts(sourceFileHashes) {
  const head = await gitHead();
  const status = await run("git", ["status", "--short", "--untracked-files=all", "--", ...ownedPaths]);
  const diff = await run("git", ["diff", "--no-ext-diff", "--binary", "--", ...ownedPaths]);
  const material = `${status.output}\n${diff.output}\n${JSON.stringify(sourceFileHashes)}`;
  return {
    sourceSha: head,
    dirtyDiffDigest: `sha256:${createHash("sha256").update(material).digest("hex")}`,
    dirtySummary: status.output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(0, 2)).join(",") || "clean",
  };
}

async function runtimeFacts() {
  try {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "build/omp-runtime/darwin-arm64/manifest.json"), "utf8"));
    return { ompManifestSha256: manifest.sha256 ?? "unavailable" };
  } catch {
    return { ompManifestSha256: "unavailable" };
  }
}

async function runTsTests(tsTests) {
  if (tsTests.length === 0) {
    return {
      command: "not_run: required test file missing",
      exitCode: null,
      output: "",
      status: "not_run",
      tests: [],
      testFileCount: 0,
      blockingReason: "required_test_not_generated",
    };
  }
  const result = await run(
    "npm",
    ["run", "test", "--workspace=@anna/harness-service", "--", "--run", ...tsTests],
    { ...process.env, ANNA_WB02_RECEIPT_DIR: runtimeReceiptRoot },
  );
  return {
    command: result.command,
    exitCode: result.exitCode,
    output: result.output,
    status: result.exitCode === 0 ? "pass" : "fail",
    tests: tsTests,
    testFileCount: tsTests.length,
  };
}

async function runPythonTest(pythonTests) {
  if (pythonTests.length === 0) {
    return {
      command: "not_run: required test file missing",
      exitCode: null,
      output: "",
      status: "not_run",
      tests: [requiredPythonTest],
      testFileCount: 0,
      blockingReason: "required_test_not_generated",
    };
  }
  const result = await run("uv", ["run", "pytest", "-q", ...pythonTests], {
    ...process.env,
    ANNA_WB02_RECEIPT_DIR: runtimeReceiptRoot,
  });
  return {
    command: result.command,
    exitCode: result.exitCode,
    output: result.output,
    status: result.exitCode === 0 ? "pass" : "fail",
    tests: pythonTests,
    testFileCount: pythonTests.length,
  };
}

const sourcePathsBefore = await collectSourcePaths();
const sourceHashesBefore = await hashFiles(sourcePathsBefore);
const sourceHeadBefore = await gitHead();
const ownedHashesBefore = await hashFiles(ownedPaths);
const discoveredBefore = await collectCapabilityTests();
const tsTests = discoveredBefore.tsTests;
const missingTsTests = [requiredTsTest, ...requiredSkillTests].filter((path) => !tsTests.includes(path));
const pythonTests = discoveredBefore.pythonTests;
const missingPythonTests = pythonTests.includes(requiredPythonTest) ? [] : [requiredPythonTest];

const tsResult = await runTsTests(tsTests);
const pythonResult = await runPythonTest(pythonTests);
await writeFile(join(privateRoot, "ts.log"), tsResult.output, "utf8");
await writeFile(join(privateRoot, "ts.exit"), `${tsResult.exitCode ?? "not_run"}\n`, "utf8");
await writeFile(join(privateRoot, "python.log"), pythonResult.output, "utf8");
await writeFile(join(privateRoot, "python.exit"), `${pythonResult.exitCode ?? "not_run"}\n`, "utf8");

const sourcePathsAfter = await collectSourcePaths();
const sourceHashesAfter = await hashFiles(sourcePathsAfter);
const sourceHeadAfter = await gitHead();
const ownedHashesAfter = await hashFiles(ownedPaths);
const sourcePathChanged = JSON.stringify(sourcePathsBefore) !== JSON.stringify(sourcePathsAfter);
const sourceChanged = sourcePathChanged
  || sourceHeadBefore !== sourceHeadAfter
  || JSON.stringify(sourceHashesBefore) !== JSON.stringify(sourceHashesAfter);
const ownedChanged = JSON.stringify(ownedHashesBefore) !== JSON.stringify(ownedHashesAfter);
const modulesHashBefore = snapshotHash(sourcePathsBefore, sourceHashesBefore);
const modulesHashAfter = snapshotHash(sourcePathsAfter, sourceHashesAfter);
const [git, runtime] = await Promise.all([gitFacts(sourceHashesAfter), runtimeFacts()]);

const baselinePath = join(repositoryRoot, "evals/workbench/wb00/runs", baselineRound, "evidence/baseline-result.json");
const baselineResult = JSON.parse(await readFile(baselinePath, "utf8"));
if (baselineResult.datasetVersion !== baselineDataset) throw new Error("baseline_dataset_mismatch");

const receipts = [
  {
    id: "ts-workbench-capabilities",
    command: tsResult.command,
    exitCode: tsResult.exitCode,
    status: tsResult.status,
    testSummary: testSummary(redact(tsResult.output)),
    tests: tsResult.tests,
    testFileCount: tsResult.testFileCount,
    evidenceModes: ["D"],
    ...(tsResult.blockingReason === undefined ? {} : { blockingReason: tsResult.blockingReason }),
  },
  {
    id: "python-workbench-capabilities",
    command: pythonResult.command,
    exitCode: pythonResult.exitCode,
    status: pythonResult.status,
    testSummary: testSummary(redact(pythonResult.output)),
    tests: pythonResult.tests,
    testFileCount: pythonResult.testFileCount,
    evidenceModes: ["D"],
    ...(pythonResult.blockingReason === undefined ? {} : { blockingReason: pythonResult.blockingReason }),
  },
];
for (const receipt of receipts) {
  await writeFile(join(evidenceRoot, `receipt-${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}
for (const path of missingTsTests) {
  const receipt = {
    id: `missing-${path.split("/").at(-1)}`,
    command: "not_run: required test file missing",
    exitCode: null,
    status: "not_run",
    testSummary: "not_run: required test file missing",
    tests: [path],
    testFileCount: 0,
    evidenceModes: ["D"],
    blockingReason: "required_test_not_generated",
  };
  receipts.push(receipt);
  await writeFile(join(evidenceRoot, `receipt-${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}
for (const path of missingPythonTests) {
  const receipt = {
    id: `missing-${path.split("/").at(-1)}`,
    command: "not_run: required test file missing",
    exitCode: null,
    status: "not_run",
    testSummary: "not_run: required test file missing",
    tests: [path],
    testFileCount: 0,
    evidenceModes: ["D"],
    blockingReason: "required_test_not_generated",
  };
  receipts.push(receipt);
  await writeFile(join(evidenceRoot, `receipt-${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

const commandFailed = receipts.some((receipt) => receipt.status === "fail");
const missingRequired = missingTsTests.length > 0 || missingPythonTests.length > 0;
const counts = { pass: 0, fail: 0, blocked: 0, not_run: 0 };
for (const receipt of receipts) {
  if (receipt.status in counts) counts[receipt.status] += 1;
}
const result = {
  schemaVersion: 1,
  specVersion: "1.2",
  wbTicket: "WB-02",
  requirementIds: ["R-01", "R-04", "R-05", "R-15", "R-18"],
  acceptanceIds: ["AC-01", "AC-04", "AC-05", "AC-15", "AC-18b"],
  evaluationBaselineId: "wb00-baseline-20260910",
  baselineRound,
  datasetVersion: baselineDataset,
  evalRoundId: roundId,
  runtimeReceiptPath: "runtime-receipts",
  ...git,
  sourceScopePathsBefore: sourcePathsBefore,
  sourceScopePathsAfter: sourcePathsAfter,
  sourceHashesBefore,
  sourceHashesAfter,
  modulesHashBefore,
  modulesHashAfter,
  sourceShaBefore: sourceHeadBefore,
  sourceShaAfter: sourceHeadAfter,
  sourceChanged,
  ownedHashesBefore,
  ownedHashesAfter,
  ownedChanged,
  implementationBoundary: "WB-02 capability contract evidence entry; runtime product receipt writers remain responsible for receipts.",
  evidenceModes: ["D"],
  evidenceStatus: { D: "recorded", O: "metadata_only", L: "blocked", M: "blocked", P: "not_run" },
  oStatus: "metadata_only; supervisor owns final O scope",
  lStatus: "blocked",
  mStatus: "blocked",
  pStatus: "not_run",
  platform: `${process.platform}-${process.arch}`,
  ...runtime,
  runtimeModelConfigFingerprint: "unavailable",
  usage: "unavailable",
  engineeringModel: "controller:gpt-6-astra/xhigh;coding:gpt-5.6-luna/xhigh",
  testDiscovery: {
    ts: {
      required: [requiredTsTest, ...requiredSkillTests],
      discovered: tsTests,
      missing: missingTsTests,
      testFileCount: tsTests.length,
    },
    python: { required: requiredPythonTest, discovered: pythonTests, missing: missingPythonTests, testFileCount: pythonTests.length },
  },
  testFileCounts: { ts: tsResult.testFileCount, python: pythonResult.testFileCount, receipts: receipts.length },
  commands: [
    { command: tsResult.command, exitCode: tsResult.exitCode, testFileCount: tsResult.testFileCount, evidenceMode: "D" },
    { command: pythonResult.command, exitCode: pythonResult.exitCode, testFileCount: pythonResult.testFileCount, evidenceMode: "D" },
  ],
  baseline_delta: "Against wb00-baseline-20260910-r5 / wb00-dataset-v1.1: records WB-02 capability focused D checks; O is metadata-only, L/M are blocked, P is not_run.",
  generatedAt,
  receipts: receipts.map(({ id, command, exitCode, status, testSummary, tests, testFileCount, evidenceModes, blockingReason }) => ({ id, command, exitCode, status, testSummary, tests, testFileCount, evidenceModes, blockingReason })),
  summary: { counts, qualityGate: "AC-18b increment evidence only; final 36-slot quality gate is not applied here" },
  status: commandFailed || missingRequired || sourceChanged || ownedChanged ? "fail" : "pass",
  blockingReason: sourceChanged || ownedChanged
    ? "source_changed_during_run"
    : missingRequired
      ? "required_test_not_generated"
      : commandFailed
        ? "focused_command_failed"
        : null,
};

await writeFile(join(evidenceRoot, "source-snapshot.json"), `${JSON.stringify({
  sourceScopePathsBefore: sourcePathsBefore,
  sourceScopePathsAfter: sourcePathsAfter,
  sourceHashesBefore,
  sourceHashesAfter,
  modulesHashBefore,
  modulesHashAfter,
  sourceShaBefore: sourceHeadBefore,
  sourceShaAfter: sourceHeadAfter,
}, null, 2)}\n`);
await writeFile(join(evidenceRoot, "increment-result.json"), `${JSON.stringify(result, null, 2)}\n`);

const manifestEnv = {
  ...process.env,
  ANNA_EVIDENCE_CASE_ID: "wb02-capability-increment",
  ANNA_EVIDENCE_GENERATED_AT: generatedAt,
  ANNA_EVIDENCE_MODE: "D",
  ANNA_EVIDENCE_PROVIDER: "blocked",
  ANNA_EVIDENCE_GIT_HEAD: git.sourceSha,
};
const manifest = await run(process.execPath, [join(repositoryRoot, "scripts/build-evidence-manifest.mjs"), evidenceRoot], manifestEnv);
if (manifest.exitCode !== 0) throw new Error("evidence_manifest_build_failed");
const verified = await run(process.execPath, [join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), join(evidenceRoot, "manifest.json")]);
if (verified.exitCode !== 0) throw new Error("evidence_manifest_verify_failed");
process.stdout.write(`${JSON.stringify({ ok: result.status === "pass", evalRoundId: roundId, evidenceRoot: relative(repositoryRoot, evidenceRoot), status: result.status })}\n`);
if (result.status !== "pass") process.exitCode = 1;
