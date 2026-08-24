import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SandboxAdapter, ToolRequest, ToolResult } from "./interfaces";
import {
  SchemaValidationError,
  expectNonEmptyString,
  expectRecord,
  type Schema,
} from "./schema";
import type { ToolDefinition } from "./tool-gateway";

const pathOutsideApprovedWorktree: ToolResult = {
  status: "failed",
  output: { reason: "path_outside_approved_worktree" },
};

const toolNotImplemented: ToolResult = {
  status: "failed",
  output: { reason: "tool_not_implemented" },
};

const invalidToolInput: ToolResult = {
  status: "failed",
  output: { reason: "invalid_tool_input" },
};

const readWorkspaceFailed: ToolResult = {
  status: "failed",
  output: { reason: "read_workspace_failed" },
};

const boundedPatchFailed: ToolResult = {
  status: "failed",
  output: { reason: "bounded_patch_failed" },
};

const patchPreconditionFailed: ToolResult = {
  status: "failed",
  output: { reason: "patch_precondition_failed" },
};

const cancelled: ToolResult = {
  status: "failed",
  output: { reason: "cancelled" },
};

const defaultMaxReadBytes = 64 * 1024;
const defaultMaxPatchBytes = 64 * 1024;
const openReadOnlyWithoutFollowing =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

interface BoundedPatchInput {
  path: string;
  expected: string;
  replacement: string;
}

function expectExactInputRecord(
  input: unknown,
  name: string,
  fields: readonly string[],
): Record<string, unknown> {
  const record = expectRecord(input, name);
  if (
    Reflect.ownKeys(record).length !== fields.length ||
    fields.some(
      (field) => !Object.prototype.hasOwnProperty.call(record, field),
    )
  ) {
    throw new SchemaValidationError(
      `${name} must define only ${fields.join(", ")}`,
    );
  }

  return record;
}

const readWorkspaceInputSchema: Schema<unknown> = Object.freeze({
  parse(input: unknown) {
    const record = expectExactInputRecord(input, "read_workspace input", [
      "path",
    ]);
    return {
      path: expectNonEmptyString(record.path, "read_workspace input.path"),
    };
  },
});

const boundedPatchInputSchema: Schema<unknown> = Object.freeze({
  parse(input: unknown) {
    const record = expectExactInputRecord(input, "bounded_patch input", [
      "path",
      "expected",
      "replacement",
    ]);
    if (typeof record.replacement !== "string") {
      throw new SchemaValidationError(
        "bounded_patch input.replacement must be a string",
      );
    }

    return {
      path: expectNonEmptyString(record.path, "bounded_patch input.path"),
      expected: expectNonEmptyString(
        record.expected,
        "bounded_patch input.expected",
      ),
      replacement: record.replacement,
    };
  },
});

export function createLocalPreviewWorktreeToolCatalog(): readonly ToolDefinition[] {
  return Object.freeze([
    Object.freeze({
      name: "read_workspace",
      replayPolicy: "safe" as const,
      inputSchema: readWorkspaceInputSchema,
    }),
    Object.freeze({
      name: "bounded_patch",
      replayPolicy: "never" as const,
      inputSchema: boundedPatchInputSchema,
    }),
  ]);
}

function pathIsWithin(approvedWorktreeRoot: string, candidatePath: string): boolean {
  const pathFromRoot = relative(approvedWorktreeRoot, candidatePath);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

function relativePathFrom(input: ToolRequest["input"]): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const path = input.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function boundedPatchInputFrom(
  input: ToolRequest["input"],
): BoundedPatchInput | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const { path, expected, replacement } = input;
  return typeof path === "string" &&
    path.length > 0 &&
    typeof expected === "string" &&
    expected.length > 0 &&
    typeof replacement === "string"
    ? { path, expected, replacement }
    : undefined;
}

function nearestExistingRealpath(candidatePath: string): string | undefined {
  let pathToCheck = candidatePath;

  while (true) {
    try {
      return realpathSync(pathToCheck);
    } catch {
      const parentPath = dirname(pathToCheck);
      if (parentPath === pathToCheck) {
        return undefined;
      }

      pathToCheck = parentPath;
    }
  }
}

function hasSameFileIdentity(
  first: { dev: number; ino: number; size: number },
  second: { dev: number; ino: number; size: number },
): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size
  );
}

async function openApprovedRegularFile(
  candidatePath: string,
  approvedWorktreeRoot: string,
) {
  let fileHandle;
  try {
    fileHandle = await open(candidatePath, openReadOnlyWithoutFollowing);
    const [resolvedPath, linkStats, fileStats] = await Promise.all([
      realpath(candidatePath),
      lstat(candidatePath),
      fileHandle.stat(),
    ]);
    if (
      !pathIsWithin(approvedWorktreeRoot, resolvedPath) ||
      !linkStats.isFile() ||
      linkStats.isSymbolicLink() ||
      !fileStats.isFile() ||
      !hasSameFileIdentity(linkStats, fileStats)
    ) {
      throw new Error("opened file no longer matches its approved path");
    }

    return { fileHandle, fileStats };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    throw error;
  }
}

async function readWholeFile(fileHandle: Awaited<ReturnType<typeof open>>, size: number) {
  const bytes = Buffer.alloc(size);
  const { bytesRead } =
    size === 0
      ? { bytesRead: 0 }
      : await fileHandle.read(bytes, 0, size, 0);
  if (bytesRead !== size) {
    throw new Error("file changed while it was being read");
  }

  return bytes;
}

// This local-preview allowlist seam is not production containment: Node path and
// descriptor checks reduce local races but cannot replace a production Sandbox.
export function createLocalPreviewWorktreeSandbox(options: {
  approvedWorktreeRoot: string;
  maxReadBytes?: number;
  maxPatchBytes?: number;
}): SandboxAdapter {
  const maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
    throw new TypeError("maxReadBytes must be a positive safe integer");
  }

  const maxPatchBytes = options.maxPatchBytes ?? defaultMaxPatchBytes;
  if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes <= 0) {
    throw new TypeError("maxPatchBytes must be a positive safe integer");
  }

  const approvedWorktreeRoot = realpathSync(options.approvedWorktreeRoot);

  return {
    async execute(request, signal): Promise<ToolResult> {
      if (
        request.name !== "read_workspace" &&
        request.name !== "bounded_patch"
      ) {
        return toolNotImplemented;
      }

      const requestedPath = relativePathFrom(request.input);
      if (requestedPath === undefined) {
        return invalidToolInput;
      }

      if (isAbsolute(requestedPath)) {
        return pathOutsideApprovedWorktree;
      }

      const candidatePath = resolve(approvedWorktreeRoot, requestedPath);
      if (!pathIsWithin(approvedWorktreeRoot, candidatePath)) {
        return pathOutsideApprovedWorktree;
      }

      const existingPath = nearestExistingRealpath(candidatePath);
      if (
        existingPath !== undefined &&
        !pathIsWithin(approvedWorktreeRoot, existingPath)
      ) {
        return pathOutsideApprovedWorktree;
      }

      if (request.name === "bounded_patch") {
        const patchInput = boundedPatchInputFrom(request.input);
        if (
          patchInput === undefined ||
          typeof request.effectKey !== "string" ||
          request.effectKey.length === 0
        ) {
          return invalidToolInput;
        }

        if (
          Buffer.byteLength(patchInput.expected, "utf8") > maxPatchBytes ||
          Buffer.byteLength(patchInput.replacement, "utf8") > maxPatchBytes
        ) {
          return boundedPatchFailed;
        }

        if (signal.aborted) {
          return cancelled;
        }

        let sourceFile;
        let temporaryPath: string | undefined;
        let temporaryFile;
        try {
          const openedSource = await openApprovedRegularFile(
            candidatePath,
            approvedWorktreeRoot,
          );
          sourceFile = openedSource.fileHandle;
          const sourceStats = openedSource.fileStats;
          if (!sourceStats.isFile() || sourceStats.size > maxPatchBytes) {
            return boundedPatchFailed;
          }

          const parentRealpath = await realpath(dirname(candidatePath));
          if (!pathIsWithin(approvedWorktreeRoot, parentRealpath)) {
            return boundedPatchFailed;
          }

          if (signal.aborted) {
            return cancelled;
          }

          const beforeBytes = await readWholeFile(sourceFile, sourceStats.size);

          let before: string;
          try {
            before = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(beforeBytes);
          } catch {
            return patchPreconditionFailed;
          }

          const firstMatch = before.indexOf(patchInput.expected);
          if (
            firstMatch === -1 ||
            before.indexOf(patchInput.expected, firstMatch + 1) !== -1
          ) {
            return patchPreconditionFailed;
          }

          const after =
            before.slice(0, firstMatch) +
            patchInput.replacement +
            before.slice(firstMatch + patchInput.expected.length);
          const afterBytes = Buffer.from(after, "utf8");
          if (afterBytes.length > maxPatchBytes) {
            return boundedPatchFailed;
          }

          const beforeHash = `sha256:${createHash("sha256")
            .update(beforeBytes)
            .digest("hex")}`;
          const afterHash = `sha256:${createHash("sha256")
            .update(afterBytes)
            .digest("hex")}`;

          await sourceFile.close();
          sourceFile = undefined;

          if (signal.aborted) {
            return cancelled;
          }

          temporaryPath = join(
            dirname(candidatePath),
            `.bounded-patch-${randomUUID()}.tmp`,
          );
          temporaryFile = await open(temporaryPath, "wx", sourceStats.mode);
          await temporaryFile.chmod(sourceStats.mode).catch(() => undefined);

          if (signal.aborted) {
            return cancelled;
          }

          await temporaryFile.writeFile(afterBytes);
          await temporaryFile.sync();
          await temporaryFile.close();
          temporaryFile = undefined;

          if (signal.aborted) {
            return cancelled;
          }

          try {
            const currentParentRealpath = await realpath(dirname(candidatePath));
            if (
              currentParentRealpath !== parentRealpath ||
              !pathIsWithin(approvedWorktreeRoot, currentParentRealpath)
            ) {
              return patchPreconditionFailed;
            }

            const currentLinkStats = await lstat(candidatePath);
            if (
              !currentLinkStats.isFile() ||
              currentLinkStats.isSymbolicLink()
            ) {
              return patchPreconditionFailed;
            }

            const currentTarget = await openApprovedRegularFile(
              candidatePath,
              approvedWorktreeRoot,
            );
            try {
              if (
                !hasSameFileIdentity(sourceStats, currentTarget.fileStats) ||
                createHash("sha256")
                  .update(
                    await readWholeFile(
                      currentTarget.fileHandle,
                      currentTarget.fileStats.size,
                    ),
                  )
                  .digest("hex") !== beforeHash.slice("sha256:".length)
              ) {
                return patchPreconditionFailed;
              }
            } finally {
              await currentTarget.fileHandle.close().catch(() => undefined);
            }
          } catch {
            return patchPreconditionFailed;
          }

          if (signal.aborted) {
            return cancelled;
          }

          await rename(temporaryPath, candidatePath);
          temporaryPath = undefined;

          return {
            status: "succeeded",
            output: {
              path: requestedPath,
              changedFiles: [requestedPath],
              beforeHash,
              afterHash,
            },
          };
        } catch {
          return signal.aborted ? cancelled : boundedPatchFailed;
        } finally {
          await sourceFile?.close().catch(() => undefined);
          await temporaryFile?.close().catch(() => undefined);
          if (temporaryPath !== undefined) {
            await unlink(temporaryPath).catch(() => undefined);
          }
        }
      }

      if (signal.aborted) {
        return cancelled;
      }

      let fileHandle;
      try {
        const openedFile = await openApprovedRegularFile(
          candidatePath,
          approvedWorktreeRoot,
        );
        fileHandle = openedFile.fileHandle;
        if (signal.aborted) {
          return cancelled;
        }

        const fileStats = openedFile.fileStats;

        if (signal.aborted) {
          return cancelled;
        }

        const bytesToRead = Math.min(maxReadBytes, fileStats.size);
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } =
          bytesToRead === 0
            ? { bytesRead: 0 }
            : await fileHandle.read(buffer, 0, bytesToRead, 0);

        if (signal.aborted) {
          return cancelled;
        }

        return {
          status: "succeeded",
          output: {
            path: requestedPath,
            content: buffer.subarray(0, bytesRead).toString("utf8"),
            truncated: fileStats.size > bytesRead,
          },
        };
      } catch {
        return signal.aborted ? cancelled : readWorkspaceFailed;
      } finally {
        await fileHandle?.close().catch(() => undefined);
      }
    },
  };
}
