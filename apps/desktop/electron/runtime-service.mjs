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

export function resolvePythonExecutable(projectRoot, env = process.env, platform = process.platform) {
  if (env.ANNA_PYTHON_BIN) {
    return env.ANNA_PYTHON_BIN;
  }
  const isWindows = platform === "win32";
  const sidecarCandidates = isWindows
    ? [path.join(projectRoot, "build", "python-runtime", "python", "python.exe")]
    : [path.join(projectRoot, "build", "python-runtime", "python", "bin", "python3.12")];
  for (const sidecarPython of sidecarCandidates) {
    if (existsSync(sidecarPython)) {
      return sidecarPython;
    }
  }
  const venvPython = isWindows
    ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, ".venv", "bin", "python");
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return isWindows ? "python" : "python3";
}

function resolveNodeExecutable(env = process.env) {
  if (env.ANNA_NODE_BIN) {
    return env.ANNA_NODE_BIN;
  }
  return process.execPath;
}

function resolvePythonPath(projectRoot, env = process.env) {
  const entries = [projectRoot];
  const sidecarSitePackages = path.join(
    projectRoot,
    "build",
    "python-runtime",
    "site-packages",
  );
  if (existsSync(sidecarSitePackages)) {
    entries.push(sidecarSitePackages);
  }
  if (env.PYTHONPATH) {
    entries.push(env.PYTHONPATH);
  }
  return entries.join(path.delimiter);
}

export function createRuntimeConfig({
  projectRoot = resolveProjectRoot(),
  userDataPath,
  apiPort = DEFAULT_API_PORT,
  harnessV2Port,
  env = process.env,
} = {}) {
  if (!userDataPath) {
    throw new Error("userDataPath is required for Anna desktop runtime");
  }
  // A source checkout may carry an ignored `.anna/runtime.json` with its
  // local model, connector, and migrated state. Prefer that complete local
  // state bundle when present. Packaged installs and clean checkouts keep the
  // existing Electron userData defaults.
  const projectLocalStatePath = path.join(projectRoot, ".anna");
  const projectLocalRuntimeConfigPath = path.join(projectLocalStatePath, "runtime.json");
  const useProjectLocalState = existsSync(projectLocalRuntimeConfigPath);
  const defaultStateRoot = useProjectLocalState ? projectLocalStatePath : userDataPath;
  const stateDbPath =
    env.ANNA_STATE_DB_PATH ?? path.join(defaultStateRoot, "state", "anna-state.sqlite3");
  const harnessV2Enabled = env.ANNA_HARNESS_V2_BRIDGE_ENABLED === "1"
    || env.ANNA_HARNESS_V2_BRIDGE_MANAGED === "1";
  const harnessV2Managed = harnessV2Enabled
    && (env.ANNA_HARNESS_V2_BRIDGE_MANAGED === "1"
      || env.ANNA_HARNESS_V2_BRIDGE_ORIGIN === undefined);
  const resolvedHarnessV2Port = harnessV2Port ?? Number(env.ANNA_HARNESS_V2_PORT ?? 0);
  if (harnessV2Managed && (!Number.isInteger(resolvedHarnessV2Port) || resolvedHarnessV2Port < 1)) {
    throw new Error("Managed Harness v2 requires a preallocated harnessV2Port");
  }
  const harnessV2ApiBase = harnessV2Enabled
    ? env.ANNA_HARNESS_V2_BRIDGE_ORIGIN
      ?? `http://${API_HOST}:${resolvedHarnessV2Port}`
    : undefined;
  const harnessV2EventStorePath =
    env.ANNA_HARNESS_V2_EVENT_STORE_PATH
      ?? path.join(defaultStateRoot, "state", "harness-v2.sqlite3");
  const harnessV2EntryPath = path.join(projectRoot, "apps", "harness-service", "dist", "main.js");
  const harnessV2Env = harnessV2Enabled && harnessV2ApiBase
    ? {
        ANNA_HARNESS_V2_BRIDGE_ENABLED: "1",
        ANNA_HARNESS_V2_BRIDGE_MANAGED: harnessV2Managed ? "1" : "0",
        ANNA_HARNESS_V2_BRIDGE_ORIGIN: harnessV2ApiBase,
        ANNA_HARNESS_V2_EVENT_STORE_PATH: harnessV2EventStorePath,
        ...(harnessV2Managed ? { ANNA_HARNESS_V2_PORT: String(resolvedHarnessV2Port) } : {}),
      }
    : {};
  const runtimeConfigPath =
    env.ANNA_RUNTIME_CONFIG_PATH
    ?? (useProjectLocalState
      ? projectLocalRuntimeConfigPath
      : path.join(userDataPath, "config", "runtime.json"));
  const runtimeInfoPath =
    env.ANNA_RUNTIME_INFO_PATH
    ?? (useProjectLocalState
      ? path.join(projectLocalStatePath, "runtime-info-electron.json")
      : path.join(userDataPath, "runtime-info.json"));
  const runtimeEnv = {
    ...env,
    ANNA_RUNTIME_CONFIG_PATH: runtimeConfigPath,
    ANNA_RUNTIME_INFO_PATH: runtimeInfoPath,
    ANNA_STATE_DB_PATH: stateDbPath,
    ...harnessV2Env,
    PYTHONPATH: resolvePythonPath(projectRoot, env),
  };
  const args = [
    "-m",
    "uvicorn",
    "services.api.app.main:app",
    "--host",
    API_HOST,
    "--port",
    String(apiPort),
  ];
  return {
    projectRoot,
    userDataPath,
    apiHost: API_HOST,
    apiPort,
    apiBase: `http://${API_HOST}:${apiPort}`,
    pythonExecutable: resolvePythonExecutable(projectRoot, env),
    nodeExecutable: resolveNodeExecutable(env),
    moduleName: "uvicorn",
    args,
    env: runtimeEnv,
    runtimeConfigPath,
    runtimeInfoPath,
    stateDbPath,
    harnessV2Enabled,
    harnessV2Managed,
    harnessV2ApiBase,
    harnessV2Port: harnessV2Enabled ? resolvedHarnessV2Port : undefined,
    harnessV2EntryPath,
    harnessV2EventStorePath,
  };
}

export async function createDesktopRuntime(options = {}) {
  const apiPort = options.apiPort ?? (await findFreePort());
  const env = options.env ?? process.env;
  const managedHarnessV2 = env.ANNA_HARNESS_V2_BRIDGE_ENABLED === "1"
    && env.ANNA_HARNESS_V2_BRIDGE_ORIGIN === undefined;
  const harnessV2Port = options.harnessV2Port
    ?? (managedHarnessV2 ? await findFreePort() : undefined);
  const config = createRuntimeConfig({ ...options, apiPort, harnessV2Port });
  return startRuntimeService(config, options);
}

export async function restartDesktopRuntime(currentRuntime, options = {}) {
  const startRuntime = options.startRuntime ?? createDesktopRuntime;
  const restartDelayMs = options.restartDelayMs ?? 400;
  const env = restartEnvironment(currentRuntime, options.env ?? currentRuntime?.env);
  const startOptions = {
    projectRoot: options.projectRoot ?? currentRuntime?.projectRoot,
    userDataPath: options.userDataPath ?? currentRuntime?.userDataPath,
    apiPort: options.apiPort ?? currentRuntime?.apiPort,
    harnessV2Port: options.harnessV2Port ?? currentRuntime?.harnessV2Port,
    env,
    healthTimeoutMs: options.healthTimeoutMs,
    onExit: options.onExit,
  };
  await currentRuntime?.stop?.();
  await delay(restartDelayMs);
  return startRuntime(startOptions);
}

function restartEnvironment(currentRuntime, env) {
  if (!currentRuntime?.harnessV2Managed || env === undefined) {
    return env;
  }
  const {
    ANNA_HARNESS_V2_BRIDGE_ORIGIN: _bridgeOrigin,
    ...managedEnv
  } = env;
  return managedEnv;
}

export async function startRuntimeService(config, options = {}) {
  mkdirSync(path.dirname(config.stateDbPath), { recursive: true });
  mkdirSync(path.dirname(config.runtimeConfigPath), { recursive: true });
  const harnessV2Child = config.harnessV2Managed
    ? spawnManagedHarnessV2(config, options)
    : undefined;
  let harnessV2Stderr = "";
  harnessV2Child?.stderr?.on("data", (chunk) => {
    harnessV2Stderr += chunk.toString();
  });
  const child = spawn(config.pythonExecutable, config.args, {
    cwd: config.projectRoot,
    env: config.env,
    stdio: options.stdio ?? "pipe",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let startupComplete = false;
  observeRuntimeExit(
    child,
    options,
    () => stderr,
    () => startupComplete,
  );
  const startupFailure = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!startupComplete && !child.__annaIntentionalStop) {
        reject(
          new Error(`Anna runtime exited with ${formatRuntimeExitReason(code, signal)}`),
        );
      }
    });
  });
  const harnessV2StartupFailure = harnessV2Child === undefined
    ? undefined
    : new Promise((_, reject) => {
        harnessV2Child.once("error", reject);
        harnessV2Child.once("exit", (code, signal) => {
          if (!harnessV2Child.__annaIntentionalStop) {
            reject(new Error(
              `Anna Harness v2 sidecar exited with ${formatRuntimeExitReason(code, signal)}${harnessV2Stderr ? `: ${harnessV2Stderr}` : ""}`,
            ));
          }
        });
      });
  try {
    if (harnessV2Child !== undefined) {
      await Promise.race([
        waitForHealth(`${config.harnessV2ApiBase}/health`, options.healthTimeoutMs ?? 15000),
        harnessV2StartupFailure,
      ]);
    }
    await Promise.race([
      waitForHealth(`${config.apiBase}/api/health`, options.healthTimeoutMs ?? 15000),
      startupFailure,
    ]);
    startupComplete = true;
    writeRuntimeInfo(config, child, harnessV2Child);
  } catch (error) {
    await stopRuntimeService(child);
    if (harnessV2Child !== undefined) {
      await stopRuntimeService(harnessV2Child);
    }
    throw error;
  }
  return {
    ...config,
    child,
    harnessV2Child,
    stop: async () => {
      await stopRuntimeService(child);
      if (harnessV2Child !== undefined) {
        await stopRuntimeService(harnessV2Child);
      }
    },
  };
}

function spawnManagedHarnessV2(config, options) {
  if (!existsSync(config.harnessV2EntryPath)) {
    throw new Error(
      `Harness v2 sidecar is not built: ${config.harnessV2EntryPath}. Run npm run harness:v2:build first.`,
    );
  }
  const child = spawn(config.nodeExecutable, [config.harnessV2EntryPath], {
    cwd: config.projectRoot,
    env: {
      ...config.env,
      ...(path.basename(config.nodeExecutable).toLowerCase().includes("electron")
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {}),
    },
    stdio: options.stdio ?? "pipe",
  });
  observeRuntimeExit(child, options, () => "Harness v2 sidecar exited unexpectedly");
  return child;
}

function writeRuntimeInfo(config, child, harnessV2Child) {
  if (!config.runtimeInfoPath) {
    return;
  }
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
        runtimeConfigPath: config.runtimeConfigPath,
        stateDbPath: config.stateDbPath,
        harnessV2ApiBase: config.harnessV2ApiBase,
        harnessV2Pid: harnessV2Child?.pid,
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
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check failed with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError ?? new Error("Anna runtime health check timed out");
}

export async function stopRuntimeService(child, options = {}) {
  child.__annaIntentionalStop = true;
  if (hasRuntimeExited(child)) {
    return;
  }
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

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, API_HOST, () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Unable to allocate Anna runtime port"));
      });
    });
  });
}

export function parseApiBaseFromArgv(argv = process.argv) {
  const prefix = "--anna-api-base=";
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

export function parseRuntimeBaseFromArgv(
  argv = process.argv,
  prefix = "--anna-harness-v2-api-base=",
) {
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
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
  if (typeof child.once !== "function") {
    return Promise.resolve();
  }
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
