import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { launchManagedWorker } from "../src/managed-launcher";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const runtimeRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
const bunPath = join(runtimeRoot, "bun");

test("fails closed when the managed runtime is unavailable without a fallback", async () => {
  await expect(launchManagedWorker({
    runtimeRoot: "/private/var/empty/anna-omp-runtime",
    entryPath: "/private/var/empty/anna-omp-runtime/worker.ts",
  })).rejects.toMatchObject({
    code: "OMP_RUNTIME_INVALID",
  });
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !existsSync(bunPath))(
  "runs the verified Bun through sandbox-exec with protected I/O and process boundaries",
  async () => {
    const container = await mkdtemp(join(tmpdir(), "anna-omp-launcher-test-"));
    const probeRuntimeRoot = join(container, "runtime");
    const attemptParent = join(container, "attempt-parent");
    const workspaceRoot = join(container, "workspace");
    const protectedPath = join(workspaceRoot, "protected.txt");
    const protectedLink = join(probeRuntimeRoot, "protected-link.txt");
    const workspaceWritePath = join(workspaceRoot, "must-not-write.txt");
    const runtimeWritePath = join(probeRuntimeRoot, `.managed-launcher-${container.slice(-6)}.tmp`);
    const probePath = join(probeRuntimeRoot, "probe.ts");
    const parentSentinel = join(attemptParent, "sentinel.txt");
    await mkdir(probeRuntimeRoot, { recursive: true });
    await mkdir(attemptParent, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await cp(bunPath, join(probeRuntimeRoot, "bun"));
    await writeFile(protectedPath, "protected-fixture\n", "utf8");
    await writeFile(parentSentinel, "keep-parent\n", "utf8");
    await symlink(protectedPath, protectedLink);
    await writeFile(probePath, probeSource, "utf8");

    let worker: Awaited<ReturnType<typeof launchManagedWorker>> | undefined;
    try {
      worker = await launchManagedWorker({
        runtimeRoot: probeRuntimeRoot,
        entryPath: probePath,
        bunPath: join(probeRuntimeRoot, "bun"),
        attemptParent,
        workspaceRoot,
        args: [protectedPath, protectedLink, workspaceWritePath, runtimeWritePath],
      });
      expect(worker.argv[0]).toBe("-p");
      expect(worker.child.stdin).not.toBeNull();
      expect(worker.child.stdout).not.toBeNull();
      expect(worker.child.stderr).not.toBeNull();
      expect((await stat(worker.attemptRoot)).mode & 0o777).toBe(0o700);

      const attemptRoot = worker.attemptRoot;
      const output = await collectWorkerOutput(worker.child, 10_000);
      expect(output.code).toBe(0);
      const result = JSON.parse(output.stdout) as ProbeResult;
      expect(result.protectedRead.ok).toBe(false);
      expect(result.symlinkRead.ok).toBe(false);
      expect(result.workspaceWrite.ok).toBe(false);
      expect(result.runtimeWrite.ok).toBe(false);
      expect(result.attemptWrite.ok).toBe(true);
      expect(result.childProcess.ok).toBe(false);
      expect(result.serverConnections).toBe(0);
      expect(result.fetch.ok).toBe(false);
      expect(result.envKeys).toEqual([
        "ANNA_OMP_ATTEMPT_ROOT",
        "CI",
        "HOME",
        "PATH",
        "TMPDIR",
        "USERPROFILE",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
      ]);
      await worker.close();
      worker = undefined;
      await expect(stat(join(attemptRoot, "allowed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(parentSentinel, "utf8")).resolves.toBe("keep-parent\n");
      await expect(readlink(protectedLink)).resolves.toBe(protectedPath);
      await expect(stat(workspaceWritePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(runtimeWritePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await worker?.close().catch(() => undefined);
      await rm(runtimeWritePath, { force: true });
      await rm(container, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !existsSync(bunPath))(
  "runs the pinned OMP SDK/native canary through the managed launcher",
  async () => {
    const container = await mkdtemp(join(tmpdir(), "anna-omp-sdk-canary-"));
    const attemptParent = join(container, "attempt-parent");
    const entryPath = join(runtimeRoot, "canary.ts");
    let worker: Awaited<ReturnType<typeof launchManagedWorker>> | undefined;
    try {
      await mkdir(attemptParent);
      worker = await launchManagedWorker({
        runtimeRoot,
        entryPath,
        attemptParent,
        workspaceRoot: repositoryRoot,
      });
      const output = await collectWorkerOutput(worker.child, 20_000);
      expect(output.code).toBe(0);
      expect(output.stderr).toBe("");
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: "ok",
        bun: "1.3.14",
        omp: "18.0.11",
        modelCalls: 0,
        fetchCalls: 0,
        activeTools: [],
        sessionFile: null,
        disposed: true,
      });
    } finally {
      await worker?.close().catch(() => undefined);
      await rm(container, { recursive: true, force: true });
    }
  },
  120_000,
);

interface ProbeResult {
  readonly protectedRead: ProbeOperation;
  readonly symlinkRead: ProbeOperation;
  readonly workspaceWrite: ProbeOperation;
  readonly runtimeWrite: ProbeOperation;
  readonly attemptWrite: ProbeOperation;
  readonly childProcess: ProbeOperation;
  readonly serverConnections: number;
  readonly fetch: ProbeOperation;
  readonly envKeys: string[];
}

interface ProbeOperation {
  readonly ok: boolean;
  readonly code?: string;
}

async function collectWorkerOutput(
  child: ReturnType<typeof launchManagedWorker> extends Promise<infer T>
    ? T extends { child: infer C } ? C : never
    : never,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  return new Promise((resolvePromise, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      callback();
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolvePromise({ code, stdout, stderr })));
    timer = setTimeout(() => finish(() => reject(new Error(`managed probe timed out\n${stderr}`))), timeoutMs);
  });
}

const probeSource = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const [protectedPath, protectedLink, workspaceWritePath, runtimeWritePath] = process.argv.slice(2);
const operation = (run) => {
  try {
    run();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? error?.name ?? "error" };
  }
};
const result = {
  protectedRead: operation(() => readFileSync(protectedPath, "utf8")),
  symlinkRead: operation(() => readFileSync(protectedLink, "utf8")),
  workspaceWrite: operation(() => writeFileSync(workspaceWritePath, "blocked")),
  runtimeWrite: operation(() => writeFileSync(runtimeWritePath, "blocked")),
  attemptWrite: operation(() => writeFileSync(process.env.ANNA_OMP_ATTEMPT_ROOT + "/allowed.txt", "allowed")),
  childProcess: operation(() => {
    const child = spawnSync("/bin/sh", ["-c", "printf child"], { encoding: "utf8" });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error("child exited " + child.status);
  }),
  serverConnections: 0,
  fetch: { ok: false },
  envKeys: Object.keys(process.env).sort(),
};
const finish = () => process.stdout.write(JSON.stringify(result) + "\n");
const server = createServer(() => {
  result.serverConnections += 1;
});
server.once("error", () => finish());
try {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") return finish();
    fetch("http://127.0.0.1:" + address.port)
      .then(() => { result.fetch = { ok: true }; })
      .catch((error) => { result.fetch = { ok: false, code: error?.code ?? error?.name ?? "error" }; })
      .finally(() => server.close(() => finish()));
  });
} catch (error) {
  result.fetch = { ok: false, code: error?.code ?? error?.name ?? "error" };
  finish();
}
`;
