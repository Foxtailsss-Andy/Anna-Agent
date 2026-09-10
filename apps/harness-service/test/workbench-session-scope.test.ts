import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("Workbench resource scope rejects invalid or anonymous access without presence leaks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-scope-"));
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
  const productSessions = new ProductSessionStore(sessionStorePath);
  const modelContexts: Array<unknown[]> = [];
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;

  try {
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      ompModelTransport: async function* (context) {
        modelContexts.push(context.messages as unknown[]);
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
      serviceToken: "wb01-scope-host-token",
      sessionStore: productSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const created = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ surface: "chat" }),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as { session_id: string };
    const randomId = "00000000-0000-4000-8000-000000000000";

    const invalidExisting = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}`, {
      headers: { authorization: "Bearer invalid-workbench-token" },
    });
    const invalidMissing = await fetch(`${host.url}/api/workbench/sessions/${randomId}`, {
      headers: { authorization: "Bearer invalid-workbench-token" },
    });
    expect(invalidExisting.status).toBe(401);
    expect(invalidMissing.status).toBe(401);
    expect(await invalidExisting.json()).toEqual({ code: "authentication_required" });
    expect(await invalidMissing.json()).toEqual({ code: "authentication_required" });

    const anonymousExisting = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}`);
    const anonymousMissing = await fetch(`${host.url}/api/workbench/sessions/${randomId}`);
    expect(anonymousExisting.status).toBe(404);
    expect(anonymousMissing.status).toBe(404);
    expect(await anonymousExisting.json()).toEqual({ code: "session_not_found" });
    expect(await anonymousMissing.json()).toEqual({ code: "session_not_found" });

    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-01 private project session",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    const project = await projectResponse.json() as { id: string };
    const projectSession = async () => {
      const response = await fetch(`${host!.url}/api/workbench/sessions`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({ project_id: project.id, surface: "chat" }),
      });
      expect(response.status).toBe(201);
      return await response.json() as { session_id: string };
    };
    const firstProjectSession = await projectSession();
    const secondProjectSession = await projectSession();
    const projectRun = await fetch(`${host.url}/api/workbench/sessions/${firstProjectSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "A 私聊限制：只能用 EUR",
        source_event_id: "wb01-project-private-source",
        surface: "chat",
      }),
    });
    expect(projectRun.status).toBe(202);
    const projectRunBody = await projectRun.json() as { run_id: string };
    await waitForCompleted(host.url, projectRunBody.run_id, business.authorization);
    const secondDetail = await fetch(
      `${host.url}/api/workbench/sessions/${secondProjectSession.session_id}`,
      { headers: { authorization: business.authorization } },
    );
    expect(secondDetail.status).toBe(200);
    const secondDetailBody = await secondDetail.json() as { runs: unknown[]; messages: Array<{ content: string }> };
    expect(secondDetailBody.runs).toEqual([]);
    expect(secondDetailBody.messages).toEqual([]);
    const secondProjectRun = await fetch(`${host.url}/api/workbench/sessions/${secondProjectSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "B 私聊独有文本，不得读取 A 私聊",
        source_event_id: "wb01-project-private-source-b",
        surface: "chat",
      }),
    });
    expect(secondProjectRun.status).toBe(202);
    const secondProjectRunBody = await secondProjectRun.json() as { run_id: string };
    await waitForCompleted(host.url, secondProjectRunBody.run_id, business.authorization);
    const secondAfterRun = await fetch(
      `${host.url}/api/workbench/sessions/${secondProjectSession.session_id}`,
      { headers: { authorization: business.authorization } },
    );
    const secondAfterRunBody = await secondAfterRun.json() as { messages: Array<{ content: string }> };
    expect(secondAfterRunBody.messages.some((message) => message.content.includes("B 私聊独有文本"))).toBe(true);
    expect(secondAfterRunBody.messages.some((message) => message.content.includes("A 私聊限制"))).toBe(false);
    expect(JSON.stringify(modelContexts.at(-1))).not.toContain("A 私聊限制");
    const firstRunDetail = await fetch(`${host.url}/api/workbench/runs/${projectRunBody.run_id}`, {
      headers: { authorization: business.authorization },
    });
    const secondRunDetail = await fetch(`${host.url}/api/workbench/runs/${secondProjectRunBody.run_id}`, {
      headers: { authorization: business.authorization },
    });
    expect(firstRunDetail.status).toBe(200);
    expect(secondRunDetail.status).toBe(200);
    const firstRunDetailBody = await firstRunDetail.json() as { watermark: Record<string, unknown>; source_event_id: string };
    const secondRunDetailBody = await secondRunDetail.json() as { watermark: Record<string, unknown>; source_event_id: string };

    const andyLogin = await fetch(`${business.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "andy@anna.demo", password: "crew-demo" }),
    });
    expect(andyLogin.status).toBe(200);
    const andyToken = (await andyLogin.json() as { token: string }).token;
    const bossList = await fetch(`${host.url}/api/workbench/sessions`, {
      headers: { authorization: business.authorization },
    });
    expect(bossList.status).toBe(200);
    expect((await bossList.json() as { sessions: Array<{ session_id: string }> }).sessions.map((item) => item.session_id))
      .toContain(firstProjectSession.session_id);
    const andyList = await fetch(`${host.url}/api/workbench/sessions`, {
      headers: { authorization: `Bearer ${andyToken}` },
    });
    expect(andyList.status).toBe(200);
    expect((await andyList.json() as { sessions: unknown[] }).sessions).toEqual([]);
    const spoofHeaders = {
      authorization: `Bearer ${andyToken}`,
      "x-anna-workspace-id": business.workspaceId,
      "x-anna-user-id": business.actorUserId,
    };
    const crossActorSession = await fetch(
      `${host.url}/api/workbench/sessions/${firstProjectSession.session_id}`,
      { headers: spoofHeaders },
    );
    expect(crossActorSession.status).toBe(404);
    expect(await crossActorSession.json()).toEqual({ code: "session_not_found" });
    const firstRunForSpoof = projectRunBody.run_id;
    const crossActorRun = await fetch(`${host.url}/api/workbench/runs/${firstRunForSpoof}`, {
      headers: spoofHeaders,
    });
    expect(crossActorRun.status).toBe(404);
    expect(await crossActorRun.json()).toEqual({ code: "run_not_found" });
    const otherLogin = await fetch(`${business.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@anna.demo", password: "other-demo" }),
    });
    expect(otherLogin.status).toBe(200);
    const otherToken = (await otherLogin.json() as { token: string }).token;
    const otherSessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ surface: "chat" }),
    });
    expect(otherSessionResponse.status).toBe(201);
    const otherSession = await otherSessionResponse.json() as { session_id: string };
    const bossCannotReadOther = await fetch(`${host.url}/api/workbench/sessions/${otherSession.session_id}`, {
      headers: { authorization: business.authorization },
    });
    expect(bossCannotReadOther.status).toBe(404);
    expect(await bossCannotReadOther.json()).toEqual({ code: "session_not_found" });
    const otherCannotReadProject = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ project_id: project.id, surface: "chat" }),
    });
    expect(otherCannotReadProject.status).toBe(404);
    expect(await otherCannotReadProject.json()).toEqual({ code: "scope_not_found" });
    const otherCannotReadBossRun = await fetch(`${host.url}/api/workbench/runs/${firstRunForSpoof}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherCannotReadBossRun.status).toBe(404);
    expect(await otherCannotReadBossRun.json()).toEqual({ code: "run_not_found" });
    const missingProject = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ project_id: "proj-does-not-exist", surface: "chat" }),
    });
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toEqual({ code: "scope_not_found" });
    const bodySpoof = await fetch(`${host.url}/api/workbench/sessions/${firstProjectSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "伪造 scope",
        source_event_id: "wb01-spoof-source",
        surface: "chat",
        workspace_id: "other-workspace",
        actor_user_id: "other-actor",
        channel_id: "other-channel",
      }),
    });
    expect(bodySpoof.status).toBe(400);
    expect(await bodySpoof.json()).toEqual({ code: "invalid_request" });
    await writeWorkbenchReceipt({
      case: "session-scope-isolation",
      workspace_id: business.workspaceId,
      actor_user_id: business.actorUserId,
      project_id: project.id,
      session_ids: [firstProjectSession.session_id, secondProjectSession.session_id, otherSession.session_id],
      runs: [
        { run_id: projectRunBody.run_id, source_event_id: firstRunDetailBody.source_event_id, watermark: firstRunDetailBody.watermark },
        { run_id: secondProjectRunBody.run_id, source_event_id: secondRunDetailBody.source_event_id, watermark: secondRunDetailBody.watermark },
      ],
      model_transport_calls: modelContexts.length,
      unauthorized_projection: "blocked",
      usage: "unavailable",
    }, "workbench-session-scope.json");
  } finally {
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

async function waitForCompleted(origin: string, runId: string, authorization: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${origin}/api/workbench/runs/${runId}`, {
      headers: { authorization },
    });
    const body = await response.json() as { status?: string };
    if (["completed", "failed", "cancelled", "timed_out"].includes(body.status ?? "")) {
      expect(body.status).toBe("completed");
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Project Run did not terminate: ${runId}`);
}
