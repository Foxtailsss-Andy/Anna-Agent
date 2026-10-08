import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, openSync, statSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isWithinPath, parseRelativePathInput } from "./workdir-paths";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const LSOF_EXECUTABLE = "/usr/sbin/lsof";
const SHELL_EXECUTABLE = "/bin/sh";
const SANDBOX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SIGKILL_GRACE_MS = 1_000;
/** After the command returns and leftovers are terminated, how long to wait for pipes to drain. */
const STREAM_CLOSE_GRACE_MS = 500;
const MARKER_FILE = ".anna-sandbox-marker";

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
    const markerPath = join(scratchRoot, MARKER_FILE);
    try {
      await writeFile(markerPath, "", { mode: 0o600, flag: "wx" });
    } catch {
      return { status: "failed", output: { reason: "sandbox_scratch_unavailable" } };
    }
    return await executeSandboxed({
      profile,
      command: parsed.command,
      cwd,
      scratchRoot,
      markerPath,
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
  if (parseRelativePathInput(requested) === undefined) throw new Error("sandbox_cwd_outside_workdir");
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

export function buildSandboxProfile(input: {
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
  // Deny by default, then allow what ordinary command-line tools need. Everything not
  // listed stays denied: network, Mach/XPC services (LaunchServices, Apple Events,
  // pasteboard, preferences daemons), IOKit, sysctl writes, and writes outside the
  // workdir/scratch. Later rules take precedence, so the read denials below narrow the
  // broad read allowance.
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem)",
    "(allow pseudo-tty)",
    "(allow file-ioctl)",
    // User/group lookups (getpwuid etc.) used by git, python, whoami.
    `(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))`,
    "(allow file-read*)",
    `(allow file-write* (require-any ${writable}))`,
    "(deny network*)",
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
  markerPath: string;
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
    // Every descendant inherits this descriptor (fd 3) unless it deliberately closes it,
    // so processes that detach with setsid() can still be found and terminated.
    let markerFd: number;
    let marker: { device: bigint; inode: bigint };
    try {
      markerFd = openSync(input.markerPath, "r");
    } catch {
      resolvePromise({ status: "failed", output: { reason: "sandbox_launch_failed" } });
      return;
    }
    try {
      const info = fstatSync(markerFd, { bigint: true });
      marker = { device: info.dev, inode: info.ino };
    } catch {
      closeSync(markerFd);
      resolvePromise({ status: "failed", output: { reason: "sandbox_launch_failed" } });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(SANDBOX_EXECUTABLE, argv, {
        cwd: input.cwd,
        env: buildEnvironment(input.scratchRoot),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", markerFd],
      });
    } catch {
      closeSync(markerFd);
      resolvePromise({ status: "failed", output: { reason: "sandbox_launch_failed" } });
      return;
    }
    // Retain the inode until all sweeps finish. Unlinking the pathname in the
    // writable scratch must neither hide holders nor permit inode reuse.

    const stdout = createCappedSink(input.maxOutputBytes);
    const stderr = createCappedSink(input.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const rootPid = child.pid;
    const rootStartIdentity = rootPid === undefined ? undefined : processStartIdentity(rootPid);
    let timedOut = false;
    let killSignal: string | undefined;
    let settled = false;
    let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let streamsClosed = false;
    let swept = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let sweepQueue = Promise.resolve();
    let terminationStarted = false;

    const sweep = (signalName: "SIGTERM" | "SIGKILL") => {
      sweepQueue = sweepQueue.then(() => rootPid === undefined ? undefined : terminateSandboxProcesses({
        rootPid,
        rootStartIdentity,
        rootExited: exitResult !== undefined,
        marker,
        startedAt,
        signalName,
      }));
      return sweepQueue;
    };

    const beginTermination = () => {
      if (terminationStarted || exitResult !== undefined || settled) return;
      terminationStarted = true;
      timedOut = true;
      killSignal = "SIGTERM";
      void sweep("SIGTERM");
      sigkillTimer = setTimeout(() => {
        if (exitResult !== undefined || settled) return;
        killSignal = "SIGKILL";
        void sweep("SIGKILL");
      }, SIGKILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => {
      beginTermination();
    }, input.timeoutMs);

    const onAbort = () => {
      beginTermination();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    const cleanupTimers = () => {
      clearTimeout(timeoutTimer);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      if (closeGraceTimer !== undefined) clearTimeout(closeGraceTimer);
      input.signal.removeEventListener("abort", onAbort);
      closeSync(markerFd);
    };

    const finish = () => {
      if (settled || exitResult === undefined) return;
      settled = true;
      cleanupTimers();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const effectiveSignal = exitResult.signal ?? (timedOut ? killSignal : undefined);
      const output: SandboxExecOutput = {
        exit_code: exitResult.code,
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout: stdout.decode(),
        stderr: stderr.decode(),
        stdout_truncated: stdout.truncated(),
        stderr_truncated: stderr.truncated(),
        sandbox: input.descriptor,
      };
      const status = exitResult.code === 0 && !timedOut ? "succeeded" : "failed";
      resolvePromise({ status, output });
    };

    child.on("error", () => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolvePromise({ status: "failed", output: { reason: "sandbox_launch_failed" } });
    });
    child.on("exit", (code, signalName) => {
      exitResult = { code, signal: signalName };
      // Sweep tracked jobs before reporting the result. A process that closes all
      // inherited descriptors and detaches before discovery remains untracked.
      void sweep("SIGKILL").finally(() => {
        swept = true;
        if (streamsClosed) finish();
        else closeGraceTimer = setTimeout(finish, STREAM_CLOSE_GRACE_MS);
      });
    });
    child.on("close", () => {
      streamsClosed = true;
      if (swept) finish();
    });
  });
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  startedAtMs: number;
  startIdentity: string;
}

/**
 * Signals the observed process tree: the original process group and live root's ppid closure,
 * plus detached holders of the per-call marker inode and their descendants.
 * The Host's pid is never signalled.
 * A process that both closes every inherited descriptor and detaches is not found; it
 * stays under the same seatbelt profile.
 */
async function terminateSandboxProcesses(input: {
  rootPid: number;
  rootStartIdentity: string | undefined;
  rootExited: boolean;
  marker: { device: bigint; inode: bigint };
  startedAt: number;
  signalName: "SIGTERM" | "SIGKILL";
}): Promise<void> {
  const rows = await processSnapshot();
  const detachedCandidates = rows
    .filter((row) => row.pid !== process.pid && row.startedAtMs >= input.startedAt - 2_000)
    .map((row) => row.pid);
  const holders = detachedCandidates.length === 0 ? [] : await markerHolderPids(input.marker, detachedCandidates);
  const rootStillOwned = !input.rootExited && input.rootStartIdentity !== undefined
    && rows.some((row) => row.pid === input.rootPid && row.startIdentity === input.rootStartIdentity);
  // A process group survives its leader. Ordinary background commands can close
  // fd 3 without leaving that group, so retain its observed members after root
  // exit. If the leader PID now belongs to a new process, distrust the numeric
  // group entirely. Every selected member is identity-checked again below.
  const rootReplaced = rows.some((row) => row.pid === input.rootPid
    && (input.rootExited || row.startIdentity !== input.rootStartIdentity));
  const groupMembers = rootReplaced ? [] : rows.filter((row) => row.pgid === input.rootPid
    && row.startedAtMs >= input.startedAt - 2_000).map((row) => row.pid);
  const targets = descendantClosure(rows, [
    ...(rootStillOwned ? [input.rootPid] : []), ...holders, ...groupMembers,
  ]);
  for (const row of rows) {
    if (!targets.has(row.pid) || row.pid === process.pid || row.pid <= 1) continue;
    try {
      // Never signal an unverified stale snapshot PID or an already-reaped root's
      // numeric process group. macOS lacks a Node pidfd equivalent; this narrows,
      // but cannot atomically eliminate, the check-to-signal reuse window.
      const current = processStartIdentity(row.pid);
      if (current !== row.startIdentity) continue;
      process.kill(row.pid, input.signalName);
    } catch {
      // already exited
    }
  }
}

function descendantClosure(rows: readonly ProcessRow[], seeds: readonly number[]): Set<number> {
  const tracked = new Set<number>(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (tracked.has(row.pid)) continue;
      if (tracked.has(row.ppid)) {
        tracked.add(row.pid);
        grew = true;
      }
    }
  }
  return tracked;
}

function processStartIdentity(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function processSnapshot(): Promise<ProcessRow[]> {
  return new Promise((resolvePromise) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,etime=,lstart="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolvePromise([]);
        return;
      }
      const now = Date.now();
      const rows: ProcessRow[] = [];
      for (const line of stdout.split("\n")) {
        const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (fields === null) continue;
        const [, pid, ppid, pgid, etime, startIdentity] = fields;
        const elapsed = parseElapsedSeconds(etime);
        const numbers = [Number(pid), Number(ppid), Number(pgid)];
        if (elapsed === undefined || !numbers.every(Number.isSafeInteger)) continue;
        rows.push({ pid: numbers[0]!, ppid: numbers[1]!, pgid: numbers[2]!, startedAtMs: now - elapsed * 1_000, startIdentity: startIdentity! });
      }
      resolvePromise(rows);
    });
  });
}

/** `ps` etime: `[[dd-]hh:]mm:ss`. */
function parseElapsedSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (match === null) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function markerHolderPids(marker: { device: bigint; inode: bigint }, candidates: readonly number[]): Promise<number[]> {
  return new Promise((resolvePromise) => {
    execFile(
      LSOF_EXECUTABLE,
      ["-w", "-a", "-p", candidates.join(","), "-F", "pDfi"],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout) => {
        const holders = new Set<number>();
        let pid = 0;
        let device: bigint | undefined;
        for (const line of String(stdout ?? "").split("\n")) {
          if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
          else if (line.startsWith("f")) device = undefined;
          else if (/^D0x[\da-f]+$/i.test(line)) device = BigInt(line.slice(1));
          else if (/^i\d+$/.test(line) && device === marker.device && BigInt(line.slice(1)) === marker.inode) {
            if (Number.isSafeInteger(pid) && pid > 1) holders.add(pid);
          }
        }
        resolvePromise([...holders]);
      },
    );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
