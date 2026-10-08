import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const SHELL_EXECUTABLE = "/bin/sh";
const SANDBOX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SIGKILL_GRACE_MS = 1_000;

// User-data roots whose file *contents* are denied unless the access is inside
// the admitted workdir or the per-call scratch directory.
const READ_DENIED_ROOT_CANDIDATES = [
  "/Users",
  "/Volumes",
  "/private/var/folders",
  "/private/tmp",
  "/tmp",
] as const;

export interface SandboxDescriptor {
  kind: "macos-seatbelt";
  network: "denied";
  writable_roots: string[];
  read_denied_roots: string[];
}

export interface SandboxExecInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export interface SandboxExecOutput {
  exit_code: number | null;
  signal?: string;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  sandbox: SandboxDescriptor;
}

export interface RunSandboxedCommandOptions {
  workdirRoot: string;
  protectedPaths: readonly string[];
  signal: AbortSignal;
  maxOutputBytes?: number;
}

export function sandboxSupport(): { available: true } | { available: false; reason: string } {
  if (process.platform !== "darwin") {
    return { available: false, reason: "sandbox_requires_macos" };
  }
  try {
    const info = statSync(SANDBOX_EXECUTABLE);
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      return { available: false, reason: "sandbox_exec_not_executable" };
    }
  } catch {
    return { available: false, reason: "sandbox_exec_missing" };
  }
  return { available: true };
}

export async function runSandboxedCommand(
  input: unknown,
  options: RunSandboxedCommandOptions,
): Promise<{ status: "succeeded" | "failed"; output: SandboxExecOutput | { reason: string } }> {
  if (options.signal.aborted) {
    return { status: "failed", output: { reason: "cancelled" } };
  }
  const support = sandboxSupport();
  if (!support.available) {
    return { status: "failed", output: { reason: support.reason } };
  }
  const parsed = parseSandboxInput(input);
  if (parsed === undefined) {
    return { status: "failed", output: { reason: "invalid_sandbox_exec_request" } };
  }

  let workdirRoot: string;
  try {
    workdirRoot = await realpath(options.workdirRoot);
    const rootInfo = await stat(workdirRoot);
    if (!rootInfo.isDirectory()) {
      return { status: "failed", output: { reason: "sandbox_workdir_unavailable" } };
    }
  } catch {
    return { status: "failed", output: { reason: "sandbox_workdir_unavailable" } };
  }

  let cwd: string;
  try {
    cwd = await resolveCwd(workdirRoot, parsed.cwd);
  } catch {
    return { status: "failed", output: { reason: "sandbox_cwd_outside_workdir" } };
  }

  const protectedPaths = await canonicalizeProtectedPaths(options.protectedPaths);
  const readDeniedRoots = await canonicalizeReadDeniedRoots();
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);

  let scratchRoot: string | undefined;
  try {
    const created = await mkdtemp(resolve(tmpdir(), "anna-sandbox-"));
    await chmod(created, 0o700);
    scratchRoot = await realpath(created);
  } catch {
    if (scratchRoot !== undefined) await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
    return { status: "failed", output: { reason: "sandbox_scratch_unavailable" } };
  }

  const descriptor: SandboxDescriptor = {
    kind: "macos-seatbelt",
    network: "denied",
    writable_roots: [workdirRoot, scratchRoot],
    read_denied_roots: readDeniedRoots,
  };

  try {
    const profile = buildSandboxProfile({
      workdirRoot,
      scratchRoot,
      protectedPaths,
      readDeniedRoots,
    });
    return await executeSandboxed({
      profile,
      command: parsed.command,
      cwd,
      scratchRoot,
      timeoutMs: parsed.timeoutMs,
      maxOutputBytes,
      signal: options.signal,
      descriptor,
    });
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface ParsedSandboxInput {
  command: string;
  cwd?: string;
  timeoutMs: number;
}

function parseSandboxInput(input: unknown): ParsedSandboxInput | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of Object.keys(input)) {
    if (key !== "command" && key !== "cwd" && key !== "timeout_ms") return undefined;
  }
  if (typeof input.command !== "string" || input.command.trim() === "") return undefined;
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim() === "")) return undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (input.timeout_ms !== undefined) {
    const raw = input.timeout_ms;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
    timeoutMs = Math.min(raw, MAX_TIMEOUT_MS);
  }
  return {
    command: input.command,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    timeoutMs,
  };
}

async function resolveCwd(workdirRoot: string, requested: string | undefined): Promise<string> {
  if (requested === undefined) return workdirRoot;
  if (isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested) || requested.startsWith("\\")) {
    throw new Error("sandbox_cwd_outside_workdir");
  }
  const target = resolve(workdirRoot, requested);
  if (!isWithinPath(relative(workdirRoot, target))) throw new Error("sandbox_cwd_outside_workdir");
  const canonical = await realpath(target);
  if (!isWithinPath(relative(workdirRoot, canonical))) throw new Error("sandbox_cwd_outside_workdir");
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("sandbox_cwd_outside_workdir");
  return canonical;
}

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return DEFAULT_MAX_OUTPUT_BYTES;
  return value;
}

async function canonicalizeProtectedPaths(paths: readonly string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.trim() === "") continue;
    const resolved = await realpath(resolve(path)).catch(() => resolve(path));
    canonical.push(resolved);
  }
  return uniquePaths(canonical);
}

async function canonicalizeReadDeniedRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of READ_DENIED_ROOT_CANDIDATES) {
    roots.push(candidate);
    const resolved = await realpath(candidate).catch(() => undefined);
    if (resolved !== undefined) roots.push(resolved);
  }
  return uniquePaths(roots);
}

function buildSandboxProfile(input: {
  workdirRoot: string;
  scratchRoot: string;
  protectedPaths: readonly string[];
  readDeniedRoots: readonly string[];
}): string {
  const writable = [
    subpath(input.workdirRoot),
    subpath(input.scratchRoot),
    `(literal ${JSON.stringify("/dev/null")})`,
    `(literal ${JSON.stringify("/dev/zero")})`,
    `(regex #"^/dev/tty")`,
    `(regex #"^/dev/fd/")`,
  ].join(" ");
  const allowedReads = [subpath(input.workdirRoot), subpath(input.scratchRoot)].join(" ");
  const deniedReadRoots = input.readDeniedRoots.map(subpath).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    `(deny file-write* (require-not (require-any ${writable})))`,
    `(deny file-read-data (require-all (require-any ${deniedReadRoots}) (require-not (require-any ${allowedReads}))))`,
  ];
  // Protected paths are always denied for read and write, even inside an allowed root.
  for (const path of input.protectedPaths) {
    lines.push(`(deny file-read* (subpath ${JSON.stringify(path)}))`);
    lines.push(`(deny file-write* (subpath ${JSON.stringify(path)}))`);
  }
  return lines.join("\n");
}

function subpath(path: string): string {
  return `(subpath ${JSON.stringify(path)})`;
}

interface ExecuteInput {
  profile: string;
  command: string;
  cwd: string;
  scratchRoot: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  descriptor: SandboxDescriptor;
}

function executeSandboxed(
  input: ExecuteInput,
): Promise<{ status: "succeeded" | "failed"; output: SandboxExecOutput | { reason: string } }> {
  return new Promise((resolvePromise) => {
    const argv = ["-p", input.profile, SHELL_EXECUTABLE, "-c", input.command];
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(SANDBOX_EXECUTABLE, argv, {
        cwd: input.cwd,
        env: buildEnvironment(input.scratchRoot),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolvePromise({ status: "failed", output: { reason: "sandbox_launch_failed" } });
      return;
    }

    const stdout = createCappedSink(input.maxOutputBytes);
    const stderr = createCappedSink(input.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let timedOut = false;
    let killSignal: string | undefined;
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signalName: "SIGTERM" | "SIGKILL") => {
      killSignal = signalName;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // process already gone
        }
      }
    };

    const beginTermination = () => {
      killGroup("SIGTERM");
      sigkillTimer = setTimeout(() => killGroup("SIGKILL"), SIGKILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, input.timeoutMs);

    const onAbort = () => {
      timedOut = true;
      beginTermination();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      input.signal.removeEventListener("abort", onAbort);
      const effectiveSignal = exitSignal ?? killSignal;
      const output: SandboxExecOutput = {
        exit_code: exitCode,
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout: stdout.decode(),
        stderr: stderr.decode(),
        stdout_truncated: stdout.truncated(),
        stderr_truncated: stderr.truncated(),
        sandbox: input.descriptor,
      };
      const status = exitCode === 0 && !timedOut ? "succeeded" : "failed";
      resolvePromise({ status, output });
    };

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      input.signal.removeEventListener("abort", onAbort);
      resolvePromise({ status: "failed", output: { reason: "sandbox_launch_failed" } });
    });
    child.on("close", (code, signalName) => finish(code, signalName));
  });
}

function buildEnvironment(scratchRoot: string): Record<string, string> {
  return {
    PATH: SANDBOX_PATH,
    HOME: scratchRoot,
    TMPDIR: scratchRoot,
    LANG: "en_US.UTF-8",
    ANNA_SANDBOX: "1",
  };
}

interface CappedSink {
  push(chunk: Buffer): void;
  decode(): string;
  truncated(): boolean;
}

function createCappedSink(maxBytes: number): CappedSink {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (total >= maxBytes) {
        truncated = true;
        return;
      }
      if (total + chunk.byteLength > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    },
    decode() {
      return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
    },
    truncated() {
      return truncated;
    },
  };
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function isWithinPath(relativePath: string): boolean {
  return relativePath === ""
    || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
