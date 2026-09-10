import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runner = join(repositoryRoot, "scripts/workbench-capability-evidence.mjs");
const roundRoot = (id) => join(repositoryRoot, "evals/workbench/wb02/runs", id);

test("WB-02 runner refuses an existing round without overwriting it", async () => {
  const id = `cli-test-${process.pid}-${Date.now()}`;
  const root = roundRoot(id);
  await mkdir(root, { recursive: true });
  const marker = join(root, "marker.txt");
  await writeFile(marker, "preserve-me\n");
  try {
    const result = await runNode(runner, { ANNA_WB02_EVAL_ROUND_ID: id });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /EEXIST|already exists/i);
    assert.equal(await readFile(marker, "utf8"), "preserve-me\n");
    assert.deepEqual(await readdir(root), ["marker.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WB-02 runner records missing required loading and Python tests as not_run", async () => {
  const id = `missing-test-${process.pid}-${Date.now()}`;
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anna-wb02-evidence-"));
  const fixtureScripts = join(fixtureRoot, "scripts");
  const baselineEvidence = join(fixtureRoot, "evals/workbench/wb00/runs/wb00-baseline-20260910-r5/evidence");
  await mkdir(fixtureScripts, { recursive: true });
  await mkdir(baselineEvidence, { recursive: true });
  await cp(runner, join(fixtureScripts, "workbench-capability-evidence.mjs"));
  await cp(join(repositoryRoot, "scripts/build-evidence-manifest.mjs"), join(fixtureScripts, "build-evidence-manifest.mjs"));
  await cp(join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), join(fixtureScripts, "verify-evidence-manifest.mjs"));
  await writeFile(join(baselineEvidence, "baseline-result.json"), JSON.stringify({ datasetVersion: "wb00-dataset-v1.1" }));
  const fixtureRunner = join(fixtureScripts, "workbench-capability-evidence.mjs");
  const root = join(fixtureRoot, "evals/workbench/wb02/runs", id);
  try {
    const result = await runNode(fixtureRunner, { ANNA_WB02_EVAL_ROUND_ID: id });
    assert.notEqual(result.code, 0);
    assert.ok(result.stdout || result.stderr, `runner emitted no diagnostics: ${JSON.stringify(result)}`);
    let evidenceText;
    try {
      evidenceText = await readFile(join(root, "evidence", "increment-result.json"), "utf8");
    } catch (error) {
      assert.fail(`runner did not produce increment result: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    }
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.datasetVersion, "wb00-dataset-v1.1");
    assert.equal(evidence.commands.length, 2);
    assert.ok(evidence.commands.every((command) => Number.isInteger(command.exitCode) || command.exitCode === null));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-loading.test.ts" && receipt.status === "not_run"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-test_workbench_capabilities.py" && receipt.status === "not_run"));
    assert.equal(evidence.oStatus, "metadata_only; supervisor owns final O scope");
    assert.equal(evidence.evidenceModes.length, 1);
    assert.equal(evidence.evidenceModes[0], "D");
    assert.equal(evidence.usage, "unavailable");
    assert.equal(evidence.ownedChanged, false);
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/src/production.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("packages/harness-v2/src/capability-catalog.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("packages/harness-v2/src/skill-catalog.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("packages/harness-v2/src/index.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("packages/harness-v2/src/run-profile.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/test/workbench-capability-skills.test.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/test/workbench-capability-skill-restore.test.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/test/workbench-session-fixture.ts"));
    assert.equal(evidence.sourceScopePathsBefore.includes("apps/harness-service/src/run-profile.ts"), false);
    assert.equal(evidence.sourceScopePathsBefore.includes("apps/harness-service/src/product-task.ts"), false);
    assert.match(evidence.modulesHashBefore, /^sha256:[0-9a-f]{64}$/);
    assert.match(evidence.modulesHashAfter, /^sha256:[0-9a-f]{64}$/);
    assert.equal(evidence.commands[0].testFileCount, 0);
    assert.equal(evidence.commands[1].testFileCount, 0);
    const manifest = JSON.parse(await readFile(join(root, "evidence", "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.files.some((entry) => entry.path === "source-snapshot.json"));
    assert.ok(manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("WB-02 required Python guard fails when another capability test is present", async () => {
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_other_capability.py"],
    tsFiles: ["apps/harness-service/test/workbench-capability-loading.test.ts"],
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.sourceChanged, false);
    assert.deepEqual(evidence.testDiscovery.python.discovered, ["tests/contracts/test_other_capability.py"]);
    assert.deepEqual(evidence.testDiscovery.python.missing, ["tests/contracts/test_workbench_capabilities.py"]);
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-test_workbench_capabilities.py" && receipt.status === "not_run"));
    assert.equal(evidence.status, "fail");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 Skill tests are independently required", async () => {
  const missingRestore = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skills.test.ts",
    ],
  });
  try {
    const result = await runNode(missingRestore.runner, missingRestore.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(missingRestore.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.deepEqual(evidence.testDiscovery.ts.missing, ["test/workbench-capability-skill-restore.test.ts"]);
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-skill-restore.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(missingRestore.root, { recursive: true, force: true });
  }

  const missingSkill = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
    ],
  });
  try {
    const result = await runNode(missingSkill.runner, missingSkill.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(missingSkill.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.deepEqual(evidence.testDiscovery.ts.missing, ["test/workbench-capability-skills.test.ts"]);
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-skills.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(missingSkill.root, { recursive: true, force: true });
  }
});

test("WB-02 source snapshot catches a changed capability core module while unchanged synthetic run passes", async () => {
  const passingFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skills.test.ts",
      "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
    ],
  });
  try {
    const result = await runNode(passingFixture.runner, passingFixture.env);
    assert.equal(result.code, 0);
    const evidence = await readEvidence(passingFixture.roundRoot);
    assert.equal(evidence.status, "pass");
    assert.equal(evidence.sourceChanged, false);
    assert.ok(evidence.sourceScopePathsBefore.includes("packages/harness-v2/src/skill-catalog.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/test/workbench-capability-skills.test.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/test/workbench-capability-skill-restore.test.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("skills/harness-v2/general-assistant/SKILL.md"));
  } finally {
    await rm(passingFixture.root, { recursive: true, force: true });
  }

  const changedFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skills.test.ts",
      "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
    ],
    mutatePath: "packages/harness-v2/src/capability-catalog.ts",
  });
  try {
    const result = await runNode(changedFixture.runner, changedFixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(changedFixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.sourceChanged, true);
    assert.equal(evidence.blockingReason, "source_changed_during_run");
    assert.notEqual(evidence.modulesHashBefore, evidence.modulesHashAfter);
    const catalog = await readFile(join(changedFixture.root, "packages/harness-v2/src/capability-catalog.ts"), "utf8");
    assert.match(catalog, /mutated-by-synthetic-stub/);
  } finally {
    await rm(changedFixture.root, { recursive: true, force: true });
  }

  const changedSkillFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skills.test.ts",
      "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
    ],
    mutatePath: "packages/harness-v2/src/skill-catalog.ts",
  });
  try {
    const result = await runNode(changedSkillFixture.runner, changedSkillFixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(changedSkillFixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.sourceChanged, true);
    assert.equal(evidence.blockingReason, "source_changed_during_run");
    assert.notEqual(evidence.modulesHashBefore, evidence.modulesHashAfter);
  } finally {
    await rm(changedSkillFixture.root, { recursive: true, force: true });
  }

  const changedSkillDocumentFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skills.test.ts",
      "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
    ],
    mutatePath: "skills/harness-v2/general-assistant/SKILL.md",
  });
  try {
    const result = await runNode(changedSkillDocumentFixture.runner, changedSkillDocumentFixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(changedSkillDocumentFixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.sourceChanged, true);
    assert.equal(evidence.blockingReason, "source_changed_during_run");
    assert.notEqual(evidence.modulesHashBefore, evidence.modulesHashAfter);
  } finally {
    await rm(changedSkillDocumentFixture.root, { recursive: true, force: true });
  }
});

async function createSyntheticFixture({ pythonFiles, tsFiles, mutatePath = null }) {
  const root = await mkdtemp(join(tmpdir(), "anna-wb02-synthetic-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const baselineEvidence = join(root, "evals/workbench/wb00/runs/wb00-baseline-20260910-r5/evidence");
  await mkdir(scripts, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(baselineEvidence, { recursive: true });
  await cp(runner, join(scripts, "workbench-capability-evidence.mjs"));
  await cp(join(repositoryRoot, "scripts/build-evidence-manifest.mjs"), join(scripts, "build-evidence-manifest.mjs"));
  await cp(join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), join(scripts, "verify-evidence-manifest.mjs"));
  await writeFile(join(baselineEvidence, "baseline-result.json"), JSON.stringify({ datasetVersion: "wb00-dataset-v1.1" }));
  for (const path of [
    ...pythonFiles,
    ...tsFiles,
    "packages/harness-v2/src/capability-catalog.ts",
    "packages/harness-v2/src/index.ts",
    "packages/harness-v2/src/skill-catalog.ts",
    "skills/harness-v2/general-assistant/SKILL.md",
  ]) {
    const target = join(root, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, `synthetic fixture: ${path}\n`);
  }
  const stubScript = (name) => join(bin, name);
  const gitStub = stubScript("git");
  const npmStub = stubScript("npm");
  const uvStub = stubScript("uv");
  await writeFile(gitStub, "#!/bin/sh\ncase \"$1\" in\n  rev-parse) printf 'synthetic-head\\n' ;;\n  *) : ;;\nesac\n");
  await writeFile(npmStub, "#!/bin/sh\nif [ -n \"${WB02_MUTATE_TARGET:-}\" ]; then printf 'mutated-by-synthetic-stub\\n' >> \"$WB02_MUTATE_TARGET\"; fi\nprintf 'synthetic npm\\n'\n");
  await writeFile(uvStub, "#!/bin/sh\nprintf 'synthetic uv\\n'\n");
  await Promise.all([chmod(gitStub, 0o755), chmod(npmStub, 0o755), chmod(uvStub, 0o755)]);
  const id = `synthetic-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    root,
    runner: join(scripts, "workbench-capability-evidence.mjs"),
    roundRoot: join(root, "evals/workbench/wb02/runs", id),
    env: {
      ANNA_WB02_EVAL_ROUND_ID: id,
      PATH: `${bin}:${process.env.PATH}`,
      ...(mutatePath === null ? {} : { WB02_MUTATE_TARGET: join(root, mutatePath) }),
    },
  };
}

async function readEvidence(roundRoot) {
  return JSON.parse(await readFile(join(roundRoot, "evidence", "increment-result.json"), "utf8"));
}

function runNode(script, env) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}
