import { constants } from "node:fs";
import { execFile } from "node:child_process";

// macOS checks every path component in the kernel at open time (O_NOFOLLOW
// alone checks only the leaf). Do not silently fall back to the racy operation.
const WORKDIR_NOFOLLOW_ANY = 0x20000000;
export function containedOpenFlags(flags: number): number {
  if (process.platform !== "darwin") throw new Error("workdir_containment_unavailable");
  // Darwin rejects O_NOFOLLOW_ANY combined with the older O_NOFOLLOW flag.
  return (flags & ~constants.O_NOFOLLOW) | WORKDIR_NOFOLLOW_ANY;
}

interface DirectoryEntry {
  name: string;
  type: "file" | "dir";
  bytes?: number;
}

// cwd is pinned by the kernel before this process starts. Check its physical path,
// then use only '.' or a single basename: a concurrent rename cannot redirect an
// operation through a newly installed intermediate symlink. No user code is loaded.
const DIRECTORY_HELPER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [root, operation, name, limitText] = process.argv.slice(1);
const relative = path.relative(root, process.cwd());
if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
  process.stdout.write(JSON.stringify({ error: "workdir_path_outside_root" }));
} else {
  try {
    if (operation === "mkdir") {
      if (!name || name === "." || name === ".." || path.basename(name) !== name) throw new Error("invalid basename");
      fs.mkdirSync(name);
      process.stdout.write("{}");
    } else {
      const entries = [];
      let truncated = false;
      const names = fs.readdirSync(".").sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        let fd;
        try {
          fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | 0x20000000);
          const info = fs.fstatSync(fd);
          if (info.isDirectory()) {
            if (name.startsWith(".") || name === "node_modules") continue;
            entries.push({ name, type: "dir" });
          }
          else if (info.isFile()) entries.push({ name, type: "file", bytes: info.size });
        } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
        if (entries.length >= Number(limitText)) { truncated = names.indexOf(name) < names.length - 1; break; }
      }
      process.stdout.write(JSON.stringify({ entries, truncated }));
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.code || "workdir_path_unavailable" }));
  }
}
`;

async function directoryOperation(
  root: string, directory: string, operation: "mkdir" | "list", name = "", limit = 5_001, signal?: AbortSignal,
): Promise<{ entries?: DirectoryEntry[]; truncated?: boolean }> {
  if (process.platform !== "darwin") throw new Error("workdir_containment_unavailable");
  // mkdir also has an OS write boundary. Listing is read-only even if the helper
  // regresses; it receives no credentials or inherited NODE_OPTIONS/NODE_PATH.
  const profile = `(version 1)(allow default)(deny file-write*)${operation === "mkdir"
    ? `(allow file-write* (subpath ${JSON.stringify(root)}))` : ""}`;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--input-type=commonjs", "-e", DIRECTORY_HELPER,
      root, operation, name, String(limit)], {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
      timeout: 10_000,
      signal,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    }, (error, output) => error ? reject(error) : resolve(output));
  });
  const result = JSON.parse(stdout) as { error?: string; entries?: DirectoryEntry[]; truncated?: boolean };
  if (result.error !== undefined) throw Object.assign(new Error(result.error), { code: result.error });
  return result;
}

export async function mkdirContained(root: string, directory: string, name: string, signal?: AbortSignal): Promise<void> {
  await directoryOperation(root, directory, "mkdir", name, 0, signal);
}

export async function readContainedDirectory(
  root: string, directory: string, limit: number, signal: AbortSignal,
): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  const result = await directoryOperation(root, directory, "list", "", limit, signal);
  return { entries: result.entries ?? [], truncated: result.truncated ?? false };
}
