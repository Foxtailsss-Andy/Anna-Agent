import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { launchManagedWorker } from "../src/managed-launcher";

test("actual managed Bun denies protected reads while allowing its own temporary writes", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "anna-launcher-public-")));
  const runtime = join(parent, "runtime");
  const workspace = join(parent, "workspace");
  let handle: Awaited<ReturnType<typeof launchManagedWorker>> | undefined;
  let connections = 0;
  const server = createServer(socket => { connections += 1; socket.on("error", () => {}); socket.end(); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener unavailable");
  try {
    await mkdir(runtime);
    await mkdir(workspace);
    const protectedFile = join(workspace, "sentinel.txt");
    await writeFile(protectedFile, "host-owned");
    await copyFile(resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64/bun"), join(runtime, "bun"));
    const entry = join(runtime, "probe.ts");
    await writeFile(entry, `
      import { readFile, writeFile, symlink } from "node:fs/promises";
      import { connect } from "node:net";
      let denied = false;
      try { await readFile(${JSON.stringify(protectedFile)}, "utf8"); }
      catch { denied = true; }
      await writeFile(process.env.ANNA_OMP_ATTEMPT_ROOT + "/owned.txt", "owned");
      const alias = process.env.ANNA_OMP_ATTEMPT_ROOT + "/alias";
      await symlink(${JSON.stringify(protectedFile)}, alias);
      let aliasDenied = false;
      try { await readFile(alias); } catch { aliasDenied = true; }
      let runtimeWriteDenied = false;
      try { await writeFile(${JSON.stringify(join(runtime, "escape.txt"))}, "bad"); }
      catch { runtimeWriteDenied = true; }
      const spawnDenied = [];
      for (const argv of [["/bin/sh", "-c", "exit 0"], [process.execPath, "--version"]]) {
        try { const result = Bun.spawnSync(argv); spawnDenied.push(result.exitCode !== 0); }
        catch { spawnDenied.push(true); }
      }
      await new Promise(resolve => {
        const socket = connect(${address.port}, "127.0.0.1");
        socket.on("connect", () => { socket.destroy(); resolve(); });
        socket.on("error", () => resolve());
        socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
      });
      console.log(JSON.stringify({denied, owned: true, aliasDenied, runtimeWriteDenied, spawnDenied}));
    `);
    handle = await launchManagedWorker({ runtimeRoot: runtime, entryPath: entry, workspaceRoot: workspace });
    const child = handle.child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Bun probe timed out")); }, 5_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolveExit(code); });
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ denied: true, owned: true, aliasDenied: true, runtimeWriteDenied: true, spawnDenied: [true, true] });
    expect(connections).toBe(0);
    await promisify(execFile)(join(runtime, "bun"), ["-e", `
      const {connect} = require("node:net");
      const socket = connect(${address.port}, "127.0.0.1");
      socket.on("connect", () => socket.end());
      socket.on("error", () => process.exitCode = 1);
    `], { env: { PATH: "/usr/bin:/bin", HOME: handle.attemptRoot }, timeout: 3_000 });
    expect(connections).toBe(1);
    expect(await readFile(protectedFile, "utf8")).toBe("host-owned");
  } finally {
    await handle?.close();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(parent, { recursive: true, force: true });
  }
}, 15_000);

test("closing an active worker waits for pipe closure before removing only its attempt", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "anna-launcher-close-")));
  const runtime = join(parent, "runtime");
  let handle: Awaited<ReturnType<typeof launchManagedWorker>> | undefined;
  try {
    await mkdir(runtime);
    await writeFile(join(parent, "sentinel"), "keep");
    await copyFile(resolve(import.meta.dirname, "../../../build/omp-runtime/darwin-arm64/bun"), join(runtime, "bun"));
    const entry = join(runtime, "waiting.ts");
    await writeFile(entry, 'console.log("ready"); setInterval(() => {}, 1000);');
    handle = await launchManagedWorker({ runtimeRoot: runtime, entryPath: entry, attemptParent: parent });
    const child = handle.child;
    let closed = false;
    child.once("close", () => { closed = true; });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("worker readiness timed out")), 5_000);
      child.stdout.once("data", () => { clearTimeout(timer); done(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    const attempt = handle.attemptRoot;
    await handle.close();
    expect(closed).toBe(true);
    await expect(readFile(join(attempt, "anything"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(parent, "sentinel"), "utf8")).toBe("keep");
    await handle.close();
  } finally {
    await handle?.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 15_000);
