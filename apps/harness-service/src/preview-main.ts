import { startPreviewHarnessService } from "./preview";

let service: Awaited<ReturnType<typeof startPreviewHarnessService>>;
try {
  service = await startPreviewHarnessService({
    host: process.env.ANNA_PREVIEW_HOST,
    stateRoot: process.env.ANNA_PREVIEW_STATE_ROOT,
    configPath: process.env.ANNA_PREVIEW_CONFIG_PATH,
    workspaceRoot: process.env.ANNA_PREVIEW_WORKSPACE_ROOT,
    staticRoot: process.env.ANNA_PREVIEW_STATIC_ROOT,
    ompRuntimeRoot: process.env.ANNA_PREVIEW_OMP_RUNTIME_ROOT,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Anna Preview Host failed to start: ${message}\n`);
  process.exitCode = 1;
  throw error;
}

process.stdout.write(JSON.stringify({ status: "ready", url: service.url }) + "\n");

const shutdown = async () => {
  await service.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
