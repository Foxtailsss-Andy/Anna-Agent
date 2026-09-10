import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
// Keep one legal external transport delay so this fixture protects the
// completion observer from regressing to the former five-second window.
const delayedTransportMs = 6_000;
const fixtureRunObservationWindowMs = 30_000;
const terminalEventTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "run.awaiting_input",
  "run.awaiting_approval",
]);

test("Workbench Run admission failure is stable on same-source retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-admission-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  await writeFile(configPath, JSON.stringify({
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

  try {
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat"],
      requireOmp: true,
      allowUnconfigured: true,
      ompRuntimeRoot: materializedRoot,
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-admission-host-token",
      sessionStorePath,
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
    const body = {
      prompt: "模型未配置时不能伪装排队",
      source_event_id: "wb01-admission-failure-source",
      surface: "chat",
    };
    const first = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ code: "model_not_configured" });

    const listAfterFailure = await fetch(`${host.url}/api/workbench/sessions`, { headers: auth });
    expect(listAfterFailure.status).toBe(200);
    const listBody = await listAfterFailure.json() as {
      sessions: Array<{ runs: Array<Record<string, unknown>> }>
    };
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]?.runs).toEqual([
      expect.objectContaining({
        run_id: expect.any(String),
        status: "not_started",
        admission_status: "failed",
        admission_error: "model_not_configured",
      }),
    ]);

    const detailAfterFailure = await fetch(
      `${host.url}/api/workbench/sessions/${session.session_id}`,
      { headers: auth },
    );
    expect(detailAfterFailure.status).toBe(200);
    const detailBody = await detailAfterFailure.json() as {
      runs: Array<Record<string, unknown>>
    };
    expect(detailBody.runs).toEqual([
      expect.objectContaining({
        run_id: expect.any(String),
        status: "not_started",
        admission_status: "failed",
        admission_error: "model_not_configured",
      }),
    ]);

    const concurrentBody = {
      prompt: "并发入场失败不能伪装排队",
      source_event_id: "wb01-admission-concurrent-source",
      surface: "chat",
    };
    const [concurrentA, concurrentB] = await Promise.all([
      fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(concurrentBody),
      }),
      fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(concurrentBody),
      }),
    ]);
    expect(concurrentA.status).toBe(409);
    expect(await concurrentA.json()).toEqual({ code: "model_not_configured" });
    expect(concurrentB.status).toBe(409);
    expect(await concurrentB.json()).toEqual({ code: "model_not_configured" });

    const retry = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ code: "model_not_configured" });

    await host.close();
    host = undefined;
    await writeFile(
      `${sessionStorePath}.v2.json`,
      JSON.stringify({ schema_version: 2, sessions: [{ session_id: "corrupt" }], runs: [] }),
      "utf8",
    );
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-admission-host-token-restarted",
      sessionStorePath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const corruptRead = await fetch(`${host.url}/api/workbench/sessions`, {
      headers: { authorization: business.authorization },
    });
    expect(corruptRead.status).toBe(500);
    expect(await corruptRead.json()).toEqual({ code: "product_host_internal_error" });
    await writeAdmissionReceipt({
      case: "admission-failure",
      failed_code: "model_not_configured",
      query_status: "not_started",
      concurrent_duplicate_calls: 2,
      model_transport_calls: 0,
    }, "workbench-admission-failure.json");
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

async function waitForCanonicalCompletion(
  eventStore: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>>["eventStore"],
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<void> {
  const scoped = eventStore.scope({ workspaceId: workspaceId as never, channelId: channelId as never });
  const startedAt = Date.now();
  let afterSeq = -1;
  let lastEvent: { type: string; seq: number } | undefined;
  while (Date.now() - startedAt < fixtureRunObservationWindowMs) {
    for await (const event of scoped.read(runId as never, afterSeq)) {
      afterSeq = event.seq;
      lastEvent = { type: event.type, seq: event.seq };
      if (event.type === "run.completed") return;
      if (terminalEventTypes.has(event.type)) {
        throw new Error(`canonical run ${runId} ended with ${event.type} at seq ${event.seq}`);
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `canonical run ${runId} did not complete within ${fixtureRunObservationWindowMs}ms; last_event=${lastEvent?.type ?? "none"}; last_seq=${lastEvent?.seq ?? "none"}`,
  );
}

test("Workbench retry prefers a canonical Run when admission status persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb01-admission-canonical-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const workbenchPath = join(directory, "workbench.json");
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
  let modelCalls = 0;
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
      ompModelTransport: async function* () {
        modelCalls += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delayedTransportMs));
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "canonical answer" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "canonical answer" }],
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
      serviceToken: "wb01-admission-canonical-token",
      sessionStorePath,
      workbenchSessionStorePath: workbenchPath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const auth = { authorization: business.authorization };
    const created = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ surface: "chat" }),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as { session_id: string };
    const body = {
      prompt: "canonical优先",
      source_event_id: "canonical-priority-source",
      surface: "chat",
    };
    const first = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { run_id: string };
    await waitForCanonicalCompletion(live.eventStore, business.workspaceId, `chat_channel:${business.workspaceId}`, firstBody.run_id);
    const sidecar = JSON.parse(await readFile(workbenchPath, "utf8")) as {
      schema_version: number;
      sessions: unknown[];
      runs: Array<Record<string, unknown>>;
    };
    expect(sidecar.runs).toHaveLength(1);
    sidecar.runs[0]!.admission_status = "pending";
    delete sidecar.runs[0]!.admission_error;
    await host.close();
    host = undefined;
    await writeFile(workbenchPath, `${JSON.stringify(sidecar)}\n`, "utf8");
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-admission-canonical-token-restarted",
      sessionStorePath,
      workbenchSessionStorePath: workbenchPath,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const retry = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(retry.status).toBe(202);
    const retryBody = await retry.json() as { run_id: string; status: string };
    expect(retryBody.status).toBe("completed");
    expect(modelCalls).toBe(1);
    await writeAdmissionReceipt({
      case: "canonical-admission-retry",
      run_id: retryBody.run_id,
      status: retryBody.status,
      model_transport_calls: modelCalls,
      usage: "unavailable",
    }, "workbench-admission-canonical.json");
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

async function writeAdmissionReceipt(payload: Record<string, unknown>, filename: string): Promise<void> {
  const root = process.env.ANNA_WB01_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
