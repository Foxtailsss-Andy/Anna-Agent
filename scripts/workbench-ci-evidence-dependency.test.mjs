import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const checksJob = workflow.slice(workflow.indexOf("  checks:"), workflow.indexOf("  product:"));

function step(name) {
  const start = checksJob.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing checks step: ${name}`);
  const next = checksJob.indexOf("\n      - name:", start + 1);
  return checksJob.slice(start, next === -1 ? checksJob.length : next);
}

function condition(name) {
  const block = step(name);
  const match = block.match(/^        if: (.+)$/m);
  assert.ok(match, `${name} must declare an explicit dependency condition`);
  return match[1];
}

function evaluate(expression, scenario) {
  const source = expression
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "");
  const format = (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? "");
  const hashFiles = (...patterns) => {
    const files = new Set(scenario.files ?? []);
    const found = patterns.some((pattern) => {
      if (pattern.endsWith("/**")) {
        const prefix = pattern.slice(0, -3);
        return [...files].some((file) => file.startsWith(`${prefix}/`));
      }
      return files.has(pattern);
    });
    return found ? "sha256:fixture" : "";
  };
  return vm.runInNewContext(source, {
    cancelled: () => scenario.cancelled === true,
    format,
    github: { run_id: "123", run_attempt: "1" },
    hashFiles,
    steps: Object.fromEntries(Object.entries(scenario.steps ?? {}).map(([id, outcome]) => [id, { outcome }])),
  });
}

const healthy = {
  cancelled: false,
  steps: {
    npm_install: "success",
    omp_prepare: "success",
    python_setup: "success",
    python_install: "success",
    web_host_build: "success",
    chromium_install: "success",
    wb00_baseline: "success",
    wb01_evidence: "success",
    wb02_evidence: "success",
  },
  files: [
    "evals/workbench/wb00/runs/ci-123-1/evidence/baseline-result.json",
    "evals/workbench/wb00/runs/ci-123-1/evidence/manifest.json",
    "evals/workbench/wb01/runs/ci-123-1/evidence/increment-result.json",
    "evals/workbench/wb01/runs/ci-123-1/evidence/manifest.json",
    "evals/workbench/wb02/runs/ci-123-1/evidence/increment-result.json",
    "evals/workbench/wb02/runs/ci-123-1/evidence/manifest.json",
  ],
};
const evidenceCases = [
  ["wb00_baseline", "Verify WB-00 baseline schema and manifest", "Retain WB-00 baseline evidence", "wb00"],
  ["wb01_evidence", "Verify WB-01 session evidence manifest", "Retain WB-01 session evidence", "wb01"],
  ["wb02_evidence", "Verify WB-02 capability evidence manifest", "Retain WB-02 capability evidence", "wb02"],
];

test("independent product and evidence checks continue after a test failure", () => {
  for (const name of [
    "Run JavaScript tests",
    "Run maintained frontend smoke",
    "Build web and Harness v2 service",
    "Exercise RC1 through the real product UI",
    "Run WB-00 baseline fixture and freeze evidence",
    "Install Python dependencies",
    "Run Python tests",
    "Run WB-02 capability evidence CLI guards",
  ]) {
    assert.match(condition(name), /!cancelled\(\)/, `${name} must continue after an earlier failure`);
  }
  assert.match(condition("Run JavaScript tests"), /steps\.python_install\.outcome == 'success'/);
  assert.match(condition("Exercise RC1 through the real product UI"), /steps\.python_install\.outcome == 'success'/);
  assert.match(condition("Run WB-00 baseline fixture and freeze evidence"), /steps\.omp_prepare\.outcome == 'success'/);
  assert.match(condition("Run Python tests"), /steps\.python_install\.outcome == 'success'/);
  assert.match(condition("Install Python dependencies"), /steps\.python_setup\.outcome == 'success'/);

  const testFailure = structuredClone(healthy);
  testFailure.steps.javascript_tests = "failure";
  for (const name of [
    "Run maintained frontend smoke",
    "Build web and Harness v2 service",
    "Exercise RC1 through the real product UI",
    "Run WB-00 baseline fixture and freeze evidence",
    "Run Python tests",
    "Run WB-01 session increment evidence",
    "Run WB-02 capability evidence CLI guards",
    "Run WB-02 capability increment evidence",
  ]) {
    assert.equal(evaluate(condition(name), testFailure), true, `${name} must run after JS failure`);
  }
});

test("verifies generated evidence and retains partial output", () => {
  for (const [producer, verifier, upload, ticket] of evidenceCases) {
    const verifyCondition = condition(verifier);
    const uploadCondition = condition(upload);
    assert.match(verifyCondition, new RegExp(`steps\\.${producer}\\.outcome == 'success'`));
    assert.match(verifyCondition, new RegExp(`hashFiles\\(format\\('evals/workbench/${ticket}/runs/`));
    assert.match(uploadCondition, new RegExp(`hashFiles\\(format\\('evals/workbench/${ticket}/runs/`));
    assert.match(uploadCondition, /!= ''/);
  }

  for (const [name, expected] of [
    ["Verify WB-00 baseline schema and manifest", true],
    ["Retain WB-00 baseline evidence", true],
    ["Verify WB-01 session evidence manifest", true],
    ["Retain WB-01 session evidence", true],
    ["Verify WB-02 capability evidence manifest", true],
    ["Retain WB-02 capability evidence", true],
  ]) {
    assert.equal(evaluate(condition(name), healthy), expected, `${name} healthy path`);
  }

  for (const [producer, verifier, upload, ticket] of evidenceCases) {
    const producerFailedNoOutput = structuredClone(healthy);
    producerFailedNoOutput.steps[producer] = "failure";
    producerFailedNoOutput.files = producerFailedNoOutput.files.filter((file) => !file.startsWith(`evals/workbench/${ticket}/`));
    assert.equal(evaluate(condition(verifier), producerFailedNoOutput), false, `${ticket} verifier without output`);
    assert.equal(evaluate(condition(upload), producerFailedNoOutput), false, `${ticket} upload without output`);

    const producerFailedWithManifest = structuredClone(producerFailedNoOutput);
    producerFailedWithManifest.files.push(`evals/workbench/${ticket}/runs/ci-123-1/evidence/manifest.json`);
    assert.equal(evaluate(condition(verifier), producerFailedWithManifest), true, `${ticket} verifier with partial output`);
    assert.equal(evaluate(condition(upload), producerFailedWithManifest), true, `${ticket} upload with partial output`);

    const producerSucceededWithoutManifest = structuredClone(healthy);
    producerSucceededWithoutManifest.files = producerSucceededWithoutManifest.files.filter((file) => !file.startsWith(`evals/workbench/${ticket}/`));
    assert.equal(evaluate(condition(verifier), producerSucceededWithoutManifest), true, `${ticket} verifier after producer success`);
    assert.equal(evaluate(condition(upload), producerSucceededWithoutManifest), false, `${ticket} upload without output`);
  }
});

test("evidence producers retain direct runtime dependencies", () => {
  assert.match(condition("Run WB-01 session increment evidence"), /steps\.npm_install\.outcome == 'success'/);
  assert.match(condition("Run WB-01 session increment evidence"), /steps\.python_install\.outcome == 'success'/);
  assert.match(condition("Run WB-01 session increment evidence"), /steps\.omp_prepare\.outcome == 'success'/);
  assert.match(condition("Run WB-02 capability increment evidence"), /steps\.npm_install\.outcome == 'success'/);
  assert.match(condition("Run WB-02 capability increment evidence"), /steps\.python_install\.outcome == 'success'/);
  assert.match(condition("Run WB-02 capability increment evidence"), /steps\.omp_prepare\.outcome == 'success'/);

  const npmFailed = { cancelled: false, steps: { npm_install: "failure", omp_prepare: "skipped", python_setup: "success", python_install: "success" } };
  assert.equal(evaluate(condition("Run JavaScript tests"), npmFailed), false);
  assert.equal(evaluate(condition("Install Python dependencies"), npmFailed), true);
  assert.equal(evaluate(condition("Audit Python dependencies"), npmFailed), true);
  assert.equal(evaluate(condition("Run Python tests"), npmFailed), true);
  assert.equal(evaluate(condition("Run WB-01 session increment evidence"), npmFailed), false);
  assert.equal(evaluate(condition("Run WB-02 capability increment evidence"), npmFailed), false);

  const pythonSetupFailed = { cancelled: false, steps: { npm_install: "success", omp_prepare: "success", python_setup: "failure", python_install: "skipped" } };
  assert.equal(evaluate(condition("Install Python dependencies"), pythonSetupFailed), false);
  assert.equal(evaluate(condition("Audit Python dependencies"), pythonSetupFailed), false);
  assert.equal(evaluate(condition("Run Python tests"), pythonSetupFailed), false);

  const pythonFailed = { cancelled: false, steps: { npm_install: "success", omp_prepare: "success", python_setup: "success", python_install: "failure" } };
  assert.equal(evaluate(condition("Run JavaScript tests"), pythonFailed), false);
  assert.equal(evaluate(condition("Run WB-01 session increment evidence"), pythonFailed), false);
  assert.equal(evaluate(condition("Run WB-02 capability increment evidence"), pythonFailed), false);

  const ompFailed = { cancelled: false, steps: { npm_install: "success", omp_prepare: "failure", python_install: "success" } };
  assert.equal(evaluate(condition("Run JavaScript tests"), ompFailed), false);
  assert.equal(evaluate(condition("Run WB-00 baseline fixture and freeze evidence"), ompFailed), false);
  assert.equal(evaluate(condition("Run WB-01 session increment evidence"), ompFailed), false);
  assert.equal(evaluate(condition("Run WB-02 capability increment evidence"), ompFailed), false);

  const cancelled = structuredClone(healthy);
  cancelled.cancelled = true;
  for (const name of [
    "Run JavaScript tests",
    "Exercise RC1 through the real product UI",
    "Install Python dependencies",
    "Run Python tests",
    "Run WB-00 baseline fixture and freeze evidence",
    "Verify WB-00 baseline schema and manifest",
    "Retain WB-00 baseline evidence",
    "Run WB-01 session increment evidence",
    "Verify WB-01 session evidence manifest",
    "Retain WB-01 session evidence",
    "Run WB-02 capability increment evidence",
    "Verify WB-02 capability evidence manifest",
    "Retain WB-02 capability evidence",
  ]) {
    assert.equal(evaluate(condition(name), cancelled), false, `${name} must stop after cancellation`);
  }
});
