import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

import { InMemoryEventStore } from "@anna/event-store";
import { startProductHost } from "../src/product-facade";
import { publicProductConfig, readProductConfig, writeProductConfig } from "../src/product-config";
import { ProductSessionStore } from "../src/product-session";

const cleanup: string[] = [];
const services: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("Host-owned model settings persist secrets without returning them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-product-config-"));
  cleanup.push(directory);
  const configPath = join(directory, "host.json");

  await expect(readProductConfig(configPath)).resolves.toEqual({});
  await writeProductConfig(configPath, {
    model_provider: "openai-compatible",
    model_endpoint: "https://provider.example/v1/chat/completions",
    model_name: "deepseek-v4-pro",
    model_api_key: "fixture-host-key",
  });

  const raw = await readFile(configPath, "utf8");
  expect(raw).toContain("fixture-host-key");
  const publicConfig = publicProductConfig(configPath, await readProductConfig(configPath));
  expect(publicConfig).toMatchObject({
    values: { model_name: "deepseek-v4-pro" },
    secrets: { model_api_key_configured: true },
  });
  expect(JSON.stringify(publicConfig)).not.toContain("fixture-host-key");
});

test("Host rejects a ProductTask workdir that aliases protected runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-product-workdir-"));
  cleanup.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const configPath = join(workspace, "host.json");
  await writeFile(configPath, "{}\n");
  const runtime = {
    evidenceMode: "test" as const,
    surfaces: ["chat"] as const,
    async start() {
      return { runId: "run", status: "queued" as const };
    },
  };
  const service = await startProductHost({
    runtime,
    eventStore: new InMemoryEventStore(),
    staticRoot: directory,
    runtimeConfigPath: configPath,
    serviceToken: "fixture-service-token",
    sessionStore: new ProductSessionStore(),
  });
  services.push(service);

  const response = await fetch(`${service.url}/_harness/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-anna-service-token": "fixture-service-token",
    },
    body: JSON.stringify({
      run_id: "run-protected-workdir",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Read the protected file.",
      workdir_path: workspace,
    }),
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ code: "workdir_protected_path" });
});

test("Product Settings remains readable before model configuration and owns model writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-product-settings-"));
  cleanup.push(directory);
  const configPath = join(directory, "config", "host.json");
  const runtime = {
    evidenceMode: "live" as const,
    surfaces: ["chat"] as const,
    async start() {
      return { runId: "run", status: "queued" as const };
    },
  };
  const service = await startProductHost({
    runtime,
    eventStore: new InMemoryEventStore(),
    staticRoot: directory,
    runtimeConfigPath: configPath,
    serviceToken: "fixture-service-token",
    sessionStore: new ProductSessionStore(),
  });
  services.push(service);

  const initial = await fetch(`${service.url}/api/admin/runtime/config`);
  expect(initial.status).toBe(200);
  await expect(initial.json()).resolves.toMatchObject({
    exists: false,
    secrets: { model_api_key_configured: false },
  });

  const update = await fetch(`${service.url}/api/admin/runtime/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model_provider: "openai-compatible",
      model_endpoint: "https://provider.example/v1/chat/completions",
      model_name: "deepseek-v4-pro",
      model_api_key: "fixture-host-key",
    }),
  });
  expect(update.status).toBe(200);
  const publicUpdate = await update.json();
  expect(publicUpdate.secrets.model_api_key_configured).toBe(true);
  expect(JSON.stringify(publicUpdate)).not.toContain("fixture-host-key");
  expect(await readFile(configPath, "utf8")).toContain("fixture-host-key");
});
