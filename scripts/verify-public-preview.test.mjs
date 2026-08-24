import assert from "node:assert/strict";
import test from "node:test";

import { verifyPublicPreviewFiles } from "./verify-public-preview.mjs";

test("public preview verification accepts clean source and public docs", () => {
  const result = verifyPublicPreviewFiles([
    { path: "README.md", content: "Anna Developer Preview" },
    { path: "apps/desktop/src/App.tsx", content: 'import { HomePage } from "./pages/home/HomePage";' },
    { path: "package.json", content: '{"name":"anna"}' },
  ]);

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("public preview verification rejects local state, generated output, secrets, and paths", () => {
  const result = verifyPublicPreviewFiles([
    { path: ".anna/runtime.json", content: '{"model_api_key":"secret"}' },
    { path: "dist/index.html", content: "built" },
    { path: "evals/live/run.sqlite3", content: "sqlite" },
    { path: "docs/debug.md", content: `workspace: ${["", "Users", "alice", "Desktop", "Anna"].join("/")}` },
    { path: "docs/windows-debug.json", content: `{"workspace":"${["C:", "Users", "alice", "Desktop", "Anna"].join("\\\\")}"}` },
    { path: "services/config.ts", content: `const key = "${["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-")}";` },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((violation) => violation.code), [
    "local_state",
    "generated_output",
    "runtime_database",
    "absolute_path",
    "absolute_path",
    "credential_marker",
  ]);
});
