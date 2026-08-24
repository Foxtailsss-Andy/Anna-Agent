import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const manifestPath = resolve(process.argv[2] ?? "evidence/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const root = resolve(manifestPath, "..");
const failures = [];
const listedPaths = new Set((manifest.files ?? []).map((entry) => entry.path));

async function collectFiles(current, result) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = join(current, entry.name);
    const stats = await lstat(target);
    const path = relative(root, target).split(sep).join("/");
    if (stats.isSymbolicLink()) {
      failures.push(`${path}:symlink_rejected`);
    } else if (entry.isDirectory()) {
      await collectFiles(target, result);
    } else if (stats.isFile() && path !== "manifest.json") {
      result.add(path);
    }
  }
}

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
  failures.push("invalid_manifest_schema");
}

for (const entry of manifest.files ?? []) {
  if (
    typeof entry.path !== "string"
    || entry.path.startsWith("/")
    || entry.path.split("/").includes("..")
  ) {
    failures.push(`${String(entry.path)}:unsafe_path`);
    continue;
  }
  const target = join(root, entry.path);
  try {
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      failures.push(`${entry.path}:not_regular_file`);
      continue;
    }
    const bytes = await readFile(target);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== entry.size || sha256 !== entry.sha256) {
      failures.push(`${entry.path}:hash_mismatch`);
    }
  } catch {
    failures.push(`${entry.path}:missing`);
  }
}

const actualPaths = new Set();
await collectFiles(root, actualPaths);
for (const path of actualPaths) {
  if (!listedPaths.has(path)) failures.push(`${path}:not_in_manifest`);
}
for (const path of listedPaths) {
  if (!actualPaths.has(path)) failures.push(`${path}:not_on_disk`);
}

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, failures })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: manifestPath, fileCount: manifest.files.length })}\n`);
}
