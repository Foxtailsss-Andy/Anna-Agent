import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { InMemoryEventStore } from "@anna/event-store";
import { startPreviewHarnessService } from "../src/preview";

const services: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Harness Preview public HTTP seam", () => {
  test("boots without model configuration and reports the Preview protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-preview-red-"));
    directories.push(directory);
    const service = await startPreviewHarnessService({
      stateRoot: directory,
      workspaceRoot: directory,
    });
    services.push(service);

    await expect(fetch(`${service.url}/health`).then((response) => response.json())).resolves.toEqual({
      status: "ok",
      protocol: "anna-harness-preview/1",
    });
    await expect(fetch(`${service.url}/api/preview/status`).then((response) => response.json())).resolves.toEqual({
      protocol: "anna-harness-preview/1",
      kernel: "omp",
      configured: false,
      ready: false,
      reason: "model_configuration_missing",
    });
  });

  test("persists settings without returning the key and derives Run scope at the Host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-preview-settings-"));
    directories.push(directory);
    const store = new InMemoryEventStore();
    const starts: unknown[] = [];
    const service = await startPreviewHarnessService({
      stateRoot: directory,
      workspaceRoot: directory,
      createRuntime: async () => ({
        eventStore: store,
        runtime: {
          async start(_surfaceId, body) {
            starts.push(body);
            return { runId: "run-settings", status: "queued" };
          },
        },
        close() {},
      }),
    });
    services.push(service);

    const settingsResponse = await fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_name: "preview-model",
        model_endpoint: "https://provider.example/v1/chat/completions",
        workspace_root: directory,
        model_api_key: "preview-secret",
      }),
    });
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toEqual({
      model_name: "preview-model",
      model_endpoint: "https://provider.example/v1/chat/completions",
      workspace_root: directory,
      has_api_key: true,
    });
    expect(await fetch(`${service.url}/api/preview/settings`).then((response) => response.text()))
      .not.toContain("preview-secret");

    const injectedScope = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-settings",
        command_id: "command-settings",
        goal: "Read the approved note.",
        workspace_id: "attacker-workspace",
      }),
    });
    expect(injectedScope.status).toBe(400);

    const started = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-settings",
        command_id: "command-settings",
        goal: "Read the approved note.",
      }),
    });
    expect(started.status).toBe(202);
    expect(starts).toEqual([{
      workspace_id: expect.stringMatching(/^workspace:preview:/),
      channel_id: expect.stringMatching(/^channel:preview:/),
      command_id: "command-settings",
      run_id: "run-settings",
      source_event_id: "preview:source:command-settings",
      goal: "Read the approved note.",
    }]);
  });

  test("rejects unsafe settings URLs, cross-origin mutations, and oversized or widened bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-preview-security-"));
    directories.push(directory);
    const service = await startPreviewHarnessService({
      stateRoot: directory,
      workspaceRoot: directory,
      createRuntime: async () => ({
        eventStore: new InMemoryEventStore(),
        runtime: {
          async start() {
            return { runId: "run-security", status: "queued" };
          },
        },
        close() {},
      }),
    });
    services.push(service);

    const unsafeUrl = await fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_name: "preview-model",
        model_endpoint: "https://user:secret@provider.example/v1/chat/completions",
        workspace_root: directory,
        model_api_key: "secret-key",
      }),
    });
    expect(unsafeUrl.status).toBe(400);
    await expect(unsafeUrl.json()).resolves.toEqual({ code: "invalid_settings" });

    const csrf = await fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        model_name: "preview-model",
        model_endpoint: "https://provider.example/v1/chat/completions",
        workspace_root: directory,
      }),
    });
    expect(csrf.status).toBe(403);
    await expect(csrf.json()).resolves.toEqual({ code: "csrf_origin_mismatch" });

    const unsupportedContentType = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(unsupportedContentType.status).toBe(400);
    await expect(unsupportedContentType.json()).resolves.toEqual({ code: "unsupported_content_type" });

    const widened = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-security",
        command_id: "command-security",
        goal: "Read the note.",
        profile: "pi",
        kernel: "pi",
      }),
    });
    expect(widened.status).toBe(400);
    await expect(widened.json()).resolves.toEqual({ code: "invalid_run_request" });

    const oversized = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-security",
        command_id: "command-security",
        goal: "x".repeat(1_024 * 1_024),
      }),
    });
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toEqual({ code: "body_too_large" });
  });

  test("rejects requests carrying a different Host header", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-preview-host-header-"));
    directories.push(directory);
    const service = await startPreviewHarnessService({ stateRoot: directory, workspaceRoot: directory });
    services.push(service);

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${service.url}/api/preview/settings`, {
        headers: { host: "127.0.0.1:1" },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolve({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.end();
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ code: "csrf_host_mismatch" });
  });

  test("does not treat an unknown API path as the application shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-preview-api-boundary-"));
    directories.push(directory);
    const service = await startPreviewHarnessService({ stateRoot: directory, workspaceRoot: directory });
    services.push(service);

    const response = await fetch(`${service.url}/api/chat/runs/submit`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "not_found" });
  });

  test("keeps the UI available while configured without an admitted OMP runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-preview-no-omp-"));
    directories.push(directory);
    const service = await startPreviewHarnessService({
      stateRoot: directory,
      workspaceRoot: directory,
      ompRuntimeRoot: "",
    });
    services.push(service);

    const settings = await fetch(`${service.url}/api/preview/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_name: "preview-model",
        model_endpoint: "https://provider.example/v1/chat/completions",
        workspace_root: directory,
        model_api_key: "fixture-key",
      }),
    });
    expect(settings.status).toBe(200);
    await expect(fetch(`${service.url}/api/preview/status`).then((response) => response.json())).resolves.toMatchObject({
      configured: true,
      ready: false,
      reason: "omp_runtime_unavailable",
    });
    const run = await fetch(`${service.url}/api/preview/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "no-omp-run", command_id: "no-omp-command", goal: "run" }),
    });
    expect(run.status).toBe(503);
    await expect(run.json()).resolves.toEqual({ code: "omp_unavailable" });
  });
});
