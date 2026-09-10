import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { JsonValue } from "@anna/harness-v2";

export const WORKDIR_RESOURCE_PREFIX = "workdir:";
export const WORKDIR_READ_MAX_CHARS = 16_384;
export const WORKDIR_READ_MAX_BYTES = 65_536;
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
