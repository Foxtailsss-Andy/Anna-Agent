import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import { createLiveHarnessV2Runtime } from "../src/production";
import { createChannelMemoryRepository, parseCanonicalEvent, parseStartRun } from "@anna/harness-v2";
import { resolvedRunProfileFixture } from "../../../packages/event-store/test/run-profile-fixture";
import { measureOmpImplementation } from "../../../packages/omp-loop-kernel/src/kernel-source";

const root = resolve(import.meta.dirname, "../../..");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("production OMP Run loads Host context and evaluates before terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-omp-composition-"));
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  try {
    const runtimeRoot = join(directory, "runtime");
    await cp(join(root, "build/omp-runtime/darwin-arm64"), runtimeRoot, { recursive: true });
    for (const name of ["worker.ts", "protocol.ts", "package-lock.json"]) await cp(join(root, "packages/omp-loop-kernel/runtime", name), join(runtimeRoot, name));
    await rm(join(runtimeRoot, "manifest.json"));
    const files: { path: string; bytes: number; sha256: string }[] = [];
    async function visit(path: string): Promise<void> {
      for (const name of await readdir(path)) {
        const file = join(path, name);
        const info = await stat(file);
        if (info.isDirectory()) await visit(file);
        else files.push({ path: relative(runtimeRoot, file), bytes: info.size, sha256: hash(await readFile(file)) });
      }
    }
    await visit(runtimeRoot);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifestDigest = hash(JSON.stringify(files));
    await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, files, sha256: `sha256:${manifestDigest}` }));
    const descriptor = {
      schemaVersion: 1, adapterId: "omp", protocolVersion: "anna-omp/1",
      adapterSource: { packageName: "@anna/omp-loop-kernel", sha256: measureOmpImplementation().sourceSha256 },
      upstream: { packageName: "@oh-my-pi/pi-coding-agent", version: "18.0.11", sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2", integrity: "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==" },
      runtime: { platform: "darwin", arch: "arm64", bunVersion: "1.3.14",
        bunSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
        nativeSha256: "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b",
        dependencyLockSha256: hash(await readFile(join(root, "packages/omp-loop-kernel/runtime/package-lock.json"))), runtimeManifestSha256: manifestDigest },
    };
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "notes.txt"), "actual production content");
    const configPath = join(directory, "runtime.json");
    await writeFile(configPath, JSON.stringify({ model_provider: "openai-compatible", model_name: "fixture-model", model_api_key: "fixture-only", model_endpoint: "https://provider.invalid/v1/chat/completions", harness_v2_kernel: "omp", harness_v2_omp_runtime_root: runtimeRoot, harness_v2_omp_descriptor: descriptor }));
    let calls = 0;
    live = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath: join(directory, "events.sqlite"), workspaceRoot, surfaces: ["cowork"],
      ompModelTransport: async function* (context) {
        calls += 1;
        expect(context.systemPrompt).toContain("Read notes with owner review.");
        if (calls === 1) yield { deltas: [], message: { role: "assistant", content: [{ type: "toolCall", id: "production-read", name: "read_only", arguments: { path: "notes.txt" } }], stopReason: "toolUse" } };
        else {
          expect(JSON.stringify(context.messages)).toContain("actual production content");
          yield { deltas: [], message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } };
        }
      },
    });
    const sourceProfile = resolvedRunProfileFixture({ memoryPolicy: { read: "channel", write: "propose" } });
    const source = parseStartRun({ workspaceId: "w-omp", channelId: "c-omp", commandId: "memory-source-command", runId: "memory-source-run", goal: "Record review requirement.", source: { eventId: "memory-source" }, runProfile: { id: sourceProfile.id, version: sourceProfile.version }, runProfileSnapshot: sourceProfile, budget: sourceProfile.budget, permissionScope: "memory-permission", stopCondition: sourceProfile.terminalRules.stopCondition });
    await live.eventStore.scope(source).claimStart(source);
    await live.eventStore.scope(source).append(parseCanonicalEvent({ id: "memory-source-completed", workspaceId: source.workspaceId, channelId: source.channelId, streamId: source.runId, seq: 0, type: "run.completed", timestamp: "2026-08-30T00:00:00.000Z", schemaVersion: 1, payload: { outcome: "completed" } }));
    const memories = createChannelMemoryRepository({ eventStore: live.eventStore, scope: source, runProfileSnapshot: sourceProfile, authorization: { async assertOwner(scope, actorId) { if (scope.workspaceId !== "w-omp" || scope.channelId !== "c-omp" || actorId !== "owner") throw new Error("Owner denied"); } } });
    await memories.propose({ id: "review-memory", content: "Read notes with owner review.", sourceRunId: source.runId, sourceEventIds: ["memory-source-completed"] });
    await memories.accept({ candidateId: "review-memory", actorId: "owner" });
    await live.runtime.start("cowork", { workspace_id: "w-omp", channel_id: "c-omp", command_id: "cmd-omp", run_id: "run-omp", source_event_id: "src-omp", goal: "Read notes." });
    const events = await (async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const result = await live!.runtime.readEvents("w-omp", "c-omp", "run-omp");
        if (result.some(event => ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(event.type))) return result;
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error("OMP production Run did not terminate");
    })();
    expect(calls, JSON.stringify(events.map(event => ({ type: event.type, payload: event.payload })))).toBe(2);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.at(-2)?.type).toBe("run.eval.contract");
    expect(events.some(event => event.type === "run.context.ready")).toBe(true);
    expect(events.filter(event => event.type === "memory.hit")).toHaveLength(1);
    expect(JSON.stringify(events.filter(event => event.type === "memory.hit" || event.type === "run.context.ready"))).not.toContain("Read notes with owner review.");
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index));
    await live.close();
    live = undefined;
    const invalidDescriptors = [
      { ...descriptor, adapterSource: { ...descriptor.adapterSource, sha256: "0".repeat(64) } },
      { ...descriptor, upstream: { ...descriptor.upstream, integrity: `sha512-${"A".repeat(86)}==` } },
      ...["bunSha256", "nativeSha256", "dependencyLockSha256"].map(field => ({ ...descriptor, runtime: { ...descriptor.runtime, [field]: "0".repeat(64) } })),
    ];
    for (const invalid of invalidDescriptors) {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      await writeFile(configPath, JSON.stringify({ ...config, harness_v2_omp_descriptor: invalid }));
      live = await createLiveHarnessV2Runtime({ runtimeConfigPath: configPath, eventStorePath: join(directory, "events.sqlite"), workspaceRoot, surfaces: ["cowork"] });
      await expect(live.runtime.start("cowork", { workspace_id: "w-omp", channel_id: "c-omp", command_id: "invalid-command", run_id: "invalid-run", source_event_id: "invalid-source", goal: "Reject invalid identity." })).rejects.toMatchObject({ body: { code: "kernel_unavailable" } });
      expect(await live.eventStore.scope(source).getRunCommand("invalid-run" as never)).toBeUndefined();
      await live.close();
      live = undefined;
    }
  } finally {
    await live?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
