import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  claimRunWithResolvedProfile,
  RunManager,
  SqliteEventStore,
  type UnresolvedStartRun,
} from "../src/index";
import {
  parseStartRun,
  SchemaValidationError,
  type ChannelPolicy,
  type ChannelScope,
  type CommandId,
  type EventId,
  type RunProfile,
  type RunProfileId,
  type RunId,
  type SkillCatalogEntry,
  type WorkerProfile,
  type WorkerProfileId,
  type PermissionScopeId,
} from "@anna/harness-v2";

const scope = {
  workspaceId: "workspace-resolved-profile",
  channelId: "channel-resolved-profile",
} as ChannelScope;

const expectedSnapshot = {
  id: "release-review-run",
  version: "7",
  hash: "sha256:d1a1e88b117d1569661ea7dc68e00a017a1c8bce54645b879e5da846eed85020",
  workerProfileId: "release-manager",
  workerProfile: {
    id: "release-manager",
    version: "1.0.0",
    instructions: "Review release evidence and provide a validated release artifact.",
  },
  model: {
    provider: "openai",
    name: "gpt-5.6-terra",
    reasoning: "high",
  },
  skills: [
    {
      id: "release-review",
      name: "Release review",
      version: "1.2.0",
      hash: "sha256:5c5e7f4a",
      provenance: {
        source: "workspace",
        uri: "skills/release-review/SKILL.md",
      },
      content: "Review the approved release evidence before creating an artifact.",
      allowedTools: ["read_workspace", "write_workspace"],
      forbiddenTools: ["shell"],
    },
  ],
  allowedTools: ["read_workspace"],
  budget: {
    turns: 4,
    toolCalls: 2,
  },
  contextTransforms: [
    {
      kind: "compact",
      preserve: ["goal"],
    },
  ],
  memoryPolicy: {
    read: "channel",
    write: "propose",
  },
  evalPolicy: {
    contract: "required",
    quality: "human_on_risk",
  },
  artifactContract: {
    kind: "release_review",
    requiredFor: ["completed"],
    verification: "tests",
  },
  terminalRules: {
    allowedOutcomes: ["completed", "failed"],
    stopCondition: "artifact_or_terminal",
  },
} as const;

function withDatabase(
  testBody: (path: string, stores: SqliteEventStore[]) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "anna-resolved-run-profile-"));
  const stores: SqliteEventStore[] = [];

  return testBody(join(directory, "events.sqlite"), stores).finally(() => {
    for (const store of stores.reverse()) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });
}

test("resolves, claims, and restores the exact RunProfile snapshot through one Run-start seam", async () => {
  const catalog: SkillCatalogEntry[] = [
    {
      id: "release-review",
      name: "Release review",
      version: "1.2.0",
      hash: "sha256:5c5e7f4a",
      provenance: {
        source: "workspace",
        uri: "skills/release-review/SKILL.md",
      },
      content: "Review the approved release evidence before creating an artifact.",
      allowedTools: ["read_workspace", "write_workspace"],
      forbiddenTools: ["shell"],
    },
  ];
  const channelPolicy: ChannelPolicy = {
    toolPolicy: { allowedTools: ["read_workspace"] },
    allowedSkillIds: ["release-review"],
    allowedModels: [
      {
        provider: "openai",
        name: "gpt-5.6-terra",
        reasoning: "high",
      },
    ],
    budgetLimits: { turns: 5, toolCalls: 3 },
    memoryPolicy: {
      allowedReadModes: ["channel"],
      allowedWriteModes: ["propose"],
    },
  };
  const workerProfile: WorkerProfile = {
    id: "release-manager" as WorkerProfileId,
    version: "1.0.0",
    instructions: "Review release evidence and provide a validated release artifact.",
    allowedSkillIds: ["release-review"],
    allowedTools: ["read_workspace", "write_workspace"],
    modelPolicy: {
      allowedModels: [
        {
          provider: "openai",
          name: "gpt-5.6-terra",
          reasoning: "high",
        },
      ],
    },
    budgetDefaults: { turns: 5, toolCalls: 3 },
    artifactContract: {
      kind: "release_review",
      requiredFor: ["completed"],
      verification: "tests",
    },
  };
  const runProfile: RunProfile = {
    id: "release-review-run" as RunProfileId,
    version: "7",
    model: {
      provider: "openai",
      name: "gpt-5.6-terra",
      reasoning: "high",
    },
    skillIds: ["release-review"],
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
    toolPolicy: { allowedTools: ["read_workspace", "write_workspace"] },
    budget: { turns: 4, toolCalls: 2 },
    memoryPolicy: { read: "channel", write: "propose" },
    evalPolicy: { contract: "required", quality: "human_on_risk" },
    artifactContract: {
      kind: "release_review",
      requiredFor: ["completed"],
      verification: "tests",
    },
    terminalRules: {
      allowedOutcomes: ["completed", "failed"],
      stopCondition: "artifact_or_terminal",
    },
  };

  await withDatabase(async (path, stores) => {
    const first = new SqliteEventStore(path);
    stores.push(first);
    const command: UnresolvedStartRun = {
      commandId: "command-resolved-profile" as CommandId,
      runId: "run-resolved-profile" as RunId,
      goal: "Prepare the release brief from the approved evidence.",
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      source: { eventId: "source-event-resolved-profile" as EventId },
      permissionScope: "permission-resolved-profile" as PermissionScopeId,
    };

    const claimed = await claimRunWithResolvedProfile({
      store: first,
      command,
      catalog,
      channelPolicy,
      workerProfile,
      runProfile,
    });

    expect(claimed.runProfile).toEqual({
      id: expectedSnapshot.id,
      version: expectedSnapshot.version,
    });
    expect(claimed.runProfileSnapshot).toEqual(expectedSnapshot);
    expect(claimed.budget).toEqual(expectedSnapshot.budget);
    expect(claimed.stopCondition).toBe(expectedSnapshot.terminalRules.stopCondition);

    catalog[0] = {
      ...catalog[0],
      name: "Changed release review",
      version: "2.0.0",
      hash: "sha256:changed",
      content: "Changed after the Run started.",
    };
    channelPolicy.toolPolicy = { allowedTools: ["write_workspace"] };
    channelPolicy.allowedSkillIds = [];
    channelPolicy.allowedModels = [
      {
        provider: "anthropic",
        name: "claude-opus-4-1",
        reasoning: "low",
      },
    ];
    channelPolicy.budgetLimits = { turns: 1, toolCalls: 1 };
    channelPolicy.memoryPolicy = {
      allowedReadModes: ["none"],
      allowedWriteModes: ["disabled"],
    };
    workerProfile.version = "2.0.0";
    workerProfile.instructions = "Changed worker instructions.";
    workerProfile.allowedSkillIds = [];
    workerProfile.allowedTools = ["write_workspace"];
    workerProfile.modelPolicy = { allowedModels: [] };
    workerProfile.budgetDefaults = { turns: 1, toolCalls: 1 };
    workerProfile.artifactContract = {
      kind: "changed_artifact",
      requiredFor: ["completed"],
      verification: "tests",
    };
    runProfile.model = {
      provider: "anthropic",
      name: "claude-opus-4-1",
      reasoning: "low",
    };
    runProfile.skillIds = [];
    runProfile.contextTransforms = [];
    runProfile.toolPolicy = { allowedTools: ["write_workspace"] };
    runProfile.budget = { turns: 1, toolCalls: 1 };
    runProfile.memoryPolicy = { read: "none", write: "disabled" };
    runProfile.evalPolicy = { contract: "disabled", quality: "disabled" };
    runProfile.artifactContract = {
      kind: "changed_artifact",
      requiredFor: ["completed"],
      verification: "tests",
    };
    runProfile.terminalRules = {
      allowedOutcomes: ["completed"],
      stopCondition: "artifact_or_terminal",
    };

    first.close();
    stores.pop();

    const reopened = new SqliteEventStore(path);
    stores.push(reopened);
    const restoredStore = reopened.scope(scope);

    await expect(restoredStore.getRunCommand(command.runId)).resolves.toMatchObject({
      runProfile: {
        id: expectedSnapshot.id,
        version: expectedSnapshot.version,
      },
      runProfileSnapshot: expectedSnapshot,
      budget: expectedSnapshot.budget,
      stopCondition: expectedSnapshot.terminalRules.stopCondition,
    });
    await expect(new RunManager(restoredStore).get(command.runId)).resolves.toMatchObject({
      runProfile: {
        id: expectedSnapshot.id,
        version: expectedSnapshot.version,
      },
      runProfileSnapshot: expectedSnapshot,
      budget: expectedSnapshot.budget,
      stopCondition: expectedSnapshot.terminalRules.stopCondition,
    });

    expect(() => parseStartRun({
      ...command,
      runProfile: {
        id: expectedSnapshot.id,
        version: expectedSnapshot.version,
      },
      runProfileSnapshot: {
        id: expectedSnapshot.id,
        version: expectedSnapshot.version,
        hash: expectedSnapshot.hash,
      },
      budget: expectedSnapshot.budget,
      stopCondition: expectedSnapshot.terminalRules.stopCondition,
    })).toThrow(SchemaValidationError);
  });
});
