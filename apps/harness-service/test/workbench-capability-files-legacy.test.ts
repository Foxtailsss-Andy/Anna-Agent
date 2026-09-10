import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { apiFetch } from "../../desktop/src/lib/api/client";
import { submitChatRun, subscribeChatRun } from "../../desktop/src/lib/api/chat";
import { getIdentity, setToken } from "../../desktop/src/lib/api/identity";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const services: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
const repositoryRoot = join(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  if (typeof globalThis.localStorage !== "undefined") setToken(null);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("legacy Product Host workdir client seam", () => {
  test("registers a workdir through apiFetch with the logged-in Bearer identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-legacy-client-"));
    directories.push(directory);
    const workdirRoot = join(directory, "registered-workdir");
    await mkdir(workdirRoot, { recursive: true });

    const hostPort = await findFreePort();
    const business = await startBusinessFixture(
      join(directory, "business.sqlite3"),
      `http://127.0.0.1:${hostPort}`,
    );
    services.push(business);
    const runtimeConfigPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const sessionStorePath = join(directory, "sessions.json");
    const workspaceRoot = join(directory, "runtime-workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const descriptor = await createOmpKernelDescriptor(materializedRoot);
    await writeFile(runtimeConfigPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: materializedRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      protectedPaths: [eventStorePath, sessionStorePath],
    });
    services.push(live);
    const host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-files-legacy-host-token",
      sessionStore: new ProductSessionStore(),
      sessionStorePath,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    services.push(host);

    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __ANNA_RUNTIME__: { apiBase: host.url } },
    });

    setToken(business.authorization.slice("Bearer ".length));
    const identity = await getIdentity(true);
    expect(identity).toMatchObject({
      workspaceId: business.workspaceId,
      userId: business.actorUserId,
      source: "token",
    });

    const response = await apiFetch("/api/workdirs", {
      method: "POST",
      json: { path: workdirRoot, name: "Legacy client RED" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "Legacy client RED" });

    const explicitRoot = join(directory, "explicit-header-workdir");
    await mkdir(explicitRoot, { recursive: true });
    const explicitResponse = await apiFetch("/api/workdirs", {
      method: "POST",
      headers: new Headers({ AUTHORIZATION: business.authorization }),
      json: { path: explicitRoot, name: "Explicit Bearer" },
    });
    expect(explicitResponse.status).toBe(200);
    await expect(explicitResponse.json()).resolves.toMatchObject({ name: "Explicit Bearer" });
  });

  test("rechecks a v1 workdir id when a task also supplies a path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-legacy-admission-"));
    directories.push(directory);
    const registeredRoot = join(directory, "registered-workdir");
    const conflictingRoot = join(directory, "conflicting-workdir");
    await mkdir(registeredRoot, { recursive: true });
    await mkdir(conflictingRoot, { recursive: true });

    const hostPort = await findFreePort();
    const business = await startBusinessFixture(
      join(directory, "business.sqlite3"),
      `http://127.0.0.1:${hostPort}`,
    );
    services.push(business);
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: registeredRoot, name: "Legacy admission" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };

    const runtimeConfigPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const sessionStorePath = join(directory, "sessions.json");
    const workspaceRoot = join(directory, "runtime-workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const descriptor = await createOmpKernelDescriptor(materializedRoot);
    await writeFile(runtimeConfigPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: materializedRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    const sessions = new ProductSessionStore(sessionStorePath);
    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["create"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessions.get(runId))?.task,
      productTaskPeek: (runId) => sessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        yield textResponse("legacy task continued");
      },
    });
    services.push(live);
    const host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-files-legacy-host-token",
      sessionStore: sessions,
      sessionStorePath,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    services.push(host);

    const response = await fetch(`${host.url}/_harness/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anna-service-token": "wb02-files-legacy-host-token",
      },
      body: JSON.stringify({
        run_id: "legacy-admission-recheck",
        workspace_id: business.workspaceId,
        actor_user_id: business.actorUserId,
        surface: "create",
        prompt: "Continue from the registered directory.",
        context: { workdir_id: registered.id },
        workdir_path: conflictingRoot,
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "workdir_binding_changed" });
    await writeLegacyReceipt("files-legacy-admission", {
      run_id: "legacy-admission-recheck",
      status: "rejected_before_runtime",
      error: "workdir_binding_changed",
      evidence_boundary: "actual Product Host admission with real Python identity/scope; no model transport needed",
    });
  });

  test("denies a v1 file read after the registered workdir is deleted, then continues text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-legacy-revoke-"));
    directories.push(directory);
    const registeredRoot = join(directory, "registered-workdir");
    await mkdir(registeredRoot, { recursive: true });
    await writeFile(join(registeredRoot, "note.txt"), "LEGACY_REAL_NOTE\n", "utf8");

    const hostPort = await findFreePort();
    const business = await startBusinessFixture(
      join(directory, "business.sqlite3"),
      `http://127.0.0.1:${hostPort}`,
    );
    services.push(business);
    const registration = await fetch(`${business.origin}/api/workdirs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
        "x-anna-workspace-id": business.workspaceId,
        "x-anna-user-id": business.actorUserId,
      },
      body: JSON.stringify({ path: registeredRoot, name: "Legacy revoke" }),
    });
    expect(registration.status).toBe(200);
    const registered = await registration.json() as { id: string };
    const runtimeConfigPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const sessionStorePath = join(directory, "sessions.json");
    const workspaceRoot = join(directory, "runtime-workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const descriptor = await createOmpKernelDescriptor(materializedRoot);
    await writeFile(runtimeConfigPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: materializedRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    const sessions = new ProductSessionStore(sessionStorePath);
    let readCount = 0;
    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessions.get(runId))?.task,
      productTaskPeek: (runId) => sessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      protectedPaths: [eventStorePath, sessionStorePath],
      ompModelTransport: async function* (context) {
        const lastToolResult = [...context.messages].reverse().find(isToolResultMessage);
        if (lastToolResult === undefined) {
          yield toolResponse("legacy-read-before-revoke", "read_only", { path: "note.txt" });
          return;
        }
        if (lastToolResult.toolName !== "read_only") throw new Error(`unexpected tool ${lastToolResult.toolName}`);
        readCount += 1;
        if (readCount === 1) {
          expect(lastToolResult.status).toBe("succeeded");
          expect(JSON.parse(lastToolResult.content)).toMatchObject({
            path: "note.txt",
            content: "LEGACY_REAL_NOTE\n",
          });
          const deletion = await fetch(`${business.origin}/api/workdirs/${registered.id}`, {
            method: "DELETE",
            headers: {
              authorization: business.authorization,
              "x-anna-workspace-id": business.workspaceId,
              "x-anna-user-id": business.actorUserId,
            },
          });
          expect(deletion.status).toBe(200);
          yield toolResponse("legacy-read-after-revoke", "read_only", { path: "note.txt" });
          return;
        }
        expect(lastToolResult.status).toBe("failed");
        yield textResponse("已确认目录撤销，继续普通文本回答。");
      },
    });
    services.push(live);
    const host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-files-legacy-host-token",
      sessionStore: sessions,
      sessionStorePath,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      protectedPaths: [eventStorePath, sessionStorePath],
    });
    services.push(host);

    const start = await fetch(`${host.url}/_harness/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anna-service-token": "wb02-files-legacy-host-token",
      },
      body: JSON.stringify({
        run_id: "legacy-revoke-read",
        workspace_id: business.workspaceId,
        actor_user_id: business.actorUserId,
        surface: "crew",
        prompt: "Read the note, then continue with a text answer.",
        context: { workdir_id: registered.id },
      }),
    });
    expect(start.status).toBe(202);
    const run = await start.json() as { run_id: string };
    const detail = await waitForLegacyRun(host.url, run.run_id);
    expect(detail.status, JSON.stringify(detail.events.slice(-8))).toBe("completed");
    const readResponses = detail.events
      .filter((event) => event.type === "omp.tool.response");
    expect(readResponses).toHaveLength(2);
    expect(readResponses[0]).toMatchObject({
      payload: { toolCallId: "legacy-read-before-revoke", result: { status: "succeeded" } },
    });
    expect(readResponses[1]).toMatchObject({
      payload: { toolCallId: "legacy-read-after-revoke", result: { status: "failed" } },
    });
    expect(detail.result).toMatchObject({ assistant_message: "已确认目录撤销，继续普通文本回答。" });
    await writeLegacyReceipt("files-legacy-revoke", {
      run_id: run.run_id,
      status: detail.status,
      tool_responses: readResponses.map((event) => {
        const payload = event.payload as Record<string, unknown>;
        const result = payload.result as Record<string, unknown>;
        return { tool_call_id: payload.toolCallId, status: result.status };
      }),
      evidence_boundary: "actual Product Host/OMP with real Python identity, registered file, real DELETE revoke; model transport is a fixture",
    });
  }, 40_000);

  test("keeps the legacy Chat client path reading a registered file and completing text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-wb02-files-legacy-chat-"));
    directories.push(directory);
    const registeredRoot = join(directory, "registered-workdir");
    await mkdir(registeredRoot, { recursive: true });
    await writeFile(join(registeredRoot, "note.txt"), "LEGACY_CHAT_NOTE\n", "utf8");

    const hostPort = await findFreePort();
    const business = await startBusinessFixture(
      join(directory, "business.sqlite3"),
      `http://127.0.0.1:${hostPort}`,
    );
    services.push(business);
    const runtimeConfigPath = join(directory, "runtime.json");
    const eventStorePath = join(directory, "events.sqlite");
    const sessionStorePath = join(directory, "sessions.json");
    const workspaceRoot = join(directory, "runtime-workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const descriptor = await createOmpKernelDescriptor(materializedRoot);
    await writeFile(runtimeConfigPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "fixture-only",
      model_endpoint: "https://provider.invalid/v1/chat/completions",
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: materializedRoot,
      harness_v2_omp_descriptor: descriptor,
    }), "utf8");
    const sessions = new ProductSessionStore(sessionStorePath);
    const live = await createLiveHarnessV2Runtime({
      runtimeConfigPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessions.get(runId))?.task,
      productTaskPeek: (runId) => sessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      protectedPaths: [eventStorePath, sessionStorePath],
      ompModelTransport: async function* (context) {
        const lastToolResult = [...context.messages].reverse().find(isToolResultMessage);
        if (lastToolResult === undefined) {
          yield toolResponse("legacy-chat-read", "workdir.read_file", {
            path: "note.txt",
          });
          return;
        }
        expect(lastToolResult.toolName).toBe("workdir.read_file");
        expect(lastToolResult.status).toBe("succeeded");
        expect(JSON.parse(lastToolResult.content)).toMatchObject({
          path: "note.txt",
          content: "LEGACY_CHAT_NOTE\n",
        });
        yield textResponse("Chat 已读取真实目录并继续普通回答。");
      },
    });
    services.push(live);
    const host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb01-business-service-token",
      sessionStore: sessions,
      sessionStorePath,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      protectedPaths: [eventStorePath, sessionStorePath],
    });
    services.push(host);

    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __ANNA_RUNTIME__: { apiBase: host.url } },
    });
    setToken(business.authorization.slice("Bearer ".length));
    const identity = await getIdentity(true);
    expect(identity.source).toBe("token");

    const registration = await apiFetch("/api/workdirs", {
      method: "POST",
      json: { path: registeredRoot, name: "Legacy Chat" },
    });
    expect(registration.status).toBe(200);
    const workdir = await registration.json() as { id: string };

    const submitted = await submitChatRun({
      message: "读取登记目录中的 note.txt，然后继续普通文本回答。",
      workdirId: workdir.id,
    });
    expect(submitted.status).toBe("generating");
    const frames: Record<string, unknown>[] = [];
    await subscribeChatRun(submitted.run_id, 0, { onFrame: (frame) => frames.push(frame) });
    expect(frames.length).toBeGreaterThan(0);
    const completed = await apiFetch(`/api/chat/runs/${submitted.run_id}`);
    expect(completed.status).toBe(200);
    const completedBody = await completed.json() as Record<string, unknown>;
    expect(completedBody).toMatchObject({
      status: "ready",
      assistant_message: "Chat 已读取真实目录并继续普通回答。",
    });
    await writeLegacyReceipt("files-legacy-chat", {
      run_id: submitted.run_id,
      status: "ready",
      stream_frames: frames
        .filter((frame) => frame.type === "tool_start" || frame.type === "tool_done" || frame.type === "done")
        .map((frame) => ({ type: frame.type, name: frame.name, ok: frame.ok })),
      evidence_boundary: "actual desktop Chat submit/subscribe through Python Product Host and OMP; real identity/scope and registered file; model transport is a fixture",
    });
  }, 60_000);
});

function isToolResultMessage(value: unknown): value is {
  role: "toolResult";
  toolName: string;
  status: string;
  content: string;
} {
  return typeof value === "object"
    && value !== null
    && (value as { role?: unknown }).role === "toolResult"
    && typeof (value as { toolName?: unknown }).toolName === "string"
    && typeof (value as { status?: unknown }).status === "string"
    && typeof (value as { content?: unknown }).content === "string";
}

function toolResponse(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return {
    deltas: [{ type: "toolCall" as const, contentIndex: 0 as const, id, name, argumentsDelta: JSON.stringify(argumentsValue) }],
    message: {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id, name, arguments: argumentsValue }],
      stopReason: "toolUse" as const,
    },
  };
}

function textResponse(text: string) {
  return {
    deltas: [{ type: "text" as const, contentIndex: 0 as const, text }],
    message: { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const },
  };
}

async function waitForLegacyRun(
  origin: string,
  runId: string,
): Promise<{ status: string; result?: Record<string, unknown>; events: Array<Record<string, unknown> & { type: string }> }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const response = await fetch(`${origin}/_harness/runs/${runId}`, {
      headers: { "x-anna-service-token": "wb02-files-legacy-host-token" },
    });
    expect(response.status).toBe(200);
    const detail = await response.json() as {
      status: string;
      result?: Record<string, unknown>;
      events: Array<Record<string, unknown> & { type: string }>;
    };
    if (["completed", "failed", "cancelled", "timed_out", "awaiting_input", "awaiting_approval"].includes(detail.status)) {
      return detail;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`legacy run ${runId} did not terminate within 30000ms`);
}

async function writeLegacyReceipt(name: string, payload: Record<string, unknown>): Promise<void> {
  const root = process.env.ANNA_WB02_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
