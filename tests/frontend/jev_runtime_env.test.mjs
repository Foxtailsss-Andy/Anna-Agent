import assert from "node:assert/strict";
import { test } from "node:test";

import { createProductRuntimeConfig } from "../../apps/desktop/electron/runtime-service.mjs";

test("Product launcher keeps Jev configuration Host-only and protects the key file", () => {
  const config = createProductRuntimeConfig({
    projectRoot: "/anna-project",
    userDataPath: "/anna-user-data",
    apiPort: 18_765,
    businessPort: 18_766,
    env: {
      ANNA_JEV_ENABLED: "1",
      ANNA_JEV_API_KEY_FILE: "/protected/jev.key",
      ANNA_HARNESS_HOST_CONFIG_PATH: "/protected/host.json",
      ANNA_HARNESS_BUSINESS_CONFIG_PATH: "/protected/business.json",
      ANNA_JEV_API_KEY: "must-not-cross-process-boundary",
    },
  });

  assert.equal(config.hostEnv.ANNA_JEV_ENABLED, "1");
  assert.equal(config.hostEnv.ANNA_JEV_API_KEY_FILE, "/protected/jev.key");
  assert.equal(config.businessEnv.ANNA_JEV_ENABLED, undefined);
  assert.equal(config.businessEnv.ANNA_JEV_API_KEY_FILE, undefined);
  assert.equal(config.businessEnv.ANNA_JEV_API_KEY, undefined);
  assert.ok(config.hostEnv.ANNA_HARNESS_PROTECTED_PATHS.split(":").includes("/protected/jev.key"));
});
