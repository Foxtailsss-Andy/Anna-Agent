import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdirContained } from "./workdir-io";

// Shared path-containment rules for the Host-side workdir tools and the Sandbox.
// Every tool resolves a caller path against a canonical (realpath) workdir root.

/** True when `relativePath` (as returned by `path.relative(root, x)`) stays inside the root. */
export function isWithinPath(relativePath: string): boolean {
  return relativePath === ""
    || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

export function containsPath(parent: string, child: string): boolean {
  return isWithinPath(relative(parent, child));
}

/** A caller-supplied relative path: non-empty, not absolute, no drive letter or leading backslash. */
export function parseRelativePathInput(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\")) return undefined;
  return value;
}

export interface ContainedTarget {
  /** Canonical directory that holds the target; verified to be inside the root. */
  readonly parent: string;
  /** Final path component (never resolved; callers open it with O_NOFOLLOW_ANY). */
  readonly name: string;
  /** Path of the target relative to the root, built from the canonical parent. */
  readonly relativePath: string;
}

/**
 * Resolves `requested` under the canonical `root` one directory segment at a time.
 * Each existing segment is canonicalised and must stay inside the root before the next
 * segment is looked at, so an intermediate symlinked directory cannot lead outside.
 * With `createParents`, a missing segment is created (non-recursively) only beneath a
 * directory that has already been verified, so nothing is created outside the root.
 * Directory creation uses a pinned-cwd helper with OS write confinement; file opens
 * must additionally use O_NOFOLLOW_ANY because canonical path strings can be replaced.
 */
export async function locateContainedTarget(
  root: string,
  requested: string,
  options: { createParents: boolean; signal?: AbortSignal },
): Promise<ContainedTarget | { reason: string }> {
  const requestedRelative = relative(root, resolve(root, requested));
  if (requestedRelative === "" || !isWithinPath(requestedRelative)) return { reason: "workdir_path_outside_root" };
  const segments = requestedRelative.split(sep);
  const name = segments.pop();
  if (name === undefined || name === "" || name === "." || name === "..") return { reason: "workdir_path_outside_root" };
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { reason: "workdir_path_unavailable" };
      if (!options.createParents) return { reason: "workdir_file_unavailable" };
      try {
        await mkdirContained(root, current, segment, options.signal);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") return { reason: "workdir_write_failed" };
      }
      try {
        info = await lstat(next);
      } catch {
        return { reason: "workdir_write_failed" };
      }
    }
    if (info.isSymbolicLink()) {
      let canonical: string;
      try {
        canonical = await realpath(next);
      } catch {
        return { reason: "workdir_path_unavailable" };
      }
      if (!containsPath(root, canonical)) return { reason: "workdir_path_outside_root" };
      try {
        if (!(await stat(canonical)).isDirectory()) return { reason: "workdir_path_not_directory" };
      } catch {
        return { reason: "workdir_path_unavailable" };
      }
      current = canonical;
    } else if (info.isDirectory()) {
      try {
        current = await realpath(next);
      } catch {
        return { reason: "workdir_path_unavailable" };
      }
      if (!containsPath(root, current)) return { reason: "workdir_path_outside_root" };
    } else {
      return { reason: "workdir_path_not_directory" };
    }
  }
  return { parent: current, name, relativePath: relative(root, join(current, name)) };
}

/**
 * Confirms, after `open`, that the opened inode is still the one at the verified location:
 * the parent still canonicalises inside the root and the path names the same file.
 */
export async function openedTargetStillContained(
  root: string,
  target: ContainedTarget,
  opened: { dev: number; ino: number },
): Promise<boolean> {
  try {
    const parent = await realpath(target.parent);
    if (!containsPath(root, parent)) return false;
    const current = await lstat(join(target.parent, target.name));
    return current.isFile() && current.dev === opened.dev && current.ino === opened.ino;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
