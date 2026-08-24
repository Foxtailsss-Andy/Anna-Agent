import {
  resolveRunProfile,
  type Budget,
  type ChannelPolicy,
  type ResolvedRunProfile,
  type RunProfile,
  type RunProfileId,
  type SkillCatalogEntry,
  type WorkerProfile,
  type WorkerProfileId,
} from "../src/index";

export function resolvedRunProfileFixture(
  options: { id?: string; version?: string; budget?: Budget } = {},
): ResolvedRunProfile {
  const allowedTools = ["read_workspace", "fixture_read"];
  const budget = options.budget ?? { turns: 1 };
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
    memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
  };
  const artifactContract = {
    kind: "fixture_artifact",
    requiredFor: ["completed"],
    verification: "tests",
  } as const;
  const workerProfile: WorkerProfile = {
    id: "fixture-worker" as WorkerProfileId,
    version: "1.0.0",
    instructions: "Use the fixture policy.",
    allowedSkillIds: ["fixture-skill"],
    allowedTools,
    modelPolicy: { allowedModels: channelPolicy.allowedModels },
    budgetDefaults: budget,
    artifactContract,
  };
  const runProfile: RunProfile = {
    id: (options.id ?? "profile-1") as RunProfileId,
    version: options.version ?? "1",
    model: channelPolicy.allowedModels[0]!,
    skillIds: ["fixture-skill"],
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
    toolPolicy: { allowedTools },
    budget,
    memoryPolicy: { read: "none", write: "disabled" },
    evalPolicy: { contract: "disabled", quality: "disabled" },
    artifactContract,
    terminalRules: {
      allowedOutcomes: ["completed", "failed"],
      stopCondition: "artifact_or_terminal",
    },
  };
  return resolveRunProfile({ catalog, channelPolicy, workerProfile, runProfile });
}
