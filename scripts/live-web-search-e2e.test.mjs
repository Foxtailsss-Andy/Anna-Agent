import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  missingOperatorInputs,
  summarizeWebSearchRun,
} from "./live-web-search-e2e.mjs";

test("requires the WebSearch canary inputs without inspecting provider secrets", () => {
  assert.deepEqual(
    missingOperatorInputs({}),
    [
      "ANNA_WEB_SEARCH_LIVE_BACKEND_ORIGIN",
      "ANNA_WEB_SEARCH_LIVE_PROVIDER",
      "ANNA_WEB_SEARCH_LIVE_WORKSPACE_ID",
      "ANNA_WEB_SEARCH_LIVE_CHANNEL_ID",
      "ANNA_WEB_SEARCH_LIVE_QUERY",
      "ANNA_WEB_SEARCH_LIVE_EVIDENCE_DIR",
    ],
  );
});

test("summarizes only bounded WebSearch Run evidence", () => {
  const summary = summarizeWebSearchRun([
    { seq: 0, type: "run.queued", payload: { secret: "omit" } },
    { seq: 1, type: "run.tool.started", payload: { tool: "web_search", query: "omit" } },
    { seq: 2, type: "run.tool.completed", payload: { tool: "web_search", outcome: "succeeded", results: ["omit"] } },
    { seq: 3, type: "create.artifact.created", payload: { artifact: "omit" } },
    { seq: 4, type: "create.artifact.validated", payload: { validation: "omit" } },
    { seq: 5, type: "run.eval.contract", payload: { passed: true } },
    { seq: 6, type: "run.completed", payload: { answer: "omit" } },
  ], "provider-1");

  assert.deepEqual(summary, {
    provider: "provider-1",
    eventCount: 7,
    sequence: [0, 1, 2, 3, 4, 5, 6],
    terminal: "run.completed",
    webSearchToolCalls: 1,
    webSearchFailures: 0,
    createArtifactEvents: 1,
    createValidationEvents: 1,
    evalPassed: true,
    evidenceSufficient: true,
    eventIndex: [
      { seq: 0, type: "run.queued" },
      { seq: 1, type: "run.tool.started", tool: "web_search" },
      { seq: 2, type: "run.tool.completed", tool: "web_search", outcome: "succeeded" },
      { seq: 3, type: "create.artifact.created" },
      { seq: 4, type: "create.artifact.validated" },
      { seq: 5, type: "run.eval.contract" },
      { seq: 6, type: "run.completed" },
    ],
  });
});

test("fixture backend produces a manifest without raw query or Tool output", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "anna-web-search-evidence-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && request.url === "/capabilities") {
      response.end(JSON.stringify({
        surfaces: [{ id: "create", status: "available" }],
        unsupported_capabilities: { web_search: { status: "available" } },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v2/surfaces/create/runs") {
      response.writeHead(202);
      response.end(JSON.stringify({ run_id: "run-fixture-web-search" }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v2/runs/run-fixture-web-search/events?")) {
      response.end(JSON.stringify({ events: [
        { seq: 0, type: "run.queued", payload: {} },
        { seq: 1, type: "run.tool.started", payload: { tool: "web_search", query: "raw query" } },
        { seq: 2, type: "run.tool.completed", payload: { tool: "web_search", outcome: "succeeded", results: ["raw result"] } },
        { seq: 3, type: "create.artifact.created", payload: {} },
        { seq: 4, type: "create.artifact.validated", payload: {} },
        { seq: 5, type: "run.eval.contract", payload: { passed: true } },
        { seq: 6, type: "run.completed", payload: {} },
      ] }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ code: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const child = spawn(process.execPath, ["scripts/live-web-search-e2e.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANNA_WEB_SEARCH_LIVE_BACKEND_ORIGIN: `http://127.0.0.1:${address.port}`,
      ANNA_WEB_SEARCH_LIVE_PROVIDER: "fixture-provider",
      ANNA_WEB_SEARCH_LIVE_WORKSPACE_ID: "workspace-fixture",
      ANNA_WEB_SEARCH_LIVE_CHANNEL_ID: "channel-fixture",
      ANNA_WEB_SEARCH_LIVE_QUERY: "durable harness",
      ANNA_WEB_SEARCH_LIVE_EVIDENCE_DIR: evidenceDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  try {
    assert.equal(exitCode, 0);
    const summary = await readFile(join(evidenceDir, "summary.json"), "utf8");
    const manifest = await readFile(join(evidenceDir, "manifest.json"), "utf8");
    assert.match(summary, /"evidenceSufficient": true/);
    assert.doesNotMatch(summary, /durable harness|raw query|raw result/);
    assert.doesNotMatch(manifest, /durable harness|raw query|raw result/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(evidenceDir, { recursive: true, force: true });
  }
});
