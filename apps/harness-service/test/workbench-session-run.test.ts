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

test("Workbench Session accepts two idempotent Runs across surfaces and preserves public messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-run-"));
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
  let modelCalls = 0;
  const modelContexts: Array<{ messages: unknown[] }> = [];
  let releaseConcurrent!: () => void;
  let concurrentEntered!: () => void;
  const concurrentEnteredPromise = new Promise<void>((resolvePromise) => {
    concurrentEntered = resolvePromise;
  });
  const concurrentRelease = new Promise<void>((resolvePromise) => {
    releaseConcurrent = resolvePromise;
  });
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let restartedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let restartedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;

  try {
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      ompModelTransport: async function* (context) {
        modelCalls += 1;
        modelContexts.push({ messages: context.messages as unknown[] });
        if (JSON.stringify(context.messages).includes("并发相同source")) {
          concurrentEntered();
          await concurrentRelease;
        }
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "真实 OMP fixture answer" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "真实 OMP fixture answer" }],
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
      serviceToken: "wb01-run-host-token",
      sessionStore: productSessions,
      staticRoot: directory,
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
    const session = await sessionResponse.json() as { session_id: string };

    const unsupportedArtifact = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "不支持的产物类型",
        source_event_id: "wb01-unsupported-artifact",
        surface: "chat",
        requested_artifact: "unsupported",
      }),
    });
    expect(unsupportedArtifact.status).toBe(400);
    expect(await unsupportedArtifact.json()).toEqual({ code: "invalid_requested_artifact" });

    const rendererRunId = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "renderer-chosen-run-id",
        prompt: "客户端不应指定执行 ID",
        source_event_id: "wb01-source-renderer-id",
        surface: "chat",
      }),
    });
    expect(rendererRunId.status).toBe(400);
    expect(await rendererRunId.json()).toEqual({ code: "invalid_request" });

    const first = await submitRun(host.url, session.session_id, auth, {
      prompt: "只能用EUR完成第一轮研究",
      source_event_id: "wb01-source-1",
      surface: "chat",
    });
    expect(await waitForRun(host.url, first.run_id, auth)).toBe("completed");
    const second = await submitRun(host.url, session.session_id, auth, {
      prompt: "切换到 Create 入口继续第二轮",
      source_event_id: "wb01-source-2",
      surface: "create",
    });
    expect(first.run_id).not.toBe(second.run_id);

    const retry = await submitRun(host.url, session.session_id, auth, {
      prompt: "只能用EUR完成第一轮研究",
      source_event_id: "wb01-source-1",
      surface: "chat",
    });
    expect(retry.run_id).toBe(first.run_id);
    const conflict = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "篡改后的正文",
        source_event_id: "wb01-source-1",
        surface: "chat",
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "run_conflict" });

    expect(await waitForRun(host.url, second.run_id, auth)).toBe("completed");
    const detail = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}`, { headers: auth });
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      runs: Array<{ run_id: string; source_event_id: string; surface: string }>;
      messages: Array<{ run_id: string; role: string; content: string; event_id: string; seq: number }>;
      watermark: { session_id: string; run_id?: string; runs: Array<{ run_id: string; event_id: string; seq: number }> };
    };
    expect(body.runs.map((run) => run.run_id)).toEqual([first.run_id, second.run_id]);
    expect(body.runs.map((run) => run.surface)).toEqual(["chat", "create"]);
    expect(body.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "只能用EUR完成第一轮研究",
      "切换到 Create 入口继续第二轮",
    ]);
    expect(body.messages.some((message) => message.role === "assistant" && message.content === "真实 OMP fixture answer")).toBe(true);
    const localPathPrefix = ["/", "Users/"].join("");
    expect(body.messages.every((message) => !message.content.includes(localPathPrefix))).toBe(true);
    expect(body.watermark.session_id).toBe(session.session_id);
    expect(body.watermark.run_id).toBeUndefined();
    expect(body.watermark.runs.map((item) => item.run_id)).toEqual([first.run_id, second.run_id]);
    expect(body.watermark.runs.every((item) => item.event_id && item.seq >= 0)).toBe(true);
    expect(modelCalls).toBe(2);
    expect(JSON.stringify(modelContexts[0]?.messages)).toContain("只能用EUR");
    expect(JSON.stringify(modelContexts[1]?.messages)).toContain("只能用EUR");
    expect(JSON.stringify(modelContexts[1]?.messages)).toContain("真实 OMP fixture answer");

    const beforeRestart = {
      runs: body.runs.map((run) => ({ run_id: run.run_id, source_event_id: run.source_event_id, surface: run.surface })),
      watermark: body.watermark,
    };
    await host.close();
    host = undefined;
    await live.close();
    live = undefined;
    const restartedSessions = new ProductSessionStore(sessionStorePath);
    restartedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await restartedSessions.get(runId))?.task,
      productTaskPeek: (runId) => restartedSessions.peek(runId)?.task,
      ompModelTransport: async function* (context) {
        modelCalls += 1;
        modelContexts.push({ messages: context.messages as unknown[] });
        if (JSON.stringify(context.messages).includes("并发相同source")) {
          concurrentEntered();
          await concurrentRelease;
        }
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "真实 OMP fixture answer" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "真实 OMP fixture answer" }],
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
      serviceToken: "wb01-run-host-token-restarted",
      sessionStore: restartedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const afterRestartResponse = await fetch(
      `${restartedHost.url}/api/workbench/sessions/${session.session_id}`,
      { headers: auth },
    );
    expect(afterRestartResponse.status).toBe(200);
    const afterRestart = await afterRestartResponse.json() as {
      runs: Array<{ run_id: string; source_event_id: string; surface: string }>;
      watermark: { session_id: string; runs: Array<{ run_id: string; event_id: string; seq: number }> };
    };
    expect({
      runs: afterRestart.runs.map((run) => ({ run_id: run.run_id, source_event_id: run.source_event_id, surface: run.surface })),
      watermark: afterRestart.watermark,
    }).toEqual(beforeRestart);
    const third = await submitRun(restartedHost.url, session.session_id, auth, {
      prompt: "第三轮继续同样限制，只能用EUR",
      source_event_id: "wb01-source-3",
      surface: "chat",
    });
    expect(await waitForRun(restartedHost.url, third.run_id, auth)).toBe("completed");
    expect(modelCalls).toBe(3);
    expect(JSON.stringify(modelContexts[2]?.messages)).toContain("只能用EUR");
    expect(JSON.stringify(modelContexts[2]?.messages)).toContain("真实 OMP fixture answer");
    const concurrentBody = {
      prompt: "并发相同source只能执行一次",
      source_event_id: "wb01-concurrent-source",
      surface: "chat",
    };
    const [concurrentA, concurrentB] = await Promise.all([
      submitRun(restartedHost.url, session.session_id, auth, concurrentBody),
      submitRun(restartedHost.url, session.session_id, auth, concurrentBody),
    ]);
    expect(concurrentA.run_id).toBe(concurrentB.run_id);
    await concurrentEnteredPromise;
    releaseConcurrent();
    expect(await waitForRun(restartedHost.url, concurrentA.run_id, auth)).toBe("completed");
    expect(modelCalls).toBe(4);
    await writeWorkbenchReceipt({
      case: "session-run-idempotency-restart",
      session_id: session.session_id,
      runs: body.runs.map((run) => ({ run_id: run.run_id, source_event_id: run.source_event_id, surface: run.surface })),
      watermarks: body.watermark.runs,
      model_transport_calls: modelCalls,
      usage: "unavailable",
    }, "workbench-session-run.json");
  } finally {
    releaseConcurrent();
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

async function submitRun(
  origin: string,
  sessionId: string,
  auth: Record<string, string>,
  body: Record<string, string>,
): Promise<{ run_id: string }> {
  const response = await fetch(`${origin}/api/workbench/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { run_id?: string; code?: string };
  expect(response.status, JSON.stringify(payload)).toBe(202);
  expect(typeof payload.run_id).toBe("string");
  return { run_id: payload.run_id! };
}

async function waitForRun(origin: string, runId: string, auth: Record<string, string>): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${origin}/api/workbench/runs/${runId}`, { headers: auth });
    const body = await response.json() as { status?: string };
    if (["completed", "failed", "cancelled", "timed_out"].includes(body.status ?? "")) {
      expect(body.status).toBe("completed");
      return body.status;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Workbench Run did not terminate: ${runId}`);
}
