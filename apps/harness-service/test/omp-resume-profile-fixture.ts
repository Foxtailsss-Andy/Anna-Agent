import {
  resolveRunProfile,
  type ResolvedRunProfile,
} from "@anna/harness-v2";

export const OMP_RESUME_FIXTURE_WALL_TIME_MS = 180_000;

/** Re-resolve a test profile with a wider wall window before its Run is claimed. */
export function withAmpleRunBudget(
  base: ResolvedRunProfile,
): ResolvedRunProfile {
  const budget = { ...base.budget, wallTimeMs: OMP_RESUME_FIXTURE_WALL_TIME_MS };
  const skillIds = base.skills.map((skill) => skill.id);

  return resolveRunProfile({
    catalog: base.skills,
    channelPolicy: {
      toolPolicy: { allowedTools: base.allowedTools },
      allowedSkillIds: skillIds,
      allowedModels: [base.model],
      budgetLimits: budget,
      memoryPolicy: {
        allowedReadModes: [base.memoryPolicy.read],
        allowedWriteModes: [base.memoryPolicy.write],
      },
    },
    workerProfile: {
      id: base.workerProfile.id,
      version: base.workerProfile.version,
      instructions: base.workerProfile.instructions,
      allowedSkillIds: skillIds,
      allowedTools: base.allowedTools,
      modelPolicy: { allowedModels: [base.model] },
      budgetDefaults: budget,
      artifactContract: base.artifactContract,
    },
    runProfile: {
      id: base.id,
      version: base.version,
      model: base.model,
      skillIds,
      contextTransforms: base.contextTransforms,
      toolPolicy: { allowedTools: base.allowedTools },
      budget,
      memoryPolicy: base.memoryPolicy,
      evalPolicy: base.evalPolicy,
      artifactContract: base.artifactContract,
      terminalRules: base.terminalRules,
      ...(base.kernel === undefined ? {} : { kernel: base.kernel }),
    },
  });
}
