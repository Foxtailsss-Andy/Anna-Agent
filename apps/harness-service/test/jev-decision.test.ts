import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryEventStore } from "@anna/event-store";
import { afterEach, describe, expect, test, vi } from "vitest";

import { decideAssignee } from "../src/jev-decision";
import { startProductHost } from "../src/product-facade";
import { readRegisteredWorkdirFile } from "../src/workbench-files";

const services: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Jev decision Host seam", () => {
  test("rejects a missing or incorrect service token before any provider call", async () => {
    const { service, providerTransport, body } = await startDecisionHost();

    const missing = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ code: "service_token_required" });

    const incorrect = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "wrong-token" },
      body: JSON.stringify(body),
    });
    expect(incorrect.status).toBe(401);
    await expect(incorrect.json()).resolves.toEqual({ code: "service_token_required" });
    expect(providerTransport).not.toHaveBeenCalled();
  });

  test("returns an explicit unavailable result when Jev is not configured without invoking the main model", async () => {
    vi.stubEnv("ANNA_JEV_ENABLED", "0");
    const { service, providerTransport, body, mainModelStart } = await startDecisionHost();

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      decision_id: body.decision_id,
      status: "unavailable",
      member_id: null,
      source: "none",
      reason_code: "jev_unavailable",
      meta: {
        requested_model: "jev-1.13.0",
        returned_model: null,
        provider_calls: 0,
        retry_count: 0,
        error_code: "jev_unavailable",
      },
    });
    expect(providerTransport).not.toHaveBeenCalled();
    expect(mainModelStart).not.toHaveBeenCalled();
  });

  test("sends the official Choice wire once and maps a valid candidate", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async ({ endpoint, apiKey, body }: { endpoint: string; apiKey: string; body: Record<string, unknown> }) => {
      expect(endpoint).toBe("https://api.typesafe.ai/v1/systemone");
      expect(apiKey).toBe("fixture-secret");
      expect(body).toMatchObject({
        model: "jev-1.13.0",
        questions: {
          assignee: {
            type: "choice",
            criteria: { c1: expect.any(String), abstain: expect.any(String) },
          },
        },
      });
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: { assignee: { type: "choice", choice: "c1", probabilities: { c1: 0.9, abstain: 0.1 }, confidence: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "suggested",
      member_id: "c1",
      source: "jev",
      meta: { input_tokens: 10, output_tokens: 2, provider_calls: 1, retry_count: 0 },
    });
    expect(providerTransport).toHaveBeenCalledTimes(1);
  });

  test("accepts a valid Choice when provider probability metadata is absent", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { assignee: { type: "choice", choice: "c1" } },
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200 }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "suggested",
      member_id: "c1",
      meta: { probabilities: null, confidence: null, input_tokens: 10, output_tokens: 2 },
    });
  });

  test("cancels a response that arrives after the provider signal was aborted", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    let resolveLate!: (response: Response) => void;
    let cancelCount = 0;
    const providerTransport = vi.fn(async () => await new Promise<Response>((resolve) => { resolveLate = resolve; }));
    const { body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const abortController = new AbortController();
    const pending = decideAssignee(body, {
      enabled: "1",
      apiKeyFile: keyFile,
      signal: abortController.signal,
      transport: providerTransport,
    });
    for (let attempt = 0; attempt < 50 && providerTransport.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    abortController.abort();
    await expect(pending).resolves.toMatchObject({ status: "unavailable", reason_code: "jev_timeout" });
    const lateBody = { cancel() { cancelCount += 1; return Promise.resolve(); } };
    resolveLate({ status: 401, ok: false, headers: new Headers(), body: lateBody } as unknown as Response);
    for (let attempt = 0; attempt < 50 && cancelCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cancelCount).toBe(1);
  });

  test("does not wait for a provider body cancel that never settles", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    let cancelCount = 0;
    const neverSettlingBody = new ReadableStream<Uint8Array>({ cancel() { cancelCount += 1; return new Promise<void>(() => {}); } });
    const providerTransport = vi.fn(async () => new Response(neverSettlingBody, { status: 401 }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const started = Date.now();
    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(cancelCount).toBe(1);
    await expect(response.json()).resolves.toMatchObject({ reason_code: "jev_auth_failed" });
  });

  test("does not wait for a never-settling cancel after an oversized provider body", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    let cancelCount = 0;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(70 * 1024)); },
      cancel() { cancelCount += 1; return new Promise<void>(() => {}); },
    });
    const providerTransport = vi.fn(async () => new Response(oversizedBody, { status: 200 }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const started = Date.now();
    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(cancelCount).toBe(1);
    await expect(response.json()).resolves.toMatchObject({ reason_code: "invalid_response" });
  });

  test("cancels an unstarted provider reader when abort wins the first-read microtask race", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const abortController = new AbortController();
    let bodyCancelCount = 0;
    let body: ReadableStream<Uint8Array> | undefined;
    const providerTransport = vi.fn(async () => {
      body = new ReadableStream<Uint8Array>({
        cancel() { bodyCancelCount += 1; },
      });
      queueMicrotask(() => queueMicrotask(() => abortController.abort()));
      return new Response(body, { status: 200 });
    });
    const { body: input } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const result = await decideAssignee(input, {
      enabled: "1",
      apiKeyFile: keyFile,
      signal: abortController.signal,
      transport: providerTransport,
    });
    expect(result).toMatchObject({ status: "unavailable", reason_code: "jev_timeout" });
    expect(abortController.signal.aborted).toBe(true);
    expect(bodyCancelCount).toBe(1);
    expect(body?.locked).toBe(false);
  });

  test("keeps the provider request id on malformed JSON in HTTP and telemetry metadata", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const telemetry = vi.fn();
    const providerTransport = vi.fn(async () => new Response("{malformed", {
      status: 200,
      headers: { "x-request-id": "fixture-id" },
    }));
    const { service, body } = await startDecisionHost(providerTransport, telemetry);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { meta: { provider_request_id: string | null } };
    expect(result.meta.provider_request_id).toBe("fixture-id");
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ provider_request_id: "fixture-id" }) }));
  });

  test("retains one provider call in a normalized provider failure", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async () => new Response("", { status: 401 }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      reason_code: "jev_auth_failed",
      meta: { provider_calls: 1, error_code: "jev_auth_failed" },
    });
    expect(providerTransport).toHaveBeenCalledTimes(1);
  });

  test("maps local Choice ids back when real member ids use reserved object keys", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
      const state = body.state as { candidates: Array<{ id: string }> };
      expect(state.candidates.map((candidate) => candidate.id)).toEqual(["c1", "c2"]);
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: { assignee: { type: "choice", choice: "c2", probabilities: { c1: 0.1, c2: 0.8, abstain: 0.1 } } },
      }), { status: 200 });
    });
    const { service, body } = await startDecisionHost(providerTransport);
    body.state.candidates = [
      { id: "abstain", role: "engineering", kind: "agent" },
      { id: "__proto__", role: "engineering", kind: "human" },
    ];
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "suggested", member_id: "__proto__" });
  });

  test("returns a bounded timeout while a provider transport ignores AbortSignal", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response("{}", { status: 200 });
    });
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const started = Date.now();
    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(4_700);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      reason_code: "jev_timeout",
      meta: { provider_calls: 1, error_code: "jev_timeout" },
    });
  }, 7_000);

  test("rejects a widened input body before dispatching Jev", async () => {
    const { service, providerTransport, body } = await startDecisionHost();
    const oversized = { ...body, state: { ...body.state, project_goal: "x".repeat(40_000) } };

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(oversized),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ code: "input_too_large" });
    expect(providerTransport).not.toHaveBeenCalled();
  });

  test("abstains without a provider call when no candidates are present", async () => {
    const { service, providerTransport, body } = await startDecisionHost();
    body.state.candidates = [];

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "abstained",
      member_id: null,
      reason_code: "no_candidates",
      source: "none",
      meta: { provider_calls: 0 },
    });
    expect(providerTransport).not.toHaveBeenCalled();
  });

  test("rejects the fifth in-flight request and reuses a released slot", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const providerTransport = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ answers: { assignee: { type: "choice", choice: "abstain", probabilities: { c1: 0, abstain: 1 } } } }), { status: 200 });
    });
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const requests = Array.from({ length: 4 }, () => fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    }));
    for (let attempt = 0; attempt < 50 && providerTransport.mock.calls.length < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const busy = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(busy.status).toBe(429);
    await expect(busy.json()).resolves.toEqual({ code: "jev_busy" });
    release();
    expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true);

    const recovered = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(recovered.status).toBe(200);
    expect(providerTransport).toHaveBeenCalledTimes(5);
  });

  test("normalizes an oversized or malformed provider response without leaking its body", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async () => new Response(`{"answers":{},"junk":"${"x".repeat(70_000)}"}`, { status: 200 }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ status: "unavailable", reason_code: "invalid_response", meta: { provider_calls: 1 } });
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
  });

  test("rejects duplicate provider answer keys as invalid response", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const duplicate = '{"model":"jev-1.13.0","answers":{"assignee":{"type":"choice","choice":"c1","probabilities":{"c1":1,"abstain":0},"choice":"abstain"}}}';
    const providerTransport = vi.fn(async () => new Response(duplicate, { status: 200 }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", reason_code: "invalid_response" });
  });

  test("propagates client cancellation to the provider signal and releases the slot", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const signals: AbortSignal[] = [];
    const providerTransport = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response("{}", { status: 200 });
    });
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const abortController = new AbortController();
    const pending = fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      signal: abortController.signal,
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    for (let attempt = 0; attempt < 50 && signals.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    abortController.abort();
    await expect(pending).rejects.toThrow();
    for (let attempt = 0; attempt < 50 && !signals[0]?.aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(signals[0]?.aborted).toBe(true);
  });

  test("bounds a request whose body never finishes", async () => {
    const { service, providerTransport } = await startDecisionHost();
    const started = Date.now();
    let clientRequest: ReturnType<typeof httpRequest> | undefined;
    const result = await new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
      const request = clientRequest = httpRequest(`${service.url}/_harness/crew/assignee-decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token", connection: "keep-alive" },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const result = { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), connection: response.headers.connection };
          clientRequest?.destroy();
          resolve(result);
        });
      });
      request.on("error", reject);
      request.write("{\"schema_version\":1,");
    });
    expect(Date.now() - started).toBeLessThan(4_700);
    expect(result.status).toBe(408);
    expect(result.connection).toBe("close");
    expect(JSON.parse(result.body)).toEqual({ code: "jev_timeout" });
    expect(providerTransport).not.toHaveBeenCalled();
    const closeStarted = Date.now();
    await service.close();
    expect(Date.now() - closeStarted).toBeLessThan(1_000);
  }, 7_000);

  test("closes an incomplete keep-alive request when the Host is closed", async () => {
    const { service, providerTransport } = await startDecisionHost();
    let clientRequest: ReturnType<typeof httpRequest> | undefined;
    const responsePromise = new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const request = clientRequest = httpRequest(`${service.url}/_harness/crew/assignee-decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token", connection: "keep-alive" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0, connection: response.headers.connection }));
      });
      request.on("error", reject);
      request.write("{\"schema_version\":1,");
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const closeStarted = Date.now();
    const closeResult = await Promise.race([
      service.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    try {
      expect(closeResult).toBe(true);
      expect(Date.now() - closeStarted).toBeLessThan(1_000);
      await expect(responsePromise).resolves.toMatchObject({ status: 503, connection: "close" });
      expect(providerTransport).not.toHaveBeenCalled();
    } finally {
      clientRequest?.destroy();
    }
  }, 7_000);

  test("closes an incomplete keep-alive request rejected by the body limit", async () => {
    const { service, providerTransport } = await startDecisionHost();
    const result = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const request = httpRequest(`${service.url}/_harness/crew/assignee-decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-anna-service-token": "test-service-token",
          "content-length": "40000",
          connection: "keep-alive",
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0, connection: response.headers.connection }));
      });
      request.on("error", reject);
      request.write("{");
    });
    expect(result).toEqual({ status: 413, connection: "close" });
    expect(providerTransport).not.toHaveBeenCalled();
    const closeStarted = Date.now();
    await service.close();
    expect(Date.now() - closeStarted).toBeLessThan(1_000);
  });

  test("closes an oversized chunked keep-alive request without Content-Length", async () => {
    const { service, providerTransport } = await startDecisionHost();
    const result = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const request = httpRequest(`${service.url}/_harness/crew/assignee-decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token", connection: "keep-alive" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0, connection: response.headers.connection }));
      });
      request.on("error", reject);
      request.write(Buffer.alloc(40_000, "x"));
    });
    expect(result).toEqual({ status: 413, connection: "close" });
    expect(providerTransport).not.toHaveBeenCalled();
    const closeStarted = Date.now();
    await service.close();
    expect(Date.now() - closeStarted).toBeLessThan(1_000);
  });

  test("rejects provider state over 16 KiB while the HTTP body remains under 32 KiB", async () => {
    const { service, providerTransport, body } = await startDecisionHost();
    body.state.task.description = "x".repeat(17_000);
    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    await expect(response.json()).resolves.toEqual({ code: "input_too_large" });
    expect(providerTransport).not.toHaveBeenCalled();
  });

  test("closes a keep-alive request rejected by the four-slot busy gate", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const providerTransport = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ answers: { assignee: { type: "choice", choice: "abstain", probabilities: { c1: 0, abstain: 1 } } } }), { status: 200 });
    });
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);
    const requests = Array.from({ length: 4 }, () => fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    }));
    for (let attempt = 0; attempt < 50 && providerTransport.mock.calls.length < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const busy = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const request = httpRequest(`${service.url}/_harness/crew/assignee-decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token", connection: "keep-alive" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0, connection: response.headers.connection }));
      });
      request.on("error", reject);
      request.write("{");
    });
    expect(busy).toEqual({ status: 429, connection: "close" });
    release();
    await Promise.all(requests);
    await service.close();
  }, 7_000);

  test("keeps the Jev key path outside the production file capability", async () => {
    const protectedDirectory = await mkdtemp(join(tmpdir(), "anna-jev-protected-"));
    directories.push(protectedDirectory);
    const keyFile = join(protectedDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const result = await readRegisteredWorkdirFile(
      { path: "typesafe.key", offset: 0, limit: 100 },
      {
        origin: "http://business.local",
        workspaceId: "workspace-1",
        actorUserId: "actor-1",
        resourceRefs: ["workdir:preview"],
        protectedPaths: [keyFile],
        fetchImpl: async () => new Response(JSON.stringify({ workdir_id: "preview", workdir_path: protectedDirectory }), { status: 200 }),
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ status: "failed", output: { reason: "workdir_protected_path" } });
  });

  test("abstains when the chosen candidate has indistinguishable role and kind", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const providerTransport = vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { assignee: { type: "choice", choice: "c1", probabilities: { c1: 0.8, c2: 0.1, abstain: 0.1 }, confidence: 0.8 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200 }));
    const telemetry = vi.fn();
    const { service, body } = await startDecisionHost(providerTransport, telemetry);
    body.state.candidates = [
      { id: "member-a", role: "engineering", kind: "agent" },
      { id: "member-b", role: "engineering", kind: "agent" },
    ];
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "abstained",
      member_id: null,
      reason_code: "insufficient_information",
      source: "jev",
      meta: { provider_calls: 1, input_tokens: 10, output_tokens: 2 },
    });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      raw_choice: "c1",
      final_member_id: null,
      raw_probabilities: { c1: 0.8, c2: 0.1, abstain: 0.1 },
    }));
  });

  test("closes a non-2xx provider response whose body never finishes", async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "anna-jev-key-"));
    directories.push(keyDirectory);
    const keyFile = join(keyDirectory, "typesafe.key");
    await writeFile(keyFile, "fixture-secret\n", { mode: 0o600 });
    const provider = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain", connection: "keep-alive" });
      response.write("provider error body that intentionally never ends");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("provider did not bind");
    const providerUrl = `http://127.0.0.1:${address.port}`;
    const providerTransport = vi.fn(async ({ signal }: { signal: AbortSignal }) => fetch(providerUrl, { signal }));
    const { service, body } = await startDecisionHost(providerTransport);
    vi.stubEnv("ANNA_JEV_ENABLED", "1");
    vi.stubEnv("ANNA_JEV_API_KEY_FILE", keyFile);

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`${service.url}/_harness/crew/assignee-decision`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-anna-service-token": "test-service-token" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ reason_code: "jev_auth_failed", meta: { provider_calls: 1 } });
      }
      for (let attempt = 0; attempt < 40 && await openConnections(provider) !== 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await openConnections(provider)).toBe(0);
      await service.close();
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});

function openConnections(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => server.getConnections((_error, count) => resolve(count)));
}

async function startDecisionHost(providerTransport = vi.fn(async () => {
  throw new Error("provider must not be called");
}), telemetry?: (record: unknown) => void) {
  const directory = await mkdtemp(join(tmpdir(), "anna-jev-host-"));
  directories.push(directory);
  await writeFile(join(directory, "index.html"), "<div id=\"root\"></div>\n");
  const mainModelStart = vi.fn(async () => {
    throw new Error("main model must not be called by Jev decision route");
  });
  const runtime = {
    evidenceMode: "test" as const,
    surfaces: ["crew"] as const,
    start: mainModelStart,
    async readEvents() { return []; },
    async stop() { return { status: "cancelled" }; },
  };
  const service = await startProductHost({
    runtime,
    eventStore: new InMemoryEventStore(),
    staticRoot: directory,
    serviceToken: "test-service-token",
    jevTransport: providerTransport,
    jevTelemetry: telemetry,
  });
  services.push(service);
  return {
    service,
    providerTransport,
    mainModelStart,
    body: {
      schema_version: 1,
      decision_id: "550e8400-e29b-41d4-a716-446655440000",
      workspace_id: "workspace-1",
      actor_user_id: "actor-1",
      project_id: "project-1",
      task_id: "task-1",
      input_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      question_version: "crew-assignee-v1",
      state: {
        project_goal: "Ship the preview",
        task: {
          title: "Implement the decision",
          description: "Add the bounded Host decision seam.",
          role_required: "engineering",
          acceptance_criteria: "The Host returns a typed result.",
        },
        candidates: [{ id: "c1", role: "engineering", kind: "agent" }],
      },
    },
  };
}
