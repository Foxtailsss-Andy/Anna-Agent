import { createHash } from "node:crypto";
import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";

import { measureOmpImplementation } from "../../../packages/omp-loop-kernel/src/kernel-source";
import { startHarnessService } from "../src/index";
import { createLiveHarnessV2Runtime } from "../src/production";

test("rejects OMP admission on an unsupported platform before Run claim", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-platform-admission-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, "build/omp-runtime/darwin-arm64/manifest.json"),
    "utf8",
  )) as { sha256: string };
  const dependencyLockSha256 = createHash("sha256").update(await readFile(
    join(repositoryRoot, "packages/omp-loop-kernel/runtime/package-lock.json"),
  )).digest("hex");
  const descriptor = {
    schemaVersion: 1,
    adapterId: "omp",
    protocolVersion: "anna-omp/1",
    adapterSource: {
      packageName: "@anna/omp-loop-kernel",
      sha256: measureOmpImplementation().sourceSha256,
    },
    upstream: {
      packageName: "@oh-my-pi/pi-coding-agent",
      version: "18.0.11",
      sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2",
      integrity: "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==",
    },
    runtime: {
      platform: "darwin",
      arch: "arm64",
      bunVersion: "1.3.14",
      bunSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
      nativeSha256: "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b",
      dependencyLockSha256,
      runtimeManifestSha256: manifest.sha256.replace(/^sha256:/, ""),
    },
  };
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: join(repositoryRoot, "build/omp-runtime/darwin-arm64"),
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");

  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const arch = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  let kernelStarts = 0;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: () => ({
      async start() {
        kernelStarts += 1;
        throw new Error("kernel must not start");
      },
      async steer() {},
      async answer() {},
      async abort() {},
    }),
  });
  const service = await startHarnessService({ runtime: live.runtime });
  try {
    const response = await fetch(`${service.url}/v2/surfaces/cowork/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "workspace:omp-platform",
        channel_id: "channel:omp-platform",
        command_id: "command:omp-platform",
        run_id: "run:omp-platform",
        source_event_id: "event:omp-platform-source",
        goal: "Reject unsupported OMP platform.",
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "kernel_unavailable",
      requested_adapter: "omp",
      reason: "managed_runtime_unavailable",
    });
    expect(kernelStarts).toBe(0);
    const scope = live.eventStore.scope({
      workspaceId: "workspace:omp-platform" as never,
      channelId: "channel:omp-platform" as never,
    });
    expect(await scope.getRunCommand("run:omp-platform" as never)).toBeUndefined();
    const events = [];
    for await (const event of scope.read("run:omp-platform" as never)) events.push(event);
    expect(events).toEqual([]);
  } finally {
    await service.close();
    await live.close();
    platform.mockRestore();
    arch.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
