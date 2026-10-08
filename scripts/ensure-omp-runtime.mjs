import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = resolve(repositoryRoot, "build/omp-runtime/darwin-arm64");
const manifestPath = resolve(runtimeRoot, "manifest.json");

if (existsSync(runtimeRoot) && existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion === 1 && Array.isArray(manifest.files) && typeof manifest.sha256 === "string") {
    for (const name of ["worker.ts", "protocol.ts", "canary.ts", "package-lock.json"]) {
      const source = resolve(repositoryRoot, "packages/omp-loop-kernel/runtime", name);
      const prepared = resolve(runtimeRoot, name);
      if (!existsSync(prepared) || !readFileSync(source).equals(readFileSync(prepared))) {
        throw new Error(`Prepared OMP runtime is stale (${name} differs). Stop Anna, move build/omp-runtime/darwin-arm64 aside, then prepare it again with ANNA_OMP_BUN_ARCHIVE_URL configured. Bound runtimes are not replaced automatically.`);
      }
    }
    process.stdout.write(`Reusing prepared OMP runtime at ${runtimeRoot}\n`);
    process.exit(0);
  }
  throw new Error(`Prepared OMP runtime manifest is invalid: ${manifestPath}`);
}

execFileSync(process.execPath, [resolve(repositoryRoot, "scripts/prepare-omp-runtime.mjs")], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: process.env,
});
