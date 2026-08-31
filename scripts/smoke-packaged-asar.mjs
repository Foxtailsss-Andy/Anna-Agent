import { app } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Anna Harness Preview packaged smoke currently supports macOS arm64 only");
}
const resourcesRoot = path.resolve(
  "release",
  "mac-arm64",
  "Anna.app",
  "Contents",
  "Resources",
);
const runtimeModuleUrl = pathToFileURL(
  path.join(resourcesRoot, "app.asar", "apps", "desktop", "electron", "runtime-service.mjs"),
).href;
const expectedProjectRoot = path.join(resourcesRoot, "app.asar.unpacked");
const userDataPath = mkdtempSync(path.join(tmpdir(), "anna-asar-smoke-"));

let runtime;

try {
  const { createDesktopRuntime, resolveProjectRoot } = await import(runtimeModuleUrl);
  const resolvedProjectRoot = resolveProjectRoot(runtimeModuleUrl);
  if (resolvedProjectRoot !== expectedProjectRoot) {
    throw new Error(
      `Expected project root ${expectedProjectRoot}, received ${resolvedProjectRoot}`,
    );
  }

  runtime = await createDesktopRuntime({
    userDataPath,
    healthTimeoutMs: 15000,
  });
  const health = await fetch(`${runtime.apiBase}/health`).then((response) => response.json());
  const index = await fetch(runtime.apiBase).then((response) => response.text());
  const status = await fetch(`${runtime.apiBase}/api/preview/status`).then((response) => response.json());
  const settings = await fetch(`${runtime.apiBase}/api/preview/settings`).then((response) => response.json());
  if (health.status !== "ok" || health.protocol !== "anna-harness-preview/1") {
    throw new Error(`Preview health check failed: ${JSON.stringify(health)}`);
  }
  if (status.kernel !== "omp" || status.configured !== false || status.ready !== false) {
    throw new Error(`Preview status should open without model configuration: ${JSON.stringify(status)}`);
  }
  if (settings.has_api_key !== false || "model_api_key" in settings) {
    throw new Error("Preview settings exposed a model API key");
  }
  if (!index.includes('<div id="root"></div>')) {
    throw new Error("Preview Host did not serve the built application");
  }

  console.log(
    JSON.stringify(
      {
        apiBase: runtime.apiBase,
        projectRoot: runtime.projectRoot,
        nodeExecutable: runtime.nodeExecutable,
        previewEntryPath: runtime.entryPath,
        ompRuntimeRoot: runtime.ompRuntimeRoot,
        servedIndex: index.includes('<div id="root"></div>'),
        health,
        previewStatus: status,
      },
      null,
      2,
    ),
  );
  await runtime.stop();
  rmSync(userDataPath, { recursive: true, force: true });
  app.exit(0);
} catch (error) {
  await runtime?.stop?.();
  rmSync(userDataPath, { recursive: true, force: true });
  console.error(error);
  app.exit(1);
}
