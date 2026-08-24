import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createEvidence(root, name, content) {
  const evidenceDir = join(root, name);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "evidence.json"), content);
  const result = await run("scripts/build-evidence-manifest.mjs", [evidenceDir]);
  assert.equal(result.code, 0, result.stderr);
  return evidenceDir;
}

test("verifies every evidence manifest below the requested root", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-evidence-manifests-"));
  try {
    await createEvidence(root, "fixture-case", "fixture evidence\n");
    await createEvidence(root, "live-boundary-case", "live boundary evidence\n");

    const result = await run("scripts/verify-evidence-manifests.mjs", [root]);

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.manifestCount, 2);
    assert.deepEqual(
      report.manifests.map((entry) => entry.file).sort(),
      [
        join(root, "fixture-case", "manifest.json"),
        join(root, "live-boundary-case", "manifest.json"),
      ].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails the aggregate gate when one evidence file changes after hashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-evidence-manifests-"));
  try {
    const evidenceDir = await createEvidence(root, "stale-case", "original evidence\n");
    await writeFile(join(evidenceDir, "evidence.json"), "changed evidence\n");

    const result = await run("scripts/verify-evidence-manifests.mjs", [root]);

    assert.equal(result.code, 1);
    const report = JSON.parse(result.stderr);
    assert.equal(report.ok, false);
    assert.equal(report.manifestCount, 1);
    assert.deepEqual(report.manifests[0].failures, ["evidence.json:hash_mismatch"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
