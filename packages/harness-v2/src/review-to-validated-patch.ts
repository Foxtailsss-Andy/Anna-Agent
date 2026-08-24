import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStartRun, type CanonicalEvent, type ScheduleRecord, type StreamId } from "./contracts";
import type {
  DurableToolGateway,
  Scheduler,
  SandboxAdapter,
  ScopedChannelStore,
  ToolRequest,
  ToolResult,
} from "./interfaces";
import type { ChannelMemoryRepository } from "./memory-types";
import { createToolGateway, type ToolDefinition } from "./tool-gateway";
import {
  parseResolvedRunProfileSnapshot,
  resolveRunProfile,
  type ResolvedRunProfile,
} from "./run-profile";
import {
  createLocalPreviewWorktreeSandbox,
  createLocalPreviewWorktreeToolCatalog,
} from "./worktree-sandbox";

export interface ReviewScenarioInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly reviewNotes: string;
  readonly prdPath: string;
  readonly uiPath: string;
  readonly testPath?: string;
  readonly ownerId: string;
  readonly sourceRunId: string;
  readonly sourceEventIds: readonly string[];
}

export interface ReviewScenarioPaths {
  readonly root: string;
  readonly prd: string;
  readonly ui: string;
  readonly test?: string;
  readonly screenshot: string;
}

export type ReviewLane = "prd" | "ui";
export type ReviewArtifactKind = "prd" | "ui" | "ui-build" | "screenshot" | "patch" | "test";
export type ReviewEvidenceMode = "fixture" | "live";

export interface ReviewArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly runId: string;
  readonly kind: ReviewArtifactKind;
  readonly uri: string;
  readonly path: string;
  readonly hash: string;
  readonly version: string;
  readonly producerRunId: string;
  readonly validationStatus: "pending" | "passed" | "failed";
  readonly reviewState: "pending" | "approved";
  readonly changedFiles: readonly string[];
  readonly sourceBuildHash?: string;
  readonly buildCommand?: string;
  readonly buildEvidence?: ReviewCommandEvidence;
  readonly visibleText?: string;
}

export interface ReviewLaneOutput {
  readonly id: string;
  readonly lane: ReviewLane;
  readonly kind: "proposal" | "artifact";
  readonly traceId: string;
  readonly targetPath: string;
  readonly candidate: string;
  readonly artifact?: ReviewArtifact;
  readonly uiBuild?: ReviewArtifact;
  readonly screenshot?: ReviewArtifact;
  readonly approved: boolean;
}

export interface ReviewGate {
  readonly id: string;
  readonly kind: "prd_ui_approval" | "development_approval" | "tests";
  readonly status: "pending" | "passed" | "failed";
  readonly traceId: string;
  readonly artifactIds: readonly string[];
  readonly actorId?: string;
}

export interface ReviewMemoryCandidate {
  readonly id: string;
  readonly content: string;
  readonly sourceRunId: string;
  readonly sourceEventIds: readonly string[];
  readonly traceId: string;
  readonly confirmed: boolean;
}

export interface ReviewFollowUp {
  readonly id: string;
  readonly dueAt: string;
  readonly trigger: { readonly kind: "explicit"; readonly label: string };
  readonly audience: readonly string[];
  readonly traceId: string;
  readonly schedule: ScheduleRecord;
}

export type FollowUpScheduler = Pick<Scheduler, "schedule">;

export interface ReviewTrace {
  readonly traceId: string;
  readonly artifactIds: readonly string[];
  readonly gateIds: readonly string[];
  readonly eventIds: readonly string[];
}

export interface ReviewTraceProjector {
  project(events: readonly CanonicalEvent[], traceId: string): Promise<ReviewTrace> | ReviewTrace;
}

export interface ReviewEvalResult {
  readonly passed: boolean;
  readonly reason?: string;
  readonly checkedEventIds: readonly string[];
}

export interface ReviewEvalGate {
  evaluate(input: {
    readonly traceId: string;
    readonly events: readonly CanonicalEvent[];
    readonly artifacts: readonly ReviewArtifact[];
    readonly testsPassed: boolean;
    readonly reviewNotes?: string;
    readonly contract?: ReviewEvalResult;
  }): Promise<ReviewEvalResult>;
}

export interface ReviewApprovalProvider {
  confirmMemoryCandidate(candidate: ReviewMemoryCandidate): Promise<ReviewApprovalDecision>;
  approveLane(lane: ReviewLaneOutput): Promise<ReviewApprovalDecision>;
  approveEffect(effectKey: string): Promise<ReviewApprovalDecision>;
}

export interface ReviewApprovalDecision {
  readonly approved: boolean;
  readonly actorId: string;
}

export interface ReviewCommandEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReviewScenarioServices {
  readonly events: Pick<ScopedChannelStore, "append" | "appendIdempotent" | "read" | "listRunStreamIds">;
  readonly memory: Pick<ChannelMemoryRepository, "propose" | "accept">;
  readonly traceProjector: ReviewTraceProjector;
  readonly evalGate: ReviewEvalGate;
}

export class ReviewUnsupportedPlatformError extends Error {
  readonly code = "T07_UNSUPPORTED_PLATFORM";

  constructor(readonly platform: NodeJS.Platform) {
    super(`T07 live evidence is supported only on macOS; received ${platform}`);
    this.name = "ReviewUnsupportedPlatformError";
  }
}

export function assertT07LivePlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    throw new ReviewUnsupportedPlatformError(platform);
  }
}

export interface ReviewGitEvidence {
  readonly worktreeRoot: string;
  readonly diff: string;
  readonly status: string;
  readonly commands: readonly string[];
  readonly valid: boolean;
  readonly error?: string;
}

interface ReviewDependencyBridgeEvidence {
  readonly sourceRoot: string;
  readonly dependencyRoot: string;
  readonly readOnly: true;
}

export interface ReviewTestResult {
  readonly passed: boolean;
  readonly mergeReady: boolean;
  readonly blockedBy: readonly string[];
  readonly artifact: ReviewArtifact;
  readonly evidence: ReviewCommandEvidence;
}

export interface ReviewScenarioResult {
  readonly traceId: string;
  readonly paths: ReviewScenarioPaths;
  readonly artifacts: readonly ReviewArtifact[];
  readonly gates: readonly ReviewGate[];
  readonly screenshot: ReviewArtifact;
  readonly uiBuild: ReviewArtifact;
  readonly commands: readonly string[];
  readonly mergeReady: boolean;
  readonly blockedBy: readonly string[];
  readonly humanMergeDecision: "pending";
  readonly evidenceMode: ReviewEvidenceMode;
  readonly testEvidence: ReviewCommandEvidence;
  readonly eval: ReviewEvalResult;
  readonly trace: {
    readonly traceId: string;
    readonly artifactIds: readonly string[];
    readonly gateIds: readonly string[];
    readonly memoryCandidateId?: string;
    readonly followUpId?: string;
    readonly eventIds: readonly string[];
  };
  readonly memoryCandidate?: ReviewMemoryCandidate;
  readonly followUp?: ReviewFollowUp;
  readonly git: ReviewGitEvidence;
}

export interface PreparedReview {
  readonly traceId: string;
  readonly paths: ReviewScenarioPaths;
  readonly prdBefore: string;
  readonly uiBefore: string;
  readonly testBefore?: string;
}

export interface DevelopmentPatch {
  readonly traceId: string;
  readonly paths: ReviewScenarioPaths;
  readonly prd: ReviewLaneOutput;
  readonly ui: ReviewLaneOutput;
  readonly artifacts: readonly ReviewArtifact[];
  readonly uiBuild: ReviewArtifact;
  readonly testSource?: ReviewArtifact;
}

export interface ReviewScenarioOptions {
  readonly root: string;
  readonly input: ReviewScenarioInput;
  readonly mode?: ReviewEvidenceMode;
  readonly liveWorktree?: { readonly expectedHead: string; readonly backendOrigin?: string };
  readonly runProfileSnapshot?: ResolvedRunProfile;
  readonly followUpDueAt?: string;
  readonly followUpRunProfileSnapshot?: ResolvedRunProfile;
  readonly scheduler?: FollowUpScheduler;
  readonly services: ReviewScenarioServices;
  readonly approvalProvider?: ReviewApprovalProvider;
}

export interface DeterministicReviewFixture {
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly input: ReviewScenarioInput;
  readonly cleanup: () => Promise<void>;
}

interface ProjectedReviewState {
  readonly traceId: string;
  readonly lanes: readonly ReviewLaneOutput[];
  readonly gates: readonly ReviewGate[];
  readonly artifacts: readonly ReviewArtifact[];
  readonly memoryCandidate?: ReviewMemoryCandidate;
  readonly followUp?: ReviewFollowUp;
  readonly result?: ReviewScenarioResult;
}

const safeCommands = Object.freeze([
  "git diff",
  "git status --short",
  "git rev-parse HEAD",
  "git rev-parse --show-toplevel",
  "git rev-parse --git-common-dir",
  "npm test",
  "npm run build",
]);
const execFile = promisify(execFileCallback);
const blockedCommandPattern = /(?:^|\s)(?:git\s+(?:push|merge)|deploy)(?:\s|$)/i;
const require = createRequire(import.meta.url);

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export const hashBytesForTest = hashBytes;

class ReviewApprovalRejectedError extends Error {
  readonly code = "T07_APPROVAL_REJECTED";
}

class ReviewBudgetExceededError extends Error {
  readonly code = "T07_BUDGET_EXCEEDED";
}

function requireApprovalDecision(
  value: unknown,
  expectedActorId: string,
  action: string,
): ReviewApprovalDecision {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || typeof (value as { approved?: unknown }).approved !== "boolean"
    || typeof (value as { actorId?: unknown }).actorId !== "string"
    || (value as { actorId: string }).actorId.trim().length === 0
  ) {
    throw new ReviewApprovalRejectedError(`${action} must return an approval decision with a non-empty actorId`);
  }
  const decision = value as ReviewApprovalDecision;
  if (decision.approved && decision.actorId !== expectedActorId) {
    throw new ReviewApprovalRejectedError(`${action} approval actor does not match the Channel Owner`);
  }
  return decision;
}

function failureClassification(stage: string, error: unknown): string | undefined {
  if (error instanceof ReviewBudgetExceededError) return "STOP";
  if (error instanceof ReviewApprovalRejectedError) return "STOP";
  if (stage === "eval") return "GRADER";
  if (stage === "tests") return "OUTPUT";
  if (stage === "screenshot") return "ADAPTER";
  if (stage === "development") return "TOOL_EXEC";
  if (stage === "git_evidence") return "TOOL_EXEC";
  if (stage === "prepare") return "CONTEXT";
  if (stage === "memory_candidate" || stage === "review_lanes") return "PLAN";
  if (error instanceof Error && error.name === "ReviewUnsupportedPlatformError") return "INFRA";
  return undefined;
}

function evaluateReviewContract(input: {
  readonly traceId: string;
  readonly events: readonly CanonicalEvent[];
  readonly artifacts: readonly ReviewArtifact[];
  readonly testsPassed: boolean;
  readonly plannedTerminal: "run.completed" | "run.failed";
}): ReviewEvalResult {
  const checkedEventIds = input.events.map((event) => event.id);
  const started = input.events.find((event) => event.type === "run.started");
  const startedPayload = started?.payload as Record<string, unknown> | undefined;
  const hasRunContract = startedPayload?.runId === input.traceId
    && typeof startedPayload?.runProfileSnapshot === "object"
    && startedPayload?.budget !== undefined
    && typeof startedPayload?.permissionScope === "string"
    && typeof startedPayload?.stopCondition === "string";
  const approvalsHaveActors = input.events
    .filter((event) => event.type === "tool.approval.answered")
    .every((event) => {
      const payload = event.payload as Record<string, unknown>;
      return typeof payload.actorId === "string" && payload.actorId.trim().length > 0;
    });
  const terminalPlanIsValid = input.plannedTerminal === "run.completed" ? input.testsPassed : true;
  const sideEffectsLedgered = input.events
    .filter((event) => event.type === "tool.effect.started")
    .every((event) => input.events.some((candidate) => {
      const terminalEffect = candidate.type === "tool.effect.succeeded"
        || candidate.type === "tool.effect.failed"
        || candidate.type === "tool.effect.unknown"
        || candidate.type === "tool.effect.cancelled";
      return terminalEffect
        && (candidate.payload as Record<string, unknown>).effectKey
          === (event.payload as Record<string, unknown>).effectKey;
    }));
  const artifactsValid = input.artifacts.length > 0
    && input.artifacts.every((artifact) => artifact.producerRunId === input.traceId)
    && input.artifacts.some((artifact) => artifact.kind === "test")
    && input.artifacts.some((artifact) => artifact.kind === "patch");
  const passed = hasRunContract
    && approvalsHaveActors
    && sideEffectsLedgered
    && artifactsValid
    && terminalPlanIsValid;
  return {
    passed,
    reason: passed
      ? undefined
      : "contract eval blocked: terminal/permission/tool/artifact/side-effect evidence is incomplete",
    checkedEventIds,
  };
}

function idPart(value: string): string {
  return hash(value).slice("sha256:".length, "sha256:".length + 16);
}

function asJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonPayload(value: unknown): CanonicalEvent["payload"] {
  return JSON.parse(JSON.stringify(value)) as CanonicalEvent["payload"];
}

function ensureRelativePath(value: string, name: string): string {
  if (value.length === 0 || isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${name} must be a relative path inside the worktree`);
  }
  return value;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(".." + "/"));
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function denyHostHomeReadsExcept(allowedPaths: readonly string[]): string {
  const home = homedir();
  return [
  // Node resolves module paths by reading ancestor metadata before opening the
  // approved file. Keep metadata visible for traversal, but deny file data
  // everywhere in host-home except the worker's approved inputs.
    "(deny file-read-data (require-all",
    `(subpath ${JSON.stringify(home)})`,
    "(require-not (require-any",
    ...allowedPaths.map((path) => `(subpath ${JSON.stringify(path)})`),
    "))))",
    `(allow file-read-metadata (subpath ${JSON.stringify(home)}))`,
  ].join("");
}

function requireLocalAnnaBackendOrigin(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("live evidence requires an explicit local Anna backend origin");
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("live evidence requires a valid local Anna backend origin");
  }
  const localhost = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    origin.protocol !== "http:"
    || !localhost.has(origin.hostname.toLowerCase())
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) {
    throw new Error("live evidence requires an explicit local Anna backend origin");
  }
  return origin.origin;
}

async function ensureSecureDirectory(root: string, target: string): Promise<string> {
  if (!pathIsWithin(root, target)) {
    throw new Error(`path is outside the approved worktree: ${target}`);
  }
  const pathFromRoot = relative(root, target);
  let current = root;
  for (const segment of pathFromRoot.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`unsafe symlink or non-directory in approved worktree path: ${current}`);
    }
    const resolved = await realpath(current);
    if (!pathIsWithin(root, resolved)) {
      throw new Error(`directory resolves outside the approved worktree: ${current}`);
    }
  }
  return target;
}

async function prepareSecureEmptyDirectory(root: string, target: string): Promise<string> {
  await ensureSecureDirectory(root, dirname(target));
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`unsafe symlink or non-directory build path: ${target}`);
    }
    const resolved = await realpath(target);
    if (!pathIsWithin(root, resolved)) {
      throw new Error(`build path resolves outside the approved worktree: ${target}`);
    }
    await rm(target, { recursive: true });
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  await mkdir(target);
  return ensureSecureDirectory(root, target);
}

async function writeFileNoFollow(
  root: string,
  target: string,
  content: string | Uint8Array,
): Promise<void> {
  await ensureSecureDirectory(root, dirname(target));
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`unsafe symlink or non-file output path: ${target}`);
    }
    await rm(target);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  const file = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
    0o644,
  );
  try {
    await file.writeFile(content);
    const [pathStats, fileStats] = await Promise.all([lstat(target), file.stat()]);
    if (
      pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || pathStats.dev !== fileStats.dev
      || pathStats.ino !== fileStats.ino
    ) {
      throw new Error(`output identity changed while writing: ${target}`);
    }
  } finally {
    await file.close();
  }
}

async function readFileNoFollow(root: string, target: string): Promise<Buffer> {
  await ensureSecureDirectory(root, dirname(target));
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isFile() || !pathIsWithin(root, await realpath(target))) {
    throw new Error(`unsafe symlink or file outside the approved worktree: ${target}`);
  }
  const file = await open(
    target,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
  );
  try {
    const opened = await file.stat();
    if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw new Error(`file identity changed while reading: ${target}`);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function playwrightHeadlessShellExecutable(): string {
  const chromiumExecutable = realpathSync(require("playwright").chromium.executablePath());
  let current = dirname(chromiumExecutable);
  let chromiumRevisionDirectory: string | undefined;
  while (dirname(current) !== current) {
    if (/^chromium-.+$/.test(basename(current))) {
      chromiumRevisionDirectory = current;
      break;
    }
    current = dirname(current);
  }
  if (chromiumRevisionDirectory === undefined) {
    throw new Error("unable to derive the installed Playwright Chromium revision");
  }
  const revision = basename(chromiumRevisionDirectory).slice("chromium-".length);
  const headlessShellDirectory = join(
    dirname(chromiumRevisionDirectory),
    `chromium_headless_shell-${revision}`,
  );
  const executable = readdirSync(headlessShellDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(headlessShellDirectory, entry.name, "chrome-headless-shell"))
    .find((path) => existsSync(path));
  if (executable === undefined) {
    throw new Error("matching Playwright Chromium headless shell is unavailable for contained screenshot evidence");
  }
  return realpathSync(executable);
}

async function runUiWorker(
  root: string,
  request: Record<string, unknown>,
  sourceRoot: string,
  network: "deny" | "loopback",
  contained: boolean,
  dependencyBridge?: ReviewDependencyBridgeEvidence,
): Promise<Record<string, unknown>> {
  if (contained && process.platform !== "darwin") {
    throw new ReviewUnsupportedPlatformError(process.platform);
  }
  const processDirectory = await ensureSecureDirectory(root, join(root, "dist", ".t07-process"));
  const workerPath = fileURLToPath(new URL("./review-ui-worker.mjs", import.meta.url));
  const dependencyRoot = resolve(dirname(require.resolve("vite")), "../../..");
  const nodeDirectory = dirname(realpathSync(process.execPath));
  const headlessShellExecutablePath = request.action === "screenshot" && contained
    ? playwrightHeadlessShellExecutable()
    : undefined;
  const headlessShellBundleDirectory = headlessShellExecutablePath === undefined
    ? undefined
    : dirname(headlessShellExecutablePath);
  const workerRequest = request.action === "screenshot"
    ? {
        ...request,
        headlessShellExecutablePath,
      }
    : request;
  const requestPath = join(processDirectory, `ui-worker-${idPart(JSON.stringify(workerRequest))}.json`);
  await writeFileNoFollow(root, requestPath, JSON.stringify(workerRequest));
  const sandboxProfile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...(network === "loopback"
      ? [
          '(allow network-outbound (remote ip "localhost:*"))',
          '(allow network-inbound (local ip "localhost:*"))',
        ]
      : []),
    denyHostHomeReadsExcept([
      root,
      sourceRoot,
      ...(dependencyBridge === undefined
        ? []
        : [dependencyBridge.sourceRoot, dependencyBridge.dependencyRoot]),
      dirname(workerPath),
      dependencyRoot,
      nodeDirectory,
      ...(headlessShellBundleDirectory === undefined ? [] : [headlessShellBundleDirectory]),
    ]),
    `(allow file-read* (subpath ${JSON.stringify(root)}))`,
    `(allow file-read* (subpath ${JSON.stringify(sourceRoot)}))`,
    ...(dependencyBridge === undefined
      ? []
      : [
          `(allow file-read* (subpath ${JSON.stringify(dependencyBridge.sourceRoot)}))`,
          `(allow file-read* (subpath ${JSON.stringify(dependencyBridge.dependencyRoot)}))`,
        ]),
    `(allow file-read* (subpath ${JSON.stringify(dirname(workerPath))}))`,
    `(allow file-read* (subpath ${JSON.stringify(dependencyRoot)}))`,
    `(allow file-read* (subpath ${JSON.stringify(nodeDirectory)}))`,
    ...(headlessShellBundleDirectory === undefined
      ? []
      : [`(allow file-read* (subpath ${JSON.stringify(headlessShellBundleDirectory)}))`]),
    `(deny file-write* (require-not (subpath ${JSON.stringify(root)})))`,
  ].join("");
  try {
    const result = await execFile(contained ? "/usr/bin/sandbox-exec" : process.execPath, contained ? [
      "-p", sandboxProfile, process.execPath, workerPath, requestPath,
    ] : [workerPath, requestPath], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: processDirectory,
        TMPDIR: processDirectory,
        XDG_CONFIG_HOME: processDirectory,
        XDG_CACHE_HOME: processDirectory,
        XDG_DATA_HOME: processDirectory,
        XDG_RUNTIME_DIR: processDirectory,
        CI: "1",
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } finally {
    await rm(requestPath, { force: true });
  }
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function fixtureScreenshot(buildHash: string, visibleText: string): Uint8Array {
  const hashBytes = Buffer.from(buildHash.replace("sha256:", ""), "hex");
  const pixel = Buffer.from([0, hashBytes[0] ?? 0, hashBytes[1] ?? 0, hashBytes[2] ?? 0, 255]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const provenance = Buffer.from(`t07-build-hash=${buildHash};visible-text=${visibleText}`, "utf8");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", provenance),
    pngChunk("IDAT", deflateSync(pixel)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function toolRequest(
  input: ReviewScenarioInput,
  traceId: string,
  name: string,
  requestInput: Record<string, string>,
  effectKey?: string,
): ToolRequest {
  return {
    workspaceId: input.workspaceId as ToolRequest["workspaceId"],
    channelId: input.channelId as ToolRequest["channelId"],
    runId: traceId as ToolRequest["runId"],
    workerProfileId: "worker:t07-development" as ToolRequest["workerProfileId"],
    name,
    input: requestInput,
    toolCallId: `tool:t07:${idPart(`${name}:${JSON.stringify(requestInput)}`)}`,
    ...(effectKey === undefined ? {} : { effectKey }),
  };
}

function commandEvidence(error: unknown, command: string): ReviewCommandEvidence {
  const value = error as {
    readonly code?: number | string;
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
  };
  return {
    command,
    exitCode: typeof value.code === "number" ? value.code : 1,
    stdout: value.stdout?.toString() ?? "",
    stderr: value.stderr?.toString() ?? String(error),
  };
}

async function executeAllowedCommand(
  root: string,
  command: string,
  evidenceMode: ReviewEvidenceMode,
  dependencyBridge?: ReviewDependencyBridgeEvidence,
): Promise<ReviewCommandEvidence> {
  const targetedTestPrefix = "npm exec --no -- vitest run --configLoader runner ";
  const targetedTestPath = command.startsWith(targetedTestPrefix)
    ? command.slice(targetedTestPrefix.length)
    : undefined;
  const useLiveLocalVitest = targetedTestPath !== undefined
    && evidenceMode === "live"
    && process.platform === "darwin";
  const invocation = command === "git diff"
    ? ["git", ["diff"]] as const
    : command === "git status --short"
      ? ["git", ["status", "--short"]] as const
      : command === "git rev-parse HEAD"
        ? ["git", ["rev-parse", "HEAD"]] as const
        : command === "git rev-parse --show-toplevel"
          ? ["git", ["rev-parse", "--show-toplevel"]] as const
          : command === "git rev-parse --git-common-dir"
            ? ["git", ["rev-parse", "--git-common-dir"]] as const
        : command === "npm test"
        ? ["npm", ["test"]] as const
        : targetedTestPath !== undefined && targetedTestPath.length > 0
          ? useLiveLocalVitest
            ? [
                process.execPath,
                [
                  realpathSync(join(
                    dependencyBridge?.dependencyRoot ?? realpathSync(join(root, "node_modules")),
                    "vitest",
                    "vitest.mjs",
                  )),
                  "run",
                  "--configLoader",
                  "runner",
                  targetedTestPath,
                ],
              ] as const
            : ["npm", ["exec", "--no", "--", "vitest", "run", "--configLoader", "runner", targetedTestPath]] as const
        : command === "npm run build"
          ? ["npm", ["run", "build"]] as const
          : undefined;
  if (invocation === undefined) {
    throw new Error(`command is not allowlisted: ${command}`);
  }
  const requiresProcessContainment = command === "npm test"
    || targetedTestPath !== undefined
    || command === "npm run build";
  const useProcessContainment = requiresProcessContainment && evidenceMode === "live" && process.platform === "darwin";
  const useFixtureWorker = requiresProcessContainment && evidenceMode === "fixture";
  const processDirectory = requiresProcessContainment
    ? join(root, "dist", ".t07-process")
    : tmpdir();
  const fixtureNetworkGuardPath = fileURLToPath(new URL("./review-test-fixture-runner.cjs", import.meta.url));
  if (requiresProcessContainment) {
    await ensureSecureDirectory(root, processDirectory);
  }
  const fixturePermissionFlags = [
    "--permission",
    `--allow-fs-read=${root}`,
    `--allow-fs-read=${processDirectory}`,
    `--allow-fs-read=${dirname(fixtureNetworkGuardPath)}`,
    "--allow-fs-read=/usr/local",
    "--allow-fs-read=/dev",
    `--allow-fs-write=${root}`,
    "--allow-child-process",
  ];
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: processDirectory,
    npm_config_cache: join(processDirectory, "npm-cache"),
    npm_config_update_notifier: "false",
    CI: "1",
    ANNA_T07_LIVE_SOURCE: "",
    ...(useFixtureWorker ? {
      HOME: processDirectory,
      NODE_OPTIONS: [...fixturePermissionFlags, `--require=${fixtureNetworkGuardPath}`].join(" "),
      ANNA_T07_FIXTURE_NO_NETWORK: "1",
    } : {}),
  };
  const sandboxProfile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    denyHostHomeReadsExcept([
      root,
      ...(dependencyBridge === undefined
        ? []
        : [dependencyBridge.sourceRoot, dependencyBridge.dependencyRoot]),
    ]),
    `(allow file-read* (subpath ${JSON.stringify(root)}))`,
    ...(dependencyBridge === undefined
      ? []
      : [
          `(allow file-read* (subpath ${JSON.stringify(dependencyBridge.sourceRoot)}))`,
          `(allow file-read* (subpath ${JSON.stringify(dependencyBridge.dependencyRoot)}))`,
        ]),
    `(deny file-write* (require-not (subpath ${JSON.stringify(root)})))`,
  ].join("");
  const executable = useProcessContainment
    ? "/usr/bin/sandbox-exec"
    : useFixtureWorker
      ? process.execPath
      : invocation[0];
  const args = useProcessContainment
    ? ["-p", sandboxProfile, invocation[0], ...invocation[1]]
    : useFixtureWorker
      ? [...fixturePermissionFlags, realpathSync("/usr/local/bin/npm"), ...invocation[1]]
      : [...invocation[1]];
  try {
    const result = await execFile(executable, args, {
      cwd: root,
      env: environment,
    });
    return { command, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return commandEvidence(error, command);
  }
}

function outputArtifact(
  input: ReviewScenarioInput,
  kind: ReviewArtifactKind,
  path: string,
  content: string,
  producerRunId: string,
  changedFiles: readonly string[],
  reviewState: ReviewArtifact["reviewState"] = "pending",
  sourceBuildHash?: string,
): ReviewArtifact {
  const contentHash = hash(content);
  return {
    id: `artifact:${kind}:${idPart(`${path}:${contentHash}`)}`,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    runId: producerRunId,
    kind,
    uri: path,
    path,
    hash: contentHash,
    version: `1.0.0+${idPart(contentHash).slice(0, 8)}`,
    producerRunId,
    validationStatus: "pending",
    reviewState,
    changedFiles,
    ...(sourceBuildHash === undefined ? {} : { sourceBuildHash }),
  };
}

function outputBinaryArtifact(
  input: ReviewScenarioInput,
  kind: ReviewArtifactKind,
  path: string,
  bytes: Uint8Array,
  producerRunId: string,
  changedFiles: readonly string[],
  reviewState: ReviewArtifact["reviewState"],
  sourceBuildHash?: string,
): ReviewArtifact {
  const contentHash = hashBytes(bytes);
  return {
    id: `artifact:${kind}:${idPart(`${path}:${contentHash}`)}`,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    runId: producerRunId,
    kind,
    uri: path,
    path,
    hash: contentHash,
    version: `1.0.0+${idPart(contentHash).slice(0, 8)}`,
    producerRunId,
    validationStatus: "pending",
    reviewState,
    changedFiles,
    ...(sourceBuildHash === undefined ? {} : { sourceBuildHash }),
  };
}

function gate(
  kind: ReviewGate["kind"],
  status: ReviewGate["status"],
  traceId: string,
  artifactIds: readonly string[],
  actorId?: string,
): ReviewGate {
  return {
    id: `gate:${kind}:${idPart(`${traceId}:${artifactIds.join(",")}:${status}`)}`,
    kind,
    status,
    traceId,
    artifactIds,
    ...(actorId === undefined ? {} : { actorId }),
  };
}

function reviewRunProfileSnapshot(
  evidenceMode: ReviewEvidenceMode,
  purpose: "main" | "follow_up" = "follow_up",
): ResolvedRunProfile {
  const main = purpose === "main";
  const allowedTools = main
    ? ["read_workspace", "bounded_patch", "build_changed_ui", "capture_screenshot", "run_command", "write_artifact", "create_isolated_worktree"]
    : ["read_workspace"];
  const budget = main ? { turns: 32, toolCalls: 64 } : { turns: 1, toolCalls: 1 };
  const skill = {
    id: "t07-follow-up-skill",
    name: "T07 follow-up",
    version: "1.0.0",
    content: "Inspect the validated patch and report only new evidence.",
    hash: hash("Inspect the validated patch and report only new evidence."),
    provenance: {
      source: evidenceMode === "live" ? "anna-live" : "anna-fixture",
      uri: evidenceMode === "live" ? "anna://live/t07/follow-up" : "fixture://t07/follow-up",
    },
    allowedTools,
    forbiddenTools: ["shell", "git push", "git merge", "deploy"],
  };
  const model = {
    provider: evidenceMode === "live" ? "anna-local" : "fixture",
    name: "t07-review",
    reasoning: "low" as const,
  };
  const workerProfile = {
    id: (main ? "worker:t07-development" : "worker:t07-follow-up") as never,
    version: "1.0.0",
    instructions: main
      ? "Execute the approved T07 review-to-validated-patch flow inside its isolated worktree."
      : "Read the validated patch and stop after reporting evidence.",
    allowedSkillIds: [skill.id],
    allowedTools,
    modelPolicy: { allowedModels: [model] },
    budgetDefaults: budget,
    artifactContract: {
      kind: main ? "validated_patch" : "follow_up_report",
      requiredFor: ["completed" as const],
      verification: "tests" as const,
    },
  };
  return resolveRunProfile({
    catalog: [skill],
    workerProfile,
    channelPolicy: {
      toolPolicy: { allowedTools },
      allowedSkillIds: [skill.id],
      allowedModels: [model],
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
    },
    runProfile: {
      id: (main ? "profile:t07-review" : "profile:t07-follow-up") as never,
      version: "1.0.0",
      model,
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal", "provenance"] }],
      toolPolicy: { allowedTools },
      budget,
      memoryPolicy: { read: "none", write: "disabled" },
      evalPolicy: { contract: "required", quality: "disabled" },
      artifactContract: workerProfile.artifactContract,
      terminalRules: {
        allowedOutcomes: main ? ["completed", "failed", "awaiting_approval"] : ["completed", "failed"],
        stopCondition: "artifact_or_terminal",
      },
    },
  });
}

async function filesUnder(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path));
    } else if (entry.isFile()) {
      files.push(path);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`build output contains an unsafe symlink: ${path}`);
    }
  }
  return files;
}

async function digestFiles(root: string, files: readonly string[]): Promise<string> {
  const digest = createHash("sha256");
  const normalized = (path: string) => relative(root, path).replaceAll("\\", "/");
  for (const path of [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(normalized(left), "utf8"), Buffer.from(normalized(right), "utf8")))) {
    digest.update(Buffer.from(normalized(path), "utf8"));
    digest.update(Buffer.from([0]));
    digest.update(await readFile(path));
  }
  return `sha256:${digest.digest("hex")}`;
}

export const digestFilesForTest = digestFiles;

async function ensureSecureUiSourceTree(root: string, uiPath: string): Promise<void> {
  const segments = uiPath.split(/[\\/]/).filter(Boolean);
  const sourceIndex = segments.lastIndexOf("src");
  const sourceRoot = sourceIndex === -1
    ? dirname(join(root, uiPath))
    : join(root, ...segments.slice(0, sourceIndex + 1));
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stats = await lstat(current);
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || !pathIsWithin(root, await realpath(current))
    ) {
      throw new Error("UI source tree contains an unsafe path");
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error("UI source tree contains an unsafe symlink");
      }
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
}

async function buildChangedReactUi(
  root: string,
  input: ReviewScenarioInput,
  producerRunId: string,
  options: {
    readonly outputDirectory?: string;
    readonly candidate?: string;
    readonly evidenceMode?: ReviewEvidenceMode;
    readonly sourceRoot?: string;
    readonly dependencyBridge?: ReviewDependencyBridgeEvidence;
  } = {},
): Promise<ReviewArtifact> {
  const sourceRoot = options.sourceRoot ?? root;
  const outputDirectory = options.outputDirectory ?? "dist/t07-ui-build";
  const absoluteOutputDirectory = join(root, outputDirectory);
  const entryDirectory = join(root, "dist", ".t07-entry");
  const indexPath = join(entryDirectory, "index.html");
  const entryPath = relative(entryDirectory, join(sourceRoot, input.uiPath)).replaceAll("\\", "/");
  await prepareSecureEmptyDirectory(root, absoluteOutputDirectory);
  try {
    await ensureSecureUiSourceTree(sourceRoot, input.uiPath);
    await prepareSecureEmptyDirectory(root, entryDirectory);
    await writeFileNoFollow(root, indexPath, `<!doctype html><html><head><meta charset="utf-8"><title>Anna T07 review</title></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>\n`);
    await runUiWorker(root, {
      action: "build",
      root,
      sourceRoot,
      uiPath: input.uiPath,
      entryDirectory,
      indexPath,
      outputDirectory: absoluteOutputDirectory,
      ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
    }, sourceRoot, "deny", options.evidenceMode === "live", options.dependencyBridge);
  } finally {
    await rm(entryDirectory, { recursive: true, force: true });
  }
  const builtFiles = await filesUnder(absoluteOutputDirectory);
  const buildDigest = await digestFiles(absoluteOutputDirectory, builtFiles);
  const artifact = outputArtifact(
    input,
    "ui-build",
    outputDirectory,
    buildDigest,
    producerRunId,
    [input.uiPath],
    "approved",
  );
  return {
    ...artifact,
    hash: buildDigest,
    buildCommand: "vite.build()",
    buildEvidence: {
      command: "vite.build()",
      exitCode: 0,
      stdout: builtFiles.map((path) => relative(absoluteOutputDirectory, path)).join("\n"),
      stderr: "",
    },
  };
}

async function captureBuiltUiScreenshot(
  root: string,
  outputDirectory: string,
  visibleText: string,
  backendOrigin?: string,
  evidenceMode: ReviewEvidenceMode = "fixture",
): Promise<{
  readonly bytes: Uint8Array;
  readonly visibleText: string;
  readonly normalShell: boolean;
  readonly sessionStatus?: number;
}> {
  await ensureSecureDirectory(root, join(root, outputDirectory));
  if (evidenceMode === "fixture") {
    const builtFiles = await filesUnder(join(root, outputDirectory));
    const buildHash = await digestFiles(join(root, outputDirectory), builtFiles);
    return {
      bytes: fixtureScreenshot(buildHash, visibleText),
      visibleText,
      normalShell: false,
    };
  }
  const result = await runUiWorker(root, {
    action: "screenshot",
    root,
    outputDirectory,
    visibleText,
    ...(backendOrigin === undefined ? {} : { backendOrigin }),
  }, root, "loopback", true);
  const apiResponses = Array.isArray(result.apiResponses)
    ? result.apiResponses.filter((response): response is { path: string; status: number } =>
      typeof response === "object"
      && response !== null
      && typeof (response as { path?: unknown }).path === "string"
      && typeof (response as { status?: unknown }).status === "number")
    : [];
  const sessionStatus = apiResponses.find((response) => response.path === "/api/session/current")?.status;
  if (
    typeof result.bytes !== "string"
    || result.visibleText !== visibleText
    || typeof result.normalShell !== "boolean"
    || (backendOrigin !== undefined && (result.normalShell !== true || sessionStatus !== 200))
  ) {
    throw new Error("contained screenshot worker returned invalid evidence");
  }
  return {
    bytes: Buffer.from(result.bytes, "base64"),
    visibleText,
    normalShell: result.normalShell,
    ...(sessionStatus === undefined ? {} : { sessionStatus }),
  };
}

const reviewEffectTools: readonly ToolDefinition[] = [
  "create_isolated_worktree",
  "build_changed_ui",
  "build_candidate_ui",
  "capture_screenshot",
  "capture_candidate_screenshot",
  "run_command",
  "write_artifact",
].map((name) => ({
  name,
  replayPolicy: name === "run_command"
    || name === "build_candidate_ui"
    || name === "capture_candidate_screenshot"
    ? "safe" as const
    : "never" as const,
  inputSchema: {
    parse(value: unknown) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${name} input must be an object`);
      }
      return value;
    },
  },
}));

function createReviewEffectsSandbox(
  root: string,
  input: ReviewScenarioInput,
  backendOrigin?: string,
  evidenceMode: ReviewEvidenceMode = "fixture",
  sourceRoot: string = root,
  dependencyBridge?: ReviewDependencyBridgeEvidence,
): SandboxAdapter {
  const workspace = createLocalPreviewWorktreeSandbox({ approvedWorktreeRoot: root });
  return {
    async execute(request, signal): Promise<ToolResult> {
      if (request.name === "read_workspace" || request.name === "bounded_patch") {
        return workspace.execute(request, signal);
      }
      if (signal.aborted) {
        return { status: "failed", output: { reason: "cancelled" } };
      }
      if (request.name === "create_isolated_worktree") {
        const output = request.input as Record<string, unknown>;
        if (
          typeof output.sourceRoot !== "string"
          || typeof output.worktreeRoot !== "string"
          || typeof output.expectedHead !== "string"
          || typeof output.dependencyRoot !== "string"
          || output.expectedHead.length === 0
          || !isAbsolute(output.dependencyRoot)
          || !isAbsolute(output.worktreeRoot)
        ) {
          return { status: "failed", output: { reason: "invalid_tool_input" } };
        }
        let sourceRoot: string | undefined;
        let worktreeRoot: string | undefined;
        let worktreeCreated = false;
        try {
          sourceRoot = realpathSync(output.sourceRoot);
          const worktreeParent = realpathSync(dirname(output.worktreeRoot));
          worktreeRoot = join(worktreeParent, basename(output.worktreeRoot));
          if (existsSync(worktreeRoot)) {
            return { status: "failed", output: { reason: "worktree_target_exists" } };
          }
          const evidence = await execFile("git", [
            "-C", sourceRoot, "worktree", "add", "--detach", worktreeRoot, output.expectedHead,
          ]);
          worktreeCreated = true;
          const dependencyRoot = realpathSync(output.dependencyRoot);
          const expectedDependencyRoot = realpathSync(join(sourceRoot, "node_modules"));
          const dependencyStats = await lstat(dependencyRoot);
          if (dependencyRoot !== expectedDependencyRoot || !dependencyStats.isDirectory()) {
            throw new Error("dependencyRoot must resolve to sourceRoot/node_modules as a directory");
          }
          const worktreeDependencyRoot = join(worktreeRoot, "node_modules");
          if (existsSync(worktreeDependencyRoot)) {
            throw new Error("development worktree node_modules already exists");
          }
          await symlink(dependencyRoot, worktreeDependencyRoot, "dir");
          return {
            status: "succeeded",
            output: jsonPayload({
              worktreeRoot: realpathSync(worktreeRoot),
              dependencyBridge: {
                sourceRoot,
                dependencyRoot,
                readOnly: true,
              },
              evidence: {
                command: "git worktree add --detach",
                exitCode: 0,
                stdout: evidence.stdout,
                stderr: evidence.stderr,
              },
            }),
          };
        } catch (error) {
          if (worktreeCreated && sourceRoot !== undefined && worktreeRoot !== undefined) {
            await execFile("git", ["-C", sourceRoot, "worktree", "remove", "--force", worktreeRoot])
              .catch(() => undefined);
          }
          const missingDependency = isMissingPath(error);
          return {
            status: "failed",
            output: {
              reason: missingDependency ? "dependency_root_missing" : "dependency_bridge_failed",
              detail: missingDependency
                ? "live dependencyRoot is missing: sourceRoot/node_modules"
                : String(error),
            },
          };
        }
      }
      if (request.name === "build_changed_ui") {
        try {
          const artifact = await buildChangedReactUi(root, input, request.runId, {
            evidenceMode,
            dependencyBridge,
          });
          return { status: "succeeded", output: jsonPayload({ artifact }) };
        } catch (error) {
          return { status: "failed", output: { reason: "ui_build_failed", detail: String(error) } };
        }
      }
      if (request.name === "build_candidate_ui") {
        const output = request.input as Record<string, unknown>;
        if (typeof output.candidate !== "string") {
          return { status: "failed", output: { reason: "invalid_tool_input" } };
        }
        try {
          const artifact = await buildChangedReactUi(root, input, request.runId, {
            outputDirectory: "dist/t07-ui-proposal",
            candidate: output.candidate,
            evidenceMode,
            sourceRoot,
            dependencyBridge,
          });
          return { status: "succeeded", output: jsonPayload({ artifact }) };
        } catch (error) {
          return { status: "failed", output: { reason: "ui_proposal_build_failed", detail: String(error) } };
        }
      }
      if (request.name === "capture_screenshot") {
        const output = request.input as Record<string, unknown>;
        if (
          typeof output.buildPath !== "string"
          || typeof output.screenshotPath !== "string"
          || typeof output.visibleText !== "string"
        ) {
          return { status: "failed", output: { reason: "invalid_tool_input" } };
        }
        try {
          await ensureSecureDirectory(root, join(root, "dist"));
          const evidence = await captureBuiltUiScreenshot(
            root,
            output.buildPath,
            output.visibleText,
            backendOrigin,
            evidenceMode,
          );
          await writeFileNoFollow(root, resolve(root, output.screenshotPath), Buffer.from(evidence.bytes));
          return {
            status: "succeeded",
            output: {
              bytes: Buffer.from(evidence.bytes).toString("base64"),
              visibleText: evidence.visibleText,
              normalShell: evidence.normalShell,
              ...(evidence.sessionStatus === undefined ? {} : { sessionStatus: evidence.sessionStatus }),
            },
          };
        } catch (error) {
          return { status: "failed", output: { reason: "screenshot_failed", detail: String(error) } };
        }
      }
      if (request.name === "capture_candidate_screenshot") {
        const output = request.input as Record<string, unknown>;
        if (
          typeof output.buildPath !== "string"
          || typeof output.screenshotPath !== "string"
          || typeof output.visibleText !== "string"
        ) {
          return { status: "failed", output: { reason: "invalid_tool_input" } };
        }
        try {
          const evidence = await captureBuiltUiScreenshot(
            root,
            output.buildPath,
            output.visibleText,
            backendOrigin,
            evidenceMode,
          );
          await writeFileNoFollow(root, resolve(root, output.screenshotPath), Buffer.from(evidence.bytes));
          return {
            status: "succeeded",
            output: {
              bytes: Buffer.from(evidence.bytes).toString("base64"),
              visibleText: evidence.visibleText,
              normalShell: evidence.normalShell,
              ...(evidence.sessionStatus === undefined ? {} : { sessionStatus: evidence.sessionStatus }),
            },
          };
        } catch (error) {
          return { status: "failed", output: { reason: "screenshot_failed", detail: String(error) } };
        }
      }
      if (request.name === "run_command") {
        const output = request.input as Record<string, unknown>;
        if (typeof output.command !== "string") {
          return { status: "failed", output: { reason: "invalid_tool_input" } };
        }
        let evidence: ReviewCommandEvidence;
        try {
          evidence = await executeAllowedCommand(root, output.command, evidenceMode, dependencyBridge);
        } catch (error) {
          evidence = commandEvidence(error, output.command);
        }
        return {
          // Command execution succeeded; the process exit code remains the test evidence.
          status: "succeeded",
          output: jsonPayload({ evidence }),
        };
      }
      if (request.name === "write_artifact") {
        const output = request.input as Record<string, unknown>;
        if (typeof output.path !== "string" || typeof output.content !== "string") {
          return { status: "failed", output: { reason: "invalid_tool_input" } };
        }
        try {
          const target = resolve(root, output.path);
          if (!pathIsWithin(root, target)) {
            return { status: "failed", output: { reason: "path_outside_approved_worktree" } };
          }
          await writeFileNoFollow(root, target, output.content);
          return { status: "succeeded", output: { path: output.path, hash: hash(output.content) } };
        } catch (error) {
          return { status: "failed", output: { reason: "artifact_write_failed", detail: String(error) } };
        }
      }
      return { status: "failed", output: { reason: "tool_not_implemented" } };
    },
  };
}

function createReviewGateway(
  root: string,
  input: ReviewScenarioInput,
  services: ReviewScenarioServices,
  backendOrigin?: string,
  evidenceMode: ReviewEvidenceMode = "fixture",
  sourceRoot: string = root,
  dependencyBridge?: ReviewDependencyBridgeEvidence,
): DurableToolGateway {
  return createToolGateway({
    catalog: [...createLocalPreviewWorktreeToolCatalog(), ...reviewEffectTools],
    scope: {
      workspaceId: input.workspaceId as ToolRequest["workspaceId"],
      channelId: input.channelId as ToolRequest["channelId"],
    },
    workerProfileId: "worker:t07-development" as ToolRequest["workerProfileId"],
    policy: {
      async decide(request) {
        if (request.name === "read_workspace") {
          return "allow";
        }
        if (request.name === "build_candidate_ui" || request.name === "capture_candidate_screenshot") {
          return "allow";
        }
        const requestCommand = typeof request.input === "object" && request.input !== null && !Array.isArray(request.input)
          && typeof request.input.command === "string"
          ? request.input.command
          : undefined;
        if (
          request.name === "run_command"
          && request.effectKey === undefined
          && (requestCommand?.startsWith("git rev-parse") || requestCommand === "git status --short")
        ) {
          return "allow";
        }
        return "require_approval";
      },
    },
    sandbox: createReviewEffectsSandbox(
      root,
      input,
      backendOrigin,
      evidenceMode,
      sourceRoot,
      dependencyBridge,
    ),
    events: services.events,
  });
}

function commandEvidenceFrom(result: ToolResult): ReviewCommandEvidence {
  const output = result.output as { evidence?: ReviewCommandEvidence } | undefined;
  if (output?.evidence === undefined) {
    throw new Error("ToolGateway did not return command evidence");
  }
  return output.evidence;
}

async function gitEvidence(
  root: string,
  input: ReviewScenarioInput,
  runCommand: (command: string) => Promise<ReviewCommandEvidence>,
): Promise<ReviewGitEvidence> {
  const commands = ["git diff", "git status --short"] as const;
  const diff = await runCommand("git diff");
  const status = await runCommand("git status --short");
  const errors = [diff, status].filter((item) => item.exitCode !== 0);
  const requiredPaths = [
    input.prdPath,
    input.uiPath,
    ...(input.testPath === undefined ? [] : [input.testPath]),
  ];
  const changedPathsPresent = requiredPaths.every((path) =>
    diff.stdout.includes(path) && status.stdout.includes(path));
  return {
    worktreeRoot: root,
    diff: diff.stdout,
    status: status.stdout,
    commands: [...commands],
    valid: errors.length === 0 && changedPathsPresent,
    ...(errors.length === 0 && changedPathsPresent
      ? {}
      : { error: errors.map((item) => item.stderr).filter(Boolean).join("\n") || "required Git evidence is missing" }),
  };
}

export function createReviewToValidatedPatch(options: ReviewScenarioOptions) {
  const input = options.input;
  const evidenceMode = options.mode ?? "fixture";
  if (evidenceMode === "live") {
    assertT07LivePlatform();
  }
  const liveBackendOrigin = evidenceMode === "live"
    ? requireLocalAnnaBackendOrigin(options.liveWorktree?.backendOrigin)
    : undefined;
  let root = realpathSync(resolve(options.root));
  ensureRelativePath(input.prdPath, "input.prdPath");
  ensureRelativePath(input.uiPath, "input.uiPath");
  if (input.testPath !== undefined) {
    ensureRelativePath(input.testPath, "input.testPath");
  }
  if (input.reviewNotes.trim().length === 0) {
    throw new Error("input.reviewNotes must be non-empty");
  }
  if (evidenceMode === "live" && !existsSync(join(root, ".git"))) {
    throw new Error("live evidence requires an Anna Git repository root");
  }

  let paths: ReviewScenarioPaths = {
    root,
    prd: join(root, input.prdPath),
    ui: join(root, input.uiPath),
    ...(input.testPath === undefined ? {} : { test: join(root, input.testPath) }),
    screenshot: join(root, "dist", "review-screenshot.png"),
  };
  const traceId = `run:t07:${idPart(`${evidenceMode}:${input.workspaceId}:${input.channelId}:${input.sourceRunId}`)}`;
  const liveSourceRoot = root;
  let proposalRoot: string | undefined;
  let gateway = createReviewGateway(root, input, options.services, liveBackendOrigin, evidenceMode);
  const runProfileSnapshot = options.runProfileSnapshot === undefined
    ? reviewRunProfileSnapshot(evidenceMode, "main")
    : parseResolvedRunProfileSnapshot(options.runProfileSnapshot);
  if (evidenceMode === "live" && runProfileSnapshot.model.provider === "fixture") {
    throw new Error("live T07 RunProfile snapshot cannot use the fixture provider");
  }
  const permissionScope = "permission:t07-review";
  let executedToolCalls = 0;
  let state: ProjectedReviewState = {
    traceId,
    lanes: [],
    gates: [],
    artifacts: [],
  };
  let eventTail = Promise.resolve<CanonicalEvent | undefined>(undefined);
  const appendEvent = async (
    type: string,
    payload: unknown,
    streamId: StreamId = traceId as StreamId,
  ): Promise<CanonicalEvent> => {
    const append = eventTail.then(async () => {
      let seq = 0;
      for await (const event of options.services.events.read(streamId)) {
        seq = Math.max(seq, event.seq + 1);
      }
      const event: CanonicalEvent = {
        id: `event:t07:${idPart(`${streamId}:${seq}:${type}`)}` as CanonicalEvent["id"],
        workspaceId: input.workspaceId as CanonicalEvent["workspaceId"],
        channelId: input.channelId as CanonicalEvent["channelId"],
        streamId,
        seq,
        type,
        timestamp: new Date().toISOString(),
        schemaVersion: 1,
        payload: jsonPayload(payload),
      };
      await options.services.events.append(event);
      return event;
    });
    eventTail = append;
    return append;
  };

  const readCanonicalEvents = async (): Promise<readonly CanonicalEvent[]> => {
    const streamIds = new Set<StreamId>([
      traceId as StreamId,
      `t07-result:${traceId}` as StreamId,
      ...await options.services.events.listRunStreamIds(traceId as never),
    ]);
    const canonical: CanonicalEvent[] = [];
    for (const streamId of [...streamIds].sort()) {
      for await (const event of options.services.events.read(streamId)) {
        canonical.push(event);
      }
    }
    return canonical;
  };

  let started: Promise<CanonicalEvent> | undefined;
  const ensureRunStarted = (): Promise<CanonicalEvent> => {
    started ??= (async () => {
      const startRun = parseStartRun({
        commandId: `command:t07:${idPart(traceId)}`,
        runId: traceId,
        goal: "Review notes to validated patch",
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        source: { eventId: input.sourceEventIds[0] ?? input.sourceRunId },
        runProfile: { id: runProfileSnapshot.id, version: runProfileSnapshot.version },
        runProfileSnapshot,
        budget: runProfileSnapshot.budget,
        permissionScope,
        stopCondition: runProfileSnapshot.terminalRules.stopCondition,
      });
      const candidate: CanonicalEvent = {
        id: `event:t07:${idPart(`${traceId}:run.started`)}` as CanonicalEvent["id"],
        workspaceId: input.workspaceId as CanonicalEvent["workspaceId"],
        channelId: input.channelId as CanonicalEvent["channelId"],
        streamId: traceId as StreamId,
        seq: 0,
        type: "run.started",
        timestamp: new Date().toISOString(),
        schemaVersion: 1,
        payload: jsonPayload({
          runId: traceId,
          sourceRunId: input.sourceRunId,
          surface: "t07-review-to-validated-patch",
          evidenceMode,
          runProfile: startRun.runProfile,
          runProfileSnapshot: startRun.runProfileSnapshot,
          budget: startRun.budget,
          permissionScope: startRun.permissionScope,
          stopCondition: startRun.stopCondition,
        }),
      };
      const claimed = await options.services.events.appendIdempotent(candidate);
      if (!claimed) {
        throw new Error("T07 trace is already claimed and still in progress; refusing concurrent execution");
      }
      for await (const event of options.services.events.read(traceId as StreamId)) {
        if (event.id === candidate.id) return event;
      }
      throw new Error("T07 durable run claim was not readable after append");
    })();
    return started;
  };

  const setGate = (next: ReviewGate): void => {
    state = {
      ...state,
      gates: [...state.gates.filter((item) => item.kind !== next.kind), next],
    };
  };

  const setLane = (next: ReviewLaneOutput): void => {
    state = {
      ...state,
      lanes: [...state.lanes.filter((item) => item.lane !== next.lane), next],
    };
  };

  const setArtifacts = (next: readonly ReviewArtifact[]): void => {
    const byId = new Map(state.artifacts.map((item) => [item.id, item]));
    next.forEach((item) => byId.set(item.id, item));
    state = { ...state, artifacts: [...byId.values()] };
  };

  const executeTool = async (
    name: string,
    requestInput: Record<string, string>,
    effectKey?: string,
    onEffectApproved?: (decision: ReviewApprovalDecision) => Promise<void>,
  ): Promise<ToolResult> => {
    await ensureRunStarted();
    if (
      effectKey !== undefined
      && runProfileSnapshot.budget.toolCalls !== undefined
      && executedToolCalls >= runProfileSnapshot.budget.toolCalls
    ) {
      throw new ReviewBudgetExceededError("T07 ToolGateway budget prevents the next expensive operation");
    }
    const request = toolRequest(input, traceId, name, requestInput, effectKey);
    const signal = new AbortController().signal;
    let result = await gateway.execute(request, signal);
    const output = result.output as Record<string, unknown> | undefined;
    if (output?.reason !== "approval_required" || effectKey === undefined) {
      if (result.status === "succeeded" && effectKey !== undefined && onEffectApproved !== undefined) {
        const approvalEvents = await readCanonicalEvents();
        const approval = [...approvalEvents].reverse().find((event) => {
          const payload = event.payload as Record<string, unknown>;
          return event.type === "tool.approval.answered"
            && payload.effectKey === effectKey
            && payload.decision === "approved"
            && typeof payload.actorId === "string";
        });
        const actorId = approval === undefined
          ? undefined
          : (approval.payload as Record<string, unknown>).actorId as string;
        if (actorId !== undefined) {
          await onEffectApproved({ approved: true, actorId });
        }
      }
      if (result.status === "succeeded") executedToolCalls += effectKey === undefined ? 0 : 1;
      return result;
    }
    if (state.lanes.length !== 2 || state.lanes.some((lane) => !lane.approved)) {
      throw new Error("external effects require explicit PRD and UI approval");
    }
    const effectApproval = options.approvalProvider === undefined
      ? undefined
      : requireApprovalDecision(
        await options.approvalProvider.approveEffect(effectKey),
        input.ownerId,
        "Tool effect approval",
      );
    if (effectApproval === undefined || !effectApproval.approved) {
      throw new ReviewApprovalRejectedError(`human effect approval rejected: ${effectKey}`);
    }
    await gateway.answerApproval({
      workspaceId: input.workspaceId as ToolRequest["workspaceId"],
      channelId: input.channelId as ToolRequest["channelId"],
      runId: traceId as ToolRequest["runId"],
      effectKey,
      approvalId: `approval:${effectKey}`,
      actorId: effectApproval.actorId,
      decision: "approved",
    });
    await onEffectApproved?.(effectApproval);
    result = await gateway.execute(request, signal);
    executedToolCalls += 1;
    return result;
  };

  const readText = async (path: string): Promise<string> => {
    const result = await executeTool("read_workspace", { path });
    const output = result.output as { content?: unknown } | undefined;
    if (result.status !== "succeeded" || typeof output?.content !== "string") {
      throw new Error(`failed to read approved worktree path: ${path}`);
    }
    return output.content;
  };

  let preparedReview: Promise<PreparedReview> | undefined;
  const prepared = (): Promise<PreparedReview> => {
    preparedReview ??= (async () => {
      await ensureRunStarted();
      if (evidenceMode === "live") {
        const expectedHead = options.liveWorktree?.expectedHead;
        if (expectedHead === undefined || expectedHead.length === 0) {
          throw new Error("live evidence requires an expected disposable-worktree HEAD");
        }
        const [head, topLevel, status] = await Promise.all([
          executeTool("run_command", { command: "git rev-parse HEAD" }),
          executeTool("run_command", { command: "git rev-parse --show-toplevel" }),
          executeTool("run_command", { command: "git status --short" }),
        ]);
        const headEvidence = commandEvidenceFrom(head);
        const topLevelEvidence = commandEvidenceFrom(topLevel);
        const statusEvidence = commandEvidenceFrom(status);
        if (
          headEvidence.exitCode !== 0
          || headEvidence.stdout.trim() !== expectedHead
          || topLevelEvidence.exitCode !== 0
          || realpathSync(topLevelEvidence.stdout.trim()) !== root
          || statusEvidence.exitCode !== 0
          || statusEvidence.stdout.trim().length > 0
        ) {
          throw new Error("live evidence worktree identity, expected HEAD or clean status validation failed");
        }
      }
      const [prdBefore, uiBefore, testBefore] = await Promise.all([
        readText(input.prdPath),
        readText(input.uiPath),
        input.testPath === undefined ? undefined : readText(input.testPath),
      ]);
      return { traceId, paths, prdBefore, uiBefore, testBefore };
    })();
    return preparedReview;
  };

  const proposeMemoryCandidate = async (review: PreparedReview): Promise<ReviewMemoryCandidate> => {
    await ensureRunStarted();
    const candidate: ReviewMemoryCandidate = {
      id: `memory-candidate:t07:${idPart(traceId)}`,
      content: input.reviewNotes,
      sourceRunId: input.sourceRunId,
      sourceEventIds: input.sourceEventIds,
      traceId: review.traceId,
      confirmed: false,
    };
    await options.services.memory.propose({
      id: candidate.id,
      content: candidate.content,
      sourceRunId: candidate.sourceRunId,
      sourceEventIds: candidate.sourceEventIds,
    });
    state = { ...state, memoryCandidate: candidate };
    await appendEvent("t07.memory.proposed", { candidate: asJson(candidate), traceId });
    return candidate;
  };

  const confirmMemoryCandidate = async (candidateId: string, actorId: string): Promise<ReviewMemoryCandidate> => {
    if (actorId !== input.ownerId) {
      throw new Error("only the Channel Owner can confirm a MemoryCandidate");
    }
    if (state.memoryCandidate?.id !== candidateId) {
      throw new Error("MemoryCandidate was not found");
    }
    const confirmed = { ...state.memoryCandidate, confirmed: true };
    await options.services.memory.accept({ candidateId, actorId });
    state = { ...state, memoryCandidate: confirmed };
    await appendEvent("t07.memory.confirmed", {
      candidate: asJson(confirmed),
      actorId,
      traceId,
    });
    return confirmed;
  };

  const scheduleFollowUp = async (request: {
    readonly dueAt: string;
    readonly label: string;
    readonly scheduler: FollowUpScheduler;
  }): Promise<ReviewFollowUp> => {
    if (request.label.trim().length === 0 || Number.isNaN(Date.parse(request.dueAt))) {
      throw new Error("follow-up requires a label and parseable dueAt");
    }
    const trigger = { kind: "explicit" as const, label: request.label };
    const dueAt = new Date(request.dueAt).toISOString();
    const followUpProfile = options.followUpRunProfileSnapshot === undefined
      ? reviewRunProfileSnapshot(evidenceMode)
      : parseResolvedRunProfileSnapshot(options.followUpRunProfileSnapshot);
    if (evidenceMode === "live" && followUpProfile.model.provider === "fixture") {
      throw new Error("live follow-up RunProfile snapshot cannot use the fixture provider");
    }
    const schedule: ScheduleRecord = {
      id: `schedule:t07:${idPart(`${traceId}:${dueAt}:${request.label}`)}` as ScheduleRecord["id"],
      workspaceId: input.workspaceId as ScheduleRecord["workspaceId"],
      channelId: input.channelId as ScheduleRecord["channelId"],
      kind: "explicit",
      trigger,
      dueAt,
      catchUpPolicy: "run_latest",
      status: "active",
      run: {
        workspaceId: input.workspaceId as ScheduleRecord["workspaceId"],
        channelId: input.channelId as ScheduleRecord["channelId"],
        goal: request.label,
        source: { eventId: (await ensureRunStarted()).id },
        runProfile: { id: followUpProfile.id, version: followUpProfile.version },
        runProfileSnapshot: followUpProfile,
        budget: followUpProfile.budget,
        permissionScope: "permission:t07-read-only" as never,
        stopCondition: followUpProfile.terminalRules.stopCondition,
        trigger,
        notificationAudience: [input.ownerId as never],
      },
    };
    await request.scheduler.schedule(schedule);
    const followUp: ReviewFollowUp = {
      id: `follow-up:t07:${idPart(`${traceId}:${request.dueAt}:${request.label}`)}`,
      dueAt,
      trigger,
      audience: [input.ownerId],
      traceId,
      schedule,
    };
    state = { ...state, followUp };
    await appendEvent("t07.follow_up.scheduled", { followUp: asJson(followUp), traceId });
    return followUp;
  };

  const laneOutput = async (lane: ReviewLane): Promise<ReviewLaneOutput> => {
    const current = await prepared();
    if (lane === "prd") {
      const candidate = `${current.prdBefore.trimEnd()}\n\n## Review delta\n\n- ${input.reviewNotes}\n`;
      const artifact = outputArtifact(input, "prd", input.prdPath, candidate, traceId, [input.prdPath]);
      const output: ReviewLaneOutput = {
        id: `proposal:prd:${idPart(candidate)}`,
        lane,
        kind: "proposal",
        traceId,
        targetPath: input.prdPath,
        candidate,
        artifact,
        approved: false,
      };
      setLane(output);
      setArtifacts([artifact]);
      await appendEvent("t07.lane.proposed", { lane: asJson(output), traceId });
      await appendEvent("t07.artifact.recorded", { artifact: asJson(artifact), traceId });
      return output;
    }

    const candidate = current.uiBefore.includes("before")
      ? current.uiBefore.replace("before", "review-approved")
      : current.uiBefore.includes("<App />")
        ? current.uiBefore.replace("<App />", "<><App /><output data-t07-review=\"approved\">Review approved</output></>")
        : current.uiBefore.includes("{panel}")
          ? current.uiBefore.replace("{panel}", "{panel} Review approved")
          : current.uiBefore.includes("<main")
            ? current.uiBefore.replace("<main", "<main data-t07-review=\"approved\"")
          : (() => { throw new Error("UI source does not expose a supported visible review seam"); })();
    const artifact = outputArtifact(
      input,
      "ui",
      input.uiPath,
      candidate,
      traceId,
      [input.uiPath],
    );
    const visibleText = candidate.includes("Review approved") ? "Review approved" : "review-approved";
    if (evidenceMode === "live") {
      proposalRoot ??= realpathSync(await mkdtemp(join(tmpdir(), "anna-t07-live-preview-")));
      gateway = createReviewGateway(
        proposalRoot,
        input,
        options.services,
        liveBackendOrigin,
        evidenceMode,
        liveSourceRoot,
      );
    }
    const buildResult = await executeTool("build_candidate_ui", { candidate });
    const buildOutput = buildResult.output as { artifact?: ReviewArtifact } | undefined;
    if (buildResult.status !== "succeeded" || buildOutput?.artifact === undefined) {
      throw new Error(`changed UI proposal build failed through ToolGateway: ${JSON.stringify(buildResult.output)}`);
    }
    const uiBuild = { ...buildOutput.artifact, reviewState: "pending" as const };
    const screenshotResult = await executeTool("capture_candidate_screenshot", {
      buildPath: uiBuild.path,
      screenshotPath: "dist/review-screenshot.png",
      visibleText,
    });
    const screenshotOutput = screenshotResult.output as {
      bytes?: unknown;
      visibleText?: unknown;
      normalShell?: unknown;
      sessionStatus?: unknown;
    } | undefined;
    if (
      screenshotResult.status !== "succeeded"
      || typeof screenshotOutput?.bytes !== "string"
      || screenshotOutput.visibleText !== visibleText
    ) {
      throw new Error(`changed UI proposal screenshot failed through ToolGateway: ${JSON.stringify(screenshotResult.output)}`);
    }
    const screenshot = {
      ...outputBinaryArtifact(
        input,
        "screenshot",
        relative(root, paths.screenshot),
        Buffer.from(screenshotOutput.bytes, "base64"),
        traceId,
        [input.uiPath],
        "pending",
        uiBuild.hash,
      ),
      visibleText,
    };
    const output: ReviewLaneOutput = {
      id: `artifact-lane:ui:${idPart(candidate)}`,
      lane,
      kind: "artifact",
      traceId,
      targetPath: input.uiPath,
      candidate,
      artifact,
      uiBuild,
      screenshot,
      approved: false,
    };
    setLane(output);
    setArtifacts([artifact, uiBuild, screenshot]);
    await appendEvent("t07.lane.proposed", { lane: asJson(output), traceId });
    await appendEvent("t07.artifact.recorded", { artifact: asJson(artifact), traceId });
    await appendEvent("t07.artifact.recorded", { artifact: asJson(uiBuild), traceId });
    await appendEvent("t07.artifact.recorded", { artifact: asJson(screenshot), traceId });
    if (evidenceMode === "live") {
      if (screenshotOutput?.normalShell !== true || screenshotOutput.sessionStatus !== 200) {
        throw new Error("live UI screenshot does not prove a normal Anna backend session");
      }
      await appendEvent("t07.live.ui.api_confirmed", {
        backendOrigin: liveBackendOrigin,
        sessionStatus: screenshotOutput.sessionStatus,
        normalShell: screenshotOutput.normalShell,
        traceId,
      });
    }
    return output;
  };

  const approvedLanes = (): readonly ReviewLaneOutput[] =>
    state.lanes.filter((lane) => lane.approved);

  const provisionLiveWorktree = async (): Promise<void> => {
    if (evidenceMode !== "live") {
      return;
    }
    const expectedHead = options.liveWorktree?.expectedHead;
    if (expectedHead === undefined || expectedHead.length === 0) {
      throw new Error("live evidence requires an expected source-repository HEAD before worktree creation");
    }
    const container = await mkdtemp(join(tmpdir(), "anna-t07-live-worktree-"));
    const requestedWorktree = join(container, "worktree");
    const dependencyRoot = join(liveSourceRoot, "node_modules");
    const result = await executeTool(
      "create_isolated_worktree",
      {
        sourceRoot: liveSourceRoot,
        worktreeRoot: requestedWorktree,
        expectedHead,
        dependencyRoot,
      },
      `effect:t07:${idPart(`worktree:${root}:${expectedHead}:${requestedWorktree}`)}`,
    );
    const output = result.output as {
      worktreeRoot?: unknown;
      dependencyBridge?: ReviewDependencyBridgeEvidence;
      evidence?: ReviewCommandEvidence;
    } | undefined;
    if (
      result.status !== "succeeded"
      || typeof output?.worktreeRoot !== "string"
      || output.dependencyBridge?.sourceRoot !== liveSourceRoot
      || output.dependencyBridge.readOnly !== true
    ) {
      throw new Error(`ToolGateway failed to create the isolated live worktree: ${JSON.stringify(result.output)}`);
    }
    root = realpathSync(output.worktreeRoot);
    paths = {
      root,
      prd: join(root, input.prdPath),
      ui: join(root, input.uiPath),
      ...(input.testPath === undefined ? {} : { test: join(root, input.testPath) }),
      screenshot: join(root, "dist", "review-screenshot.png"),
    };
    gateway = createReviewGateway(
      root,
      input,
      options.services,
      liveBackendOrigin,
      evidenceMode,
      root,
      output.dependencyBridge,
    );
    await appendEvent("t07.worktree.created", {
      runId: traceId,
      worktreeRoot: root,
      expectedHead,
      evidence: output.evidence,
    });
  };

  const startDevelopment = async (review: PreparedReview): Promise<DevelopmentPatch> => {
    const lanes = state.lanes;
    if (lanes.length !== 2 || lanes.some((lane) => !lane.approved)) {
      throw new Error("development requires PRD and UI approval");
    }
    const reviewApproval = state.gates.find((item) => item.kind === "prd_ui_approval");
    if (
      reviewApproval?.status !== "passed"
      || reviewApproval.actorId !== input.ownerId
      || reviewApproval.artifactIds.length !== 2
    ) {
      throw new Error("development requires a persisted Channel Owner PRD/UI approval");
    }
    await provisionLiveWorktree();
    const prd = lanes.find((lane) => lane.lane === "prd")!;
    const ui = lanes.find((lane) => lane.lane === "ui")!;
    const developmentRunId = traceId;
    let developmentApprovalRecorded = false;
    const recordDevelopmentApproval = async (decision: ReviewApprovalDecision): Promise<void> => {
      if (developmentApprovalRecorded) return;
      const next = gate(
        "development_approval",
        "passed",
        traceId,
        reviewApproval.artifactIds,
        decision.actorId,
      );
      setGate(next);
      developmentApprovalRecorded = true;
      await appendEvent("t07.gate.recorded", { gate: asJson(next), traceId });
    };
    const patch = async (path: string, before: string, after: string): Promise<ToolResult> =>
      executeTool(
        "bounded_patch",
        {
          path,
          expected: before,
          replacement: after,
        },
        `effect:t07:${idPart(`${path}:${after}`)}`,
        recordDevelopmentApproval,
      );
    const prdResult = await patch(input.prdPath, review.prdBefore, prd.candidate);
    const uiResult = await patch(input.uiPath, review.uiBefore, ui.candidate);
    let testSource: ReviewArtifact | undefined;
    let testResult: ToolResult | undefined;
    if (input.testPath !== undefined && review.testBefore !== undefined) {
      const relativeUiPath = relative(dirname(input.testPath), input.uiPath).replaceAll("\\", "/");
      const testUiPath = relativeUiPath.startsWith(".") ? relativeUiPath : `./${relativeUiPath}`;
      const visibleMarker = ui.candidate.includes('data-t07-review="approved"')
        ? 'data-t07-review="approved"'
        : "review-approved";
      const appendedTest = review.testBefore.includes('from "vitest"')
        ? [
            review.testBefore.trimEnd(),
            "",
            'it("keeps the approved T07 decision visible in the UI entry", async () => {',
            '  const { readFile } = await import("node:fs/promises");',
            `  const source = await readFile(new URL(${JSON.stringify(testUiPath)}, import.meta.url), "utf8");`,
            `  expect(source).toContain(${JSON.stringify(visibleMarker)});`,
            "});",
            "",
          ].join("\n")
        : review.testBefore.includes('from "node:test"') && review.testBefore.includes('from "node:assert/strict"')
          ? [
              review.testBefore.trimEnd(),
              "",
              'test("keeps the approved T07 decision visible in the UI entry", async () => {',
              '  const { readFile } = await import("node:fs/promises");',
              `  const source = await readFile(new URL(${JSON.stringify(testUiPath)}, import.meta.url), "utf8");`,
              `  assert.equal(source.includes(${JSON.stringify(visibleMarker)}), true);`,
              "});",
              "",
            ].join("\n")
          : undefined;
      if (appendedTest === undefined) {
        throw new Error("test source does not expose a supported test seam");
      }
      testResult = await patch(input.testPath, review.testBefore, appendedTest);
      testSource = outputArtifact(
        input,
        "test",
        input.testPath,
        appendedTest,
        developmentRunId,
        [input.testPath],
        "approved",
      );
    }
    if (
      prdResult.status !== "succeeded"
      || uiResult.status !== "succeeded"
      || (testResult !== undefined && testResult.status !== "succeeded")
    ) {
      throw new Error("development patch failed");
    }

    const buildResult = await executeTool(
      "build_changed_ui",
      { path: input.uiPath },
      `effect:t07:${idPart(`build:${input.uiPath}:${ui.candidate}`)}`,
    );
    const buildOutput = buildResult.output as { artifact?: ReviewArtifact } | undefined;
    if (buildResult.status !== "succeeded" || buildOutput?.artifact === undefined) {
      throw new Error("changed React UI build failed through ToolGateway");
    }
    const uiBuild = { ...buildOutput.artifact, validationStatus: "passed" as const };
    if (ui.screenshot === undefined || ui.uiBuild === undefined || ui.uiBuild.hash !== uiBuild.hash) {
      throw new Error("approved UI proposal does not match the validated UI build");
    }
    const visibleText = ui.candidate.includes("Review approved") ? "Review approved" : "review-approved";
    const screenshotResult = await executeTool(
      "capture_screenshot",
      {
        buildPath: uiBuild.path,
        screenshotPath: "dist/review-screenshot.png",
        visibleText,
      },
      `effect:t07:${idPart(`screenshot:${uiBuild.hash}:${visibleText}`)}`,
    );
    const screenshotOutput = screenshotResult.output as {
      bytes?: unknown;
      visibleText?: unknown;
      normalShell?: unknown;
      sessionStatus?: unknown;
    } | undefined;
    if (
      screenshotResult.status !== "succeeded"
      || typeof screenshotOutput?.bytes !== "string"
      || screenshotOutput.visibleText !== visibleText
    ) {
      throw new Error(`validated UI screenshot failed through ToolGateway: ${JSON.stringify(screenshotResult.output)}`);
    }
    if (evidenceMode === "live") {
      if (screenshotOutput.normalShell !== true || screenshotOutput.sessionStatus !== 200) {
        throw new Error("live UI screenshot does not prove a normal Anna backend session");
      }
      await appendEvent("t07.live.ui.api_confirmed", {
        backendOrigin: liveBackendOrigin,
        sessionStatus: screenshotOutput.sessionStatus,
        normalShell: screenshotOutput.normalShell,
        traceId,
      });
    }
    const diffResult = await executeTool(
      "run_command",
      { command: "git diff" },
      `effect:t07:${idPart(`patch-diff:${traceId}`)}`,
    );
    const diffEvidence = commandEvidenceFrom(diffResult);
    if (diffEvidence.exitCode !== 0) {
      throw new Error(`implementation diff failed with exit code ${diffEvidence.exitCode}`);
    }
    const changedFiles = [input.prdPath, input.uiPath, ...(input.testPath === undefined ? [] : [input.testPath])];
    const prdArtifact = { ...outputArtifact(input, "prd", input.prdPath, prd.candidate, developmentRunId, [input.prdPath], "approved"), validationStatus: "passed" as const };
    const uiArtifact = { ...outputArtifact(input, "ui", input.uiPath, ui.candidate, developmentRunId, [input.uiPath], "approved"), validationStatus: "passed" as const };
    const patchArtifact = { ...outputArtifact(input, "patch", "git diff", diffEvidence.stdout, developmentRunId, changedFiles, "approved"), validationStatus: "passed" as const };
    const approvedScreenshot = {
      ...outputBinaryArtifact(
        input,
        "screenshot",
        relative(root, paths.screenshot),
        Buffer.from(screenshotOutput.bytes, "base64"),
        developmentRunId,
        [input.uiPath],
        "approved",
        uiBuild.hash,
      ),
      visibleText,
      validationStatus: "passed" as const,
    };
    const approvedProposalBuild = {
      ...ui.uiBuild,
      reviewState: "approved" as const,
      validationStatus: "passed" as const,
    };
    const developmentArtifacts = [
      prdArtifact,
      uiArtifact,
      patchArtifact,
      approvedProposalBuild,
      uiBuild,
      approvedScreenshot,
      ...(testSource === undefined ? [] : [testSource]),
    ];
    setArtifacts(developmentArtifacts);
    const developmentGate = state.gates.find((item) => item.kind === "development_approval");
    if (developmentGate?.status !== "passed" || developmentGate.actorId !== input.ownerId) {
      throw new Error("development approval must be persisted with the Channel Owner actor before patching");
    }
    for (const artifact of developmentArtifacts) {
      await appendEvent("t07.artifact.recorded", { artifact: asJson(artifact), traceId });
    }
    return {
      traceId,
      paths,
      prd,
      ui,
      artifacts: developmentArtifacts,
      uiBuild,
      testSource,
    };
  };

  const runTests = async (_development: DevelopmentPatch): Promise<ReviewTestResult> => {
    const testCommand = evidenceMode === "live" && input.testPath !== undefined
      ? `npm exec --no -- vitest run --configLoader runner ${input.testPath}`
      : "npm test";
    const commandResult = await executeTool(
      "run_command",
      { command: testCommand },
      `effect:t07:${idPart(`test:${testCommand}:${traceId}`)}`,
    );
    const evidence = commandEvidenceFrom(commandResult);
    const passed = evidence.exitCode === 0;
    const validatedSource = _development.testSource === undefined ? undefined : {
      ..._development.testSource,
      validationStatus: passed ? "passed" as const : "failed" as const,
    };
    if (validatedSource !== undefined) {
      setArtifacts([validatedSource]);
      await appendEvent("t07.artifact.recorded", { artifact: asJson(validatedSource), traceId });
    }
    const evidenceJson = JSON.stringify({ passed, ...evidence }, null, 2) + "\n";
    const evidenceFile = await executeTool(
      "write_artifact",
      { path: "test-results.json", content: evidenceJson },
      `effect:t07:${idPart(`test-results:${traceId}`)}`,
    );
    if (evidenceFile.status !== "succeeded") {
      throw new Error("test evidence artifact write failed through ToolGateway");
    }
    const testArtifact = outputArtifact(
      input,
      "test",
      "test-results.json",
      evidenceJson,
      traceId,
      [input.uiPath, input.prdPath, ...(input.testPath === undefined ? [] : [input.testPath])],
      "approved",
    );
    const validated = { ...testArtifact, validationStatus: passed ? "passed" as const : "failed" as const };
    setArtifacts([validated]);
    const testGate = gate("tests", passed ? "passed" : "failed", traceId, [validated.id]);
    setGate(testGate);
    await appendEvent("t07.test.executed", { evidence: asJson(evidence), traceId });
    await appendEvent("t07.artifact.recorded", { artifact: asJson(validated), traceId });
    await appendEvent("t07.gate.recorded", { gate: asJson(testGate), traceId });
    return {
      passed,
      mergeReady: passed,
      blockedBy: passed ? [] : ["tests"],
      artifact: validated,
      evidence,
    };
  };

  const renderScreenshot = async (development: DevelopmentPatch): Promise<ReviewArtifact> => {
    const screenshot = development.artifacts.find((artifact) => artifact.kind === "screenshot");
    if (screenshot === undefined || screenshot.sourceBuildHash !== development.uiBuild.hash) {
      throw new Error("approved UI screenshot is missing or does not match the validated UI build");
    }
    const approvedScreenshot = {
      ...screenshot,
      reviewState: "approved" as const,
      validationStatus: "passed" as const,
    };
    setArtifacts([approvedScreenshot]);
    await appendEvent("t07.artifact.recorded", { artifact: asJson(approvedScreenshot), traceId });
    return approvedScreenshot;
  };

  const run = async (): Promise<ReviewScenarioResult> => {
    const existingEvents = await readCanonicalEvents();
    const existingTerminal = [...existingEvents].reverse().find((event) =>
      event.type === "run.completed" || event.type === "run.failed");
    if (existingTerminal !== undefined) {
      if (
        existingTerminal.type === "run.failed"
        && !existingEvents.some((event) => event.type === "t07.result.prepared" || event.type === "t07.result.recorded")
      ) {
        throw new Error("T07 canonical run already has a terminal failure; refusing to rerun");
      }
      return await restore();
    }
    if (options.scheduler === undefined) {
      throw new Error("T07 run requires the durable T06 Scheduler seam");
    }
    if (options.approvalProvider === undefined) {
      throw new Error("T07 run requires explicit human approval");
    }
    let stage = "prepare";
    try {
      const review = await prepared();
      stage = "memory_candidate";
      const memoryCandidate = await proposeMemoryCandidate(review);
      const memoryDecision = requireApprovalDecision(
        await options.approvalProvider.confirmMemoryCandidate(memoryCandidate),
        input.ownerId,
        "MemoryCandidate confirmation",
      );
      if (!memoryDecision.approved) {
        throw new ReviewApprovalRejectedError("Channel Owner rejected the MemoryCandidate");
      }
      await confirmMemoryCandidate(memoryCandidate.id, memoryDecision.actorId);
      stage = "review_lanes";
      const [prd, ui] = await Promise.all([laneOutput("prd"), laneOutput("ui")]);
      const prdDecision = requireApprovalDecision(
        await options.approvalProvider.approveLane(prd),
        input.ownerId,
        "PRD approval",
      );
      const uiDecision = requireApprovalDecision(
        await options.approvalProvider.approveLane(ui),
        input.ownerId,
        "UI approval",
      );
      if (!prdDecision.approved || !uiDecision.approved) {
        throw new ReviewApprovalRejectedError("Channel Owner requested rework for a review lane");
      }
      await approve(prd.id, prdDecision.actorId);
      await approve(ui.id, uiDecision.actorId);
      stage = "development";
      const development = await startDevelopment(review);
      stage = "screenshot";
      const screenshot = await renderScreenshot(development);
      stage = "tests";
      const tests = await runTests(development);
      stage = "follow_up";
      const followUp = await scheduleFollowUp({
      dueAt: options.followUpDueAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      label: "Re-check the validated patch",
      scheduler: options.scheduler,
    });
    const runCommand = async (command: string): Promise<ReviewCommandEvidence> => {
      const result = await executeTool(
        "run_command",
        { command },
        `effect:t07:${idPart(`command:${command}:${traceId}`)}`,
      );
      return commandEvidenceFrom(result);
    };
      stage = "git_evidence";
    const git = await gitEvidence(root, input, runCommand);
      stage = "eval";
    const evalInputEvents = await readCanonicalEvents();
    const contractResult = evaluateReviewContract({
      traceId,
      events: evalInputEvents,
      artifacts: state.artifacts,
      testsPassed: tests.passed,
      plannedTerminal: tests.passed && git.valid ? "run.completed" : "run.failed",
    });
    await appendEvent("t07.eval.contract", {
      result: asJson(contractResult),
      plannedTerminal: tests.passed && git.valid ? "run.completed" : "run.failed",
      traceId,
    });
    const qualityResult = await options.services.evalGate.evaluate({
      traceId,
      events: evalInputEvents,
      artifacts: state.artifacts,
      testsPassed: tests.passed,
      reviewNotes: input.reviewNotes,
      contract: contractResult,
    });
    const evalResult: ReviewEvalResult = {
      passed: contractResult.passed && qualityResult.passed,
      reason: contractResult.passed ? qualityResult.reason : contractResult.reason,
      checkedEventIds: [...new Set([
        ...contractResult.checkedEventIds,
        ...qualityResult.checkedEventIds,
      ])],
    };
    await appendEvent("t07.eval.completed", {
      contract: asJson(contractResult),
      quality: asJson(qualityResult),
      result: asJson(evalResult),
      traceId,
    });
    const technicalBlockedBy = [
      ...tests.blockedBy,
      ...(evalResult.passed ? [] : ["eval"]),
      ...(git.valid ? [] : ["git_evidence"]),
    ];
    const resultBase = {
      traceId,
      paths,
      artifacts: [...state.artifacts],
      gates: [...state.gates],
      screenshot,
      uiBuild: development.uiBuild,
      commands: [development.uiBuild.buildCommand ?? "vite.build()", tests.evidence.command, ...git.commands],
      mergeReady: technicalBlockedBy.length === 0,
      blockedBy: [...new Set(technicalBlockedBy)],
      humanMergeDecision: "pending" as const,
      evidenceMode,
      testEvidence: tests.evidence,
      eval: evalResult,
      memoryCandidate: state.memoryCandidate,
      followUp: state.followUp,
      git,
    };
    await appendEvent(
      "t07.result.prepared",
      { runId: traceId, result: asJson(resultBase), traceId },
      `t07-result:${traceId}` as StreamId,
    );
    await appendEvent(
      technicalBlockedBy.length === 0 ? "run.completed" : "run.failed",
      { runId: traceId, blockedBy: technicalBlockedBy },
    );
    const canonicalEvents = await readCanonicalEvents();
    const projected = await options.services.traceProjector.project(canonicalEvents, traceId);
    const trace = {
      ...projected,
      memoryCandidateId: memoryCandidate.id,
      followUpId: followUp.id,
    };
    const result: ReviewScenarioResult = { ...resultBase, trace };
    state = { ...state, result };
    await appendEvent(
      "t07.result.recorded",
      { runId: traceId, result: asJson(result), traceId },
      `t07-result:${traceId}` as StreamId,
    );
      return result;
    } catch (error) {
      const currentEvents = await readCanonicalEvents();
      if (error instanceof ReviewApprovalRejectedError) {
        await appendEvent("t07.rework.awaiting_approval", {
          runId: traceId,
          stage,
          reason: error.message,
          evidenceSufficient: true,
        });
        throw error;
      }
      if (!currentEvents.some((event) => ["run.completed", "run.failed"].includes(event.type))) {
        await ensureRunStarted();
        const classification = failureClassification(stage, error);
        await appendEvent("run.failed", {
          runId: traceId,
          blockedBy: [stage],
          reason: String(error),
          stage,
          ...(classification === undefined
            ? { evidenceSufficient: false }
            : { classification, evidenceSufficient: true }),
        });
      }
      throw error;
    }
  };

  const restore = async (): Promise<ReviewScenarioResult> => {
    const events = await readCanonicalEvents();
    const resultEvent = [...events].reverse().find((event) => event.type === "t07.result.recorded");
    const preparedEvent = [...events].reverse().find((event) => event.type === "t07.result.prepared");
    const payload = (resultEvent?.payload ?? preparedEvent?.payload) as {
      result?: ReviewScenarioResult;
    } | undefined;
    if (payload?.result === undefined || payload.result.traceId !== traceId) {
      throw new Error("T07 canonical event projection is missing or belongs to another trace");
    }
    const terminal = [...events].reverse().find((event) =>
      event.type === "run.completed" || event.type === "run.failed");
    if (terminal === undefined) {
      throw new Error("T07 result cannot restore before a terminal event");
    }
    const base = asJson(payload.result);
    const restored = resultEvent === undefined
      ? {
          ...base,
          trace: {
            ...(await options.services.traceProjector.project(events, traceId)),
            memoryCandidateId: base.memoryCandidate?.id,
            followUpId: base.followUp?.id,
          },
        }
      : base;
    const artifactRoot = realpathSync(restored.paths.root);
    for (const artifact of restored.artifacts) {
      if (artifact.kind === "ui-build") continue;
      if (artifact.path === "git diff") {
        const diff = await execFile("git", ["-C", artifactRoot, "diff"]);
        if (hash(diff.stdout) !== artifact.hash) {
          throw new Error("restored patch Artifact hash does not match Git diff evidence");
        }
        continue;
      }
      const artifactPath = join(artifactRoot, ensureRelativePath(artifact.path, `restored ${artifact.kind} Artifact path`));
      const bytes = await readFileNoFollow(artifactRoot, artifactPath);
      if (hashBytes(bytes) !== artifact.hash) {
        throw new Error(`restored ${artifact.kind} Artifact hash does not match its bytes`);
      }
    }
    const screenshotBytes = await readFileNoFollow(artifactRoot, join(artifactRoot, restored.screenshot.path));
    if (hashBytes(screenshotBytes) !== restored.screenshot.hash) {
      throw new Error("restored screenshot Artifact hash does not match its bytes");
    }
    const buildRoot = join(artifactRoot, restored.uiBuild.path);
    await ensureSecureDirectory(artifactRoot, buildRoot);
    const builtFiles = await filesUnder(buildRoot);
    const buildDigest = await digestFiles(buildRoot, builtFiles);
    if (buildDigest !== restored.uiBuild.hash) {
      throw new Error("restored UI build Artifact hash does not match its bytes");
    }
    state = {
      traceId,
      lanes: [],
      gates: restored.gates,
      artifacts: restored.artifacts,
      memoryCandidate: restored.memoryCandidate,
      followUp: restored.followUp,
      result: restored,
    };
    return restored;
  };

  const approve = async (id: string, actorId: string): Promise<ReviewGate> => {
    if (actorId !== input.ownerId) {
      throw new Error("only the Channel Owner can approve T07 artifacts");
    }
    const lane = state.lanes.find((item) => item.id === id);
    if (lane === undefined) {
      throw new Error("review artifact was not found");
    }
    setLane({ ...lane, approved: true });
    if (lane.artifact !== undefined) {
      setArtifacts([{ ...lane.artifact, reviewState: "approved" }]);
    }
    const approvedArtifactIds = state.lanes
      .filter((item) => item.approved || item.id === id)
      .map((item) => {
        if (item.artifact === undefined) {
          throw new Error("review Lane is missing its Artifact");
        }
        return item.artifact.id;
      });
    const next = gate(
      "prd_ui_approval",
      state.lanes.length === 2 && state.lanes.every((item) => item.approved) ? "passed" : "pending",
      traceId,
      approvedArtifactIds,
      actorId,
    );
    setGate(next);
    await appendEvent("t07.lane.approved", { laneId: id, actorId, traceId });
    await appendEvent("t07.gate.recorded", { gate: asJson(next), traceId });
    return next;
  };

  const readWorkspace = async (_review: PreparedReview, requestedPath: string): Promise<ToolResult> =>
    executeTool("read_workspace", { path: requestedPath });

  const executeCommand = async (command: string): Promise<string> => {
    if (blockedCommandPattern.test(command)) {
      throw new Error("push, merge and deploy commands are unavailable in T07");
    }
    if (!safeCommands.includes(command as (typeof safeCommands)[number])) {
      throw new Error(`command is not allowlisted: ${command}`);
    }
    const result = await executeTool(
      "run_command",
      { command },
      `effect:t07:${idPart(`command:${command}:${traceId}`)}`,
    );
    const evidence = commandEvidenceFrom(result);
    if (evidence.exitCode !== 0) {
      throw new Error(`command failed with exit code ${evidence.exitCode}: ${evidence.stderr}`);
    }
    return `${evidence.stdout}${evidence.stderr}`;
  };

  return {
    prepare: prepared,
    runPrdLane: (_review: PreparedReview) => laneOutput("prd"),
    runUiLane: (_review: PreparedReview) => laneOutput("ui"),
    proposeMemoryCandidate,
    confirmMemoryCandidate,
    scheduleFollowUp,
    approve,
    startDevelopment,
    readWorkspace,
    runTests,
    run,
    restore,
    availableCommands: () => [...safeCommands],
    executeCommand,
    approvedLanes,
  };
}

async function createFixtureWorktreeThroughGateway(
  repositoryRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const streams = new Map<string, CanonicalEvent[]>();
  let eventNumber = 0;
  const events = {
    async append(event: CanonicalEvent): Promise<void> {
      const stream = streams.get(event.streamId) ?? [];
      if (event.seq !== stream.length) throw new Error("fixture ToolGateway event sequence conflict");
      stream.push(event);
      streams.set(event.streamId, stream);
    },
    async *read(streamId: StreamId): AsyncIterable<CanonicalEvent> {
      yield* streams.get(streamId) ?? [];
    },
  };
  const scope = {
    workspaceId: "workspace-review-fixture" as ToolRequest["workspaceId"],
    channelId: "channel-review-fixture" as ToolRequest["channelId"],
  };
  const gateway = createToolGateway({
    catalog: [{
      name: "create_fixture_worktree",
      replayPolicy: "never",
      inputSchema: { parse: (value: unknown) => value },
    }],
    scope,
    workerProfileId: "worker:t07-fixture" as ToolRequest["workerProfileId"],
    policy: { async decide() { return "require_approval" as const; } },
    events,
    createEventId: () => `event:t07-fixture-worktree:${++eventNumber}`,
    sandbox: {
      async execute(request): Promise<ToolResult> {
        const value = request.input as Record<string, unknown>;
        if (value.repositoryRoot !== repositoryRoot || value.worktreeRoot !== worktreeRoot) {
          return { status: "failed", output: { reason: "scope_denied" } };
        }
        try {
          await execFile("git", ["-C", repositoryRoot, "worktree", "add", "--quiet", "--detach", worktreeRoot, "HEAD"]);
          return { status: "succeeded", output: { worktreeRoot } };
        } catch (error) {
          return { status: "failed", output: { reason: "worktree_creation_failed", detail: String(error) } };
        }
      },
    },
  });
  const request = {
    ...scope,
    runId: "run:t07:fixture-worktree" as ToolRequest["runId"],
    workerProfileId: "worker:t07-fixture" as ToolRequest["workerProfileId"],
    name: "create_fixture_worktree",
    input: { repositoryRoot, worktreeRoot },
    effectKey: "effect:t07:fixture-worktree",
    toolCallId: "tool:t07:fixture-worktree",
  };
  const pending = await gateway.execute(request, new AbortController().signal);
  if ((pending.output as { reason?: unknown } | undefined)?.reason !== "approval_required") {
    throw new Error("fixture ToolGateway did not request the worktree effect approval");
  }
  await gateway.answerApproval({
    ...scope,
    runId: request.runId,
    effectKey: request.effectKey,
    approvalId: `approval:${request.effectKey}`,
    actorId: "fixture:t07-worktree",
    decision: "approved",
  });
  const result = await gateway.execute(request, new AbortController().signal);
  if (result.status !== "succeeded") {
    throw new Error(`fixture ToolGateway failed to create an isolated worktree: ${JSON.stringify(result.output)}`);
  }
}

export async function createDeterministicReviewFixture(options: {
  readonly mode: ReviewEvidenceMode;
}): Promise<DeterministicReviewFixture> {
  if (options.mode === "live") {
    throw new Error("live canary requires an explicit disposable worktree from the live Anna repository");
  }
  const container = await mkdtemp(join(tmpdir(), "anna-t07-review-fixture-"));
  const repositoryRoot = join(container, "repository");
  const worktreeRoot = join(container, "worktree");
  const input: ReviewScenarioInput = {
    workspaceId: "workspace-review-fixture",
    channelId: "channel-review-fixture",
    reviewNotes: "Keep the owner decision visible in the compact review panel.",
    prdPath: "docs/review-prd.md",
    uiPath: "src/review-panel.tsx",
    ownerId: "actor-owner",
    sourceRunId: `run-review-${options.mode}`,
    sourceEventIds: ["event-review-fixture-source"],
  };

  try {
    await mkdir(join(repositoryRoot, "docs"), { recursive: true });
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, input.prdPath), "# Review PRD\n\n- Keep owner decision visible.\n", "utf8");
    await writeFile(join(repositoryRoot, input.uiPath), [
      'import { createRoot } from "react-dom/client";',
      'const label = "before";',
      'createRoot(document.getElementById("root")!).render(<main data-review-panel="true">{label}</main>);',
      "",
    ].join("\n"), "utf8");
    await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({
      private: true,
      scripts: { test: "node -e \"console.log('t07-fixture-test-ok')\"" },
    }) + "\n", "utf8");
    await execFile("git", ["init", "--quiet", repositoryRoot]);
    await execFile("git", ["-C", repositoryRoot, "config", "user.email", "t07@example.invalid"]);
    await execFile("git", ["-C", repositoryRoot, "config", "user.name", "Anna T07 Fixture"]);
    await execFile("git", ["-C", repositoryRoot, "add", "docs/review-prd.md", "src/review-panel.tsx", "package.json"]);
    await execFile("git", ["-C", repositoryRoot, "commit", "--quiet", "-m", "fixture baseline"]);
    await createFixtureWorktreeThroughGateway(repositoryRoot, worktreeRoot);
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const canonicalWorktreeRoot = realpathSync(worktreeRoot);
  return {
    repositoryRoot: canonicalRepositoryRoot,
    worktreeRoot: canonicalWorktreeRoot,
    input,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await execFile("git", ["-C", canonicalRepositoryRoot, "worktree", "remove", "--force", canonicalWorktreeRoot]).catch(() => undefined);
      await rm(container, { recursive: true, force: true });
    },
  };
}
