import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  createPreviewRuntimeConfig,
  parseApiBaseFromArgv,
  startPreviewRuntimeService,
} from "../../apps/desktop/electron/runtime-service.mjs";

test("default desktop runtime targets one Node Preview Host without Python", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "anna-preview-project-"));
  const userDataPath = mkdtempSync(join(tmpdir(), "anna-preview-user-"));

  try {
    const config = createPreviewRuntimeConfig({
      projectRoot,
      userDataPath,
      apiPort: 18801,
      platform: "darwin",
      arch: "arm64",
      env: {},
    });

    assert.equal(config.apiBase, "http://127.0.0.1:18801");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 18801);
    assert.equal(config.entryPath, join(projectRoot, "apps", "harness-service", "dist", "preview-main.js"));
    assert.equal(config.nodeExecutable, process.execPath);
    assert.equal("pythonExecutable" in config, false);
    assert.deepEqual(config.args, [config.entryPath]);
    assert.equal(config.env.ANNA_PREVIEW_HOST, "127.0.0.1");
    assert.equal(config.env.ANNA_PREVIEW_PORT, "18801");
    assert.equal(config.env.ANNA_PREVIEW_CONFIG_PATH, join(userDataPath, "preview", "config.json"));
    assert.equal(config.env.ANNA_PREVIEW_STATE_ROOT, join(userDataPath, "preview"));
    assert.equal(config.env.ANNA_PREVIEW_WORKSPACE_ROOT, join(userDataPath, "preview", "workspace"));
    assert.equal(config.env.ANNA_PREVIEW_STATIC_ROOT, join(projectRoot, "dist"));
    assert.equal(config.env.ANNA_PREVIEW_OMP_RUNTIME_ROOT, join(projectRoot, "build", "omp-runtime", "darwin-arm64"));
    assert.equal(config.env.ANNA_RUNTIME_CONFIG_PATH, undefined);
    assert.equal(config.env.ANNA_HARNESS_V2_BRIDGE_ENABLED, undefined);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("Preview runtime accepts explicit paths and does not silently start on unsupported platforms", () => {
  const config = createPreviewRuntimeConfig({
    projectRoot: "/project",
    userDataPath: "/user-data",
    apiPort: 18802,
    platform: "darwin",
    arch: "arm64",
    env: {
      ANNA_PREVIEW_ENTRY_PATH: "/preview/preview-main.js",
      ANNA_PREVIEW_CONFIG_PATH: "/preview/config.json",
      ANNA_PREVIEW_STATE_ROOT: "/preview/state",
      ANNA_PREVIEW_WORKSPACE_ROOT: "/workspace",
      ANNA_PREVIEW_STATIC_ROOT: "/preview/dist",
      ANNA_PREVIEW_OMP_RUNTIME_ROOT: "/omp",
    },
  });

  assert.equal(config.entryPath, "/preview/preview-main.js");
  assert.equal(config.env.ANNA_PREVIEW_CONFIG_PATH, "/preview/config.json");
  assert.equal(config.env.ANNA_PREVIEW_STATE_ROOT, "/preview/state");
  assert.equal(config.env.ANNA_PREVIEW_WORKSPACE_ROOT, "/workspace");
  assert.equal(config.env.ANNA_PREVIEW_STATIC_ROOT, "/preview/dist");
  assert.equal(config.env.ANNA_PREVIEW_OMP_RUNTIME_ROOT, "/omp");

  assert.throws(
    () => createPreviewRuntimeConfig({
      projectRoot: "/project",
      userDataPath: "/user-data",
      platform: "win32",
      arch: "x64",
      env: {},
    }),
    /macOS arm64/
  );
});

test("Preview runtime startup reports a missing Host entry explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-preview-missing-entry-"));

  try {
    await assert.rejects(
      startPreviewRuntimeService(
        {
          projectRoot: root,
          userDataPath: root,
          host: "127.0.0.1",
          port: 18803,
          apiBase: "http://127.0.0.1:18803",
          entryPath: join(root, "missing-preview-main.js"),
          nodeExecutable: process.execPath,
          args: [join(root, "missing-preview-main.js")],
          env: process.env,
          stateRoot: join(root, "state"),
          configPath: join(root, "state", "config.json"),
          workspaceRoot: join(root, "workspace"),
          staticRoot: join(root, "dist"),
          ompRuntimeRoot: join(root, "omp"),
        },
        { healthTimeoutMs: 50 },
      ),
      /Preview Host entry is missing/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron preload receives the single Preview API base", () => {
  assert.equal(
    parseApiBaseFromArgv(["electron", "--anna-api-base=http://127.0.0.1:18804"]),
    "http://127.0.0.1:18804",
  );
});

test("the default renderer entry mounts Preview without legacy login or chat calls", () => {
  const source = readFileSync(new URL("../../apps/desktop/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /PreviewPage/);
  assert.doesNotMatch(source, /LoginPage|session\/current|\/api\/chat/);
});

test("desktop packaging contains the Preview Host and prepared OMP runtime", async () => {
  const packageJson = await import("../../package.json", { with: { type: "json" } });
  const scripts = packageJson.default.scripts;
  const files = packageJson.default.build.files;
  const unpack = packageJson.default.build.asarUnpack;

  assert.match(scripts["desktop:run"], /harness:v2:build/);
  assert.match(scripts["desktop:run"], /harness:omp:prepare/);
  assert.doesNotMatch(scripts["desktop:run"], /desktop:prepare-python|uvicorn/);
  assert.match(scripts["desktop:package"], /harness:omp:prepare/);
  assert.doesNotMatch(scripts["desktop:package"], /desktop:prepare-python|uvicorn/);
  assert.ok(files.includes("apps/harness-service/dist/**/*"));
  assert.ok(files.includes("build/omp-runtime/darwin-arm64/**/*"));
  assert.ok(unpack.includes("build/omp-runtime/darwin-arm64/**"));
  assert.equal(files.some((entry) => entry.includes("python-runtime")), false);
  assert.equal(unpack.some((entry) => entry.includes("python-runtime")), false);
  assert.equal(existsSync(new URL("../../apps/harness-service/src/preview.ts", import.meta.url)), true);
});
