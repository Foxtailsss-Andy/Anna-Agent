import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as esbuild from "esbuild";
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
