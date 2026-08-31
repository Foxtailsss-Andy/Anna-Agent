import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { chromium } from "playwright";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function loadPreviewPage() {
  mkdirSync(join(process.cwd(), ".tmp-tests"), { recursive: true });
  const outDir = mkdtempSync(join(process.cwd(), ".tmp-tests", "anna-preview-ui-"));
  const outFile = join(outDir, "PreviewPage.mjs");
  await esbuild.build({
    stdin: {
      contents: 'export * from "./apps/desktop/src/pages/preview/PreviewPage";',
      resolveDir: process.cwd(),
      sourcefile: "PreviewPage.tsx",
      loader: "tsx",
    },
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    loader: { ".png": "file" },
    external: ["react", "react/*"],
    define: { "import.meta.env.VITE_ANNA_API_BASE": '""' },
    logLevel: "silent",
  });
  try {
    return await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("Preview UI exposes task, lifecycle, history, stop, and settings surfaces", async () => {
  const { PreviewPage, finalMessageFromEvent } = await loadPreviewPage();
  const html = renderToStaticMarkup(React.createElement(PreviewPage));

  for (const label of ["Anna Preview", "新建任务", "运行过程", "运行历史", "停止", "设置", "模型", "工作区"]) {
    assert.ok(html.includes(label), `Expected Preview UI to include: ${label}`);
  }
  assert.equal(html.includes("/api/chat"), false);
  assert.equal(html.includes("登录"), false);

  assert.equal(finalMessageFromEvent({
    id: "event-1",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    streamId: "run-1",
    seq: 7,
    type: "omp.transcript.message",
    timestamp: "2026-08-31T00:00:00.000Z",
    schemaVersion: 1,
    payload: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "真实的 OMP 答案" }],
        stopReason: "stop",
      },
      attribution: { kernel: "omp" },
    },
  }), "真实的 OMP 答案");

});

test("a deferred stop from Run A cannot change active Run B history state", async () => {
  const { isPreviewStreamCurrent, stopResponseStatus } = await loadPreviewPage();

  // Selecting B increments the stream attempt and clears A's stopping marker.
  assert.equal(isPreviewStreamCurrent("run-b", 2, "run-a", 1), false);
  assert.equal(isPreviewStreamCurrent("run-b", 2, "run-b", 2), true);
  // A late terminal response is ignored; only a response for the active Run may apply.
  assert.equal(stopResponseStatus("run-b", "run-a", "completed"), undefined);
  assert.equal(stopResponseStatus("run-b", "run-b", "completed"), "completed");
});

test("deferred stop and history selection leave the active Preview Run usable", async () => {
  mkdirSync(join(process.cwd(), ".tmp-tests"), { recursive: true });
  const outDir = mkdtempSync(join(process.cwd(), ".tmp-tests", "anna-preview-browser-"));
  const outFile = join(outDir, "preview-browser.mjs");
  let releaseStop;
  const stopStarted = new Promise((resolve) => { releaseStop = resolve; });
  const runs = [
    { run_id: "run-a", goal: "A still running", status: "running", created_at: "2026-08-31T00:00:00.000Z", updated_at: "2026-08-31T00:00:01.000Z" },
    { run_id: "run-b", goal: "B completed history", status: "completed", created_at: "2026-08-31T00:00:00.000Z", updated_at: "2026-08-31T00:00:02.000Z" },
  ];
  const details = {
    "run-a": {
      run: runs[0],
      events: [{ seq: 0, type: "run.started", timestamp: "2026-08-31T00:00:01.000Z", payload: { phase: "started" } }],
    },
    "run-b": {
      run: runs[1],
      events: [{ seq: 2, type: "run.completed", timestamp: "2026-08-31T00:00:02.000Z", payload: { outcome: "completed" } }],
    },
  };

  await esbuild.build({
    stdin: {
      contents: [
        'import React from "react";',
        'import { createRoot } from "react-dom/client";',
        'import { PreviewPage } from "./apps/desktop/src/pages/preview/PreviewPage";',
        'createRoot(document.getElementById("root")).render(React.createElement(PreviewPage));',
      ].join("\n"),
      resolveDir: process.cwd(),
      sourcefile: "PreviewBrowser.tsx",
      loader: "tsx",
    },
    outfile: outFile,
    bundle: true,
    platform: "browser",
    format: "iife",
    loader: { ".png": "dataurl", ".css": "empty" },
    define: { "import.meta.env.VITE_ANNA_API_BASE": '""' },
    logLevel: "silent",
  });
  const script = readFileSync(outFile, "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/preview/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/preview/status") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ protocol: "anna-harness-preview/1", kernel: "omp", configured: true, ready: true }) });
      return;
    }
    if (url.pathname === "/api/preview/settings") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ model_name: "fixture", model_endpoint: "https://provider.example/v1/chat/completions", workspace_root: "/workspace", has_api_key: true }) });
      return;
    }
    if (url.pathname === "/api/preview/runs" && request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs }) });
      return;
    }
    const match = url.pathname.match(/^\/api\/preview\/runs\/([^/]+)(?:\/(events|stop))?$/);
    const runId = match?.[1];
    const action = match?.[2];
    if (runId === "run-a" && action === "stop") {
      releaseStop();
      await stopStarted;
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ contentType: "application/json", status: 202, body: JSON.stringify({ run_id: "run-a", status: "completed" }) });
      return;
    }
    if (runId && action === "events") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
      return;
    }
    if (runId && details[runId]) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(details[runId]) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "run_not_found" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.waitForSelector(".preview-run-item");
    const historyItems = page.locator(".preview-run-item");
    await historyItems.nth(0).click();
    await page.waitForFunction(() => document.querySelector(".preview-run-item--selected")?.textContent?.includes("A still running"));
    const stopButton = page.locator('[aria-label="停止任务"]');
    await stopButton.click();
    await stopStarted;
    await historyItems.nth(1).click();
    await page.waitForFunction(() => document.querySelector(".preview-run-item--selected")?.textContent?.includes("B completed history"));
    await page.waitForFunction(() => document.querySelector(".preview-activity")?.textContent?.includes("已完成"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await page.fill("#preview-goal", "A new task after history selection");
    assert.equal(await page.locator('button[type="submit"]').isDisabled(), false);
    assert.equal(await stopButton.isDisabled(), true);
    assert.ok((await page.locator(".preview-run-item--selected").textContent())?.includes("B completed history"));
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
