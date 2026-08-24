import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Keep __APP_VERSION__ defined under vitest too so anything importing the
// settings surface type-resolves / evaluates the same as the app build.
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// R2-T1 adds vitest for PURE frontend logic only (the Stage/Step trace model).
// Default `node` environment — no jsdom, no component tests this round. Scope
// discovery to the renderer sources so no backend/vendor files are collected.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  test: {
    include: ["apps/desktop/src/**/*.test.ts"],
    environment: "node",
  },
});
