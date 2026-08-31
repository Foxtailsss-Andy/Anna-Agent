import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = resolve(repositoryRoot, "build/omp-runtime/darwin-arm64");
const manifestPath = resolve(runtimeRoot, "manifest.json");

if (existsSync(runtimeRoot) && existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion === 1 && Array.isArray(manifest.files) && typeof manifest.sha256 === "string") {
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
