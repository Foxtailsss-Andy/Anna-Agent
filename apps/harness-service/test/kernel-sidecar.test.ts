import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { expect, test } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const serviceRoot = resolve(repositoryRoot, "apps/harness-service");
const ompRuntimeSource = resolve(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("built service reads the sidecar without source fallback", async () => {
  await execFile("npm", ["run", "build", "--workspace=@anna/harness-service"], {
    cwd: repositoryRoot,
    env: { ...process.env, NODE_ENV: "test" },
    timeout: 30_000,
  });

  const directory = await mkdtemp(join(tmpdir(), "anna-kernel-sidecar-"));
  const packagedService = join(directory, "apps/harness-service");
  const packagedDist = join(packagedService, "dist");
  const packagedOmpRuntime = join(directory, "build/omp-runtime/darwin-arm64");
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const workspaceRoot = join(directory, "workspace");
  try {
    await mkdir(packagedService, { recursive: true });
    await cp(join(serviceRoot, "dist"), packagedDist, { recursive: true });
    await cp(join(serviceRoot, "package.json"), join(packagedService, "package.json"));
    await cp(join(repositoryRoot, "skills"), join(directory, "skills"), { recursive: true });
    await cp(ompRuntimeSource, packagedOmpRuntime, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-key",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "omp",
    }), "utf8");

    const environment = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      ANNA_RUNTIME_CONFIG_PATH: configPath,
      ANNA_HARNESS_HOST_EVENT_STORE_PATH: eventStorePath,
      ANNA_HARNESS_HOST_WORKSPACE_ROOT: workspaceRoot,
      ANNA_HARNESS_OMP_RUNTIME_ROOT: packagedOmpRuntime,
    };
    const ready = await runService(
      join(packagedDist, "main.js"),
      directory,
      environment,
      async (url) => {
        const health = await fetch(`${url}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({
          status: "ok",
          protocol: "anna-harness-product/1",
          host: "node",
        });
        const unauthorized = await fetch(`${url}/_harness/capabilities`);
        expect(unauthorized.status).toBe(401);
      },
    );
    expect(ready).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('"status":"ready"'),
    });

    const sidecarPath = join(packagedDist, "pi-kernel-descriptor.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
      adapterSource: { packageName: string; sha256: string };
      upstream: { ai: { integrity: string } };
    };
    await writeFile(sidecarPath, JSON.stringify({
      ...sidecar,
      upstream: {
        ...sidecar.upstream,
        ai: { ...sidecar.upstream.ai, integrity: `sha512-${"A".repeat(86)}==` },
      },
    }), "utf8");
    const corruptIntegrity = await runService(
      join(packagedDist, "main.js"),
      directory,
      environment,
    );
    expect(corruptIntegrity.code).not.toBe(0);

    await writeFile(sidecarPath, JSON.stringify({
      ...sidecar,
      adapterSource: { ...sidecar.adapterSource, sha256: "0".repeat(64) },
    }), "utf8");
    const corruptSourceIdentity = await runService(
      join(packagedDist, "main.js"),
      directory,
      environment,
    );
    expect(corruptSourceIdentity.code).not.toBe(0);

    await rm(sidecarPath);
    const missingSidecar = await runService(
      join(packagedDist, "main.js"),
      directory,
      environment,
    );
    expect(missingSidecar.code).not.toBe(0);
    expect(missingSidecar.stdout).not.toContain('"status":"ready"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

async function runService(
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onReady?: (url: string) => Promise<void>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [entry], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolvePromise, reject) => {
    let ready = false;
    let hookStarted = false;
    let hookError: unknown;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", () => {
      if (!ready && !hookStarted && stdout.includes('"status":"ready"')) {
        ready = true;
        hookStarted = true;
        void (async () => {
          try {
            const line = stdout.split("\n").find((candidate) => candidate.includes('"status":"ready"'));
            const payload = line === undefined ? undefined : JSON.parse(line) as { url?: unknown };
            if (typeof payload?.url !== "string") {
              throw new Error("built service did not publish a URL");
            }
            await onReady?.(payload.url);
          } catch (error) {
            hookError = error;
          } finally {
            child.kill("SIGTERM");
          }
        })();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (hookError !== undefined) {
        reject(hookError);
        return;
      }
      if (timedOut) {
        reject(new Error("built service did not become ready"));
        return;
      }
      resolvePromise({ code, stdout, stderr });
    });
  });
}
