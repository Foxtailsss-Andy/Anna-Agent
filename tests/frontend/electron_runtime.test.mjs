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
import { join } from "node:path";
import { test } from "node:test";

import {
  createPreviewRuntimeConfig,
  observeRuntimeExit,
  parseApiBaseFromArgv,
  resolveProjectRoot,
  restartDesktopRuntime,
  startRuntimeService,
  stopRuntimeService,
} from "../../apps/desktop/electron/runtime-service.mjs";
import {
  runtimeFailureDataUrl,
  runtimeFailureHtml,
} from "../../apps/desktop/electron/runtime-failure-page.mjs";

test("Electron runtime config starts one Preview Host with isolated local state", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "anna-project-"));
  const userDataPath = mkdtempSync(join(tmpdir(), "anna-user-data-"));

  try {
    const config = createPreviewRuntimeConfig({
      projectRoot,
      userDataPath,
      apiPort: 18765,
      platform: "darwin",
      arch: "arm64",
      env: {
        ANNA_RUNTIME_CONFIG_PATH: "/legacy/runtime.json",
        ANNA_HARNESS_V2_BRIDGE_ENABLED: "1",
        ANNA_PYTHON_BIN: "/legacy/python",
      },
    });

    assert.equal(config.apiBase, "http://127.0.0.1:18765");
    assert.equal(config.nodeExecutable, process.execPath);
    assert.deepEqual(config.args, [join(projectRoot, "apps", "harness-service", "dist", "preview-main.js")]);
    assert.equal(config.env.ANNA_PREVIEW_CONFIG_PATH, join(userDataPath, "preview", "config.json"));
    assert.equal(config.env.ANNA_PREVIEW_STATE_ROOT, join(userDataPath, "preview"));
    assert.equal(config.env.ANNA_PREVIEW_WORKSPACE_ROOT, join(userDataPath, "preview", "workspace"));
    assert.equal(config.env.ANNA_RUNTIME_CONFIG_PATH, undefined);
    assert.equal(config.env.ANNA_HARNESS_V2_BRIDGE_ENABLED, undefined);
    assert.equal(config.env.ANNA_PYTHON_BIN, undefined);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("Electron Preview runtime honors explicit Host paths", () => {
  const config = createPreviewRuntimeConfig({
    projectRoot: "/project",
    userDataPath: "/user-data",
    apiPort: 18002,
    platform: "darwin",
    arch: "arm64",
    env: {
      ANNA_PREVIEW_CONFIG_PATH: "/preview/config.json",
      ANNA_PREVIEW_STATE_ROOT: "/preview/state",
      ANNA_PREVIEW_WORKSPACE_ROOT: "/workspace",
      ANNA_PREVIEW_STATIC_ROOT: "/preview/dist",
      ANNA_PREVIEW_OMP_RUNTIME_ROOT: "/omp",
      ANNA_PREVIEW_ENTRY_PATH: "/preview/preview-main.js",
    },
  });

  assert.equal(config.entryPath, "/preview/preview-main.js");
  assert.equal(config.configPath, "/preview/config.json");
  assert.equal(config.stateRoot, "/preview/state");
  assert.equal(config.workspaceRoot, "/workspace");
  assert.equal(config.staticRoot, "/preview/dist");
  assert.equal(config.ompRuntimeRoot, "/omp");
});

test("Electron Preview runtime does not reuse project-local legacy state", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "anna-project-local-state-"));
  const userDataPath = mkdtempSync(join(tmpdir(), "anna-user-data-fallback-"));
  const localStatePath = join(projectRoot, ".anna");
  mkdirSync(localStatePath, { recursive: true });
  writeFileSync(join(localStatePath, "runtime.json"), "{}\n");

  try {
    const config = createPreviewRuntimeConfig({
      projectRoot,
      userDataPath,
      apiPort: 18001,
      platform: "darwin",
      arch: "arm64",
      env: {},
    });

    assert.equal(config.configPath, join(userDataPath, "preview", "config.json"));
    assert.equal(config.stateRoot, join(userDataPath, "preview"));
    assert.equal(config.runtimeInfoPath, join(userDataPath, "preview-runtime-info.json"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("Electron Preview runtime config rejects old Python-only overrides", () => {
  const config = createPreviewRuntimeConfig({
    projectRoot: "/project",
    userDataPath: "/user-data",
    apiPort: 18000,
    platform: "darwin",
    arch: "arm64",
    env: {
      ANNA_PYTHON_BIN: "/custom/python",
      ANNA_STATE_DB_PATH: "/custom/anna.sqlite3",
    },
  });

  assert.equal("pythonExecutable" in config, false);
  assert.equal(config.env.ANNA_STATE_DB_PATH, undefined);
  assert.equal(config.env.ANNA_PYTHON_BIN, undefined);
});

test("Electron preload argument parser exposes only the Preview API base", () => {
  const preloadSource = readFileSync(
    new URL("../../apps/desktop/electron/preload.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(
    parseApiBaseFromArgv(["electron", "--anna-api-base=http://127.0.0.1:18888"]),
    "http://127.0.0.1:18888",
  );
  assert.equal(parseApiBaseFromArgv(["electron"]), "");
  assert.doesNotMatch(preloadSource, /harness-v2-api-base/);
  assert.match(preloadSource, /mode:\s*["']preview["']/);
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
    "skills/**",
    "build/omp-runtime/darwin-arm64/**",
    "package.json",
  ]);
  assert.match(packageJson.default.scripts["desktop:run"], /harness:omp:prepare/);
  assert.match(packageJson.default.scripts["desktop:package"], /harness:omp:prepare/);
  assert.doesNotMatch(packageJson.default.scripts["desktop:run"], /desktop:prepare-python|uvicorn/);
  assert.doesNotMatch(packageJson.default.scripts["desktop:package"], /desktop:prepare-python|uvicorn/);
  assert.ok(packageJson.default.build.files.includes("build/omp-runtime/darwin-arm64/**/*"));
  assert.ok(packageJson.default.build.files.includes("apps/harness-service/dist/**/*"));
  assert.equal(packageJson.default.build.files.some((entry) => entry.includes("python-runtime")), false);
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
    message: "Anna Preview Host health check timed out",
    details: "Preview Host could not start",
  });
  const dataUrl = runtimeFailureDataUrl({
    message: "Anna runtime health check timed out",
  });

  assert.ok(html.includes("Anna Preview 启动失败"));
  assert.ok(html.includes("Anna Preview Host health check timed out"));
  assert.ok(html.includes("ANNA_PREVIEW_ENTRY_PATH"));
  assert.ok(html.includes("ANNA_PREVIEW_CONFIG_PATH"));
  assert.ok(dataUrl.startsWith("data:text/html;charset=utf-8,"));
});

test("Electron runtime failure page exposes a restart action and returns to the app", () => {
  const html = runtimeFailureHtml({
    message: "Anna Preview Host exited with code 42",
  });

  assert.match(html, /id="restart-runtime"/);
  assert.match(html, /__ANNA_RUNTIME__\.restartRuntime/);
  assert.match(html, /location\.assign/);
  assert.match(html, /重启 Preview/);
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

test("Electron Preview startup rejects a missing Host entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-preview-missing-entry-"));

  try {
    await assert.rejects(
      startRuntimeService(
        {
          projectRoot: root,
          entryPath: join(root, "missing-preview-main.js"),
          args: [join(root, "missing-preview-main.js")],
          nodeExecutable: process.execPath,
          env: process.env,
          apiBase: "http://127.0.0.1:9",
          stateRoot: join(root, "state"),
          configPath: join(root, "state", "config.json"),
          workspaceRoot: join(root, "workspace"),
        },
        { healthTimeoutMs: 50 },
      ),
      /Preview Host entry is missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron Preview writes API base runtime info after startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-preview-info-"));
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
        entryPath: childScript,
        nodeExecutable: process.execPath,
        args: [childScript],
        env: process.env,
        apiBase: "http://127.0.0.1:19001",
        apiHost: "127.0.0.1",
        apiPort: 19001,
        stateRoot: join(root, "state"),
        configPath: join(root, "config", "config.json"),
        workspaceRoot: join(root, "workspace"),
        staticRoot: join(root, "dist"),
        ompRuntimeRoot: join(root, "omp"),
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
      assert.equal(info.configPath, join(root, "config", "config.json"));
      assert.equal(info.stateRoot, join(root, "state"));
    } finally {
      await runtime.stop();
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron Preview startup stops child when health check never becomes ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-preview-health-timeout-"));
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
          entryPath: childScript,
          nodeExecutable: process.execPath,
          args: [childScript],
          env: process.env,
          apiBase: "http://127.0.0.1:9",
          stateRoot: join(root, "state"),
          configPath: join(root, "config", "config.json"),
          workspaceRoot: join(root, "workspace"),
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

test("Electron Preview restart preserves the explicit Host configuration", async () => {
  let restartOptions;
  const currentRuntime = {
    apiPort: 18888,
    projectRoot: "/project",
    userDataPath: "/user-data",
    env: {
      ANNA_PREVIEW_CONFIG_PATH: "/preview/config.json",
      ANNA_PREVIEW_STATE_ROOT: "/preview/state",
      ANNA_PREVIEW_WORKSPACE_ROOT: "/preview/workspace",
      ANNA_PREVIEW_STATIC_ROOT: "/preview/dist",
      ANNA_PREVIEW_OMP_RUNTIME_ROOT: "/preview/omp",
      ANNA_PREVIEW_ENTRY_PATH: "/preview/preview-main.js",
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

  assert.equal(restartOptions.apiPort, 18888);
  assert.equal(restartOptions.env.ANNA_PREVIEW_CONFIG_PATH, "/preview/config.json");
  assert.equal(restartOptions.env.ANNA_PREVIEW_OMP_RUNTIME_ROOT, "/preview/omp");
  assert.equal("ANNA_HARNESS_V2_BRIDGE_ENABLED" in restartOptions.env, false);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
