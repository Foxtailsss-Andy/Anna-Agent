import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

import {
  createRuntimeConfig,
  observeRuntimeExit,
  parseApiBaseFromArgv,
  parseRuntimeBaseFromArgv,
  resolvePythonExecutable,
  resolveProjectRoot,
  restartDesktopRuntime,
  startRuntimeService,
  stopRuntimeService,
} from "../../apps/desktop/electron/runtime-service.mjs";
import {
  runtimeFailureDataUrl,
  runtimeFailureHtml,
} from "../../apps/desktop/electron/runtime-failure-page.mjs";

test("Electron runtime config starts Anna API with local user state database", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "anna-project-"));
  const userDataPath = mkdtempSync(join(tmpdir(), "anna-user-data-"));
  // Sidecar layout differs per platform: python.exe on Windows, bin/python3.12 elsewhere.
  const sidecarPython =
    process.platform === "win32"
      ? join(projectRoot, "build", "python-runtime", "python", "python.exe")
      : join(projectRoot, "build", "python-runtime", "python", "bin", "python3.12");
  mkdirSync(dirname(sidecarPython), { recursive: true });
  mkdirSync(join(projectRoot, "build", "python-runtime", "site-packages"), {
    recursive: true,
  });
  writeFileSync(sidecarPython, "#!/bin/sh\n");

  try {
    const config = createRuntimeConfig({
      projectRoot,
      userDataPath,
      apiPort: 18765,
      env: {
        ANNA_MODEL_ENDPOINT: "https://model.example/v1/chat/completions",
        ANNA_MODEL_API_KEY: "secret",
        ANNA_REIMBURSEMENT_MCP_SERVER: "https://mcp.example/rpc",
      },
    });

    assert.equal(config.apiBase, "http://127.0.0.1:18765");
    assert.equal(config.pythonExecutable, sidecarPython);
    assert.equal(config.moduleName, "uvicorn");
    assert.deepEqual(config.args, [
      "-m",
      "uvicorn",
      "services.api.app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      "18765",
    ]);
    assert.equal(
      config.env.ANNA_STATE_DB_PATH,
      join(userDataPath, "state", "anna-state.sqlite3"),
    );
    assert.equal(
      config.env.ANNA_RUNTIME_CONFIG_PATH,
      join(userDataPath, "config", "runtime.json"),
    );
    assert.equal(config.env.ANNA_MODEL_ENDPOINT, "https://model.example/v1/chat/completions");
    assert.equal(config.env.ANNA_REIMBURSEMENT_MCP_SERVER, "https://mcp.example/rpc");
    assert.equal(config.harnessV2Enabled, false);
    assert.equal(config.harnessV2Managed, false);
    assert.equal(
      config.env.PYTHONPATH,
      [
        projectRoot,
        join(projectRoot, "build", "python-runtime", "site-packages"),
      ].join(delimiter),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("Electron runtime opt-in provisions a managed Harness v2 sidecar", () => {
  const config = createRuntimeConfig({
    projectRoot: "/project",
    userDataPath: "/user-data",
    apiPort: 18002,
    harnessV2Port: 18003,
    env: { ANNA_HARNESS_V2_BRIDGE_ENABLED: "1" },
  });

  assert.equal(config.harnessV2Enabled, true);
  assert.equal(config.harnessV2Managed, true);
  assert.equal(config.harnessV2ApiBase, "http://127.0.0.1:18003");
  assert.equal(config.harnessV2Port, 18003);
  assert.equal(
    config.env.ANNA_HARNESS_V2_EVENT_STORE_PATH,
    join("/user-data", "state", "harness-v2.sqlite3"),
  );
  assert.equal(config.env.ANNA_HARNESS_V2_BRIDGE_ORIGIN, "http://127.0.0.1:18003");
});

test("Electron runtime config honors explicit Python and state db settings", () => {
  const config = createRuntimeConfig({
    projectRoot: "/project",
    userDataPath: "/user-data",
    apiPort: 18000,
    env: {
      ANNA_PYTHON_BIN: "/custom/python",
      ANNA_STATE_DB_PATH: "/custom/anna.sqlite3",
    },
  });

  assert.equal(config.pythonExecutable, "/custom/python");
  assert.equal(config.env.ANNA_STATE_DB_PATH, "/custom/anna.sqlite3");
  assert.equal(config.env.ANNA_RUNTIME_CONFIG_PATH, join("/user-data", "config", "runtime.json"));
});

test("Electron runtime config uses an ignored project-local Anna state bundle when present", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "anna-project-local-state-"));
  const userDataPath = mkdtempSync(join(tmpdir(), "anna-user-data-fallback-"));
  const localStatePath = join(projectRoot, ".anna");
  mkdirSync(localStatePath, { recursive: true });
  writeFileSync(join(localStatePath, "runtime.json"), "{}\n");

  try {
    const config = createRuntimeConfig({
      projectRoot,
      userDataPath,
      apiPort: 18001,
      env: {},
    });

    assert.equal(config.runtimeConfigPath, join(localStatePath, "runtime.json"));
    assert.equal(config.stateDbPath, join(localStatePath, "state", "anna-state.sqlite3"));
    assert.equal(config.runtimeInfoPath, join(localStatePath, "runtime-info-electron.json"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("Electron preload argument parser exposes runtime API base", () => {
  const preloadSource = readFileSync(
    new URL("../../apps/desktop/electron/preload.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(
    parseApiBaseFromArgv(["electron", "--anna-api-base=http://127.0.0.1:18888"]),
    "http://127.0.0.1:18888",
  );
  assert.equal(parseApiBaseFromArgv(["electron"]), "");
  assert.equal(
    parseRuntimeBaseFromArgv(
      ["electron", "--anna-harness-v2-api-base=http://127.0.0.1:18889"],
      "--anna-harness-v2-api-base=",
    ),
    "http://127.0.0.1:18889",
  );
  assert.equal(
    parseRuntimeBaseFromArgv(["electron"], "--anna-harness-v2-api-base="),
    "",
  );
  assert.match(preloadSource, /parseRuntimeBaseFromArgv/);
});

test("package scripts include real Electron app and packaging commands", async () => {
  const packageJson = await import("../../package.json", {
    with: { type: "json" },
  });

  assert.equal(packageJson.default.main, "apps/desktop/electron/main.mjs");
  assert.equal(packageJson.default.build.asar, true);
  assert.deepEqual(packageJson.default.build.asarUnpack, [
    "dist/**",
    "apps/harness-service/dist/**",
    "services/**",
    "skills/**",
    "build/python-runtime/**",
    "pyproject.toml",
    "package.json",
  ]);
  assert.match(packageJson.default.scripts["desktop:package"], /desktop:prepare-python/);
  assert.ok(packageJson.default.build.files.includes("build/python-runtime/**/*"));
  assert.equal(packageJson.default.build.files.includes(".venv/**/*"), false);
  assert.match(packageJson.default.scripts["desktop:run"], /electron/);
  assert.match(packageJson.default.scripts["desktop:package"], /electron-builder/);
  assert.equal(
    packageJson.default.scripts["desktop:smoke-asar"],
    "electron scripts/smoke-packaged-asar.mjs",
  );
  assert.equal(
    packageJson.default.scripts["live:e2e"],
    "node scripts/live-reimbursement-e2e.mjs",
  );
  assert.equal(
    existsSync(new URL("../../scripts/smoke-packaged-asar.mjs", import.meta.url)),
    true,
  );
  assert.equal(
    existsSync(new URL("../../scripts/live-reimbursement-e2e.mjs", import.meta.url)),
    true,
  );
});

test("Electron runtime resolves unpacked project root from packaged asar path", () => {
  if (process.platform === "win32") {
    assert.equal(
      resolveProjectRoot(
        "file:///C:/Program%20Files/Anna/resources/app.asar/apps/desktop/electron/runtime-service.mjs",
      ),
      "C:\\Program Files\\Anna\\resources\\app.asar.unpacked",
    );
    return;
  }
  assert.equal(
    resolveProjectRoot(
      "file:///Applications/Anna.app/Contents/Resources/app.asar/apps/desktop/electron/runtime-service.mjs",
    ),
    "/Applications/Anna.app/Contents/Resources/app.asar.unpacked",
  );
});

test("package metadata defines Anna desktop identity and macOS icon asset", async () => {
  const packageJson = await import("../../package.json", {
    with: { type: "json" },
  });

  assert.match(packageJson.default.description, /Anna/);
  assert.equal(packageJson.default.author, "Anna Project Team");
  assert.equal(packageJson.default.build.productName, "Anna");
  assert.equal(packageJson.default.build.mac.icon, "build/icon.icns");
  assert.equal(existsSync(new URL("../../build/icon.icns", import.meta.url)), true);
});

test("Electron runtime failure page explains startup failure without exposing a blank window", () => {
  const html = runtimeFailureHtml({
    message: "Anna runtime health check timed out",
    details: "uvicorn could not start",
  });
  const dataUrl = runtimeFailureDataUrl({
    message: "Anna runtime health check timed out",
  });

  assert.ok(html.includes("Anna runtime 启动失败"));
  assert.ok(html.includes("Anna runtime health check timed out"));
  assert.ok(html.includes("ANNA_PYTHON_BIN"));
  assert.ok(html.includes("ANNA_RUNTIME_CONFIG_PATH"));
  assert.ok(dataUrl.startsWith("data:text/html;charset=utf-8,"));
});

test("Electron runtime failure page exposes a restart action and returns to the app", () => {
  const html = runtimeFailureHtml({
    message: "Harness v2 sidecar exited with code 42",
  });

  assert.match(html, /id="restart-runtime"/);
  assert.match(html, /__ANNA_RUNTIME__\.restartRuntime/);
  assert.match(html, /location\.assign/);
  assert.match(html, /重启运行时/);
});

test("Electron runtime failure page redacts likely secrets", () => {
  const html = runtimeFailureHtml({
    message: "spawn failed",
    details:
      "Authorization: Bearer secret-key-123\nANNA_MODEL_API_KEY=secret-key-123\nhttps://user:secret-token@mcp.example/rpc?access_token=access-secret&client_secret=client-secret&password=password-secret",
  });

  assert.ok(!html.includes("secret-key-123"));
  assert.ok(!html.includes("secret-token"));
  assert.ok(!html.includes("access-secret"));
  assert.ok(!html.includes("client-secret"));
  assert.ok(!html.includes("password-secret"));
  assert.ok(!html.includes("user:secret-token"));
  assert.ok(html.includes("[redacted]"));
});

test("Electron runtime exit callback distinguishes crashes from intentional stop", () => {
  const events = [];
  const child = {
    killed: false,
    exitCode: null,
    kill(signal) {
      this.killed = true;
      events.push(["kill", signal]);
    },
  };
  stopRuntimeService(child);

  assert.deepEqual(events, [["kill", "SIGTERM"]]);
  assert.equal(child.__annaIntentionalStop, true);
});

test("Electron runtime startup rejects missing Python executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-runtime-missing-python-"));

  try {
    await assert.rejects(
      startRuntimeService(
        {
          projectRoot: root,
          pythonExecutable: join(root, "missing-python"),
          args: ["-V"],
          env: process.env,
          apiBase: "http://127.0.0.1:9",
          stateDbPath: join(root, "state", "anna.sqlite3"),
          runtimeConfigPath: join(root, "config", "runtime.json"),
        },
        { healthTimeoutMs: 50 },
      ),
      /ENOENT|spawn/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron runtime writes API base runtime info after startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-runtime-info-"));
  const runtimeInfoPath = join(root, "runtime-info.json");
  const childScript = join(root, "child.mjs");
  writeFileSync(childScript, "setInterval(() => {}, 1000);\n");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });

  try {
    const runtime = await startRuntimeService(
      {
        projectRoot: root,
        userDataPath: root,
        pythonExecutable: process.execPath,
        args: [childScript],
        env: process.env,
        apiBase: "http://127.0.0.1:19001",
        apiHost: "127.0.0.1",
        apiPort: 19001,
        stateDbPath: join(root, "state", "anna.sqlite3"),
        runtimeConfigPath: join(root, "config", "runtime.json"),
        runtimeInfoPath,
      },
      { healthTimeoutMs: 50 },
    );
    try {
      const info = JSON.parse(readFileSync(runtimeInfoPath, "utf8"));
      assert.equal(info.apiBase, "http://127.0.0.1:19001");
      assert.equal(info.apiPort, 19001);
      assert.equal(info.pid, runtime.child.pid);
      assert.equal(info.projectRoot, root);
      assert.equal(info.stateDbPath, join(root, "state", "anna.sqlite3"));
    } finally {
      await runtime.stop();
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron runtime startup stops child when health check never becomes ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-runtime-health-timeout-"));
  const heartbeatPath = join(root, "heartbeat.txt");
  const childScript = join(root, "child.mjs");
  // SIGTERM handlers never run on Windows (kill() uses TerminateProcess), so the
  // child writes a heartbeat instead; a stopped heartbeat proves termination.
  writeFileSync(
    childScript,
    [
      "import { writeFileSync } from 'node:fs';",
      `const heartbeatPath = ${JSON.stringify(heartbeatPath)};`,
      "let beat = 0;",
      "setInterval(() => { writeFileSync(heartbeatPath, String(beat += 1)); }, 50);",
      "setTimeout(() => process.exit(0), 10000);",
    ].join("\n"),
  );

  try {
    await assert.rejects(
      startRuntimeService(
        {
          projectRoot: root,
          pythonExecutable: process.execPath,
          args: [childScript],
          env: process.env,
          apiBase: "http://127.0.0.1:9",
          stateDbPath: join(root, "state", "anna.sqlite3"),
          runtimeConfigPath: join(root, "config", "runtime.json"),
        },
        { healthTimeoutMs: 50 },
      ),
    );
    await delay(300);
    const beatAfterStop = existsSync(heartbeatPath) ? readFileSync(heartbeatPath, "utf8") : "";
    await delay(400);
    const beatLater = existsSync(heartbeatPath) ? readFileSync(heartbeatPath, "utf8") : "";
    assert.equal(beatLater, beatAfterStop);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron runtime exit callback only fires for unexpected exit", () => {
  const crashEvents = [];
  const crashedChild = new EventEmitter();
  observeRuntimeExit(
    crashedChild,
    { onExit: (event) => crashEvents.push(event) },
    () => "boom",
  );

  crashedChild.emit("exit", 42, null);

  assert.deepEqual(crashEvents, [{ code: 42, signal: null, stderr: "boom" }]);

  const stopEvents = [];
  const stoppedChild = new EventEmitter();
  stoppedChild.__annaIntentionalStop = true;
  observeRuntimeExit(
    stoppedChild,
    { onExit: (event) => stopEvents.push(event) },
    () => "closing",
  );

  stoppedChild.emit("exit", 0, null);

  assert.deepEqual(stopEvents, []);
});

test("Electron runtime restart stops current runtime and preserves port and paths", async () => {
  const events = [];
  const currentRuntime = {
    apiPort: 18888,
    projectRoot: "/project",
    userDataPath: "/user-data",
    env: { ANNA_MODEL_NAME: "mimo-v2.5-pro" },
    stop() {
      events.push(["stop"]);
    },
  };

  const restarted = await restartDesktopRuntime(currentRuntime, {
    restartDelayMs: 0,
    healthTimeoutMs: 50,
    startRuntime: async (options) => {
      events.push(["start", options]);
      return {
        ...options,
        apiBase: `http://127.0.0.1:${options.apiPort}`,
      };
    },
  });

  assert.equal(restarted.apiBase, "http://127.0.0.1:18888");
  assert.deepEqual(events[0], ["stop"]);
  assert.equal(events[1][0], "start");
  assert.equal(events[1][1].apiPort, 18888);
  assert.equal(events[1][1].projectRoot, "/project");
  assert.equal(events[1][1].userDataPath, "/user-data");
  assert.equal(events[1][1].healthTimeoutMs, 50);
}
);

test("Electron runtime restart waits for current runtime stop before starting again", async () => {
  const events = [];
  let releaseStop;
  const currentRuntime = {
    apiPort: 18888,
    projectRoot: "/project",
    userDataPath: "/user-data",
    stop() {
      events.push("stop-called");
      return new Promise((resolve) => {
        releaseStop = () => {
          events.push("stop-resolved");
          resolve();
        };
      });
    },
  };

  const restartPromise = restartDesktopRuntime(currentRuntime, {
    restartDelayMs: 0,
    startRuntime: async () => {
      events.push("start-called");
      return { apiBase: "http://127.0.0.1:18888" };
    },
  });

  await delay(20);
  assert.deepEqual(events, ["stop-called"]);

  releaseStop();
  await restartPromise;

  assert.deepEqual(events, ["stop-called", "stop-resolved", "start-called"]);
});

test("Electron runtime restart keeps a managed Harness v2 sidecar managed", async () => {
  let restartOptions;
  const currentRuntime = {
    apiPort: 18888,
    harnessV2Port: 18889,
    harnessV2Managed: true,
    projectRoot: "/project",
    userDataPath: "/user-data",
    env: {
      ANNA_HARNESS_V2_BRIDGE_ENABLED: "1",
      ANNA_HARNESS_V2_BRIDGE_MANAGED: "1",
      ANNA_HARNESS_V2_BRIDGE_ORIGIN: "http://127.0.0.1:18889",
      ANNA_HARNESS_V2_PORT: "18889",
    },
    stop: async () => {},
  };

  await restartDesktopRuntime(currentRuntime, {
    restartDelayMs: 0,
    startRuntime: async (options) => {
      restartOptions = options;
      return options;
    },
  });

  assert.equal(restartOptions.harnessV2Port, 18889);
  assert.equal(restartOptions.env.ANNA_HARNESS_V2_BRIDGE_MANAGED, "1");
  assert.equal("ANNA_HARNESS_V2_BRIDGE_ORIGIN" in restartOptions.env, false);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
