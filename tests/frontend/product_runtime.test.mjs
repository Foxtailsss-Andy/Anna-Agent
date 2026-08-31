import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createProductRuntimeConfig } from "../../apps/desktop/electron/runtime-service.mjs";

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

test("Product smoke contract names the original app and both runtime preparation steps", async () => {
  const appSource = await readFile(new URL("../../apps/desktop/src/App.tsx", import.meta.url), "utf8");
  const preloadSource = await readFile(new URL("../../apps/desktop/electron/preload.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

  assert.match(appSource, /AnnaShell/);
  assert.doesNotMatch(appSource, /PreviewPage/);
  assert.match(preloadSource, /mode:\s*["']product["']/);
  assert.match(packageJson.scripts["desktop:run"], /desktop:prepare-python/);
  assert.match(packageJson.scripts["desktop:run"], /harness:omp:prepare/);
  assert.match(packageJson.scripts["desktop:package"], /desktop:prepare-python/);
  assert.match(packageJson.scripts["desktop:package"], /harness:omp:prepare/);
  assert.equal(
    packageJson.scripts["frontend:product-smoke"],
    "node --test tests/frontend/app_shell_smoke.mjs tests/frontend/product_runtime.test.mjs",
  );
});
