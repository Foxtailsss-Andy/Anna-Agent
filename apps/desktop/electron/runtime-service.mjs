import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_HOST = "127.0.0.1";
const DEFAULT_API_PORT = 18765;

export function resolveProjectRoot(currentFileUrl = import.meta.url) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(currentFileUrl)), "../../..");
  return projectRoot.endsWith(".asar") ? `${projectRoot}.unpacked` : projectRoot;
}

export function resolveNodeExecutable(env = process.env) {
  return env.ANNA_NODE_BIN || process.execPath;
}

export function assertPreviewPlatform(
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("Anna Harness Preview currently supports macOS arm64 only");
  }
}

export function createPreviewRuntimeConfig({
  projectRoot = resolveProjectRoot(),
  userDataPath,
  apiPort,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!userDataPath) {
    throw new Error("userDataPath is required for Anna Preview runtime");
  }
  assertPreviewPlatform(platform, arch);

  const host = env.ANNA_PREVIEW_HOST ?? API_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error("Anna Preview Host must bind to a loopback address");
  }
  const port = apiPort === undefined
    ? parseOptionalPort(env.ANNA_PREVIEW_PORT) ?? DEFAULT_API_PORT
    : parsePort(apiPort, "apiPort");
  const stateRoot = env.ANNA_PREVIEW_STATE_ROOT ?? path.join(userDataPath, "preview");
  const configPath = env.ANNA_PREVIEW_CONFIG_PATH ?? path.join(stateRoot, "config.json");
  const workspaceRoot = env.ANNA_PREVIEW_WORKSPACE_ROOT ?? path.join(stateRoot, "workspace");
  const staticRoot = env.ANNA_PREVIEW_STATIC_ROOT ?? path.join(projectRoot, "dist");
  const ompRuntimeRoot = env.ANNA_PREVIEW_OMP_RUNTIME_ROOT
    ?? path.join(projectRoot, "build", "omp-runtime", "darwin-arm64");
  const entryPath = env.ANNA_PREVIEW_ENTRY_PATH
    ?? path.join(projectRoot, "apps", "harness-service", "dist", "preview-main.js");
  const runtimeInfoPath = env.ANNA_PREVIEW_RUNTIME_INFO_PATH
    ?? path.join(userDataPath, "preview-runtime-info.json");

  // Preview deliberately does not inherit legacy Python/Harness bridge selectors.
  // The Host receives only the new, explicit path contract plus ordinary process env.
  const {
    ANNA_RUNTIME_CONFIG_PATH: _legacyConfigPath,
    ANNA_STATE_DB_PATH: _legacyStateDbPath,
    ANNA_HARNESS_V2_BRIDGE_ENABLED: _legacyBridgeEnabled,
    ANNA_HARNESS_V2_BRIDGE_MANAGED: _legacyBridgeManaged,
    ANNA_HARNESS_V2_BRIDGE_ORIGIN: _legacyBridgeOrigin,
    ANNA_HARNESS_V2_PORT: _legacyBridgePort,
    ANNA_HARNESS_V2_EVENT_STORE_PATH: _legacyEventStorePath,
    ANNA_PYTHON_BIN: _legacyPythonBin,
    ...ordinaryEnv
  } = env;
  const runtimeEnv = {
    ...ordinaryEnv,
    ANNA_PREVIEW_HOST: host,
    ANNA_PREVIEW_PORT: String(port),
    ANNA_PREVIEW_ENTRY_PATH: entryPath,
    ANNA_PREVIEW_CONFIG_PATH: configPath,
    ANNA_PREVIEW_STATE_ROOT: stateRoot,
    ANNA_PREVIEW_WORKSPACE_ROOT: workspaceRoot,
    ANNA_PREVIEW_STATIC_ROOT: staticRoot,
    ANNA_PREVIEW_OMP_RUNTIME_ROOT: ompRuntimeRoot,
  };

  return {
    projectRoot,
    userDataPath,
    host,
    port,
    apiHost: host,
    apiPort: port,
    apiBase: `http://${host}:${port}`,
    nodeExecutable: resolveNodeExecutable(env),
    entryPath,
    args: [entryPath],
    env: runtimeEnv,
    configPath,
    stateRoot,
    workspaceRoot,
    staticRoot,
    ompRuntimeRoot,
    runtimeInfoPath,
  };
}

/**
 * The normal desktop process is the Product Host. Preview remains available as
 * an explicit legacy test helper, but it is never the default launcher path.
 */
export function createProductRuntimeConfig({
  projectRoot = resolveProjectRoot(),
  userDataPath,
  apiPort,
  businessPort,
  env = process.env,
} = {}) {
  if (!userDataPath) throw new Error("userDataPath is required for Anna Product Host runtime");
  const host = env.ANNA_HARNESS_HOST ?? API_HOST;
  if (!isLoopbackHost(host)) throw new Error("Anna Product Host must bind to a loopback address");
  const port = apiPort === undefined
    ? parseOptionalPort(env.ANNA_HARNESS_HOST_PORT, "ANNA_HARNESS_HOST_PORT") ?? DEFAULT_API_PORT
    : parsePort(apiPort, "apiPort");
  const stateRoot = env.ANNA_HARNESS_STATE_ROOT ?? path.join(userDataPath, "harness");
  const hostConfigPath = env.ANNA_HARNESS_HOST_CONFIG_PATH
    ?? env.ANNA_RUNTIME_CONFIG_PATH
    ?? path.join(userDataPath, "config", "host.json");
  const businessConfigPath = env.ANNA_HARNESS_BUSINESS_CONFIG_PATH
    ?? path.join(userDataPath, "config", "business.json");
  const businessOriginConfigured = Boolean(env.ANNA_HARNESS_BUSINESS_ORIGIN);
  const businessManaged = env.ANNA_HARNESS_BUSINESS_ENABLED !== "0" && !businessOriginConfigured;
  const businessEnabled = businessManaged || businessOriginConfigured;
  const resolvedBusinessPort = businessPort
    ?? parseOptionalPort(env.ANNA_HARNESS_BUSINESS_PORT, "ANNA_HARNESS_BUSINESS_PORT")
    ?? DEFAULT_API_PORT + 1;
  const hostEntryPath = env.ANNA_HARNESS_HOST_ENTRY_PATH
    ?? path.join(projectRoot, "apps", "harness-service", "dist", "main.js");
  const staticRoot = env.ANNA_HARNESS_HOST_STATIC_ROOT ?? path.join(projectRoot, "dist");
  const ompRuntimeRoot = env.ANNA_HARNESS_OMP_RUNTIME_ROOT
    ?? path.join(projectRoot, "build", "omp-runtime", "darwin-arm64");
  const eventStorePath = env.ANNA_HARNESS_HOST_EVENT_STORE_PATH
    ?? path.join(stateRoot, "events.sqlite3");
  const sessionStorePath = env.ANNA_HARNESS_SESSION_STORE_PATH
    ?? path.join(stateRoot, "sessions.json");
  const serviceToken = env.ANNA_HARNESS_SERVICE_TOKEN ?? randomUUID();
  const hostOrigin = `http://${host}:${port}`;
  const businessOrigin = env.ANNA_HARNESS_BUSINESS_ORIGIN
    ?? (businessEnabled ? `http://${host}:${resolvedBusinessPort}` : undefined);

  // Do not inherit the old Python Agent selectors into the Node Host.
  const {
    ANNA_PREVIEW_HOST: _previewHost,
    ANNA_PREVIEW_PORT: _previewPort,
    ANNA_PREVIEW_ENTRY_PATH: _previewEntryPath,
    ANNA_PREVIEW_CONFIG_PATH: _previewConfigPath,
    ANNA_PREVIEW_STATE_ROOT: _previewStateRoot,
    ANNA_PREVIEW_WORKSPACE_ROOT: _previewWorkspaceRoot,
    ANNA_PREVIEW_STATIC_ROOT: _previewStaticRoot,
    ANNA_PREVIEW_OMP_RUNTIME_ROOT: _previewOmpRuntimeRoot,
    ANNA_HARNESS_V2_BRIDGE_ENABLED: _legacyBridgeEnabled,
    ANNA_HARNESS_V2_BRIDGE_MANAGED: _legacyBridgeManaged,
    ANNA_HARNESS_V2_BRIDGE_ORIGIN: _legacyBridgeOrigin,
    ANNA_HARNESS_V2_PORT: _legacyBridgePort,
    ANNA_HARNESS_V2_EVENT_STORE_PATH: _legacyBridgeEventStore,
    ANNA_HARNESS_HOST_CONFIG_PATH: _hostConfigPath,
    ANNA_HARNESS_HOST_EVENT_STORE_PATH: _hostEventStorePath,
    ANNA_HARNESS_HOST_WORKSPACE_ROOT: _hostWorkspaceRoot,
    ANNA_HARNESS_HOST_STATIC_ROOT: _hostStaticRoot,
    ANNA_HARNESS_HOST_ENTRY_PATH: _hostEntryPath,
    ANNA_HARNESS_HOST_PORT: _hostPort,
    ANNA_HARNESS_OMP_RUNTIME_ROOT: _hostOmpRuntimeRoot,
    ANNA_HARNESS_SESSION_STORE_PATH: _hostSessionStorePath,
    ANNA_HARNESS_BUSINESS_CONFIG_PATH: _businessConfigPath,
    ANNA_HARNESS_HOST_ORIGIN: _hostOrigin,
    ANNA_HARNESS_HOST_URL: _hostUrl,
    ANNA_HARNESS_BUSINESS_ORIGIN: _businessOrigin,
    ANNA_PYTHON_BIN: _pythonBin,
    ANNA_MODEL_API_KEY: _modelApiKey,
    ANNA_MODEL_ENDPOINT: _modelEndpoint,
    ANNA_MODEL_NAME: _modelName,
    ANNA_API_KEY: _annaApiKey,
    OPENAI_API_KEY: _openAiApiKey,
    DEEPSEEK_API_KEY: _deepSeekApiKey,
    ANNA_OPENAI_API_KEY: _annaOpenAiApiKey,
    ANNA_DEEPSEEK_API_KEY: _annaDeepSeekApiKey,
    MODEL_API_KEY: _modelApiKeyGeneric,
    MODEL_ENDPOINT: _modelEndpointGeneric,
    MODEL_NAME: _modelNameGeneric,
    OPENAI_BASE_URL: _openAiBaseUrl,
    ANTHROPIC_API_KEY: _anthropicApiKey,
    ANNA_RUNTIME_CONFIG_PATH: _runtimeConfigPath,
    ANNA_STATE_DB_PATH: _stateDbPath,
    ANNA_RUNS_DB_PATH: _runsDbPath,
    ANNA_MEMORY_DB_PATH: _memoryDbPath,
    ...ordinaryEnv
  } = env;
  const hostWorkspaceRoot = env.ANNA_HARNESS_HOST_WORKSPACE_ROOT ?? path.join(stateRoot, "workspace");
  const hostEnv = {
    ...ordinaryEnv,
    ANNA_RUNTIME_CONFIG_PATH: hostConfigPath,
    ANNA_HARNESS_HOST_CONFIG_PATH: hostConfigPath,
    ANNA_HARNESS_HOST: host,
    ANNA_HARNESS_HOST_PORT: String(port),
    ANNA_HARNESS_HOST_ENTRY_PATH: hostEntryPath,
    ANNA_HARNESS_HOST_STATIC_ROOT: staticRoot,
    ANNA_HARNESS_OMP_RUNTIME_ROOT: ompRuntimeRoot,
    ANNA_HARNESS_HOST_EVENT_STORE_PATH: eventStorePath,
    ANNA_HARNESS_HOST_WORKSPACE_ROOT: hostWorkspaceRoot,
    ANNA_HARNESS_SESSION_STORE_PATH: sessionStorePath,
    ANNA_HARNESS_SERVICE_TOKEN: serviceToken,
    ANNA_HARNESS_BUSINESS_PORT: String(resolvedBusinessPort),
    ANNA_HARNESS_PROTECTED_PATHS: [
      hostConfigPath,
      businessConfigPath,
      eventStorePath,
      sessionStorePath,
      stateRoot,
      hostWorkspaceRoot,
    ].join(path.delimiter),
    ANNA_HARNESS_BUSINESS_ENABLED: businessEnabled ? "1" : "0",
    ...(businessOrigin === undefined ? {} : { ANNA_HARNESS_BUSINESS_ORIGIN: businessOrigin }),
    ...(env.ANNA_HARNESS_BUSINESS_SERVICE_TOKEN === undefined
      ? { ANNA_HARNESS_BUSINESS_SERVICE_TOKEN: serviceToken }
      : { ANNA_HARNESS_BUSINESS_SERVICE_TOKEN: env.ANNA_HARNESS_BUSINESS_SERVICE_TOKEN }),
  };
  const businessEnv = {
    ...ordinaryEnv,
    ANNA_RUNTIME_CONFIG_PATH: businessConfigPath,
    ANNA_HARNESS_BUSINESS_CONFIG_PATH: businessConfigPath,
    ANNA_HARNESS_BUSINESS_MODE: "1",
    ANNA_BUSINESS_MODE: "1",
    ANNA_PRODUCT_MODE: "1",
    ANNA_HARNESS_BUSINESS_HOST: host,
    ANNA_HARNESS_BUSINESS_PORT: String(resolvedBusinessPort),
    ANNA_BUSINESS_HOST: host,
    ANNA_BUSINESS_PORT: String(resolvedBusinessPort),
    ANNA_HARNESS_HOST_ORIGIN: hostOrigin,
    ANNA_HARNESS_HOST_URL: hostOrigin,
    ANNA_SERVICE_TOKEN: serviceToken,
    ANNA_HARNESS_SERVICE_TOKEN: serviceToken,
    ANNA_HARNESS_BUSINESS_SERVICE_TOKEN: serviceToken,
  };
  return {
    projectRoot,
    userDataPath,
    host,
    port,
    apiHost: host,
    apiPort: port,
    apiBase: hostOrigin,
    nodeExecutable: resolveNodeExecutable(env),
    pythonExecutable: resolvePythonExecutable(projectRoot, env),
    entryPath: hostEntryPath,
    args: [hostEntryPath],
    env: hostEnv,
    hostEnv,
    businessEnv,
    businessEnabled,
    businessManaged,
    businessHost: host,
    businessPort: resolvedBusinessPort,
    businessApiBase: businessOrigin,
    hostConfigPath,
    businessConfigPath,
    stateRoot,
    eventStorePath,
    sessionStorePath,
    workspaceRoot: hostEnv.ANNA_HARNESS_HOST_WORKSPACE_ROOT,
    staticRoot,
    ompRuntimeRoot,
    serviceToken,
    runtimeInfoPath: env.ANNA_HARNESS_RUNTIME_INFO_PATH
      ?? path.join(userDataPath, "harness-runtime-info.json"),
  };
}

export function resolvePythonExecutable(projectRoot, env = process.env, platform = process.platform) {
  if (env.ANNA_PYTHON_BIN) return env.ANNA_PYTHON_BIN;
  const candidate = platform === "win32"
    ? path.join(projectRoot, "build", "python-runtime", "python", "python.exe")
    : path.join(projectRoot, "build", "python-runtime", "python", "bin", "python3.12");
  if (existsSync(candidate)) return candidate;
  const venv = platform === "win32"
    ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, ".venv", "bin", "python");
  return existsSync(venv) ? venv : platform === "win32" ? "python" : "python3";
}

// The stable launcher factory now points to the original-product Host.
export const createRuntimeConfig = createProductRuntimeConfig;

export async function createDesktopRuntime(options = {}) {
  const env = options.env ?? process.env;
  const configuredPort = options.apiPort ?? parseOptionalPort(env.ANNA_HARNESS_HOST_PORT, "ANNA_HARNESS_HOST_PORT");
  const apiPort = configuredPort ?? (await findFreePort());
  const businessManaged = env.ANNA_HARNESS_BUSINESS_ENABLED !== "0"
    && !Boolean(env.ANNA_HARNESS_BUSINESS_ORIGIN);
  const configuredBusinessPort = options.businessPort
    ?? parseOptionalPort(env.ANNA_HARNESS_BUSINESS_PORT, "ANNA_HARNESS_BUSINESS_PORT");
  const nextBusinessPort = businessManaged
    ? configuredBusinessPort ?? (await findFreePort())
    : configuredBusinessPort;
  const config = createProductRuntimeConfig({ ...options, apiPort, businessPort: nextBusinessPort });
  return startProductRuntimeService(config, options);
}

export async function restartDesktopRuntime(currentRuntime, options = {}) {
  const startRuntime = options.startRuntime ?? createDesktopRuntime;
  const restartDelayMs = options.restartDelayMs ?? 400;
  const currentEnv = options.env ?? currentRuntime?.env;
  const restartEnv = currentRuntime?.businessManaged && currentEnv
    ? (() => {
        const { ANNA_HARNESS_BUSINESS_ORIGIN: _businessOrigin, ...managedEnv } = currentEnv;
        return { ...managedEnv, ANNA_HARNESS_BUSINESS_ENABLED: "1" };
      })()
    : currentEnv;
  const startOptions = {
    projectRoot: options.projectRoot ?? currentRuntime?.projectRoot,
    userDataPath: options.userDataPath ?? currentRuntime?.userDataPath,
    apiPort: options.apiPort ?? currentRuntime?.apiPort,
    businessPort: options.businessPort ?? currentRuntime?.businessPort,
    env: restartEnv,
    healthTimeoutMs: options.healthTimeoutMs,
    onExit: options.onExit,
    platform: options.platform,
    arch: options.arch,
  };
  await currentRuntime?.stop?.();
  await delay(restartDelayMs);
  return startRuntime(startOptions);
}

export async function startPreviewRuntimeService(config, options = {}) {
  if (!config || !config.entryPath || !existsSync(config.entryPath)) {
    throw new Error(`Preview Host entry is missing: ${config?.entryPath ?? "<unknown>"}`);
  }

  mkdirSync(config.stateRoot, { recursive: true });
  mkdirSync(path.dirname(config.configPath), { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });

  const childEnv = {
    ...config.env,
    // Packaged applications run with a branded executable name (for example
    // `Anna`), so basename heuristics cannot decide whether Electron is Node.
    // Plain Node ignores this variable; Electron uses it to run preview-main.
    ELECTRON_RUN_AS_NODE: "1",
  };
  const child = spawn(config.nodeExecutable, config.args, {
    cwd: config.projectRoot,
    env: childEnv,
    stdio: options.stdio ?? "pipe",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let startupComplete = false;
  observeRuntimeExit(child, options, () => stderr, () => startupComplete);
  const startupFailure = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!startupComplete && !child.__annaIntentionalStop) {
        reject(new Error(`Anna Preview Host exited with ${formatRuntimeExitReason(code, signal)}`));
      }
    });
  });

  try {
    await Promise.race([
      waitForHealth(`${config.apiBase}/health`, options.healthTimeoutMs ?? 15000),
      startupFailure,
    ]);
    startupComplete = true;
    writeRuntimeInfo(config, child);
  } catch (error) {
    await stopRuntimeService(child);
    throw error;
  }

  return {
    ...config,
    child,
    env: childEnv,
    stop: () => stopRuntimeService(child),
  };
}

/** Start the Node Product Host and, when configured, the managed business peer. */
export async function startProductRuntimeService(config, options = {}) {
  if (!config || !config.entryPath || !existsSync(config.entryPath)) {
    throw new Error(`Anna Product Host entry is missing: ${config?.entryPath ?? "<unknown>"}`);
  }

  mkdirSync(config.stateRoot, { recursive: true });
  mkdirSync(path.dirname(config.hostConfigPath), { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });

  let business;
  if (config.businessManaged) {
    business = spawnBusinessService(config, options);
  }
  const host = spawn(config.nodeExecutable, config.args, {
    cwd: config.projectRoot,
    env: {
      ...config.hostEnv,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: options.stdio ?? "pipe",
  });
  let hostStderr = "";
  host.stderr?.on("data", (chunk) => {
    hostStderr += chunk.toString();
  });
  let hostStarted = false;
  observeRuntimeExit(host, options, () => hostStderr, () => hostStarted);
  const hostFailure = processFailure(host, "Anna Product Host", () => hostStderr, () => hostStarted);
  const businessFailure = business === undefined
    ? undefined
    : processFailure(business.child, "Anna business service", () => business.stderr, () => business.started);
  try {
    await Promise.race([
      waitForHealth(`${config.apiBase}/health`, options.healthTimeoutMs ?? 15000),
      hostFailure,
    ]);
    hostStarted = true;
    if (business !== undefined) {
      await Promise.race([
        waitForHealth(`${business.apiBase}/api/health`, options.healthTimeoutMs ?? 15000),
        businessFailure,
      ]);
      business.started = true;
    }
    writeProductRuntimeInfo(config, host, business);
  } catch (error) {
    await stopRuntimeService(host);
    await stopRuntimeService(business?.child);
    throw error;
  }

  return {
    ...config,
    child: host,
    businessChild: business?.child,
    env: config.hostEnv,
    stop: async () => {
      await stopRuntimeService(host);
      await stopRuntimeService(business?.child);
    },
  };
}

// The stable process helper is the original Product Host, never the Preview-only service.
export const startRuntimeService = startProductRuntimeService;

function spawnBusinessService(config, options) {
  const args = [
    "-m",
    "uvicorn",
    "services.business_main:app",
    "--host",
    config.businessHost,
    "--port",
    String(config.businessPort),
  ];
  const child = spawn(config.pythonExecutable, args, {
    cwd: config.projectRoot,
    env: config.businessEnv,
    stdio: options.stdio ?? "pipe",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return { child, apiBase: config.businessApiBase, get stderr() { return stderr; }, started: false };
}

function processFailure(child, label, readStderr, started) {
  return new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!started() && !child.__annaIntentionalStop) {
        const details = readStderr();
        reject(new Error(`${label} exited with ${formatRuntimeExitReason(code, signal)}${details ? `: ${details}` : ""}`));
      }
    });
  });
}

function writeProductRuntimeInfo(config, host, business) {
  if (!config.runtimeInfoPath) return;
  mkdirSync(path.dirname(config.runtimeInfoPath), { recursive: true });
  writeFileSync(
    config.runtimeInfoPath,
    JSON.stringify({
      apiBase: config.apiBase,
      apiHost: config.apiHost,
      apiPort: config.apiPort,
      pid: host.pid,
      businessApiBase: config.businessApiBase,
      businessPid: business?.child.pid,
      projectRoot: config.projectRoot,
      entryPath: config.entryPath,
      hostConfigPath: config.hostConfigPath,
      businessConfigPath: config.businessConfigPath,
      stateRoot: config.stateRoot,
      eventStorePath: config.eventStorePath,
      sessionStorePath: config.sessionStorePath,
      startedAt: new Date().toISOString(),
    }, null, 2),
  );
}

function writeRuntimeInfo(config, child) {
  if (!config.runtimeInfoPath) return;
  mkdirSync(path.dirname(config.runtimeInfoPath), { recursive: true });
  writeFileSync(
    config.runtimeInfoPath,
    JSON.stringify(
      {
        apiBase: config.apiBase,
        apiHost: config.apiHost,
        apiPort: config.apiPort,
        pid: child.pid,
        projectRoot: config.projectRoot,
        entryPath: config.entryPath,
        configPath: config.configPath,
        stateRoot: config.stateRoot,
        workspaceRoot: config.workspaceRoot,
        staticRoot: config.staticRoot,
        ompRuntimeRoot: config.ompRuntimeRoot,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function observeRuntimeExit(
  child,
  options = {},
  readStderr = () => "",
  shouldNotify = () => true,
) {
  child.once("exit", (code, signal) => {
    if (!child.__annaIntentionalStop && shouldNotify() && options.onExit) {
      options.onExit({ code, signal, stderr: readStderr() });
    }
  });
}

export async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Health check failed with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError ?? new Error("Anna Preview Host health check timed out");
}

export async function stopRuntimeService(child, options = {}) {
  if (!child) return;
  child.__annaIntentionalStop = true;
  if (hasRuntimeExited(child)) return;
  const exitPromise = waitForRuntimeExit(child);
  child.kill("SIGTERM");
  const stopped = await waitForRuntimeExitOrTimeout(
    exitPromise,
    options.shutdownTimeoutMs ?? 5000,
  );
  if (!stopped && !hasRuntimeExited(child)) {
    child.kill("SIGKILL");
    await waitForRuntimeExitOrTimeout(exitPromise, options.killTimeoutMs ?? 1000);
  }
}

export async function findFreePort(host = API_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Unable to allocate Anna Preview Host port"));
      });
    });
  });
}

export function parseApiBaseFromArgv(argv = process.argv) {
  const prefix = "--anna-api-base=";
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

// Retained as a harmless parser for old renderer fixtures; Preview does not
// inject or consume a second runtime base.
export function parseRuntimeBaseFromArgv(
  argv = process.argv,
  prefix = "--anna-harness-v2-api-base=",
) {
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

function parseOptionalPort(value, name = "ANNA_PREVIEW_PORT") {
  if (value === undefined || value.trim() === "") return undefined;
  return parsePort(value, name);
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasRuntimeExited(child) {
  return (
    (child.exitCode !== undefined && child.exitCode !== null) ||
    (child.signalCode !== undefined && child.signalCode !== null)
  );
}

function waitForRuntimeExit(child) {
  if (typeof child.once !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
}

async function waitForRuntimeExitOrTimeout(exitPromise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function formatRuntimeExitReason(code, signal) {
  return code === null ? `signal ${signal}` : `code ${code}`;
}
