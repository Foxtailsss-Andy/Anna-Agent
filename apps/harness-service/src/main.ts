import { randomUUID } from "node:crypto";

import { createLiveHarnessV2Runtime } from "./production";
import { ProductSessionStore, productSurfaces } from "./product-session";
import { startProductHost } from "./product-facade";
import { readProductConfig } from "./product-config";

const serviceToken = process.env.ANNA_HARNESS_SERVICE_TOKEN?.trim() || randomUUID();
const hostConfigPath = process.env.ANNA_HARNESS_HOST_CONFIG_PATH?.trim()
  || process.env.ANNA_RUNTIME_CONFIG_PATH?.trim();
const businessOrigin = process.env.ANNA_HARNESS_BUSINESS_ORIGIN?.trim();
const sessionStore = new ProductSessionStore(process.env.ANNA_HARNESS_SESSION_STORE_PATH);
const hostConfig = await readProductConfig(hostConfigPath);
const modelProfiles = modelProfilesFromConfig(hostConfig);
const agentDirectives = agentDirectivesFromConfig(hostConfig);

let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
let service!: Awaited<ReturnType<typeof startProductHost>>;
try {
  live = await createLiveHarnessV2Runtime({
    ...(hostConfigPath === undefined ? {} : { runtimeConfigPath: hostConfigPath }),
    ...(process.env.ANNA_HARNESS_HOST_EVENT_STORE_PATH === undefined
      ? {}
      : { eventStorePath: process.env.ANNA_HARNESS_HOST_EVENT_STORE_PATH }),
    ...(process.env.ANNA_HARNESS_HOST_WORKSPACE_ROOT === undefined
      ? {}
      : { workspaceRoot: process.env.ANNA_HARNESS_HOST_WORKSPACE_ROOT }),
    ...(process.env.ANNA_HARNESS_OMP_RUNTIME_ROOT === undefined
      ? {}
      : { ompRuntimeRoot: process.env.ANNA_HARNESS_OMP_RUNTIME_ROOT }),
    requireOmp: true,
    allowUnconfigured: true,
    surfaces: ["chat", "create", "hiker", "reimbursement", "crew", "hub"],
    ...(businessOrigin === undefined ? {} : {
      businessOrigin,
      businessServiceToken: process.env.ANNA_HARNESS_BUSINESS_SERVICE_TOKEN ?? serviceToken,
    }),
    productTaskFor: async (runId: string) => (await sessionStore.get(runId))?.task,
    productTaskPeek: (runId: string) => sessionStore.peek(runId)?.task,
    modelProfiles,
    agentDirectives,
  });
  service = await startProductHost({
    runtime: live.runtime,
    eventStore: live.eventStore,
    host: process.env.ANNA_HARNESS_HOST ?? "127.0.0.1",
    port: parsePort(process.env.ANNA_HARNESS_HOST_PORT),
    staticRoot: process.env.ANNA_HARNESS_HOST_STATIC_ROOT,
    runtimeConfigPath: hostConfigPath,
    serviceToken,
    sessionStore,
    ...(businessOrigin === undefined ? {} : { businessOrigin }),
    businessServiceToken: process.env.ANNA_HARNESS_BUSINESS_SERVICE_TOKEN,
  });
} catch (error) {
  await live?.close();
  throw error;
}

process.stdout.write(JSON.stringify({ status: "ready", url: service.url, surfaces: [...productSurfaces] }) + "\n");

const shutdown = async () => {
  await service.close();
  await live?.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ANNA_HARNESS_V2_PORT must be a valid TCP port");
  }
  return port;
}

function modelProfilesFromConfig(config: Record<string, unknown>): Record<string, {
  model_name: string;
  endpoint?: string;
  api_key?: string;
}> {
  if (!Array.isArray(config.model_profiles)) return {};
  const profiles: Record<string, { model_name: string; endpoint?: string; api_key?: string }> = {};
  for (const item of config.model_profiles) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const profile = item as Record<string, unknown>;
    if (typeof profile.id !== "string" || typeof profile.model_name !== "string" || profile.model_name.trim() === "") continue;
    profiles[profile.id] = {
      model_name: profile.model_name.trim(),
      ...(typeof profile.endpoint === "string" && profile.endpoint.trim() !== "" ? { endpoint: profile.endpoint.trim() } : {}),
      ...(typeof profile.api_key === "string" && profile.api_key.trim() !== "" ? { api_key: profile.api_key } : {}),
    };
  }
  return profiles;
}

function agentDirectivesFromConfig(config: Record<string, unknown>): Record<string, string> {
  if (typeof config.agent_directives !== "object" || config.agent_directives === null || Array.isArray(config.agent_directives)) return {};
  return Object.fromEntries(
    Object.entries(config.agent_directives)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim() !== "")
      .map(([key, value]) => [key, value.trim()]),
  );
}
