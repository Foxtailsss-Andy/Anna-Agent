import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("Workbench Session remains readable through a real business scope and Host restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-session-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
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

  const hostPort = await findFreePort();
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    `http://127.0.0.1:${hostPort}`,
  );
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let restartedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let restartedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;

  try {
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      ompModelTransport: async function* () {
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "fixture" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fixture" }],
            stopReason: "stop",
          },
        };
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-host-service-token",
      sessionStorePath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const created = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: business.authorization,
      },
      body: JSON.stringify({ surface: "chat" }),
    });
    const createdBody = await created.json() as Record<string, unknown>;
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    expect(createdBody.schema_version).toBe(2);
    expect(createdBody.workspace_id).toBe(business.workspaceId);
    expect(createdBody.actor_user_id).toBe(business.actorUserId);
    expect(createdBody.channel_id).toBe(`chat_channel:${business.workspaceId}`);
    const sessionId = String(createdBody.session_id);

    const detail = await fetch(`${host.url}/api/workbench/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: business.authorization },
    });
    expect(detail.status).toBe(200);
    expect((await detail.json() as Record<string, unknown>).session_id).toBe(sessionId);

    await host.close();
    host = undefined;
    await live.close();
    live = undefined;

    restartedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      ompModelTransport: async function* () {
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "fixture" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fixture" }],
            stopReason: "stop",
          },
        };
      },
    });
    restartedHost = await startProductHost({
      runtime: restartedLive.runtime,
      eventStore: restartedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-host-service-token-2",
      sessionStorePath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const afterRestart = await fetch(
      `${restartedHost.url}/api/workbench/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { authorization: business.authorization } },
    );
    expect(afterRestart.status).toBe(200);
    expect((await afterRestart.json() as Record<string, unknown>).session_id).toBe(sessionId);
    await writeWorkbenchReceipt({
      case: "session-contract-restart",
      session_id: sessionId,
      workspace_id: business.workspaceId,
      actor_user_id: business.actorUserId,
      channel_id: `chat_channel:${business.workspaceId}`,
      restarted_session_id: sessionId,
      usage: "unavailable",
    }, "workbench-session-contract.json");
  } finally {
    await restartedHost?.close();
    await restartedLive?.close();
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

async function writeWorkbenchReceipt(payload: Record<string, unknown>, filename: string): Promise<void> {
  const root = process.env.ANNA_WB01_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
