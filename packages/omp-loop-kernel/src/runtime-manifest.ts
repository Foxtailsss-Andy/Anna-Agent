import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const BUN_SHA256 = "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233";
const NATIVE_PATH = "node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node";
const NATIVE_SHA256 = "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b";

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("runtime manifest schema is invalid");
  }
  return value as Record<string, unknown>;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function verifyRuntimeManifest(root: string, expectedDigest: string): Promise<{
  manifestSha256: string; bunSha256: string; files: number;
}> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("runtime manifest identity is invalid");
  const canonicalRoot = await realpath(root);
  const manifestPath = join(canonicalRoot, "manifest.json");
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new Error("runtime manifest file is invalid");
  const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")), ["schemaVersion", "files", "sha256"]);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100_000) {
    throw new Error("runtime manifest schema is invalid");
  }
  let previous = "";
  const entries = manifest.files.map(input => {
    const entry = record(input, ["path", "bytes", "sha256"]);
    const path = entry.path;
    if (typeof path !== "string" || path.length === 0 || path.includes("\\")
      || path.includes("\0") || path.split("/").some(part => part === "" || part === "." || part === "..")
      || path === "manifest.json" || path <= previous
      || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error("runtime manifest entry is invalid");
    }
    previous = path;
    return { path, bytes: entry.bytes as number, sha256: entry.sha256 };
  });
  const digest = `sha256:${hash(JSON.stringify(entries))}`;
  if (digest !== expectedDigest || manifest.sha256 !== digest) throw new Error("runtime manifest identity mismatch");
  if (entries.find(entry => entry.path === "bun")?.sha256 !== BUN_SHA256
    || entries.find(entry => entry.path === NATIVE_PATH)?.sha256 !== NATIVE_SHA256) {
    throw new Error("runtime manifest required binary identity mismatch");
  }
  const remaining = new Map(entries.map(entry => [entry.path, entry]));
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const absolute = join(directory, name);
      const path = relative(canonicalRoot, absolute).split(sep).join("/");
      if (path === "manifest.json") continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("runtime manifest symbolic link rejected");
      if (info.isDirectory()) { await visit(absolute); continue; }
      const entry = remaining.get(path);
      if (!info.isFile() || entry === undefined || info.size !== entry.bytes) throw new Error("runtime manifest file mismatch");
      if (hash(await readFile(absolute)) !== entry.sha256) throw new Error("runtime manifest file digest mismatch");
      remaining.delete(path);
    }
  }
  await visit(canonicalRoot);
  if (remaining.size !== 0) throw new Error("runtime manifest file is missing");
  return { manifestSha256: digest, bunSha256: BUN_SHA256, files: entries.length };
}
