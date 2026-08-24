import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { build, preview } from "vite";

const require = createRequire(import.meta.url);
const request = JSON.parse(await readFile(process.argv[2], "utf8"));
const sourceRoot = request.sourceRoot ?? request.root;

if (request.action === "build") {
  await build({
    root: request.entryDirectory,
    configFile: false,
    logLevel: "silent",
    base: "./",
    plugins: [
      react(),
      ...(request.candidate === undefined ? [] : [{
        name: "t07-candidate-source",
        load(id) {
          return resolve(id) === resolve(sourceRoot, request.uiPath)
            ? request.candidate
            : undefined;
        },
      }]),
    ],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        { find: "@", replacement: resolve(sourceRoot, "apps/desktop/src") },
        { find: /^react$/, replacement: require.resolve("react") },
        { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve("react/jsx-dev-runtime") },
        { find: /^react\/jsx-runtime$/, replacement: require.resolve("react/jsx-runtime") },
        { find: /^react-dom$/, replacement: require.resolve("react-dom") },
        { find: /^react-dom\/client$/, replacement: require.resolve("react-dom/client") },
      ],
    },
    build: {
      outDir: request.outputDirectory,
      emptyOutDir: true,
      rollupOptions: { input: request.indexPath },
    },
  });
  process.stdout.write(JSON.stringify({ ok: true }));
} else if (request.action === "screenshot") {
  const previewServer = await preview({
    root: request.root,
    configFile: false,
    logLevel: "silent",
    build: { outDir: request.outputDirectory },
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      ...(request.backendOrigin === undefined
        ? {}
        : { proxy: { "/api": { target: request.backendOrigin, changeOrigin: true } } }),
    },
  });
  if (typeof request.headlessShellExecutablePath !== "string") {
    throw new Error("contained screenshot request is missing its Playwright headless shell");
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath: request.headlessShellExecutablePath,
    args: ["--disable-background-networking"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const apiResponses = [];
    const previewUrl = previewServer.resolvedUrls?.local[0];
    if (previewUrl === undefined) throw new Error("Vite preview did not expose a local URL");
    const previewOrigin = new URL(previewUrl).origin;
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        requestUrl.origin === previewOrigin
        || requestUrl.protocol === "data:"
        || requestUrl.protocol === "blob:"
      ) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    page.on("response", (response) => {
      try {
        const responseUrl = new URL(response.url());
        if (responseUrl.origin === previewOrigin && responseUrl.pathname.startsWith("/api/")) {
          apiResponses.push({ path: responseUrl.pathname, status: response.status() });
        }
      } catch {
        // Browser response URLs are validated by the route handler above.
      }
    });
    await page.goto(previewUrl, { waitUntil: "networkidle" });
    await page.locator("#root > *").first().waitFor({ state: "visible" });
    await page.getByText(request.visibleText, { exact: true }).waitFor({ state: "visible" });
    let normalShell = false;
    if (request.backendOrigin !== undefined) {
      await page.locator(".ir-shell").waitFor({ state: "visible", timeout: 20_000 });
      normalShell = await page.locator(".ir-shell").isVisible();
      const sessionResponse = apiResponses.find(
        (response) => response.path === "/api/session/current" && response.status >= 200 && response.status < 300,
      );
      if (!normalShell || sessionResponse === undefined) {
        throw new Error("live UI did not render the normal shell from a successful Anna backend session");
      }
    }
    const bytes = await page.screenshot({ fullPage: true });
    process.stdout.write(JSON.stringify({
      bytes: bytes.toString("base64"),
      visibleText: request.visibleText,
      pageText: await page.locator("body").innerText(),
      normalShell,
      apiResponses,
    }));
  } finally {
    await browser.close();
    await new Promise((resolveClose, rejectClose) => {
      previewServer.httpServer.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  }
} else {
  throw new Error(`unsupported UI worker action: ${request.action}`);
}
