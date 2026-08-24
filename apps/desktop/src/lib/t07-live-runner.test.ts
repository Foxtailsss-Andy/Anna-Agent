import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const runner = join(root, "scripts/live-t07-e2e.mjs");

function runRunner(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [runner], { cwd: root, env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stderr }));
  });
}

describe("T07 live runner boundary", () => {
  test("returns one stable JSON error when operator inputs are missing", async () => {
    const result = await runRunner({ ...process.env, ANNA_T07_LIVE_SOURCE: "" });
    expect(result.code).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "t07_live_operator_input_required",
    });
  });

  test.skipIf(process.platform !== "darwin")("writes and verifies fail-closed live evidence", async () => {
    const evidenceDir = await mkdtemp(join("/tmp", "anna-t07-runner-test-"));
    try {
      const result = await runRunner({
        ...process.env,
        ANNA_T07_LIVE_SOURCE: "/tmp/anna-t07-source-does-not-exist",
        ANNA_T07_LIVE_HEAD: "5aecdac8fc4f8bac1cfaa54a4f2b57a0fac2c936",
        ANNA_T07_LIVE_BACKEND_ORIGIN: "http://127.0.0.1:1",
        ANNA_T07_LIVE_OWNER_ID: "owner-test",
        ANNA_T07_LIVE_PROVIDER: "provider-test",
        ANNA_T07_LIVE_APPROVAL_ORIGIN: "http://127.0.0.1:1",
        ANNA_T07_LIVE_EVIDENCE_DIR: evidenceDir,
      });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, code: "t07_live_source_unavailable" });
      const manifest = JSON.parse(await readFile(join(evidenceDir, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        caseId: "t07-live",
        evidenceMode: "live-preflight",
        provider: "provider-test",
        gitHead: "5aecdac8fc4f8bac1cfaa54a4f2b57a0fac2c936",
        files: [{ path: "preflight.json" }],
      });
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });
});
