import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");

async function fixture(npmBody) {
  const root = await mkdtemp(join(tmpdir(), "anna-omp-preparation-test-"));
  const runtime = join(root, "packages/omp-loop-kernel/runtime");
  await mkdir(runtime, { recursive: true });
  await mkdir(join(root, "scripts"));
  await cp(join(repository, "scripts/prepare-omp-runtime.mjs"), join(root, "scripts/prepare-omp-runtime.mjs"));
  for (const name of ["package.json", "package-lock.json"]) {
    await cp(join(repository, "packages/omp-loop-kernel/runtime", name), join(runtime, name));
  }
  const bin = join(root, "bin");
  await mkdir(bin);
  const marker = join(root, "npm-invoked");
  await writeFile(join(bin, "npm"), `#!/bin/sh\nprintf invoked > '${marker}'\n${npmBody ?? "exit 89"}\n`, { mode: 0o755 });
  return { root, runtime, marker, bin };
}

async function rejectedRun(input) {
  try {
    await run(process.execPath, [join(input.root, "scripts/prepare-omp-runtime.mjs")], {
      cwd: input.root,
      env: { PATH: `${input.bin}:/usr/bin:/bin`, HOME: input.root, ANNA_OMP_BUN_ARCHIVE_URL: "https://localhost/bun.zip" },
      timeout: 5_000,
    });
    assert.fail("preparation unexpectedly succeeded");
  } catch (error) {
    return String(error.stderr ?? error);
  }
}

const supported = process.platform === "darwin" && process.arch === "arm64";

test("invalid frozen lock is rejected before invoking npm", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    const lockPath = join(input.runtime, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["node_modules/@oh-my-pi/pi-coding-agent"].integrity = `sha512-${"A".repeat(86)}==`;
    await writeFile(lockPath, JSON.stringify(lock));
    assert.match(await rejectedRun(input), /frozen package identities/);
    await assert.rejects(readFile(input.marker), { code: "ENOENT" });
  } finally {
    await rm(input.root, { recursive: true, force: true });
  }
});

test("an existing runtime is preserved before installation or download", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    const sentinel = join(input.root, "build/omp-runtime/darwin-arm64/sentinel");
    await mkdir(dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "existing-runtime");
    assert.match(await rejectedRun(input), /already exists/);
    assert.equal(await readFile(sentinel, "utf8"), "existing-runtime");
    await assert.rejects(readFile(input.marker), { code: "ENOENT" });
  } finally {
    await rm(input.root, { recursive: true, force: true });
  }
});

test("lock drift during installation stops before downloading runtime assets", { skip: !supported }, async () => {
  const input = await fixture("printf ' ' >> package-lock.json\nexit 0");
  try {
    assert.match(await rejectedRun(input), /inputs changed during installation/);
    assert.equal(await readFile(input.marker, "utf8"), "invoked");
    await assert.rejects(readFile(join(input.root, "build/omp-runtime/darwin-arm64/manifest.json")), { code: "ENOENT" });
  } finally {
    await rm(input.root, { recursive: true, force: true });
  }
});
