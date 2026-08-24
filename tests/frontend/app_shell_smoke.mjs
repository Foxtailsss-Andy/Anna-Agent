import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as esbuild from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const tmpRoot = join(process.cwd(), ".tmp-tests");

async function bundle(entry, name) {
  mkdirSync(tmpRoot, { recursive: true });
  const outDir = mkdtempSync(join(tmpRoot, "anna-shell-test-"));
  const outFile = join(outDir, `${name}.mjs`);
  await esbuild.build({
    stdin: {
      contents: `export * from "${entry}";`,
      resolveDir: process.cwd(),
      sourcefile: `${name}.tsx`,
      loader: "tsx",
    },
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react/*", "lucide-react"],
    define: {
      "import.meta.env.VITE_ANNA_API_BASE": '""',
    },
    logLevel: "silent",
  });
  const module = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
  return { module, outDir };
}

async function withBundle(entry, name, callback) {
  const { module, outDir } = await bundle(entry, name);
  try {
    return await callback(module);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("current Anna shell exposes the supported navigation surfaces", async () => {
  await withBundle("./apps/desktop/src/components/shell/AnnaShell", "AnnaShell", ({ AnnaShell }) => {
    const html = renderToStaticMarkup(
      React.createElement(AnnaShell, {
        identity: {
          workspaceId: "preview-workspace",
          userId: "preview-user",
          role: "user",
          displayName: "Preview User",
          source: "local-runtime",
        },
        onLogout: () => {},
        renderSection: (section) => React.createElement("div", null, section),
      }),
    );

    for (const label of [
      "Home",
      "Cowork",
      "Crew",
      "产物中心",
      "Review Inspector",
      "设置",
      "Agent 中心",
    ]) {
      assert.ok(html.includes(label), `Expected shell to include: ${label}`);
    }
  });
});

test("Home is the current Chat/Create entry point", async () => {
  await withBundle("./apps/desktop/src/pages/home/HomePage", "HomePage", ({ HomePage }) => {
    const html = renderToStaticMarkup(React.createElement(HomePage, { displayName: "Preview User" }));
    for (const label of ["Chat", "Create", "做个网页", "写产品文档", "数据分析", "工作空间 · 未选择"]) {
      assert.ok(html.includes(label), `Expected Home to include: ${label}`);
    }
  });
});

test("Cowork reimbursement entry is renderable without a configured connector", async () => {
  await withBundle(
    "./apps/desktop/src/pages/cowork/ReimbursementPage",
    "ReimbursementPage",
    ({ ReimbursementPage }) => {
      const html = renderToStaticMarkup(React.createElement(ReimbursementPage));
      for (const label of ["报销 · 审批直办", "附加发票", "历史报销", "正在装载报销记录"]) {
        assert.ok(html.includes(label), `Expected reimbursement page to include: ${label}`);
      }
    },
  );
});

test("Developer preview exposes the current runtime takeover surface", async () => {
  await withBundle("./apps/desktop/src/pages/settings/DevTakeover", "DevTakeover", ({ DevTakeover }) => {
    const html = renderToStaticMarkup(
      React.createElement(DevTakeover, { devMode: true, onDevMode: () => {} }),
    );
    for (const label of ["开发者接管屏", "运行时总览", "就绪矩阵", "校验探针", "Skill 注册表", "治理总览"]) {
      assert.ok(html.includes(label), `Expected takeover surface to include: ${label}`);
    }
  });
});

test("Create runtime boundary keeps Legacy and Harness v2 claims explicit", async () => {
  await withBundle(
    "./apps/desktop/src/pages/home/createRuntimeBoundary",
    "CreateRuntimeBoundary",
    ({ resolveCreateRuntimeBoundary }) => {
      assert.deepEqual(
        resolveCreateRuntimeBoundary({ v2Configured: false, runId: "run-1", v2RunId: null, channelId: null }),
        { kind: "legacy" },
      );
      assert.deepEqual(
        resolveCreateRuntimeBoundary({ v2Configured: true, runId: "run-1", v2RunId: "run-1", channelId: "channel-1" }),
        { kind: "v2", channelId: "channel-1" },
      );
    },
  );
});
