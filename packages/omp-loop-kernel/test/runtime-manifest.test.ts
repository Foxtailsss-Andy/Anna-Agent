import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { expect, test } from "vitest";
import { constants, existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { verifyRuntimeManifest, verifyRuntimeManifestCached } from "../src/runtime-manifest";

const materializedRoot = resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64");
const nativePath = "node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node";

/** A minimal runtime holding the two pinned binaries (APFS clones) plus one source file. */
async function miniRuntime(): Promise<{ root: string; digest: string; writeManifest(): Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), "anna-runtime-cache-"));
  await copyFile(join(materializedRoot, "bun"), join(root, "bun"), constants.COPYFILE_FICLONE);
  await mkdir(join(root, "node_modules/@oh-my-pi/pi-natives-darwin-arm64"), { recursive: true });
  await copyFile(join(materializedRoot, nativePath), join(root, nativePath), constants.COPYFILE_FICLONE);
  await writeFile(join(root, "worker.ts"), "export const worker = 1;\n");
  const writeManifest = async () => {
    const files: { path: string; bytes: number; sha256: string }[] = [];
    for (const path of ["bun", nativePath, "worker.ts"].sort()) {
      const bytes = await readFile(join(root, path));
      files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`;
    await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, files, sha256: digest }));
    return digest;
  };
  return { root, digest: await writeManifest(), writeManifest };
}

test.skipIf(!existsSync(join(materializedRoot, "bun")))(
  "cached verification re-checks content after any runtime file or directory changes",
  async () => {
    const runtime = await miniRuntime();
    try {
      await expect(verifyRuntimeManifestCached(runtime.root, runtime.digest)).resolves.toMatchObject({ files: 3 });
      // Same-length in-place tamper: the cache must not hide it.
      await writeFile(join(runtime.root, "worker.ts"), "export const worker = 2;\n");
      await expect(verifyRuntimeManifestCached(runtime.root, runtime.digest)).rejects.toThrow("file digest mismatch");
      await writeFile(join(runtime.root, "worker.ts"), "export const worker = 1;\n");
      await expect(verifyRuntimeManifestCached(runtime.root, runtime.digest)).resolves.toMatchObject({ files: 3 });
      // An unlisted file added to a listed directory is detected through the directory metadata.
      await writeFile(join(runtime.root, "node_modules/@oh-my-pi/extra.js"), "x");
      await expect(verifyRuntimeManifestCached(runtime.root, runtime.digest)).rejects.toThrow("file mismatch");
      await rm(join(runtime.root, "node_modules/@oh-my-pi/extra.js"));
      await expect(verifyRuntimeManifestCached(runtime.root, runtime.digest)).resolves.toMatchObject({ files: 3 });
      // A different admitted digest is never satisfied by the cached entry.
      await expect(verifyRuntimeManifestCached(runtime.root, `sha256:${"0".repeat(64)}`)).rejects.toThrow("manifest identity");
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!existsSync(join(materializedRoot, "manifest.json")))(
  "cached verification of the materialized runtime is much cheaper after the first full check",
  async () => {
    const manifest = JSON.parse(await readFile(join(materializedRoot, "manifest.json"), "utf8")) as { sha256: string };
    const firstStarted = performance.now();
    await verifyRuntimeManifestCached(materializedRoot, manifest.sha256);
    const first = performance.now() - firstStarted;
    const repeatStarted = performance.now();
    await verifyRuntimeManifestCached(materializedRoot, manifest.sha256);
    const repeat = performance.now() - repeatStarted;
    // Report the measured costs; the bound is deliberately loose (machine dependent).
    console.info(`[runtime-manifest] full=${Math.round(first)}ms cached=${Math.round(repeat)}ms`);
    expect(repeat).toBeLessThan(Math.max(first / 3, 1));
  },
  60_000,
);

test("verifies actual materialized runtime against its pinned manifest", async () => {
  const root = resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64");
  const files: { path: string; bytes: number; sha256: string }[] = [];
  async function measure(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      if (path === "manifest.json") continue;
      const info = await lstat(absolute);
      expect(info.isSymbolicLink()).toBe(false);
      if (info.isDirectory()) await measure(absolute);
      else {
        expect(info.isFile()).toBe(true);
        files.push({ path, bytes: info.size, sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
      }
    }
  }
  await measure(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`;
  for (const name of ["worker.ts", "protocol.ts", "package-lock.json"]) {
    expect(await readFile(join(root, name))).toEqual(await readFile(resolve(import.meta.dirname, "../runtime", name)));
  }
  await expect(verifyRuntimeManifest(root, digest)).resolves.toMatchObject({
    manifestSha256: digest,
    bunSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
    files: files.length,
  });
}, 30_000);

test("rejects a valid-shaped manifest when the admitted digest differs", async () => {
  const root = resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64");
  await expect(verifyRuntimeManifest(root, `sha256:${"0".repeat(64)}`)).rejects.toThrow("manifest identity");
});

test("rejects traversal and missing required runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-runtime-manifest-"));
  try {
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "runtime/manifest.json"), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: "../escape", bytes: 1, sha256: "0".repeat(64) }],
      sha256: `sha256:${"0".repeat(64)}`,
    }));
    await expect(verifyRuntimeManifest(join(root, "runtime"), `sha256:${"0".repeat(64)}`))
      .rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unlisted files, links and absent files without trusting a self-consistent manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-runtime-members-"));
  const files = [
    { path: "bun", bytes: 1, sha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233" },
    { path: "node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node", bytes: 1, sha256: "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b" },
  ];
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`;
  try {
    await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, files, sha256: digest }));
    await writeFile(join(root, "aaa-extra"), "extra");
    await expect(verifyRuntimeManifest(root, digest)).rejects.toThrow("file mismatch");
    await rm(join(root, "aaa-extra"));
    await symlink("/dev/null", join(root, "aaa-link"));
    await expect(verifyRuntimeManifest(root, digest)).rejects.toThrow("symbolic link");
    await rm(join(root, "aaa-link"));
    await expect(verifyRuntimeManifest(root, digest)).rejects.toThrow("file is missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
