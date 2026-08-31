import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Anna Product packaged smoke currently supports macOS arm64 only");
}
const resourcesRoot = path.resolve(
  "release",
  "mac-arm64",
  "Anna.app",
  "Contents",
  "Resources",
);
const packagedExecutable = path.join(resourcesRoot, "..", "MacOS", "Anna");
const userDataPath = process.env.ANNA_ASAR_SMOKE_USER_DATA_PATH
  ?? mkdtempSync(path.join(tmpdir(), "anna-asar-smoke-"));

// `npm run desktop:smoke-asar` is normally invoked by the development Electron
// binary. Re-execute this same smoke through the packaged binary so process
// discovery and ELECTRON_RUN_AS_NODE behavior match an installed Anna build.
if (process.env.ANNA_PACKAGED_SMOKE !== "1") {
  if (!path.isAbsolute(packagedExecutable)) {
    throw new Error(`Invalid packaged Anna executable path: ${packagedExecutable}`);
  }
  const result = spawnSync(packagedExecutable, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: packagedSmokeEnv(userDataPath),
    stdio: "inherit",
  });
  if (result.error) {
    rmSync(userDataPath, { recursive: true, force: true });
    throw result.error;
  }
  rmSync(userDataPath, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

if (path.basename(process.execPath) !== "Anna") {
  throw new Error(`Packaged smoke must run with the branded Anna binary, received ${process.execPath}`);
}

const runtimeModuleUrl = pathToFileURL(
  path.join(resourcesRoot, "app.asar", "apps", "desktop", "electron", "runtime-service.mjs"),
).href;
const expectedProjectRoot = path.join(resourcesRoot, "app.asar.unpacked");

let runtime;

try {
  const { createDesktopRuntime, resolveProjectRoot } = await import(runtimeModuleUrl);
  const resolvedProjectRoot = resolveProjectRoot(runtimeModuleUrl);
  if (resolvedProjectRoot !== expectedProjectRoot) {
    throw new Error(
      `Expected project root ${expectedProjectRoot}, received ${resolvedProjectRoot}`,
    );
  }

  runtime = await createDesktopRuntime({
    userDataPath,
    healthTimeoutMs: 30_000,
  });
  const healthResponse = await fetch(`${runtime.apiBase}/health`);
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.status !== "ok" || health.protocol !== "anna-harness-product/1" || health.host !== "node") {
    throw new Error(`Product Host health check failed: ${JSON.stringify(health)}`);
  }
  if (typeof runtime.businessApiBase !== "string" || runtime.businessApiBase === "") {
    throw new Error("Product runtime did not start the managed business peer");
  }
  const businessHealthResponse = await fetch(`${runtime.businessApiBase}/api/health`);
  const businessHealth = await businessHealthResponse.json();
  if (!businessHealthResponse.ok || businessHealth.status !== "ok") {
    throw new Error(`Business peer health check failed: ${JSON.stringify(businessHealth)}`);
  }
  const indexResponse = await fetch(runtime.apiBase);
  const index = await indexResponse.text();
  if (!indexResponse.ok || !index.includes('<div id="root"></div>')) {
    throw new Error("Product Host did not serve the original application");
  }
  const statusResponse = await fetch(`${runtime.apiBase}/api/admin/runtime/status`);
  const status = await statusResponse.json();
  if (!statusResponse.ok || status.model?.configured !== false || status.model?.status !== "not_configured") {
    throw new Error(`Product Host should start without model configuration: ${JSON.stringify(status)}`);
  }
  const settingsResponse = await fetch(`${runtime.apiBase}/api/admin/runtime/config`);
  const settings = await settingsResponse.json();
  if (!settingsResponse.ok || settings.exists !== false || settings.secrets?.model_api_key_configured !== false) {
    throw new Error(`Product settings should be unconfigured without a key: ${JSON.stringify(settings)}`);
  }
  const unauthorized = await fetch(`${runtime.apiBase}/_harness/capabilities`);
  if (unauthorized.status !== 401) {
    throw new Error(`Product internal route accepted an unauthenticated request: ${unauthorized.status}`);
  }
  const capabilitiesResponse = await fetch(`${runtime.apiBase}/_harness/capabilities`, {
    headers: { "x-anna-service-token": runtime.serviceToken },
  });
  const capabilities = await capabilitiesResponse.json();
  if (!capabilitiesResponse.ok || capabilities.protocol !== "anna-harness-product/1") {
    throw new Error(`Product internal capabilities check failed: ${JSON.stringify(capabilities)}`);
  }

  console.log(
    JSON.stringify(
      {
        apiBase: runtime.apiBase,
        projectRoot: runtime.projectRoot,
        nodeExecutable: runtime.nodeExecutable,
        productEntryPath: runtime.entryPath,
        ompRuntimeRoot: runtime.ompRuntimeRoot,
        servedIndex: index.includes('<div id="root"></div>'),
        health,
        businessHealth,
        productStatus: status.model,
        capabilities: { protocol: capabilities.protocol, surfaces: capabilities.surfaces },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await runtime?.stop?.();
  rmSync(userDataPath, { recursive: true, force: true });
}

function packagedSmokeEnv(smokeUserDataPath) {
  const blocked = new Set([
    "ANNA_ASAR_SMOKE_USER_DATA_PATH",
    "ANNA_HARNESS_HOST_CONFIG_PATH",
    "ANNA_RUNTIME_CONFIG_PATH",
    "ANNA_HARNESS_BUSINESS_CONFIG_PATH",
    "ANNA_HARNESS_BUSINESS_ORIGIN",
    "ANNA_HARNESS_BUSINESS_ENABLED",
    "ANNA_HARNESS_HOST",
    "ANNA_HARNESS_HOST_PORT",
    "ANNA_HARNESS_BUSINESS_HOST",
    "ANNA_HARNESS_BUSINESS_PORT",
    "ANNA_HARNESS_STATE_ROOT",
    "ANNA_HARNESS_HOST_WORKSPACE_ROOT",
    "ANNA_HARNESS_HOST_STATIC_ROOT",
    "ANNA_HARNESS_HOST_ENTRY_PATH",
    "ANNA_HARNESS_OMP_RUNTIME_ROOT",
    "ANNA_HARNESS_HOST_EVENT_STORE_PATH",
    "ANNA_HARNESS_SESSION_STORE_PATH",
    "ANNA_HARNESS_RUNTIME_INFO_PATH",
    "ANNA_HARNESS_SERVICE_TOKEN",
    "ANNA_HARNESS_BUSINESS_SERVICE_TOKEN",
    "ANNA_PYTHON_BIN",
    "ANNA_NODE_BIN",
    "PYTHONPATH",
    "PYTHONHOME",
    "ANNA_MODEL_API_KEY",
    "ANNA_MODEL_ENDPOINT",
    "ANNA_MODEL_NAME",
    "ANNA_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "ANNA_OPENAI_API_KEY",
    "ANNA_DEEPSEEK_API_KEY",
    "MODEL_API_KEY",
    "MODEL_ENDPOINT",
    "MODEL_NAME",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
  ]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.has(key)),
  );
  return {
    ...inherited,
    ANNA_PACKAGED_SMOKE: "1",
    ANNA_ASAR_SMOKE_USER_DATA_PATH: smokeUserDataPath,
    ANNA_HARNESS_HOST_CONFIG_PATH: path.join(smokeUserDataPath, "config", "host.json"),
    ANNA_HARNESS_BUSINESS_CONFIG_PATH: path.join(smokeUserDataPath, "config", "business.json"),
    ANNA_HARNESS_BUSINESS_ENABLED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
}
