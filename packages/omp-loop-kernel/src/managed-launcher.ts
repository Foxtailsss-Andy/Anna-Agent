import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const DEFAULT_PATH = "/usr/bin:/bin";
const ATTEMPT_ENV_KEYS = [
  "ANNA_OMP_ATTEMPT_ROOT",
  "CI",
  "HOME",
  "PATH",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export type ManagedLauncherErrorCode =
  | "OMP_RUNTIME_INVALID"
  | "OMP_SANDBOX_UNAVAILABLE"
  | "OMP_SANDBOX_LAUNCH_FAILED";

export class ManagedLauncherError extends Error {
  readonly code: ManagedLauncherErrorCode;

  constructor(code: ManagedLauncherErrorCode, message: string) {
    super(message);
    this.name = "ManagedLauncherError";
    this.code = code;
  }
}

export interface ManagedWorkerLaunchSpec {
  readonly runtimeRoot: string;
  readonly entryPath: string;
  readonly bunPath?: string;
  readonly args?: readonly string[];
  readonly attemptParent?: string;
  readonly workspaceRoot?: string;
  readonly protectedReadRoots?: readonly string[];
}

export interface ManagedWorkerHandle {
  readonly child: ChildProcessWithoutNullStreams;
  readonly attemptRoot: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly sandboxProfile: string;
  close(): Promise<void>;
}

export async function launchManagedWorker(
  spec: ManagedWorkerLaunchSpec,
): Promise<ManagedWorkerHandle> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new ManagedLauncherError(
      "OMP_SANDBOX_UNAVAILABLE",
      "managed OMP workers require darwin-arm64 sandbox-exec",
    );
  }

  await assertSandboxExecutable();
  const runtimeRoot = await resolveDirectory(spec.runtimeRoot, "runtime root");
  const entryPath = await resolveFile(spec.entryPath, "worker entry");
  const bunPath = await resolveFile(spec.bunPath ?? join(runtimeRoot, "bun"), "Bun executable");
  if (!isWithin(runtimeRoot, entryPath) || !isWithin(runtimeRoot, bunPath)) {
    throw new ManagedLauncherError(
      "OMP_RUNTIME_INVALID",
      "worker entry and Bun executable must remain inside the managed runtime root",
    );
  }

  const attemptParent = await resolveDirectory(spec.attemptParent ?? tmpdir(), "attempt parent");
  if (isWithin(runtimeRoot, attemptParent)) {
    throw new ManagedLauncherError(
      "OMP_RUNTIME_INVALID",
      "the writable attempt parent must not be inside the read-only runtime root",
    );
  }
  const workspaceRoot = await resolveDirectory(spec.workspaceRoot ?? process.cwd(), "workspace root");
  const protectedReadRoots = await resolveProtectedRoots(spec.protectedReadRoots ?? [], workspaceRoot);
  const attemptRoot = await mkdtemp(join(attemptParent, "anna-omp-attempt-"));
  await chmod(attemptRoot, 0o700);
  const canonicalAttemptRoot = await realpath(attemptRoot);
  if (isWithin(runtimeRoot, canonicalAttemptRoot) || isWithin(canonicalAttemptRoot, runtimeRoot)) {
    await rm(canonicalAttemptRoot, { recursive: true, force: true });
    throw new ManagedLauncherError(
      "OMP_RUNTIME_INVALID",
      "the writable attempt directory must not overlap the managed runtime root",
    );
  }
  const environment = buildEnvironment(canonicalAttemptRoot);
  const sandboxProfile = buildSandboxProfile({
    runtimeRoot,
    attemptRoot: canonicalAttemptRoot,
    bunPath,
    protectedReadRoots,
  });
  const argv = ["-p", sandboxProfile, bunPath, entryPath, ...(spec.args ?? [])];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(SANDBOX_EXECUTABLE, argv, {
      cwd: canonicalAttemptRoot,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const closeTracker = trackChildClose(child);
    await waitForSpawn(child);

    let closePromise: Promise<void> | undefined;
    const cleanup = async (): Promise<void> => {
      await rm(canonicalAttemptRoot, { recursive: true, force: true });
    };
    const close = (): Promise<void> => {
      closePromise ??= closeWorker(child, closeTracker, cleanup);
      return closePromise;
    };
    return {
      child,
      attemptRoot: canonicalAttemptRoot,
      argv,
      environment,
      sandboxProfile,
      close,
    };
  } catch (error) {
    await rm(canonicalAttemptRoot, { recursive: true, force: true });
    if (error instanceof ManagedLauncherError) throw error;
    throw new ManagedLauncherError(
      "OMP_SANDBOX_LAUNCH_FAILED",
      `managed worker could not start through ${SANDBOX_EXECUTABLE}`,
    );
  }
}

async function assertSandboxExecutable(): Promise<void> {
  try {
    const canonical = await realpath(SANDBOX_EXECUTABLE);
    const metadata = await stat(canonical);
    if (canonical !== SANDBOX_EXECUTABLE || (metadata.mode & 0o111) === 0) {
      throw new Error("sandbox executable is not executable at the fixed path");
    }
  } catch {
    throw new ManagedLauncherError(
      "OMP_SANDBOX_UNAVAILABLE",
      `${SANDBOX_EXECUTABLE} is required for managed workers`,
    );
  }
}

async function resolveDirectory(path: string, name: string): Promise<string> {
  const resolved = await resolveExisting(path, name);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory()) {
    throw new ManagedLauncherError("OMP_RUNTIME_INVALID", `${name} must be a directory`);
  }
  return resolved;
}

async function resolveFile(path: string, name: string): Promise<string> {
  const resolved = await resolveExisting(path, name);
  const metadata = await lstat(resolved);
  if (!metadata.isFile()) {
    throw new ManagedLauncherError("OMP_RUNTIME_INVALID", `${name} must be a regular file`);
  }
  return resolved;
}

async function resolveExisting(path: string, name: string): Promise<string> {
  if (path.length === 0 || !isAbsolute(path)) {
    throw new ManagedLauncherError("OMP_RUNTIME_INVALID", `${name} must be an absolute path`);
  }
  try {
    return await realpath(path);
  } catch {
    throw new ManagedLauncherError("OMP_RUNTIME_INVALID", `${name} is unavailable`);
  }
}

async function resolveProtectedRoots(
  extraRoots: readonly string[],
  workspaceRoot: string,
): Promise<string[]> {
  const roots = [
    await realpath("/Users"),
    await realpath(homedir()),
    await realpath("/Volumes"),
    await realpath("/tmp"),
    await realpath("/private/tmp"),
    await realpath("/var/tmp"),
    await realpath("/private/var/tmp"),
    await realpath("/private/var/folders"),
    workspaceRoot,
  ];
  for (const path of extraRoots) {
    roots.push(await resolveExisting(path, "protected read root"));
  }
  return uniquePaths(roots);
}

function buildEnvironment(attemptRoot: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    ANNA_OMP_ATTEMPT_ROOT: attemptRoot,
    CI: "1",
    HOME: attemptRoot,
    PATH: DEFAULT_PATH,
    TMPDIR: attemptRoot,
    USERPROFILE: attemptRoot,
    XDG_CACHE_HOME: attemptRoot,
    XDG_CONFIG_HOME: attemptRoot,
    XDG_DATA_HOME: attemptRoot,
    XDG_RUNTIME_DIR: attemptRoot,
  };
  return Object.freeze(environment);
}

function buildSandboxProfile(input: {
  runtimeRoot: string;
  attemptRoot: string;
  bunPath: string;
  protectedReadRoots: readonly string[];
}): string {
  const protectedReads = input.protectedReadRoots.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
  const allowedReads = [input.runtimeRoot, input.attemptRoot]
    .map((path) => `(subpath ${JSON.stringify(path)})`)
    .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-fork)",
    "(deny process-exec*)",
    `(allow process-exec (literal ${JSON.stringify(input.bunPath)}))`,
    `(deny file-write* (require-not (subpath ${JSON.stringify(input.attemptRoot)})))`,
    [
      "(deny file-read-data (require-all",
      `(require-any ${protectedReads})`,
      `(require-not (require-any ${allowedReads}))`,
      "))",
    ].join(""),
    `(allow file-read-metadata (require-any ${protectedReads}))`,
  ].join("");
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function closeWorker(
  child: ChildProcessWithoutNullStreams,
  closeTracker: ChildCloseTracker,
  cleanup: () => Promise<void>,
): Promise<void> {
  let closed = closeTracker.isClosed();
  try {
    if (!closed && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    if (!closed) {
      closed = await closeTracker.wait(2_000);
    }
    if (!closed && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    if (!closed) {
      closed = await closeTracker.wait(1_000);
    }
    if (!closed) {
      throw new ManagedLauncherError(
        "OMP_SANDBOX_LAUNCH_FAILED",
        "managed worker did not close its pipes before launcher cleanup deadline",
      );
    }
  } finally {
    if (closeTracker.isClosed()) {
      await cleanup();
    }
  }
}

interface ChildCloseTracker {
  isClosed(): boolean;
  wait(timeoutMs: number): Promise<boolean>;
}

function trackChildClose(child: ChildProcessWithoutNullStreams): ChildCloseTracker {
  let closed = false;
  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolvePromise) => {
    resolveClose = resolvePromise;
  });
  child.once("close", () => {
    closed = true;
    resolveClose();
  });
  return {
    isClosed: () => closed,
    wait: async (timeoutMs) => {
      if (closed) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      });
      const closedResult = closePromise.then(() => true);
      const result = await Promise.race([closedResult, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      return result;
    },
  };
}

export const managedLauncherEnvironmentKeys = ATTEMPT_ENV_KEYS;
