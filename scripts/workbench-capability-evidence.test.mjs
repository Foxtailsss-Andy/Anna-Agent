import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runner = join(repositoryRoot, "scripts/workbench-capability-evidence.mjs");
const roundRoot = (id) => join(repositoryRoot, "evals/workbench/wb02/runs", id);
const requiredCapabilityTests = [
  "apps/harness-service/test/workbench-capability-loading.test.ts",
  "apps/harness-service/test/workbench-capability-skills.test.ts",
  "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
  "apps/harness-service/test/workbench-capability-public.test.ts",
  "apps/harness-service/test/workbench-capability-public-network.test.ts",
  "apps/harness-service/test/workbench-capability-files.test.ts",
  "apps/harness-service/test/workbench-capability-files-legacy.test.ts",
  "apps/harness-service/test/web-search.test.ts",
];
const requiredFileSourcePaths = [
  "apps/harness-service/src/workbench-files.ts",
  "services/api/app/routes/workdirs.py",
  "services/runtime/app/workdir_store.py",
  "services/api/app/main.py",
  "apps/harness-service/src/product-facade.ts",
  "services/api/app/routes/business.py",
  "apps/harness-service/src/production.ts",
  "apps/harness-service/src/production-tools.ts",
  "apps/harness-service/src/workbench-capabilities.ts",
  "apps/harness-service/test/workbench-capability-files-legacy.test.ts",
  "services/api/app/security.py",
  "services/api/app/routes/chat.py",
  "services/api/app/routes/create.py",
  "services/chat/app/orchestrator.py",
  "apps/desktop/src/lib/api/client.ts",
  "apps/desktop/src/lib/api/identity.ts",
  "apps/desktop/src/lib/runtime.ts",
];

test("WB-02 file capability checks are discovered, executed, and hashed independently", async () => {
  const fixture = await createSyntheticFixture({
    pythonFiles: [
      "tests/contracts/test_workbench_capabilities.py",
      "tests/contracts/test_workbench_files.py",
    ],
    tsFiles: requiredCapabilityTests,
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "pass");
    assert.deepEqual(evidence.testDiscovery.python.discovered, [
      "tests/contracts/test_workbench_capabilities.py",
      "tests/contracts/test_workbench_files.py",
    ]);
    assert.deepEqual(evidence.testDiscovery.python.missing, []);
    assert.ok(evidence.testDiscovery.ts.required.includes("test/workbench-capability-files.test.ts"));
    assert.ok(evidence.testDiscovery.ts.required.includes("test/workbench-capability-files-legacy.test.ts"));
    assert.ok(evidence.testDiscovery.ts.discovered.includes("test/workbench-capability-files.test.ts"));
    assert.ok(evidence.testDiscovery.ts.discovered.includes("test/workbench-capability-files-legacy.test.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/src/workbench-files.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/test/workbench-capability-files-legacy.test.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/api/app/routes/workdirs.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/runtime/app/workdir_store.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/api/app/main.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/harness-service/src/product-facade.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/api/app/routes/business.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/api/app/security.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/api/app/routes/chat.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/api/app/routes/create.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("services/chat/app/orchestrator.py"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/desktop/src/lib/api/client.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/desktop/src/lib/api/identity.ts"));
    assert.ok(evidence.sourceScopePathsBefore.includes("apps/desktop/src/lib/runtime.ts"));
    assert.ok(evidence.sourceHashesBefore.some((entry) => entry.path === "apps/harness-service/src/workbench-files.ts"));
    assert.ok(evidence.sourceHashesAfter.some((entry) => entry.path === "tests/contracts/test_workbench_files.py"));
    assert.equal(evidence.commands[0].testFileCount, requiredCapabilityTests.length);
    assert.equal(evidence.commands[1].testFileCount, 2);
    const privateRoot = join(fixture.root, ".tmp-tests/wb02/evidence", fixture.id);
    const tsCommand = JSON.parse(await readFile(join(privateRoot, "issue-ts-workbench-capabilities/command.json"), "utf8"));
    const pythonCommand = JSON.parse(await readFile(join(privateRoot, "issue-python-workbench-capabilities/command.json"), "utf8"));
    assert.ok(tsCommand.argv.includes("test/workbench-capability-files.test.ts"));
    assert.ok(pythonCommand.argv.includes("tests/contracts/test_workbench_files.py"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "ts-workbench-capabilities" && receipt.status === "pass"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "python-workbench-capabilities" && receipt.status === "pass"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(evidence.testDiscovery.python.missing, [
      "tests/contracts/test_workbench_capabilities.py",
      "tests/contracts/test_workbench_files.py",
    ]);
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-test_workbench_capabilities.py" && receipt.status === "not_run"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-test_workbench_files.py" && receipt.status === "not_run"));
    assert.equal(evidence.status, "fail");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 file Python test is independently required", async () => {
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: requiredCapabilityTests,
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.deepEqual(evidence.testDiscovery.python.missing, ["tests/contracts/test_workbench_files.py"]);
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-test_workbench_files.py" && receipt.status === "not_run"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 Skill tests are independently required", async () => {
  const missingRestore = await createSyntheticFixture({
    pythonFiles: [
      "tests/contracts/test_workbench_capabilities.py",
      "tests/contracts/test_workbench_files.py",
    ],
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
    assert.ok(evidence.testDiscovery.ts.missing.includes("test/workbench-capability-skill-restore.test.ts"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-skill-restore.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(missingRestore.root, { recursive: true, force: true });
  }

  const missingSkill = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: [
      "apps/harness-service/test/workbench-capability-loading.test.ts",
      "apps/harness-service/test/workbench-capability-skill-restore.test.ts",
      "apps/harness-service/test/workbench-capability-public.test.ts",
      "apps/harness-service/test/workbench-capability-public-network.test.ts",
    ],
  });
  try {
    const result = await runNode(missingSkill.runner, missingSkill.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(missingSkill.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.ok(evidence.testDiscovery.ts.missing.includes("test/workbench-capability-skills.test.ts"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-skills.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(missingSkill.root, { recursive: true, force: true });
  }
});

test("WB-02 public capability tests are independently required", async () => {
  for (const missing of [
    "apps/harness-service/test/workbench-capability-public.test.ts",
    "apps/harness-service/test/workbench-capability-public-network.test.ts",
  ]) {
    const fixture = await createSyntheticFixture({
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: requiredCapabilityTests.filter((path) => path !== missing),
    });
    try {
      const result = await runNode(fixture.runner, fixture.env);
      assert.notEqual(result.code, 0);
      const evidence = await readEvidence(fixture.roundRoot);
      const requiredPath = missing.slice("apps/harness-service/".length);
      assert.ok(evidence.testDiscovery.ts.missing.includes(requiredPath));
      assert.ok(evidence.receipts.some((receipt) => receipt.id === `missing-${missing.split("/").at(-1)}` && receipt.status === "not_run"));
      assert.equal(evidence.status, "fail");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("WB-02 file capability test is independently required", async () => {
  const missing = "apps/harness-service/test/workbench-capability-files.test.ts";
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests.filter((path) => path !== missing),
    missingSourcePath: missing,
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.ok(evidence.testDiscovery.ts.missing.includes("test/workbench-capability-files.test.ts"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-files.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 legacy file capability test is independently required", async () => {
  const missing = "apps/harness-service/test/workbench-capability-files-legacy.test.ts";
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests.filter((path) => path !== missing),
    missingSourcePath: missing,
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.ok(evidence.testDiscovery.ts.missing.includes("test/workbench-capability-files-legacy.test.ts"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-workbench-capability-files-legacy.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 web-search test is independently required", async () => {
  const missing = "apps/harness-service/test/web-search.test.ts";
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests.filter((path) => path !== missing),
    missingSourcePath: missing,
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.ok(evidence.testDiscovery.ts.missing.includes("test/web-search.test.ts"));
    assert.ok(evidence.receipts.some((receipt) => receipt.id === "missing-web-search.test.ts" && receipt.status === "not_run"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 missing public web module cannot pass with successful synthetic commands", async () => {
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
    missingSourcePath: "apps/harness-service/src/workbench-public-web.ts",
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.sourceChanged, false);
    assert.equal(evidence.blockingReason, "required_source_missing");
    assert.ok(evidence.requiredSourcePathsMissing.includes("apps/harness-service/src/workbench-public-web.ts"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const missingSourcePath of requiredFileSourcePaths) {
  test(`WB-02 required source guard rejects missing ${missingSourcePath}`, async () => {
    const fixture = await createSyntheticFixture({
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: requiredCapabilityTests,
      missingSourcePath,
    });
    try {
      const result = await runNode(fixture.runner, fixture.env);
      assert.notEqual(result.code, 0, `missing source unexpectedly passed: ${missingSourcePath}`);
      const evidence = await readEvidence(fixture.roundRoot);
      assert.equal(evidence.status, "fail");
      assert.equal(evidence.blockingReason, "required_source_missing");
      assert.ok(evidence.requiredSourcePathsMissing.includes(missingSourcePath));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("WB-02 public guards are independently killed by isolated guard mutations", async () => {
  const variants = [
    {
      name: "public-test-guard",
      testName: "WB-02 public capability tests are independently required",
      tsFiles: requiredCapabilityTests.filter((path) => path !== "apps/harness-service/test/workbench-capability-public.test.ts"),
      mutation: (source) => removeRequiredEntry(source, "test/workbench-capability-public.test.ts"),
    },
    {
      name: "public-network-test-guard",
      testName: "WB-02 public capability tests are independently required",
      tsFiles: requiredCapabilityTests.filter((path) => path !== "apps/harness-service/test/workbench-capability-public-network.test.ts"),
      mutation: (source) => removeRequiredEntry(source, "test/workbench-capability-public-network.test.ts"),
    },
    {
      name: "public-web-source-guard",
      testName: "WB-02 missing public web module cannot pass with successful synthetic commands",
      tsFiles: requiredCapabilityTests,
      missingSourcePath: "apps/harness-service/src/workbench-public-web.ts",
      mutation: (source) => removeRequiredSourceEntry(source, "apps/harness-service/src/workbench-public-web.ts"),
    },
    {
      name: "web-search-test-guard",
      testName: "WB-02 web-search test is independently required",
      tsFiles: requiredCapabilityTests.filter((path) => path !== "apps/harness-service/test/web-search.test.ts"),
      missingSourcePath: "apps/harness-service/test/web-search.test.ts",
      mutation: (source) => removeRequiredEntry(source, "test/web-search.test.ts"),
    },
  ];

  for (const variant of variants) {
    const current = await createSyntheticFixture({
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: variant.tsFiles,
      missingSourcePath: variant.missingSourcePath ?? null,
    });
    const mutant = await createSyntheticFixture({
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: variant.tsFiles,
      missingSourcePath: variant.missingSourcePath ?? null,
    });
    try {
      const mutantRunner = await readFile(mutant.runner, "utf8");
      await writeFile(mutant.runner, variant.mutation(mutantRunner), { flag: "w" });
      const testNamePattern = `--test-name-pattern=${variant.testName}`;
      const currentResult = await runNodeTest(join(current.root, "scripts/workbench-capability-evidence.test.mjs"), testNamePattern, current.env);
      assert.equal(currentResult.code, 0, `${variant.name} current guard failed\n${currentResult.stdout}\n${currentResult.stderr}`);
      const mutantResult = await runNodeTest(join(mutant.root, "scripts/workbench-capability-evidence.test.mjs"), testNamePattern, mutant.env);
      process.stdout.write(`WB-02 isolated mutation ${variant.name}: current_exit=${currentResult.code} mutant_exit=${mutantResult.code}\n`);
      assert.equal(mutantResult.code, 1, `${variant.name} mutation was not detected\n${mutantResult.stdout}\n${mutantResult.stderr}`);
    } finally {
      await rm(current.root, { recursive: true, force: true });
      await rm(mutant.root, { recursive: true, force: true });
    }
  }
});

test("WB-02 file guards are independently killed by isolated guard mutations", async () => {
  const variants = [
    {
      name: "file-ts-test-guard",
      testName: "WB-02 file capability test is independently required",
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: requiredCapabilityTests.filter((path) => path !== "apps/harness-service/test/workbench-capability-files.test.ts"),
      missingSourcePath: "apps/harness-service/test/workbench-capability-files.test.ts",
      mutation: (source) => removeRequiredEntry(source, "test/workbench-capability-files.test.ts"),
    },
    {
      name: "file-legacy-ts-test-guard",
      testName: "WB-02 legacy file capability test is independently required",
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: requiredCapabilityTests.filter((path) => path !== "apps/harness-service/test/workbench-capability-files-legacy.test.ts"),
      missingSourcePath: "apps/harness-service/test/workbench-capability-files-legacy.test.ts",
      mutation: (source) => removeRequiredEntry(source, "test/workbench-capability-files-legacy.test.ts"),
    },
    {
      name: "file-python-test-guard",
      testName: "WB-02 file Python test is independently required",
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
      tsFiles: requiredCapabilityTests,
      mutation: removeRequiredPythonFilesTest,
    },
  ];

  for (const variant of variants) {
    const current = await createSyntheticFixture({
      pythonFiles: variant.pythonFiles,
      tsFiles: variant.tsFiles,
      missingSourcePath: variant.missingSourcePath ?? null,
    });
    const mutant = await createSyntheticFixture({
      pythonFiles: variant.pythonFiles,
      tsFiles: variant.tsFiles,
      missingSourcePath: variant.missingSourcePath ?? null,
    });
    try {
      const mutantRunner = await readFile(mutant.runner, "utf8");
      await writeFile(mutant.runner, variant.mutation(mutantRunner), { flag: "w" });
      const testNamePattern = `--test-name-pattern=${variant.testName}`;
      const currentResult = await runNodeTest(join(current.root, "scripts/workbench-capability-evidence.test.mjs"), testNamePattern, current.env);
      assert.equal(currentResult.code, 0, `${variant.name} current guard failed\n${currentResult.stdout}\n${currentResult.stderr}`);
      const mutantResult = await runNodeTest(join(mutant.root, "scripts/workbench-capability-evidence.test.mjs"), testNamePattern, mutant.env);
      process.stdout.write(`WB-02 isolated mutation ${variant.name}: current_exit=${currentResult.code} mutant_exit=${mutantResult.code}\n`);
      assert.equal(mutantResult.code, 1, `${variant.name} mutation was not detected\n${mutantResult.stdout}\n${mutantResult.stderr}`);
    } finally {
      await rm(current.root, { recursive: true, force: true });
      await rm(mutant.root, { recursive: true, force: true });
    }
  }
});

for (const missingSourcePath of requiredFileSourcePaths) {
  const guardTestName = `WB-02 required source guard rejects missing ${missingSourcePath}`;
  test(`WB-02 source guard mutation is detected for ${missingSourcePath}`, async () => {
    const current = await createSyntheticFixture({
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: requiredCapabilityTests,
      missingSourcePath,
    });
    const mutant = await createSyntheticFixture({
      pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
      tsFiles: requiredCapabilityTests,
      missingSourcePath,
    });
    try {
      const mutantRunner = await readFile(mutant.runner, "utf8");
      await writeFile(mutant.runner, removeRequiredSourceEntry(mutantRunner, missingSourcePath), { flag: "w" });
      const testNamePattern = `--test-name-pattern=^${escapeRegExp(guardTestName)}$`;
      const currentResult = await runNodeTest(join(current.root, "scripts/workbench-capability-evidence.test.mjs"), testNamePattern, current.env);
      assert.equal(currentResult.code, 0, `source guard current failed for ${missingSourcePath}\n${currentResult.stdout}\n${currentResult.stderr}`);
      const mutantResult = await runNodeTest(join(mutant.root, "scripts/workbench-capability-evidence.test.mjs"), testNamePattern, mutant.env);
      process.stdout.write(`WB-02 isolated mutation file-source-guard-${missingSourcePath}: current_exit=${currentResult.code} mutant_exit=${mutantResult.code}\n`);
      assert.equal(mutantResult.code, 1, `source guard mutation was not detected for ${missingSourcePath}\n${mutantResult.stdout}\n${mutantResult.stderr}`);
    } finally {
      await rm(current.root, { recursive: true, force: true });
      await rm(mutant.root, { recursive: true, force: true });
    }
  });
}

test("WB-02 test commands retain direct stdout and stderr in exclusive private evidence", async () => {
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
    npmExit: 7,
    npmStdout: "synthetic-ts-stdout-secret",
    npmStderr: "synthetic-ts-stderr-secret",
    uvExit: 9,
    uvStdout: "synthetic-python-stdout-secret",
    uvStderr: "synthetic-python-stderr-secret",
  });
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(fixture.roundRoot);
    assert.equal(evidence.status, "fail");
    const privateRoot = join(fixture.root, ".tmp-tests/wb02/evidence", fixture.id);
    const tsDir = join(privateRoot, "issue-ts-workbench-capabilities");
    const pythonDir = join(privateRoot, "issue-python-workbench-capabilities");
    const tsCommand = JSON.parse(await readFile(join(tsDir, "command.json"), "utf8"));
    const pythonCommand = JSON.parse(await readFile(join(pythonDir, "command.json"), "utf8"));
    const tsExit = JSON.parse(await readFile(join(tsDir, "exit.json"), "utf8"));
    const pythonExit = JSON.parse(await readFile(join(pythonDir, "exit.json"), "utf8"));
    assert.deepEqual(tsCommand.argv.slice(0, 2), ["npm", "run"]);
    assert.deepEqual(pythonCommand.argv.slice(0, 2), ["uv", "run"]);
    assert.ok(tsCommand.argv.includes("test/web-search.test.ts"));
    assert.ok(tsCommand.argv.includes("test/workbench-capability-files.test.ts"));
    assert.ok(pythonCommand.argv.includes("tests/contracts/test_workbench_capabilities.py"));
    assert.ok(pythonCommand.argv.includes("tests/contracts/test_workbench_files.py"));
    assert.equal(tsCommand.cwd, resolve(tsCommand.cwd));
    assert.equal(tsExit.exitCode, 7);
    assert.equal(pythonExit.exitCode, 9);
    assert.equal(tsCommand.sourceHashesBefore.length, tsExit.sourceHashesAfter.length);
    assert.ok(tsCommand.sourceHashesBefore.some((entry) => entry.path === "apps/harness-service/src/workbench-public-web.ts"));
    assert.match(await readFile(join(tsDir, "stdout.log"), "utf8"), /synthetic-ts-stdout-secret/);
    assert.match(await readFile(join(tsDir, "stderr.log"), "utf8"), /synthetic-ts-stderr-secret/);
    assert.match(await readFile(join(pythonDir, "stdout.log"), "utf8"), /synthetic-python-stdout-secret/);
    assert.match(await readFile(join(pythonDir, "stderr.log"), "utf8"), /synthetic-python-stderr-secret/);
    const publicText = `${await readFile(join(fixture.roundRoot, "evidence/increment-result.json"), "utf8")}\n${await readFile(join(fixture.roundRoot, "evidence/manifest.json"), "utf8")}`;
    assert.doesNotMatch(publicText, /synthetic-(?:ts|python)-(?:stdout|stderr)-secret/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 test command streams are durable before a running child exits", async () => {
  const marker = "synthetic-ts-running-marker";
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
    npmExit: 7,
    npmStdout: marker,
    npmStderr: `${marker}-stderr`,
    npmStartupDelaySeconds: "2.5",
  });
  const barrier = join(fixture.root, "release-npm.barrier");
  const live = spawnNodeLive(fixture.runner, {
    ...fixture.env,
    WB02_NPM_BARRIER: barrier,
  });
  const privateRoot = join(fixture.root, ".tmp-tests/wb02/evidence", fixture.id);
  const tsDir = join(privateRoot, "issue-ts-workbench-capabilities");
  try {
    await waitForText(join(tsDir, "stdout.log"), marker, live.child);
    await waitForText(join(tsDir, "stderr.log"), `${marker}-stderr`, live.child);
    const command = JSON.parse(await readFile(join(tsDir, "command.json"), "utf8"));
    assert.equal(command.argv[0], "npm");
    assert.ok(command.sourceHashesBefore.some((entry) => entry.path === "apps/harness-service/src/workbench-public-web.ts"));
    assert.equal(live.child.exitCode, null, "fixture runner must remain alive before barrier release");
    await assert.rejects(readFile(join(tsDir, "exit.json"), "utf8"), { code: "ENOENT" });

    await writeFile(barrier, "release\n", { flag: "wx" });
    const result = await live.result;
    assert.notEqual(result.code, 0);
    const exit = JSON.parse(await readFile(join(tsDir, "exit.json"), "utf8"));
    assert.equal(exit.exitCode, 7);
    assert.equal(command.sourceHashesBefore.length, exit.sourceHashesAfter.length);
    assert.match(await readFile(join(tsDir, "stdout.log"), "utf8"), new RegExp(marker));
    assert.match(await readFile(join(tsDir, "stderr.log"), "utf8"), new RegExp(`${marker}-stderr`));
  } finally {
    if (live.child.exitCode === null) await terminateProcessGroup(live.child);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 private round root refuses reuse even when public round is new", async () => {
  const fixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py"],
    tsFiles: requiredCapabilityTests,
  });
  const privateRoundRoot = join(fixture.root, ".tmp-tests/wb02/evidence", fixture.id);
  await mkdir(privateRoundRoot, { recursive: true });
  const marker = join(privateRoundRoot, "preserve-me.txt");
  await writeFile(marker, "private-preserve\n");
  try {
    const result = await runNode(fixture.runner, fixture.env);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /EEXIST|already exists/i);
    assert.equal(await readFile(marker, "utf8"), "private-preserve\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WB-02 source snapshot catches a changed capability core module while unchanged synthetic run passes", async () => {
  const passingFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
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
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
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
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
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
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
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

  const changedPublicWebFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
    mutatePath: "apps/harness-service/src/workbench-public-web.ts",
  });
  try {
    const result = await runNode(changedPublicWebFixture.runner, changedPublicWebFixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(changedPublicWebFixture.roundRoot);
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.sourceChanged, true);
    assert.equal(evidence.blockingReason, "source_changed_during_run");
    assert.notEqual(evidence.modulesHashBefore, evidence.modulesHashAfter);
  } finally {
    await rm(changedPublicWebFixture.root, { recursive: true, force: true });
  }

  const changedFilesFixture = await createSyntheticFixture({
    pythonFiles: ["tests/contracts/test_workbench_capabilities.py", "tests/contracts/test_workbench_files.py"],
    tsFiles: requiredCapabilityTests,
    mutatePath: "apps/harness-service/src/workbench-files.ts",
  });
  try {
    const result = await runNode(changedFilesFixture.runner, changedFilesFixture.env);
    assert.notEqual(result.code, 0);
    const evidence = await readEvidence(changedFilesFixture.roundRoot);
    assert.equal(evidence.sourceChanged, true);
    assert.equal(evidence.blockingReason, "source_changed_during_run");
    const before = evidence.sourceHashesBefore.find((entry) => entry.path === "apps/harness-service/src/workbench-files.ts");
    const after = evidence.sourceHashesAfter.find((entry) => entry.path === "apps/harness-service/src/workbench-files.ts");
    assert.notEqual(before?.sha256, after?.sha256);
  } finally {
    await rm(changedFilesFixture.root, { recursive: true, force: true });
  }
});

async function createSyntheticFixture({
  pythonFiles,
  tsFiles,
  mutatePath = null,
  missingSourcePath = null,
  npmExit = 0,
  npmStdout = "synthetic npm",
  npmStderr = "",
  npmStartupDelaySeconds = "0",
  uvExit = 0,
  uvStdout = "synthetic uv",
  uvStderr = "",
}) {
  const root = await mkdtemp(join(tmpdir(), "anna-wb02-synthetic-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const baselineEvidence = join(root, "evals/workbench/wb00/runs/wb00-baseline-20260910-r5/evidence");
  await mkdir(scripts, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(baselineEvidence, { recursive: true });
  await cp(runner, join(scripts, "workbench-capability-evidence.mjs"));
  await cp(join(repositoryRoot, "scripts/workbench-capability-evidence.test.mjs"), join(scripts, "workbench-capability-evidence.test.mjs"));
  await cp(join(repositoryRoot, "scripts/build-evidence-manifest.mjs"), join(scripts, "build-evidence-manifest.mjs"));
  await cp(join(repositoryRoot, "scripts/verify-evidence-manifest.mjs"), join(scripts, "verify-evidence-manifest.mjs"));
  await writeFile(join(baselineEvidence, "baseline-result.json"), JSON.stringify({ datasetVersion: "wb00-dataset-v1.1" }));
  const requiredSourceFixtures = [
    "apps/harness-service/src/workbench-public-web.ts",
    "apps/harness-service/src/workbench-files.ts",
    "apps/harness-service/src/production.ts",
    "apps/harness-service/src/production-tools.ts",
    "apps/harness-service/src/workbench-capabilities.ts",
    "apps/harness-service/src/product-facade.ts",
    "services/api/app/routes/workdirs.py",
    "services/runtime/app/workdir_store.py",
    "services/api/app/main.py",
    "services/api/app/routes/business.py",
    "services/api/app/security.py",
    "services/api/app/routes/chat.py",
    "services/api/app/routes/create.py",
    "services/chat/app/orchestrator.py",
    "apps/desktop/src/lib/api/client.ts",
    "apps/desktop/src/lib/api/identity.ts",
    "apps/desktop/src/lib/runtime.ts",
    "apps/harness-service/test/workbench-capability-files-legacy.test.ts",
    "apps/harness-service/test/web-search.test.ts",
    "apps/harness-service/test/production-tools.test.ts",
    "apps/harness-service/package.json",
    "package-lock.json",
  ];
  for (const path of [
    ...pythonFiles,
    ...tsFiles,
    ...requiredSourceFixtures,
    "packages/harness-v2/src/capability-catalog.ts",
    "packages/harness-v2/src/index.ts",
    "packages/harness-v2/src/skill-catalog.ts",
    "skills/harness-v2/general-assistant/SKILL.md",
  ]) {
    if (path === missingSourcePath) continue;
    const target = join(root, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, `synthetic fixture: ${path}\n`);
  }
  const stubScript = (name) => join(bin, name);
  const gitStub = stubScript("git");
  const npmStub = stubScript("npm");
  const uvStub = stubScript("uv");
  await writeFile(gitStub, "#!/bin/sh\ncase \"$1\" in\n  rev-parse) printf 'synthetic-head\\n' ;;\n  *) : ;;\nesac\n");
  await writeFile(npmStub, "#!/bin/sh\nif [ -n \"${WB02_MUTATE_TARGET:-}\" ]; then printf 'mutated-by-synthetic-stub\\n' >> \"$WB02_MUTATE_TARGET\"; fi\nif [ \"${WB02_NPM_STARTUP_DELAY_SECONDS:-0}\" != \"0\" ]; then sleep \"$WB02_NPM_STARTUP_DELAY_SECONDS\"; fi\nprintf '%s\\n' \"${WB02_NPM_STDOUT:-synthetic npm}\"\nif [ -n \"${WB02_NPM_STDERR:-}\" ]; then printf '%s\\n' \"$WB02_NPM_STDERR\" >&2; fi\nif [ -n \"${WB02_NPM_BARRIER:-}\" ]; then while [ ! -e \"$WB02_NPM_BARRIER\" ]; do sleep 0.01; done; fi\nexit \"${WB02_NPM_EXIT:-0}\"\n");
  await writeFile(uvStub, "#!/bin/sh\nprintf '%s\\n' \"${WB02_UV_STDOUT:-synthetic uv}\"\nif [ -n \"${WB02_UV_STDERR:-}\" ]; then printf '%s\\n' \"$WB02_UV_STDERR\" >&2; fi\nexit \"${WB02_UV_EXIT:-0}\"\n");
  await Promise.all([chmod(gitStub, 0o755), chmod(npmStub, 0o755), chmod(uvStub, 0o755)]);
  const id = `synthetic-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    root,
    runner: join(scripts, "workbench-capability-evidence.mjs"),
    roundRoot: join(root, "evals/workbench/wb02/runs", id),
    env: {
      ANNA_WB02_EVAL_ROUND_ID: id,
      PATH: `${bin}:${process.env.PATH}`,
      WB02_NPM_EXIT: `${npmExit}`,
      WB02_NPM_STDOUT: npmStdout,
      WB02_NPM_STDERR: npmStderr,
      WB02_NPM_STARTUP_DELAY_SECONDS: `${npmStartupDelaySeconds}`,
      WB02_UV_EXIT: `${uvExit}`,
      WB02_UV_STDOUT: uvStdout,
      WB02_UV_STDERR: uvStderr,
      ...(mutatePath === null ? {} : { WB02_MUTATE_TARGET: join(root, mutatePath) }),
    },
    id,
  };
}

async function readEvidence(roundRoot) {
  return JSON.parse(await readFile(join(roundRoot, "evidence", "increment-result.json"), "utf8"));
}

function runNode(script, env) {
  return runNodeWithArgs(script, [], env);
}

function runNodeTest(script, testNamePattern, env) {
  return runNodeWithArgs(script, ["--test", testNamePattern], env);
}

function runNodeWithArgs(script, args, env) {
  return new Promise((resolveResult) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [...args, script], {
      cwd: repositoryRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

function removeRequiredEntry(source, entry) {
  const start = source.indexOf("const requiredTsTests = [");
  const end = source.indexOf("];", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  const line = `  "${entry}",\n`;
  assert.equal(block.split(line).length - 1, 1, `expected one required test guard entry for ${entry}`);
  return source.slice(0, start) + block.replace(line, "") + source.slice(end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeRequiredSourceEntry(source, entry) {
  const start = source.indexOf("const requiredSourcePaths = [");
  const end = source.indexOf("];", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  const line = `  "${entry}",\n`;
  assert.equal(block.split(line).length - 1, 1, `expected one required source guard entry for ${entry}`);
  return source.slice(0, start) + block.replace(line, "") + source.slice(end);
}

function removeRequiredPythonFilesTest(source) {
  const block = "const requiredPythonTests = [requiredPythonTest, requiredPythonFilesTest];";
  assert.equal(source.split(block).length - 1, 1, "expected one required Python files test guard");
  return source.replace(block, "const requiredPythonTests = [requiredPythonTest];");
}

function spawnNodeLive(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: repositoryRoot,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolveResult) => {
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { child, result };
}

async function terminateProcessGroup(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (child.exitCode !== null) return;
  await new Promise((resolveResult) => child.once("close", resolveResult));
}

async function waitForText(path, marker, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture child exited before ${marker} appeared in ${path}`);
    try {
      if ((await readFile(path, "utf8")).includes(marker)) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolveResult) => setTimeout(resolveResult, Math.min(10, remaining)));
  }
  throw new Error(`timed out waiting for ${marker} in ${path}`);
}
