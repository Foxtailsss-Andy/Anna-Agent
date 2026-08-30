import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { link, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { acquireHarnessHostOwnership } from "@anna/event-store";

const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../../../packages/event-store/src/host-ownership.ts")).href;

test.each(["close", "killed"] as const)("SQLite ownership survives alias contention and releases after owner %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "anna-owner-process-"));
  const path = join(root, "events.sqlite");
  const alias = join(root, "alias.sqlite");
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<number | null> | undefined;
  try {
    await writeFile(path, "");
    await symlink(path, alias);
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import {acquireHarnessHostOwnership} from ${JSON.stringify(moduleUrl)};
      const owner = await acquireHarnessHostOwnership(process.argv[1]);
      process.stdout.write("owned\\n");
      process.stdin.once("data", () => { owner.close(); process.stdin.destroy(); });
    `, path], { stdio: "pipe" });
    exited = new Promise((resolveExit, reject) => { child!.once("close", resolveExit); child!.once("error", reject); });
    await ready(child);
    const lockPath = `${path}.omp-owner.sqlite`;
    const before = await lstat(lockPath);
    await expect(acquireHarnessHostOwnership(alias)).rejects.toMatchObject({ code: "HARNESS_HOST_ALREADY_OWNED" });
    if (mode === "killed") child.kill("SIGKILL");
    else child.stdin.end("close\n");
    const exitCode = await exited;
    if (mode === "close") expect(exitCode).toBe(0);
    child = undefined;
    const next = await acquireHarnessHostOwnership(alias);
    try { expect((await lstat(lockPath)).ino).toBe(before.ino); }
    finally { next.close(); next.close(); }
  } finally {
    if (child !== undefined) { child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("ownership rejects hard-linked stores and dangling aliases without creating alternate locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-owner-alias-"));
  const path = join(root, "events.sqlite");
  try {
    await writeFile(path, "");
    await link(path, join(root, "hard.sqlite"));
    await expect(acquireHarnessHostOwnership(path)).rejects.toThrow("hard links");
    const dangling = join(root, "dangling.sqlite");
    await symlink(join(root, "absent.sqlite"), dangling);
    await expect(acquireHarnessHostOwnership(dangling)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${dangling}.omp-owner.sqlite`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function ready(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = "";
  let diagnostics = "";
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Owner startup timed out: ${diagnostics}`)), 5_000);
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("owned\n")) { clearTimeout(timeout); resolveReady(); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", () => { clearTimeout(timeout); if (!output.includes("owned\n")) reject(new Error(`Owner exited: ${diagnostics}`)); });
  });
}
