import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import { parseCanonicalEvent, parseOmpKernelDescriptor, parseStartRun, resolveRunProfile, type CanonicalEvent, type ResolvedRunProfile, type StreamId } from "@anna/harness-v2";
import { expect, test, vi } from "vitest";

import { OmpLoopKernel } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import { measureOmpImplementation } from "../../../packages/omp-loop-kernel/src/kernel-source";
import { startHarnessService } from "../src/index";
import { createLiveHarnessV2Runtime, createLiveProfile } from "../src/production";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test.each(["model", "provider", "descriptor", "scope", "surface"] as const)("public OMP resume rejects %s mismatch before kernel or events", async (mismatch) => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-resume-model-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  const kernelStart = vi.spyOn(OmpLoopKernel.prototype, "start");

  try {
    const descriptor = await currentOmpDescriptor();
    const originalDescriptor = mismatch === "descriptor"
      ? { ...descriptor, adapterSource: { ...descriptor.adapterSource, sha256: "f".repeat(64) } }
      : descriptor;
    const originalProfile = await createLiveProfile("original-model", undefined, false, "general", "none", originalDescriptor);
    const profile = mismatch === "provider"
      ? profileWithProvider(originalProfile, "original-provider")
      : originalProfile;
    const command = parseStartRun({
      workspaceId: "workspace-omp-resume-model",
      channelId: "channel-omp-resume-model",
      commandId: "command-omp-resume-model",
      runId: "run-omp-resume-model",
      surfaceId: "cowork",
      goal: "Resume the original OMP model.",
      source: { eventId: "source-omp-resume-model" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission-omp-resume-model",
      stopCondition: profile.terminalRules.stopCondition,
    });
    const seedStore = new SqliteEventStore(eventStorePath);
    const scoped = seedStore.scope(command);
    await scoped.claimStart(command);
    await scoped.append(canonicalEvent(command, 0, "run.queued", { phase: "queued" }));
    seedStore.close();

    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: mismatch === "model" ? "current-model" : "original-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "pi",
      harness_v2_omp_runtime_root: materializedRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    let modelCalls = 0;
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot: directory,
      surfaces: ["cowork", "hub"],
      ompModelTransport: async function* () {
        modelCalls += 1;
        yield {
          deltas: [],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "must not run" }],
            stopReason: "stop" as const,
          },
        };
      },
    });
    service = await startHarnessService({ runtime: live.runtime });

    const response = await fetch(
      `${service.url}/v2/surfaces/${mismatch === "surface" ? "hub" : "cowork"}/runs/${command.runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: command.workspaceId,
          channel_id: mismatch === "scope" ? "other-channel" : command.channelId,
        }),
      },
    );
    if (mismatch === "scope" || mismatch === "surface") {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "v2_runtime_failed" });
    } else {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "kernel_unavailable",
        requested_adapter: "omp",
        reason: "kernel_identity_mismatch",
      });
    }
    expect(kernelStart).not.toHaveBeenCalled();
    expect(modelCalls).toBe(0);
    const events: CanonicalEvent[] = [];
    for await (const event of live.eventStore.scope(command).read(command.runId as unknown as StreamId)) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["run.queued"]);
  } finally {
    kernelStart.mockRestore();
    await service?.close();
    await live?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

function profileWithProvider(profile: ResolvedRunProfile, provider: string): ResolvedRunProfile {
  const model = { ...profile.model, provider };
  const skillIds = profile.skills.map((skill) => skill.id);
  const toolPolicy = { allowedTools: profile.allowedTools };
  return resolveRunProfile({
    catalog: profile.skills,
    channelPolicy: {
      toolPolicy,
      allowedSkillIds: skillIds,
      allowedModels: [model],
      budgetLimits: profile.budget,
      memoryPolicy: { allowedReadModes: [profile.memoryPolicy.read], allowedWriteModes: [profile.memoryPolicy.write] },
    },
    workerProfile: {
      ...profile.workerProfile,
      allowedSkillIds: skillIds,
      allowedTools: profile.allowedTools,
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: profile.budget,
      artifactContract: profile.artifactContract,
    },
    runProfile: {
      ...profile,
      model,
      skillIds,
      toolPolicy,
    },
  });
}

async function currentOmpDescriptor() {
  const manifest = JSON.parse(await readFile(join(materializedRoot, "manifest.json"), "utf8")) as { sha256: string };
  const implementation = measureOmpImplementation();
  return parseOmpKernelDescriptor({
    schemaVersion: 1,
    adapterId: "omp",
    protocolVersion: "anna-omp/1",
    adapterSource: {
      packageName: "@anna/omp-loop-kernel",
      sha256: implementation.sourceSha256,
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
      dependencyLockSha256: implementation.dependencyLockSha256,
      runtimeManifestSha256: manifest.sha256.replace(/^sha256:/, ""),
    },
  });
}

function canonicalEvent(
  command: ReturnType<typeof parseStartRun>,
  seq: number,
  type: string,
  payload: Record<string, string>,
): CanonicalEvent {
  return parseCanonicalEvent({
    id: `event:${command.runId}:${seq}`,
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    streamId: command.runId,
    seq,
    type,
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    payload,
  });
}
