import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";

import {
  createProductRuntimeConfig,
  findFreePort,
  startProductRuntimeService,
} from "../../apps/desktop/electron/runtime-service.mjs";

test("Product launcher starts the Node Host with a model-less business peer", () => {
  const config = createProductRuntimeConfig({
    projectRoot: "/anna-project",
    userDataPath: "/anna-user-data",
    apiPort: 18_765,
    businessPort: 18_766,
    env: {
      ANNA_HARNESS_HOST_CONFIG_PATH: "/protected/host.json",
      ANNA_HARNESS_BUSINESS_CONFIG_PATH: "/protected/business.json",
      ANNA_MODEL_API_KEY: "must-not-cross-process-boundary",
      OPENAI_API_KEY: "must-not-cross-process-boundary",
    },
  });

  assert.equal(config.entryPath, "/anna-project/apps/harness-service/dist/main.js");
  assert.equal(config.apiBase, "http://127.0.0.1:18765");
  assert.equal(config.businessApiBase, "http://127.0.0.1:18766");
  assert.equal(config.businessEnabled, true);
  assert.equal(config.businessManaged, true);
  assert.equal(config.hostEnv.ANNA_RUNTIME_CONFIG_PATH, "/protected/host.json");
  assert.equal(config.hostEnv.ANNA_HARNESS_BUSINESS_CONFIG_PATH, undefined);
  assert.equal(config.businessEnv.ANNA_RUNTIME_CONFIG_PATH, "/protected/business.json");
  assert.equal(config.businessEnv.ANNA_HARNESS_HOST_ORIGIN, "http://127.0.0.1:18765");
  assert.equal(config.hostEnv.ANNA_MODEL_API_KEY, undefined);
  assert.equal(config.businessEnv.ANNA_MODEL_API_KEY, undefined);
  assert.equal(config.businessEnv.OPENAI_API_KEY, undefined);
  assert.equal(config.businessEnv.ANNA_HARNESS_HOST_CONFIG_PATH, undefined);
  assert.equal(config.businessEnv.ANNA_HARNESS_SESSION_STORE_PATH, undefined);
});

test("Product launcher exposes bundled Python dependencies without overriding a venv", () => {
  const projectRoot = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "anna-product-python-"));
  const bundledRoot = path.join(projectRoot, "build", "python-runtime");
  const bundledPython = path.join(bundledRoot, "python", "bin", "python3.12");
  const bundledSitePackages = path.join(bundledRoot, "site-packages");
  mkdirSync(path.dirname(bundledPython), { recursive: true });
  mkdirSync(bundledSitePackages, { recursive: true });
  writeFileSync(bundledPython, "");

  try {
    const bundled = createProductRuntimeConfig({
      projectRoot,
      userDataPath: "/anna-user-data",
      apiPort: 18_765,
      businessPort: 18_766,
      env: {},
    });
    assert.equal(bundled.pythonExecutable, bundledPython);
    assert.equal(bundled.businessEnv.PYTHONPATH, `${projectRoot}${path.delimiter}${bundledSitePackages}`);
    assert.equal(bundled.businessEnv.PYTHONHOME, path.join(bundledRoot, "python"));

    const override = createProductRuntimeConfig({
      projectRoot,
      userDataPath: "/anna-user-data",
      apiPort: 18_765,
      businessPort: 18_766,
      env: {
        ANNA_PYTHON_BIN: "/custom/.venv/bin/python",
        PYTHONPATH: "/custom/.venv/lib/python/site-packages",
        PYTHONHOME: "/custom/.venv",
      },
    });
    assert.equal(override.pythonExecutable, "/custom/.venv/bin/python");
    assert.equal(override.businessEnv.PYTHONPATH, `${projectRoot}${path.delimiter}/custom/.venv/lib/python/site-packages`);
    assert.equal(override.businessEnv.PYTHONHOME, "/custom/.venv");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Product runtime drains noisy child stdout before waiting for health", async () => {
  const projectRoot = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "anna-product-stdout-"));
  const userDataPath = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "anna-product-stdout-data-"));
  const entryPath = path.join(projectRoot, "noisy-host.mjs");
  const apiPort = await findFreePort();
  writeFileSync(entryPath, [
    'import { writeSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'writeSync(1, Buffer.alloc(4 * 1024 * 1024, "x"));',
    'const server = createServer((_request, response) => { response.writeHead(200); response.end(JSON.stringify({ status: "ok" })); });',
    'server.listen(Number(process.env.ANNA_HARNESS_HOST_PORT), "127.0.0.1");',
  ].join("\n"));

  let runtime;
  try {
    const config = createProductRuntimeConfig({
      projectRoot,
      userDataPath,
      apiPort,
      env: {
        ANNA_HARNESS_HOST_ENTRY_PATH: entryPath,
        ANNA_HARNESS_BUSINESS_ENABLED: "0",
      },
    });
    runtime = await startProductRuntimeService(config, { healthTimeoutMs: 3_000 });
    const response = await fetch(`${runtime.apiBase}/health`);
    assert.equal(response.status, 200);
  } finally {
    await runtime?.stop?.();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("Product smoke contract names the original app and both runtime preparation steps", async () => {
  const appSource = await readFile(new URL("../../apps/desktop/src/App.tsx", import.meta.url), "utf8");
  const preloadSource = await readFile(new URL("../../apps/desktop/electron/preload.mjs", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("../../apps/desktop/electron/runtime-service.mjs", import.meta.url), "utf8");
  const smokeSource = await readFile(new URL("../../scripts/smoke-packaged-asar.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

  assert.match(appSource, /AnnaShell/);
  assert.doesNotMatch(appSource, /PreviewPage/);
  assert.match(preloadSource, /mode:\s*["']product["']/);
  assert.match(runtimeSource, /PYTHONPATH/);
  assert.match(runtimeSource, /PYTHONHOME/);
  assert.match(smokeSource, /anna-harness-product\/1/);
  assert.match(smokeSource, /_harness\/capabilities/);
  assert.doesNotMatch(smokeSource, /api\/preview/);
  assert.match(packageJson.scripts["desktop:run"], /desktop:prepare-python/);
  assert.match(packageJson.scripts["desktop:run"], /harness:omp:prepare/);
  assert.match(packageJson.scripts["desktop:package"], /desktop:prepare-python/);
  assert.match(packageJson.scripts["desktop:package"], /harness:omp:prepare/);
  assert.equal(
    packageJson.scripts["frontend:product-smoke"],
    "node --test tests/frontend/app_shell_smoke.mjs tests/frontend/product_runtime.test.mjs",
  );
});
