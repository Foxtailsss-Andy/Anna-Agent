import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { createAgentSession } from "./node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts";
import { ModelRegistry } from "./node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts";
import { Settings } from "./node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts";
import { SessionManager } from "./node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts";
import { AuthStorage } from "./node_modules/@oh-my-pi/pi-ai/src/auth-storage.ts";
import { registerCustomApi } from "./node_modules/@oh-my-pi/pi-ai/src/api-registry.ts";

const configuredAttemptRoot = process.env.ANNA_OMP_ATTEMPT_ROOT;
if (configuredAttemptRoot === undefined) {
  throw new Error("managed launcher attempt root is required");
}
const attemptRoot = resolve(configuredAttemptRoot);
const attemptMetadata = await stat(attemptRoot);
if (!attemptMetadata.isDirectory() || (attemptMetadata.mode & 0o777) !== 0o700) {
  throw new Error("managed launcher attempt root must be a private 0700 directory");
}
const ompPackage = JSON.parse(await readFile(
  resolve(import.meta.dirname, "node_modules/@oh-my-pi/pi-coding-agent/package.json"),
  "utf8",
)) as { version?: unknown };
if (ompPackage.version !== "18.0.11") {
  throw new Error("materialized OMP version does not match 18.0.11");
}
const require = createRequire(import.meta.url);
const native = require(
  "./node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node",
);
let fetchCalls = 0;
let modelCalls = 0;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
const rejectFetch = async () => {
  fetchCalls += 1;
  throw new Error("network is disabled in the OMP materialization canary");
};
globalThis.fetch = rejectFetch as typeof fetch;
const settings = Settings.isolated({
  "memory.backend": "off",
  "autolearn.enabled": false,
  "autolearn.autoContinue": false,
  "compaction.enabled": false,
  "retry.enabled": false,
  "advisor.enabled": false,
  "prewalk.enabled": false,
  "goal.enabled": false,
  "async.enabled": false,
  "title.refreshOnReplan": false,
  "features.unexpectedStopDetection": "none",
  includeWorkspaceTree: false,
});
const authStorage = await AuthStorage.create(":memory:", {
  usageFetch: rejectFetch,
  usageProviderResolver: () => undefined,
});
const modelRegistry = new ModelRegistry(
  authStorage,
  join(attemptRoot, "models.yml"),
  {
    ignoreLocalModelConfig: true,
    cacheDbPath: join(attemptRoot, "models.db"),
    settings,
    fetch: rejectFetch,
  },
);
registerCustomApi("anna-s1-canary-api", () => {
  modelCalls += 1;
  throw new Error("model dispatch is disabled in the materialization canary");
});
modelRegistry.registerProvider("anna-s1-canary", {
  api: "anna-s1-canary-api",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "fixture-only",
  models: [{
    id: "fixture-model",
    name: "Fixture model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  }],
});
const model = modelRegistry.find("anna-s1-canary", "fixture-model");
if (model === undefined) throw new Error("canary model registration failed");
const sessionManager = SessionManager.inMemory(attemptRoot);
try {
  const created = await createAgentSession({
    cwd: attemptRoot,
    agentDir: join(attemptRoot, "agent"),
    additionalDirectories: [],
    spawns: "",
    authStorage,
    modelRegistry,
    model,
    settings,
    sessionManager,
    systemPrompt: "Materialization canary; no prompt is submitted.",
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    workspaceTree: {
      rootPath: attemptRoot,
      rendered: "",
      truncated: false,
      totalLines: 0,
      agentsMdFiles: [],
    },
    customTools: [],
    toolNames: [],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [],
    extensions: [],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    hasUI: false,
    interactivePrompts: false,
    requireYieldTool: false,
  });
  session = created.session;
  const activeTools = session.getActiveToolNames();
  session.beginDispose();
  await session.dispose();
  process.stdout.write(JSON.stringify({
    status: "ok",
    bun: Bun.version,
    omp: ompPackage.version,
    nativeExports: Object.keys(native).length,
    modelCalls,
    fetchCalls,
    activeTools,
    sessionFile: sessionManager.getSessionFile() ?? null,
    disposed: true,
  }) + "\n");
  if (modelCalls !== 0 || fetchCalls !== 0 || activeTools.length !== 0 || sessionManager.getSessionFile()) {
    process.exitCode = 1;
  }
} finally {
  if (session) {
    session.beginDispose();
    await session.dispose();
  }
  authStorage.close();
}
