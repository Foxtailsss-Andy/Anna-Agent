import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_VERSION = "3.12";
const DEPENDENCIES = [
  "fastapi>=0.133.0",
  "httpx>=0.28.0",
  "pydantic>=2.13.0",
  "uvicorn[standard]>=0.41.0",
];

const isWindows = process.platform === "win32";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.join(projectRoot, "build", "python-runtime");
const pythonTarget = path.join(runtimeRoot, "python");
const sitePackagesTarget = path.join(runtimeRoot, "site-packages");
const cacheDir = process.env.UV_CACHE_DIR ?? path.join(os.tmpdir(), "anna-uv-cache");

const uvBin = resolveUvBin();
const pythonBin = resolveStandalonePythonBin();
// Windows standalone layout: python.exe lives at the root; POSIX: bin/python3.x
const pythonHome = isWindows
  ? path.dirname(realpathSync(pythonBin))
  : path.resolve(path.dirname(realpathSync(pythonBin)), "..");

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
cpSync(pythonHome, pythonTarget, { recursive: true, dereference: true });
mkdirSync(sitePackagesTarget, { recursive: true });

run(uvBin, [
  "pip",
  "install",
  "--target",
  sitePackagesTarget,
  "--python",
  pythonBin,
  "--link-mode",
  "copy",
  "--compile-bytecode",
  ...DEPENDENCIES,
]);

writeFileSync(
  path.join(runtimeRoot, "manifest.json"),
  `${JSON.stringify(
    { pythonVersion: PYTHON_VERSION, platform: process.platform, dependencies: DEPENDENCIES },
    null,
    2,
  )}\n`,
);

console.log(`Prepared Anna Python runtime at ${runtimeRoot}`);

function resolveUvBin() {
  if (process.env.ANNA_UV_BIN && existsSync(process.env.ANNA_UV_BIN)) {
    return process.env.ANNA_UV_BIN;
  }
  const locator = isWindows ? "where" : "which";
  const found = spawnSync(locator, ["uv"], { encoding: "utf8" });
  if (found.status === 0) {
    const first = found.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) {
      return first;
    }
  }
  for (const candidate of uvCandidates()) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "uv";
}

function uvCandidates() {
  const home = process.env.USERPROFILE ?? os.homedir();
  if (!isWindows) {
    return [
      path.join(home, ".local", "bin", "uv"),
      path.join(home, ".cargo", "bin", "uv"),
      "/opt/homebrew/bin/uv",
      "/usr/local/bin/uv",
    ];
  }
  const candidates = [
    path.join(home, ".local", "bin", "uv.exe"),
    path.join(home, ".cargo", "bin", "uv.exe"),
  ];
  const pythonRoot = path.join(process.env.LOCALAPPDATA ?? "", "Python");
  if (existsSync(pythonRoot)) {
    for (const entry of readdirSync(pythonRoot)) {
      candidates.push(path.join(pythonRoot, entry, "Scripts", "uv.exe"));
    }
  }
  return candidates;
}

function resolveStandalonePythonBin() {
  if (process.env.ANNA_STANDALONE_PYTHON_BIN) {
    return process.env.ANNA_STANDALONE_PYTHON_BIN;
  }
  // --managed-python forces a relocatable standalone build, never a project .venv.
  const result = spawnSync(uvBin, ["python", "find", "--managed-python", PYTHON_VERSION], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, UV_CACHE_DIR: cacheDir },
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Unable to find standalone CPython ${PYTHON_VERSION}.`,
        `Install it with: uv python install ${PYTHON_VERSION}`,
        (result.stderr ?? "").trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const found = result.stdout.trim();
  if (!found || !existsSync(found)) {
    throw new Error(`uv returned a missing Python executable: ${found}`);
  }
  return found;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, UV_CACHE_DIR: cacheDir },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
