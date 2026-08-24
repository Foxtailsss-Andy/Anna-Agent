import { lstat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";

const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? "evals/harness-v2");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const verifier = join(scriptDir, "verify-evidence-manifest.mjs");
const repoRoot = resolve(scriptDir, "..");

async function findManifests(current, output) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = join(current, entry.name);
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await findManifests(target, output);
    } else if (entry.isFile() && entry.name === "manifest.json") {
      output.push(target);
    }
  }
}

async function verifyManifest(file) {
  try {
    const { stdout } = await exec(process.execPath, [verifier, file], { cwd: repoRoot });
    return { file, ok: true, result: JSON.parse(stdout) };
  } catch (error) {
    let result = { ok: false, failures: [error.message] };
    try {
      result = JSON.parse(error.stderr);
    } catch {
      // Keep the process error when the single-manifest verifier did not emit JSON.
    }
    return { file, ok: false, failures: result.failures ?? [error.message] };
  }
}

const manifests = [];
await findManifests(root, manifests);
const results = await Promise.all(manifests.map(verifyManifest));
const report = {
  ok: results.length > 0 && results.every((result) => result.ok),
  root,
  manifestCount: results.length,
  manifests: results,
};

if (!report.ok) {
  process.stderr.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
