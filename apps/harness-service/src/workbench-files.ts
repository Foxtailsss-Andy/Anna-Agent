import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { JsonValue } from "@anna/harness-v2";

export const WORKDIR_RESOURCE_PREFIX = "workdir:";
export const WORKDIR_READ_MAX_CHARS = 16_384;
export const WORKDIR_READ_MAX_BYTES = 65_536;
export const WORKDIR_WRITE_MAX_BYTES = 1_048_576;
export const WORKDIR_SEARCH_MAX_FILE_BYTES = 1_048_576;
export const WORKDIR_LIST_MAX_ENTRIES = 500;
export const WORKDIR_SEARCH_DEFAULT_RESULTS = 100;
export const WORKDIR_SEARCH_MAX_RESULTS = 200;
export const WORKDIR_SEARCH_MAX_LINE_CHARS = 2_000;
export const WORKDIR_SEARCH_MAX_FILES_SCANNED = 5_000;
const WORKDIR_LIST_SKIP_DIRECTORIES = new Set([".git", "node_modules"]);
type WorkbenchFileOutput = Record<string, JsonValue>;

export interface WorkbenchWorkdirResolutionOptions {
  readonly origin: string;
  readonly serviceToken?: string;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly resourceRefs: readonly string[];
  readonly boundRoot?: string;
  readonly fetchImpl?: typeof fetch;
  readonly protectedPaths?: readonly string[];
}

export function workdirResourceId(resourceRefs: readonly string[]): string | undefined {
  if (resourceRefs.length === 0) return undefined;
  if (resourceRefs.length !== 1) throw new Error("workdir_resource_refs_not_supported");
  const ref = resourceRefs[0];
  if (ref === undefined || !ref.startsWith(WORKDIR_RESOURCE_PREFIX)) {
    throw new Error("workdir_resource_ref_not_supported");
  }
  const id = ref.slice(WORKDIR_RESOURCE_PREFIX.length).trim();
  if (id === "" || id.includes("/") || id.includes("\\")) {
    throw new Error("workdir_resource_ref_not_supported");
  }
  return id;
}

export async function resolveWorkbenchWorkdir(
  options: WorkbenchWorkdirResolutionOptions,
): Promise<string | undefined> {
  const id = workdirResourceId(options.resourceRefs);
  if (id === undefined) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.origin.replace(/\/$/, "")}/_business/workbench/scope`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-anna-workspace-id": options.workspaceId,
        "x-anna-user-id": options.actorUserId,
        ...(options.serviceToken === undefined ? {} : { "x-anna-service-token": options.serviceToken }),
      },
      body: JSON.stringify({
        workspace_id: options.workspaceId,
        actor_user_id: options.actorUserId,
        workdir_id: id,
      }),
    });
  } catch {
    throw new Error("business_workdir_unavailable");
  }
  if (!response.ok) throw new Error(response.status === 404 ? "workdir_not_found" : "business_workdir_unavailable");
  const body = await response.json() as Record<string, unknown>;
  if (body.workdir_id !== id || typeof body.workdir_path !== "string" || body.workdir_path.trim() === "") {
    throw new Error("workdir_not_found");
  }
  let canonical: string;
  try {
    canonical = await admitCanonicalRoot(body.workdir_path, options.protectedPaths);
  } catch (error) {
    if (error instanceof Error && error.message === "workdir_protected_path") throw error;
    throw new Error("workdir_unavailable");
  }
  if (options.boundRoot !== undefined) {
    const bound = resolve(options.boundRoot);
    if (canonical !== bound) throw new Error("workdir_binding_changed");
  }
  return canonical;
}

export async function readRegisteredWorkdirFile(
  input: unknown,
  options: WorkbenchWorkdirResolutionOptions,
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed"; output: WorkbenchFileOutput }> {
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
  const parsed = parseReadInput(input);
  if (parsed === undefined) return { status: "failed", output: { reason: "invalid_workdir_read_request" } };
  let root: string | undefined;
  try {
    root = await resolveWorkbenchWorkdir(options);
  } catch (error) {
    return { status: "failed", output: { reason: error instanceof Error ? error.message : "workdir_unavailable" } };
  }
  if (root === undefined) return { status: "failed", output: { reason: "workdir_not_bound" } };
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
  const resourceId = workdirResourceId(options.resourceRefs);
  if (resourceId === undefined) return { status: "failed", output: { reason: "workdir_not_bound" } };
  const target = resolve(root, parsed.path);
  const requestedRelative = relative(root, target);
  if (requestedRelative === "" || !isWithinPath(requestedRelative)) {
    return { status: "failed", output: { reason: "workdir_path_outside_root" } };
  }
  let handle: FileHandle | undefined;
  try {
    const resolvedTarget = await realpath(target);
    const resolvedRelative = relative(root, resolvedTarget);
    if (resolvedRelative === "" || !isWithinPath(resolvedRelative)) {
      return { status: "failed", output: { reason: "workdir_path_outside_root" } };
    }
    const candidate = await stat(resolvedTarget);
    if (!candidate.isFile()) return { status: "failed", output: { reason: "workdir_file_not_bounded" } };
    handle = await open(resolvedTarget, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { status: "failed", output: { reason: "workdir_file_not_bounded" } };
    if (parsed.offset > metadata.size) {
      return { status: "failed", output: { reason: "workdir_offset_out_of_range" } };
    }
    if (parsed.offset < metadata.size) {
      const firstByte = Buffer.alloc(1);
      await handle.read(firstByte, 0, 1, parsed.offset);
      if ((firstByte[0] & 0xc0) === 0x80) {
        return { status: "failed", output: { reason: "workdir_offset_not_utf8_boundary" } };
      }
    }
    const sourceLength = Math.min(WORKDIR_READ_MAX_BYTES, metadata.size - parsed.offset);
    const source = Buffer.alloc(sourceLength);
    const { bytesRead } = sourceLength === 0
      ? { bytesRead: 0 }
      : await handle.read(source, 0, sourceLength, parsed.offset);
    const decoded = decodeUtf8Prefix(
      source.subarray(0, bytesRead),
      parsed.offset + bytesRead < metadata.size,
    );
    const content = [...decoded.text].slice(0, parsed.limit).join("");
    const contentBytes = Buffer.byteLength(content, "utf8");
    const end = parsed.offset + contentBytes;
    const truncated = end < metadata.size;
    return {
      status: "succeeded",
      output: {
        resource_ref: `${WORKDIR_RESOURCE_PREFIX}${resourceId}`,
        path: resolvedRelative,
        offset: parsed.offset,
        offset_unit: "utf8_bytes",
        range: { offset: parsed.offset, end_offset: end, offset_unit: "utf8_bytes" },
        end_offset: end,
        limit: parsed.limit,
        content,
        truncated,
        ...(truncated ? { next_offset: end } : {}),
      },
    };
  } catch (error) {
    return {
      status: "failed",
      output: { reason: error instanceof TypeError ? "workdir_file_not_utf8" : "workdir_file_unavailable" },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function listRegisteredWorkdir(
  input: unknown,
  options: WorkbenchWorkdirResolutionOptions,
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed"; output: WorkbenchFileOutput }> {
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
  const parsed = parseListInput(input);
  if (parsed === undefined) return { status: "failed", output: { reason: "invalid_workdir_list_request" } };
  const resolved = await resolveToolRoot(options);
  if ("reason" in resolved) return { status: "failed", output: { reason: resolved.reason } };
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };

  const start = await resolveToolTarget(resolved.root, parsed.path);
  if ("reason" in start) return { status: "failed", output: { reason: start.reason } };
  let startInfo;
  try {
    startInfo = await stat(start.canonical);
  } catch {
    return { status: "failed", output: { reason: "workdir_path_unavailable" } };
  }
  if (!startInfo.isDirectory()) return { status: "failed", output: { reason: "workdir_not_a_directory" } };

  const entries: Array<{ path: string; type: "file" | "dir"; bytes?: number }> = [];
  let truncated = false;
  const queue: Array<{ absolute: string; depth: number }> = [{ absolute: start.canonical, depth: 1 }];
  while (queue.length > 0) {
    if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
    const current = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbsolute = join(current.absolute, dirent.name);
      const childRelative = relative(resolved.root, childAbsolute);
      let info;
      try {
        info = await lstat(childAbsolute);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (isSkippedDirectory(dirent.name)) continue;
        if (entries.length >= WORKDIR_LIST_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ path: childRelative, type: "dir" });
        if (current.depth < parsed.depth) queue.push({ absolute: childAbsolute, depth: current.depth + 1 });
      } else if (info.isFile()) {
        if (entries.length >= WORKDIR_LIST_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ path: childRelative, type: "file", bytes: info.size });
      }
    }
    if (truncated) break;
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { status: "succeeded", output: { entries, truncated } };
}

export async function searchRegisteredWorkdir(
  input: unknown,
  options: WorkbenchWorkdirResolutionOptions,
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed"; output: WorkbenchFileOutput }> {
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
  const parsed = parseSearchInput(input);
  if (parsed === undefined) return { status: "failed", output: { reason: "invalid_workdir_search_request" } };
  const resolved = await resolveToolRoot(options);
  if ("reason" in resolved) return { status: "failed", output: { reason: resolved.reason } };
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };

  const start = await resolveToolTarget(resolved.root, parsed.path);
  if ("reason" in start) return { status: "failed", output: { reason: start.reason } };

  const matcher = buildMatcher(parsed);
  if (matcher === undefined) return { status: "failed", output: { reason: "invalid_workdir_search_request" } };

  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false;
  let filesScanned = 0;
  const files: string[] = [];
  try {
    const info = await lstat(start.canonical);
    if (info.isFile()) files.push(start.canonical);
    else if (info.isDirectory()) await collectSearchFiles(start.canonical, files, signal);
    else return { status: "failed", output: { reason: "workdir_path_unavailable" } };
  } catch {
    return { status: "failed", output: { reason: "workdir_path_unavailable" } };
  }

  for (const file of files) {
    if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
    if (filesScanned >= WORKDIR_SEARCH_MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }
    filesScanned += 1;
    const text = await readSearchableText(file);
    if (text === undefined) continue;
    const relativePath = relative(resolved.root, file);
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index]!)) continue;
      if (matches.length >= parsed.maxResults) {
        truncated = true;
        break;
      }
      matches.push({ path: relativePath, line: index + 1, text: lines[index]!.slice(0, WORKDIR_SEARCH_MAX_LINE_CHARS) });
    }
    if (truncated) break;
  }
  return { status: "succeeded", output: { matches, truncated } };
}

export async function writeRegisteredWorkdirFile(
  input: unknown,
  options: WorkbenchWorkdirResolutionOptions,
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed"; output: WorkbenchFileOutput }> {
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
  const parsed = parseWriteInput(input);
  if (parsed === undefined) return { status: "failed", output: { reason: "invalid_workdir_write_request" } };
  const contentBytes = Buffer.byteLength(parsed.content, "utf8");
  if (contentBytes > WORKDIR_WRITE_MAX_BYTES) {
    return { status: "failed", output: { reason: "workdir_content_too_large" } };
  }
  const resolved = await resolveToolRoot(options);
  if ("reason" in resolved) return { status: "failed", output: { reason: resolved.reason } };
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };

  const target = resolve(resolved.root, parsed.path);
  const requestedRelative = relative(resolved.root, target);
  if (requestedRelative === "" || !isWithinPath(requestedRelative)) {
    return { status: "failed", output: { reason: "workdir_path_outside_root" } };
  }

  // Create parent directories inside the root, then confirm no symlink escaped it.
  const parent = dirname(target);
  try {
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    if (!isWithinPath(relative(resolved.root, canonicalParent))) {
      return { status: "failed", output: { reason: "workdir_path_outside_root" } };
    }
  } catch {
    return { status: "failed", output: { reason: "workdir_write_failed" } };
  }

  let created: boolean;
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) return { status: "failed", output: { reason: "workdir_path_outside_root" } };
    if (!existing.isFile()) return { status: "failed", output: { reason: "workdir_write_target_not_file" } };
    if (!parsed.overwrite) return { status: "failed", output: { reason: "workdir_file_exists" } };
    created = false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "failed", output: { reason: "workdir_write_failed" } };
    }
    created = true;
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (parsed.overwrite ? constants.O_TRUNC : constants.O_EXCL);
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, flags, 0o644);
    await handle.writeFile(parsed.content, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { status: "failed", output: { reason: "workdir_file_exists" } };
    if (code === "ELOOP") return { status: "failed", output: { reason: "workdir_path_outside_root" } };
    return { status: "failed", output: { reason: "workdir_write_failed" } };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return { status: "succeeded", output: { path: requestedRelative, bytes: contentBytes, created } };
}

export async function editRegisteredWorkdirFile(
  input: unknown,
  options: WorkbenchWorkdirResolutionOptions,
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed"; output: WorkbenchFileOutput }> {
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
  const parsed = parseEditInput(input);
  if (parsed === undefined) return { status: "failed", output: { reason: "invalid_workdir_edit_request" } };
  const resolved = await resolveToolRoot(options);
  if ("reason" in resolved) return { status: "failed", output: { reason: resolved.reason } };
  if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };

  const target = resolve(resolved.root, parsed.path);
  const requestedRelative = relative(resolved.root, target);
  if (requestedRelative === "" || !isWithinPath(requestedRelative)) {
    return { status: "failed", output: { reason: "workdir_path_outside_root" } };
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return { status: "failed", output: { reason: "workdir_file_unavailable" } };
    if (info.size > WORKDIR_WRITE_MAX_BYTES) return { status: "failed", output: { reason: "workdir_file_too_large" } };
    const buffer = await handle.readFile();
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      return { status: "failed", output: { reason: "workdir_file_not_utf8" } };
    }
    const occurrences = content.split(parsed.oldText).length - 1;
    if (occurrences === 0) return { status: "failed", output: { reason: "workdir_edit_text_not_found" } };
    if (occurrences > 1) return { status: "failed", output: { reason: "workdir_edit_text_not_unique" } };
    const next = content.split(parsed.oldText).join(parsed.newText);
    const nextBytes = Buffer.byteLength(next, "utf8");
    if (nextBytes > WORKDIR_WRITE_MAX_BYTES) return { status: "failed", output: { reason: "workdir_content_too_large" } };
    await handle.close();
    handle = undefined;
    let writeHandle: FileHandle | undefined;
    try {
      writeHandle = await open(target, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      await writeHandle.writeFile(next, "utf8");
    } finally {
      await writeHandle?.close().catch(() => undefined);
    }
    return { status: "succeeded", output: { path: requestedRelative, bytes: nextBytes, replacements: 1 } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { status: "failed", output: { reason: "workdir_path_outside_root" } };
    if (code === "ENOENT") return { status: "failed", output: { reason: "workdir_file_unavailable" } };
    return { status: "failed", output: { reason: "workdir_file_unavailable" } };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveToolRoot(
  options: WorkbenchWorkdirResolutionOptions,
): Promise<{ root: string } | { reason: string }> {
  try {
    const root = await resolveWorkbenchWorkdir(options);
    if (root === undefined) return { reason: "workdir_not_bound" };
    return { root };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "workdir_unavailable" };
  }
}

async function resolveToolTarget(
  root: string,
  relativePath: string | undefined,
): Promise<{ canonical: string } | { reason: string }> {
  if (relativePath === undefined) return { canonical: root };
  const target = resolve(root, relativePath);
  const requestedRelative = relative(root, target);
  if (!isWithinPath(requestedRelative)) return { reason: "workdir_path_outside_root" };
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    return { reason: "workdir_path_unavailable" };
  }
  if (!isWithinPath(relative(root, canonical))) return { reason: "workdir_path_outside_root" };
  return { canonical };
}

function isSkippedDirectory(name: string): boolean {
  return WORKDIR_LIST_SKIP_DIRECTORIES.has(name) || name.startsWith(".");
}

async function collectSearchFiles(startDir: string, files: string[], signal: AbortSignal): Promise<void> {
  const queue: string[] = [startDir];
  while (queue.length > 0) {
    if (signal.aborted) return;
    if (files.length >= WORKDIR_SEARCH_MAX_FILES_SCANNED) return;
    const current = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbsolute = join(current, dirent.name);
      let info;
      try {
        info = await lstat(childAbsolute);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!isSkippedDirectory(dirent.name)) queue.push(childAbsolute);
      } else if (info.isFile()) {
        if (files.length >= WORKDIR_SEARCH_MAX_FILES_SCANNED) return;
        files.push(childAbsolute);
      }
    }
  }
}

async function readSearchableText(file: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size > WORKDIR_SEARCH_MAX_FILE_BYTES) return undefined;
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return undefined;
  }
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

function buildMatcher(parsed: { pattern: string; regex: boolean }): ((line: string) => boolean) | undefined {
  if (parsed.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(parsed.pattern);
    } catch {
      return undefined;
    }
    return (line) => expression.test(line);
  }
  return (line) => line.includes(parsed.pattern);
}

function parseListInput(input: unknown): { path?: string; depth: number } | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of Object.keys(input)) {
    if (key !== "path" && key !== "depth") return undefined;
  }
  const path = parseOptionalRelativePath(input.path);
  if (path === null) return undefined;
  let depth = 1;
  if (input.depth !== undefined) {
    const raw = input.depth;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 4) return undefined;
    depth = raw;
  }
  return { ...(path === undefined ? {} : { path }), depth };
}

function parseSearchInput(
  input: unknown,
): { pattern: string; path?: string; maxResults: number; regex: boolean } | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of Object.keys(input)) {
    if (key !== "pattern" && key !== "path" && key !== "max_results" && key !== "regex") return undefined;
  }
  if (typeof input.pattern !== "string" || input.pattern === "") return undefined;
  const path = parseOptionalRelativePath(input.path);
  if (path === null) return undefined;
  let maxResults = WORKDIR_SEARCH_DEFAULT_RESULTS;
  if (input.max_results !== undefined) {
    const raw = input.max_results;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > WORKDIR_SEARCH_MAX_RESULTS) {
      return undefined;
    }
    maxResults = raw;
  }
  if (input.regex !== undefined && typeof input.regex !== "boolean") return undefined;
  return { pattern: input.pattern, ...(path === undefined ? {} : { path }), maxResults, regex: input.regex === true };
}

function parseWriteInput(input: unknown): { path: string; content: string; overwrite: boolean } | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of Object.keys(input)) {
    if (key !== "path" && key !== "content" && key !== "overwrite") return undefined;
  }
  const path = parseRequiredRelativePath(input.path);
  if (path === undefined) return undefined;
  if (typeof input.content !== "string") return undefined;
  if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") return undefined;
  return { path, content: input.content, overwrite: input.overwrite === true };
}

function parseEditInput(input: unknown): { path: string; oldText: string; newText: string } | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of Object.keys(input)) {
    if (key !== "path" && key !== "old_text" && key !== "new_text") return undefined;
  }
  const path = parseRequiredRelativePath(input.path);
  if (path === undefined) return undefined;
  if (typeof input.old_text !== "string" || input.old_text === "") return undefined;
  if (typeof input.new_text !== "string") return undefined;
  return { path, oldText: input.old_text, newText: input.new_text };
}

function parseRequiredRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\")) return undefined;
  return value;
}

// Returns undefined when absent, the path when valid, or null when present but invalid.
function parseOptionalRelativePath(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const parsed = parseRequiredRelativePath(value);
  return parsed === undefined ? null : parsed;
}

function parseReadInput(input: unknown): { path: string; offset: number; limit: number } | undefined {
  if (!isRecord(input) || typeof input.path !== "string" || input.path.trim() === "") return undefined;
  if (Object.keys(input).some((key) => key !== "path" && key !== "offset" && key !== "limit")) return undefined;
  if (isAbsolute(input.path) || /^[A-Za-z]:[\\/]/.test(input.path) || input.path.startsWith("\\")) return undefined;
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit === undefined ? WORKDIR_READ_MAX_CHARS : input.limit;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > WORKDIR_READ_MAX_CHARS) {
    return undefined;
  }
  return { path: input.path, offset, limit };
}

function decodeUtf8Prefix(bytes: Uint8Array, allowIncompleteTrailing: boolean): { text: string; bytes: number } {
  let usable = bytes.byteLength;
  if (allowIncompleteTrailing) {
    const start = incompleteTrailingSequenceStart(bytes);
    if (start !== undefined) usable = start;
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, usable));
  return { text, bytes: usable };
}

function incompleteTrailingSequenceStart(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength === 0) return undefined;
  let start = bytes.byteLength - 1;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  if (start < 0) return undefined;
  const first = bytes[start];
  const expected = first <= 0x7f
    ? 1
    : first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 0;
  return expected > 0 && bytes.byteLength - start < expected ? start : undefined;
}

async function admitCanonicalRoot(input: string, protectedPaths: readonly string[] = []): Promise<string> {
  const canonical = await realpath(resolve(input));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("workdir_unavailable");
  for (const protectedPath of protectedPaths) {
    if (!protectedPath.trim()) continue;
    const protectedCanonical = await realpath(resolve(protectedPath)).catch(() => resolve(protectedPath));
    if (containsPath(canonical, protectedCanonical) || containsPath(protectedCanonical, canonical)) {
      throw new Error("workdir_protected_path");
    }
  }
  return canonical;
}

function containsPath(parent: string, child: string): boolean {
  return isWithinPath(relative(parent, child));
}

function isWithinPath(relativePath: string): boolean {
  return relativePath === ""
    || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
