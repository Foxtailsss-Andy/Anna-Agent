import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const generatedPath = /^(?:dist|release|node_modules|\.venv|\.pytest_cache|\.tmp-tests|build\/python-runtime)(?:\/|$)/;
const localStatePath = /^(?:\.anna(?:\/|$)|.*(?:^|\/)runtime\.json$)/;
const runtimeDatabasePath = /(?:\.sqlite3?|\.db|\.jsonl)$/i;
const absolutePathMarker = /(?:^|[\s"'`=(,:])(?:\/Users\/|\/home\/|[A-Za-z]:(?:[\\/]|\\\\)(?:Users|home)(?:[\\/]|\\\\))/;
const credentialMarker = /(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,})/;

/**
 * Check the public-preview boundary at the file-content seam.
 * The caller supplies the exact candidate file list so release tooling can
 * validate a curated tree without reading local runtime state implicitly.
 */
export function verifyPublicPreviewFiles(files) {
  const violations = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    const code = violationCode(path, file.content);
    if (code !== undefined) {
      violations.push({ code, path });
    }
  }
  return { ok: violations.length === 0, violations };
}

function violationCode(path, content) {
  if (localStatePath.test(path)) return "local_state";
  if (generatedPath.test(path)) return "generated_output";
  if (runtimeDatabasePath.test(path)) return "runtime_database";
  if (absolutePathMarker.test(content)) return "absolute_path";
  if (credentialMarker.test(content)) return "credential_marker";
  return undefined;
}

function trackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"]);
  return output.toString("utf8").split("\0").filter(Boolean).map((path) => ({
    path,
    content: readFileSync(`${root}/${path}`, "utf8"),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const result = verifyPublicPreviewFiles(trackedFiles(root));
  process.stdout.write(`${JSON.stringify({ ...result, root }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
