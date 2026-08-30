import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { expect, test } from "vitest";
import { verifyRuntimeManifest } from "../src/runtime-manifest";

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
