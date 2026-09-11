import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

it("RC1 Workbench stop cancels the target OMP Run while a sibling Run completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-rc1-workbench-"));
  const productPort = await findFreePort();
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const configPath = join(directory, "runtime.json");
  const workspaceRoot = join(directory, "workspace");
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    `http://127.0.0.1:${productPort}`,
  );
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let releaseTarget!: () => void;
  let targetEntered!: () => void;
  const targetReleased = new Promise<void>((resolvePromise) => { releaseTarget = resolvePromise; });
  const targetStarted = new Promise<void>((resolvePromise) => { targetEntered = resolvePromise; });

  try {
    await mkdir(workspaceRoot, { recursive: true });
    const descriptor = await createOmpKernelDescriptor(materializedRoot);
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: materializedRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    const sessions = new ProductSessionStore(sessionStorePath);
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessions.get(runId))?.task,
      productTaskPeek: (runId) => sessions.peek(runId)?.task,
      ompModelTransport: async function* (context, signal) {
        const latestUserMessage = [...context.messages].reverse().find((message) => message.role === "user");
        if (latestUserMessage?.content.includes("RC1 target")) {
          targetEntered();
          await waitForRelease(targetReleased, signal);
        }
        yield {
          deltas: [{ type: "text" as const, contentIndex: 0, text: "OMP fixture answer" }],
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "OMP fixture answer" }],
            stopReason: "stop" as const,
          },
        };
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: productPort,
      staticRoot: directory,
      serviceToken: "rc1-workbench-host-token",
      sessionStore: sessions,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const auth = { authorization: business.authorization };
    const sessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ surface: "chat" }),
    });
    expect(sessionResponse.status).toBe(201);
    const sessionId = (await sessionResponse.json() as { session_id: string }).session_id;
    const submit = (prompt: string, sourceEventId: string, options: Record<string, unknown> = {}) => fetch(
      `${host!.url}/api/workbench/sessions/${sessionId}/runs`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prompt, source_event_id: sourceEventId, ...options }),
      },
    );
    const targetResponse = await submit("RC1 target: wait for stop", "rc1-target", {
      skill_id: "skill:chat/general-assistant",
      agent_id: "chat",
      model_profile_id: "default",
    });
    expect(targetResponse.status).toBe(202);
    const targetRunId = (await targetResponse.json() as { run_id: string }).run_id;
    await targetStarted;
    const siblingResponse = await submit("RC1 sibling: complete", "rc1-sibling");
    expect(siblingResponse.status).toBe(202);
    const siblingRunId = (await siblingResponse.json() as { run_id: string }).run_id;
    expect(siblingRunId).not.toBe(targetRunId);
    const siblingBeforeStop = await readStatus(host.url, siblingRunId, auth);
    expect(["queued", "running"]).toContain(siblingBeforeStop);

    const stopResponse = await fetch(`${host.url}/api/workbench/runs/${targetRunId}/stop`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reason: "用户停止目标 Run" }),
    });
    expect(stopResponse.status).toBe(202);
    expect(await stopResponse.json()).toEqual({ run_id: targetRunId, status: "cancelled" });
    expect(await waitForStatus(host.url, targetRunId, auth)).toBe("cancelled");
    expect(await waitForStatus(host.url, siblingRunId, auth)).toBe("completed");
    const sessionDetail = await fetch(`${host.url}/api/workbench/sessions/${sessionId}`, { headers: auth });
    const detailBody = await sessionDetail.json() as { runs?: Array<Record<string, unknown>> };
    expect(detailBody.runs?.find((run) => run.run_id === targetRunId)).toMatchObject({
      skill_id: "skill:chat/general-assistant",
      agent_id: "chat",
      model_profile_id: "default",
    });
  } finally {
    releaseTarget?.();
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

async function waitForRelease(release: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("cancelled");
  await new Promise<void>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    release.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    });
  });
}

async function waitForStatus(
  origin: string,
  runId: string,
  auth: Record<string, string>,
): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${origin}/api/workbench/runs/${runId}`, { headers: auth });
    const body = await response.json() as { status?: string };
    if (["completed", "failed", "cancelled", "timed_out"].includes(body.status ?? "")) {
      return body.status!;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Workbench Run did not terminate: ${runId}`);
}

async function readStatus(origin: string, runId: string, auth: Record<string, string>): Promise<string> {
  const response = await fetch(`${origin}/api/workbench/runs/${runId}`, { headers: auth });
  const body = await response.json() as { status?: string };
  return body.status ?? "unknown";
}
