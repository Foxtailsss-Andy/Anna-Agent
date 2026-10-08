import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("runtime preparation refuses a cached worker after its source changes", () => {
  const root = mkdtempSync(join(tmpdir(), "anna-runtime-inputs-"));
  const source = join(root, "packages/omp-loop-kernel/runtime");
  const runtime = join(root, "build/omp-runtime/darwin-arm64");
  try {
    for (const dir of [source, runtime, join(root, "scripts")]) mkdirSync(dir, { recursive: true });
    cpSync(resolve("scripts/ensure-omp-runtime.mjs"), join(root, "scripts/ensure-omp-runtime.mjs"));
    for (const name of ["worker.ts", "protocol.ts", "canary.ts", "package-lock.json"]) {
      writeFileSync(join(source, name), name);
      writeFileSync(join(runtime, name), name);
    }
    writeFileSync(join(runtime, "manifest.json"), JSON.stringify({ schemaVersion: 1, files: [], sha256: "sha256:fixture" }));
    const args = [join(root, "scripts/ensure-omp-runtime.mjs")];
    assert.match(execFileSync(process.execPath, args, { encoding: "utf8" }), /Reusing/);

    for (const name of ["worker.ts", "protocol.ts", "package-lock.json"]) {
      writeFileSync(join(source, name), "changed source");
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.notEqual(result.status, 0, `stale ${name} must not be reused`);
      assert.match(result.stderr, /stale|differ/i);
      assert.doesNotMatch(result.stdout, /Reusing/);
      writeFileSync(join(source, name), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
