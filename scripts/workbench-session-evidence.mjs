import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRound = "wb00-baseline-20260910-r5";
const baselineDataset = "wb00-dataset-v1.1";
const roundId = process.env.ANNA_WB01_EVAL_ROUND_ID
  ?? `wb01-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(roundId)) throw new Error("invalid_eval_round_id");
const roundRoot = join(repositoryRoot, "evals/workbench/wb01/runs", roundId);
const evidenceRoot = join(roundRoot, "evidence");
const runtimeReceiptRoot = join(evidenceRoot, "runtime-receipts");
const privateRoot = join(repositoryRoot, ".tmp-tests/wb01/evidence", roundId);
const ownedPaths = ["scripts/workbench-session-evidence.mjs", "scripts/workbench-session-evidence.test.mjs", ".github/workflows/ci.yml", "package.json"];
const migrationTest = "test/workbench-session-migration.test.ts";
const pythonTest = "tests/business/test_workbench_scope.py";
const generatedAt = new Date().toISOString();
await mkdir(dirname(roundRoot), { recursive: true });
await mkdir(roundRoot);
await mkdir(evidenceRoot);
await mkdir(runtimeReceiptRoot);
await mkdir(privateRoot, { recursive: true });
async function run(program, args, env = process.env) {
  const command = [program, ...args].join(" ");
  try {
    const result = await exec(program, args, { cwd: repositoryRoot, env, maxBuffer: 20 * 1024 * 1024 });
    return { command, exitCode: 0, output: `${result.stdout}${result.stderr ?? ""}` };
  } catch (error) {
    return { command, exitCode: typeof error.code === "number" ? error.code : 1, output: `${error.stdout ?? ""}${error.stderr ?? error.message ?? ""}` };
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
async function gitFacts(ownedFileHashes, sourceFileHashes = []) {
  const head = await run("git", ["rev-parse", "HEAD"]);
  const status = await run("git", ["status", "--short", "--untracked-files=all", "--", ...ownedPaths]);
  const diff = await run("git", ["diff", "--no-ext-diff", "--binary", "--", ...ownedPaths]);
  const material = `${status.output}\n${diff.output}\n${JSON.stringify(ownedFileHashes)}\n${JSON.stringify(sourceFileHashes)}`;
  return {
    sourceSha: head.exitCode === 0 ? head.output.trim() : "unavailable",
    dirtyDiffDigest: `sha256:${createHash("sha256").update(material).digest("hex")}`,
    dirtySummary: status.output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(0, 2)).join(",") || "clean",
    ownedFileHashes,
  };
}
async function runtimeFacts() {
  try {
    const manifestPath = join(repositoryRoot, "build/omp-runtime/darwin-arm64/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return { ompManifestSha256: manifest.sha256 ?? "unavailable" };
  } catch {
    return { ompManifestSha256: "unavailable" };
  }
}
async function existing(paths) {
  const result = [];
  for (const path of paths) {
    const target = path.startsWith("test/")
      ? join(repositoryRoot, "apps/harness-service", path)
      : join(repositoryRoot, path);
    try { await access(target); result.push(path); } catch { /* explicit not_run below */ }
  }
  return result;
}
async function collectTsTests() {
  const names = (await readdir(join(repositoryRoot, "apps/harness-service/test"))).filter((name) => /^workbench-session-.*\.test\.ts$/.test(name)).sort().map((name) => `test/${name}`);
  return [...new Set([...names, migrationTest, "test/workbench-admission-failure.test.ts"])].sort((left, right) => left.localeCompare(right));
}
async function collectSourcePaths() {
  const src = (await readdir(join(repositoryRoot, "apps/harness-service/src"))).filter((name) => /^workbench-.*\.ts$/.test(name)).sort().map((name) => `apps/harness-service/src/${name}`);
  const tests = (await collectTsTests()).map((path) => `apps/harness-service/${path}`);
  return [
    "apps/harness-service/src/product-session.ts", "apps/harness-service/src/product-facade.ts", "apps/harness-service/src/main.ts", "services/api/app/main.py", "services/api/app/routes/business.py", "tests/business/test_workbench_scope.py", "package.json", "apps/harness-service/package.json", "package-lock.json", "uv.lock", ...src,
    "apps/harness-service/test/workbench-session-fixture.ts", ...tests,
  ];
}
const receipts = [];
const tsTests = await collectTsTests();
const sourcePathsBefore = await collectSourcePaths();
const sourceHeadBefore = (await run("git", ["rev-parse", "HEAD"])).output.trim() || "unavailable";
const sourceHashesBefore = await hashFiles(sourcePathsBefore);
const ownedHashesBefore = await hashFiles(ownedPaths);
const presentTsTests = await existing(tsTests);
const missingTsTests = tsTests.filter((path) => !presentTsTests.includes(path));
if (presentTsTests.length > 0) {
  const result = await run("npm", ["run", "test", "--workspace=@anna/harness-service", "--", "--run", ...presentTsTests], { ...process.env, ANNA_WB01_RECEIPT_DIR: runtimeReceiptRoot });
  const safeOutput = redact(result.output);
  await writeFile(join(privateRoot, "ts.log"), safeOutput, "utf8");
  receipts.push({ id: "ts-session-contract", command: result.command, exitCode: result.exitCode, status: result.exitCode === 0 ? "pass" : "fail", testSummary: testSummary(safeOutput), tests: presentTsTests });
}
for (const path of missingTsTests) {
  receipts.push({ id: `missing-${path.split("/").at(-1)}`, command: "not_run: required test file missing", exitCode: null, status: "not_run", blockingReason: "required_test_not_generated", tests: [path] });
}
const pythonResult = await run("uv", ["run", "pytest", "-q", pythonTest]);
const safePythonOutput = redact(pythonResult.output);
await writeFile(join(privateRoot, "python.log"), safePythonOutput, "utf8");
receipts.push({ id: "python-scope", command: pythonResult.command, exitCode: pythonResult.exitCode, status: pythonResult.exitCode === 0 ? "pass" : "fail", testSummary: testSummary(safePythonOutput), tests: [pythonTest] });
const sourcePathsAfter = await collectSourcePaths();
const sourceHashesAfter = await hashFiles(sourcePathsAfter);
const ownedHashesAfter = await hashFiles(ownedPaths);
const sourceHeadAfter = (await run("git", ["rev-parse", "HEAD"])).output.trim() || "unavailable";
const sourcePathChanged = JSON.stringify(sourcePathsBefore) !== JSON.stringify(sourcePathsAfter);
const sourceChanged = sourcePathChanged || sourceHeadBefore !== sourceHeadAfter || JSON.stringify(sourceHashesBefore) !== JSON.stringify(sourceHashesAfter);
const ownedChanged = JSON.stringify(ownedHashesBefore) !== JSON.stringify(ownedHashesAfter);
const [ownedFileHashes, runtime] = await Promise.all([ownedHashesAfter, runtimeFacts()]);
const git = await gitFacts(ownedFileHashes, sourceHashesAfter);
const baselineResult = JSON.parse(await readFile(join(repositoryRoot, "evals/workbench/wb00/runs", baselineRound, "evidence/baseline-result.json"), "utf8"));
if (baselineResult.datasetVersion !== baselineDataset) throw new Error("baseline_dataset_mismatch");
for (const receipt of receipts) await writeFile(join(evidenceRoot, `receipt-${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
const commandFailed = receipts.some((receipt) => receipt.status === "fail");
const missingRequired = missingTsTests.length > 0;
const result = {
  schemaVersion: 1,
  specVersion: "1.2",
  wbTicket: "WB-01",
  requirementIds: ["R-03", "R-15", "R-17"],
  acceptanceIds: ["AC-03", "AC-15", "AC-17a", "AC-18b"],
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
  sourceShaBefore: sourceHeadBefore,
  sourceShaAfter: sourceHeadAfter,
  sourceChanged,
  ownedHashesBefore,
  ownedHashesAfter,
  ownedChanged,
  implementationBoundary: "Session/Run/Scope contract focused checks and Python scope; product implementation remains separately reviewed.",
  evidenceModes: ["D"],
  runTestCoverage: presentTsTests.includes("test/workbench-session-run.test.ts") ? "included_in_focused_ts_command" : "not_run",
  oStatus: "metadata_only; supervisor owns final O scope",
  platform: `${process.platform}-${process.arch}`,
  ...runtime,
  runtimeModelConfigFingerprint: "unavailable",
  usage: "unavailable",
  engineeringModel: "controller:gpt-6-astra/xhigh;coding:gpt-5.6-luna/xhigh",
  externalStatus: { provider: "blocked: EXT-PROVIDER", mcp: "blocked: EXT-MCP-READ", package: "not_run" },
  baseline_delta: `Against wb00-baseline-20260910-r5: adds D Session/Scope/admission/Python checks; migration is ${receipts.find((receipt) => receipt.tests?.includes(migrationTest))?.status ?? "not_run"}, O is metadata-only, L/M are blocked, P is not_run.`,
  generatedAt,
  receipts: receipts.map(({ id, command, exitCode, status, testSummary, tests, blockingReason }) => ({ id, command, exitCode, status, testSummary, tests, blockingReason })),
  status: commandFailed || missingRequired || sourceChanged || ownedChanged ? "fail" : "pass",
  blockingReason: sourceChanged || ownedChanged ? "source_changed_during_run" : missingRequired ? "required_test_not_generated" : commandFailed ? "focused_command_failed" : null,
};
await writeFile(join(evidenceRoot, "increment-result.json"), `${JSON.stringify(result, null, 2)}\n`);
const manifestEnv = { ...process.env, ANNA_EVIDENCE_CASE_ID: "wb01-session-increment", ANNA_EVIDENCE_GENERATED_AT: generatedAt, ANNA_EVIDENCE_MODE: "D", ANNA_EVIDENCE_PROVIDER: "blocked", ANNA_EVIDENCE_GIT_HEAD: git.sourceSha };
const manifest = await run(process.execPath, [join(repositoryRoot, "scripts/build-evidence-manifest.mjs"), evidenceRoot], manifestEnv);
if (manifest.exitCode !== 0) throw new Error("evidence_manifest_build_failed");
const verified = await run(process.execPath, [join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), join(evidenceRoot, "manifest.json")]);
if (verified.exitCode !== 0) throw new Error("evidence_manifest_verify_failed");
process.stdout.write(`${JSON.stringify({ ok: result.status === "pass", evalRoundId: roundId, evidenceRoot: relative(repositoryRoot, evidenceRoot), status: result.status })}\n`);
if (result.status !== "pass") process.exitCode = 1;
