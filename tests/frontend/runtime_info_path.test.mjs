import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { defaultRuntimeInfoPath } from "../../scripts/runtime-info-path.mjs";

const windowsHome = ["C:", "Users", "demo"].join("\\");
const windowsAppData = [windowsHome, "AppData", "Roaming"].join("\\");

test("runtime info lookup prefers repository-local Electron state", () => {
  const cwd = join("C:", "work", "Anna");
  const localPath = join(cwd, ".anna", "runtime-info-electron.json");

  assert.equal(
    defaultRuntimeInfoPath({
      cwd,
      platform: "win32",
      homedir: windowsHome,
      env: { APPDATA: windowsAppData },
      existsSync: (candidate) => candidate === localPath,
    }),
    localPath,
  );
});

test("runtime info lookup falls back to installed-app user data", () => {
  assert.equal(
    defaultRuntimeInfoPath({
      cwd: ["C:", "work", "clean-checkout"].join("\\"),
      platform: "win32",
      homedir: windowsHome,
      env: { APPDATA: windowsAppData },
      existsSync: () => false,
    }),
    join(windowsAppData, "Anna", "runtime-info.json"),
  );
});
