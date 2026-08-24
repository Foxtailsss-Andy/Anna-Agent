import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const databasePath = process.env.ANNA_EVENT_STORE_CRASH_DATABASE;
if (databasePath === undefined) {
  throw new Error("ANNA_EVENT_STORE_CRASH_DATABASE is required");
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({ root, appType: "custom", logLevel: "error" });
const { SqliteEventStore } = await vite.ssrLoadModule("/src/index.ts");
const { resolveRunProfile } = await vite.ssrLoadModule("@anna/harness-v2");
const scope = {
  workspaceId: "workspace-crash",
  channelId: "channel-crash",
};
const runProfileSnapshot = resolveRunProfile({
  catalog: [{
    id: "crash-fixture-skill",
    name: "Crash fixture skill",
    version: "1.0.0",
    hash: "sha256:crash-fixture-skill",
    provenance: { source: "test", uri: "fixture://crash-skill" },
    content: "Recover the durable fixture after a crash.",
    allowedTools: ["read_workspace"],
    forbiddenTools: ["shell"],
  }],
  channelPolicy: {
    toolPolicy: { allowedTools: ["read_workspace"] },
    allowedSkillIds: ["crash-fixture-skill"],
    allowedModels: [{ provider: "test", name: "fixture-model", reasoning: "low" }],
    budgetLimits: { turns: 1 },
    memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
  },
  workerProfile: {
    id: "crash-fixture-worker",
    version: "1.0.0",
    instructions: "Use the crash fixture policy.",
    allowedSkillIds: ["crash-fixture-skill"],
    allowedTools: ["read_workspace"],
    modelPolicy: {
      allowedModels: [{ provider: "test", name: "fixture-model", reasoning: "low" }],
    },
    budgetDefaults: { turns: 1 },
    artifactContract: {
      kind: "fixture_artifact",
      requiredFor: ["completed"],
      verification: "tests",
    },
  },
  runProfile: {
    id: "profile-1",
    version: "1",
    model: { provider: "test", name: "fixture-model", reasoning: "low" },
    skillIds: ["crash-fixture-skill"],
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
    toolPolicy: { allowedTools: ["read_workspace"] },
    budget: { turns: 1 },
    memoryPolicy: { read: "none", write: "disabled" },
    evalPolicy: { contract: "disabled", quality: "disabled" },
    artifactContract: {
      kind: "fixture_artifact",
      requiredFor: ["completed"],
      verification: "tests",
    },
    terminalRules: {
      allowedOutcomes: ["completed", "failed"],
      stopCondition: "artifact_or_terminal",
    },
  },
});
const command = {
  commandId: "command-crash",
  runId: "run-crash",
  goal: "Recover after a process crash.",
  ...scope,
  source: { eventId: "source-crash" },
  runProfile: { id: "profile-1", version: "1" },
  runProfileSnapshot,
  budget: { turns: 1 },
  permissionScope: "permission-1",
  stopCondition: "artifact_or_terminal",
};
const store = new SqliteEventStore(databasePath).scope(scope);

await store.claimStart(command);
await store.append({
  id: "crash-event-0",
  streamId: command.runId,
  seq: 0,
  type: "run.started",
  timestamp: "2026-08-18T02:00:00.000Z",
  schemaVersion: 1,
  payload: {},
  ...scope,
});
await store.append({
  id: "crash-event-1",
  streamId: command.runId,
  seq: 1,
  type: "run.progress",
  timestamp: "2026-08-18T02:00:01.000Z",
  schemaVersion: 1,
  payload: {},
  ...scope,
});

process.exit(73);
