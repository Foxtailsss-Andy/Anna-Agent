import { app } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const resourcesRoot =
  process.platform === "win32"
    ? path.resolve("release", "win-unpacked", "resources")
    : path.resolve("release", "mac-arm64", "Anna.app", "Contents", "Resources");
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
  const health = await fetch(`${runtime.apiBase}/api/health`).then((response) =>
    response.json(),
  );
  const index = await fetch(runtime.apiBase).then((response) => response.text());
  const status = await fetch(`${runtime.apiBase}/api/admin/runtime/status`).then(
    (response) => response.json(),
  );

  console.log(
    JSON.stringify(
      {
        apiBase: runtime.apiBase,
        projectRoot: runtime.projectRoot,
        pythonExecutable: runtime.pythonExecutable,
        servedIndex: index.includes('<div id="root"></div>'),
        health,
        modelStatus: status.model.status,
        mcpStatus: status.reimbursement_mcp.status,
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
