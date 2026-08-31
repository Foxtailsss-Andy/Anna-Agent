import { spawn } from "node:child_process";
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

// Existing launcher callers keep the stable config factory name; its default
// now describes the Preview Host exclusively.
export const createRuntimeConfig = createPreviewRuntimeConfig;

export async function createDesktopRuntime(options = {}) {
  const env = options.env ?? process.env;
  const configuredPort = options.apiPort ?? parseOptionalPort(env.ANNA_PREVIEW_PORT);
  const apiPort = configuredPort ?? (await findFreePort());
  const config = createPreviewRuntimeConfig({ ...options, apiPort });
  return startPreviewRuntimeService(config, options);
}

export async function restartDesktopRuntime(currentRuntime, options = {}) {
  const startRuntime = options.startRuntime ?? createDesktopRuntime;
  const restartDelayMs = options.restartDelayMs ?? 400;
  const startOptions = {
    projectRoot: options.projectRoot ?? currentRuntime?.projectRoot,
    userDataPath: options.userDataPath ?? currentRuntime?.userDataPath,
    apiPort: options.apiPort ?? currentRuntime?.apiPort,
    env: options.env ?? currentRuntime?.env,
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

// Keep the process helper name for focused launcher tests and explicit callers;
// it now always means the Preview Host, never the legacy Python service.
export const startRuntimeService = startPreviewRuntimeService;

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

function parseOptionalPort(value) {
  if (value === undefined || value.trim() === "") return undefined;
  return parsePort(value, "ANNA_PREVIEW_PORT");
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
