import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runner = join(repositoryRoot, "scripts/workbench-session-evidence.mjs");
const roundRoot = (id) => join(repositoryRoot, "evals/workbench/wb01/runs", id);

test("WB-01 runner refuses an existing round without overwriting it", async () => {
  const id = `cli-test-${process.pid}-${Date.now()}`;
  const root = roundRoot(id);
  await mkdir(root, { recursive: true });
  const marker = join(root, "marker.txt");
  await writeFile(marker, "preserve-me\n");
  try {
    const result = await runNode(runner, { ANNA_WB01_EVAL_ROUND_ID: id });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /EEXIST|already exists/i);
    assert.equal(await readFile(marker, "utf8"), "preserve-me\n");
    assert.deepEqual(await readdir(root), ["marker.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runNode(script, env) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script], { cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}
