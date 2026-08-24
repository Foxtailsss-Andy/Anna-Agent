import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, sep, resolve } from "node:path";

const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? "evidence");
const caseId = process.env.ANNA_EVIDENCE_CASE_ID ?? "manual-evidence";
const generatedAt = process.env.ANNA_EVIDENCE_GENERATED_AT ?? new Date().toISOString();
const excluded = new Set(["manifest.json"]);

async function files(current, output) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`evidence_symlink_rejected:${rel}`);
    }
    if (entry.isDirectory()) {
      await files(path, output);
    } else if (stats.isFile() && !excluded.has(rel)) {
      const bytes = await readFile(path);
      output.push({
        path: rel,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}

const entries = [];
await files(root, entries);
let gitHead = process.env.ANNA_EVIDENCE_GIT_HEAD ?? null;
if (gitHead === null) {
  try {
    gitHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  } catch {
    gitHead = null;
  }
}

const manifest = {
  schemaVersion: 1,
  caseId,
  generatedAt,
  evidenceMode: process.env.ANNA_EVIDENCE_MODE ?? "fixture",
  provider: process.env.ANNA_EVIDENCE_PROVIDER ?? null,
  gitHead,
  files: entries.sort((left, right) => left.path.localeCompare(right.path)),
};
await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ path: join(root, "manifest.json"), fileCount: entries.length, gitHead })}\n`);
