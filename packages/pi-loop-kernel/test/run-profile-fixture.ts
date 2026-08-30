import {
  resolveRunProfile,
  type ChannelPolicy,
  type ResolvedRunProfile,
  type RunProfile,
  type RunProfileId,
  type Budget,
  type SkillCatalogEntry,
  type WorkerProfile,
  type WorkerProfileId,
} from "@anna/harness-v2";

export function resolvedRunProfileFixture(
  options: {
    id?: string;
    version?: string;
    budget?: Budget;
    allowedTools?: readonly string[];
    memoryPolicy?: { read: "none" | "channel"; write: "disabled" | "propose" };
  } = {},
): ResolvedRunProfile {
  const allowedTools = [...(options.allowedTools ?? ["read_workspace", "fixture_read"])] as string[];
  const budget = options.budget ?? { turns: 1 };
  const memoryPolicy = options.memoryPolicy ?? { read: "none" as const, write: "disabled" as const };
  const catalog: SkillCatalogEntry[] = [{
    id: "fixture-skill",
    name: "Fixture skill",
    version: "1.0.0",
    hash: "sha256:fixture-skill",
    provenance: { source: "test", uri: "fixture://skill" },
    content: "Read the approved fixture before responding.",
    allowedTools,
    forbiddenTools: ["shell"],
  }];
  const channelPolicy: ChannelPolicy = {
    toolPolicy: { allowedTools },
    allowedSkillIds: ["fixture-skill"],
    allowedModels: [{ provider: "test", name: "fixture-model", reasoning: "low" }],
    budgetLimits: budget,
    memoryPolicy: {
      allowedReadModes: [memoryPolicy.read],
      allowedWriteModes: [memoryPolicy.write],
    },
  };
  const workerProfile: WorkerProfile = {
    id: "fixture-worker" as WorkerProfileId,
    version: "1.0.0",
    instructions: "Use the fixture policy.",
    allowedSkillIds: ["fixture-skill"],
    allowedTools,
    modelPolicy: { allowedModels: channelPolicy.allowedModels },
    budgetDefaults: budget,
    artifactContract: {
      kind: "fixture_artifact",
      requiredFor: ["completed"],
      verification: "tests",
    },
  };
  const runProfile: RunProfile = {
    id: (options.id ?? "profile-1") as RunProfileId,
    version: options.version ?? "1",
    model: channelPolicy.allowedModels[0]!,
    skillIds: ["fixture-skill"],
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
    toolPolicy: { allowedTools },
    budget,
    memoryPolicy,
    evalPolicy: { contract: "disabled", quality: "disabled" },
    artifactContract: workerProfile.artifactContract,
    terminalRules: {
      allowedOutcomes: ["completed", "failed"],
      stopCondition: "artifact_or_terminal",
    },
  };

  return resolveRunProfile({ catalog, channelPolicy, workerProfile, runProfile });
}
