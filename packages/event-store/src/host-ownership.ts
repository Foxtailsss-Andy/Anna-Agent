import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class HarnessHostAlreadyOwnedError extends Error {
  readonly code = "HARNESS_HOST_ALREADY_OWNED";

  constructor() {
    super("The canonical EventStore already has an active Harness Host");
    this.name = "HarnessHostAlreadyOwnedError";
  }
}

export async function acquireHarnessHostOwnership(eventStorePath: string): Promise<{
  eventStorePath: string;
  close(): void;
}> {
  const requested = resolve(eventStorePath);
  await mkdir(dirname(requested), { recursive: true });
  let info;
  try {
    info = await lstat(requested);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const canonical = info === undefined
    ? join(await realpath(dirname(requested)), basename(requested))
    : await realpath(requested);
  if (info !== undefined) {
    const target = info.isSymbolicLink() ? await lstat(canonical) : info;
    if (!target.isFile() || target.nlink !== 1) throw new Error("EventStore must be a file without hard links");
  }
  const lockPath = `${canonical}.omp-owner.sqlite`;
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Host ownership file must not be aliased");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const connection = new DatabaseSync(lockPath);
  try {
    connection.exec("PRAGMA busy_timeout = 0");
    connection.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    connection.close();
    if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) {
      throw new HarnessHostAlreadyOwnedError();
    }
    throw error;
  }
  let closed = false;
  return {
    eventStorePath: canonical,
    close() {
      if (closed) return;
      closed = true;
      try { connection.exec("ROLLBACK"); }
      finally { connection.close(); }
    },
  };
}
