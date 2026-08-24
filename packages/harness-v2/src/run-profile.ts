import { createHash } from "node:crypto";

import type {
  Budget,
  RunOutcome,
  RunProfileId,
  WorkerProfileId,
} from "./contracts";
import { SchemaValidationError, expectRecord } from "./schema";
import type { SkillCatalogEntry } from "./skill-catalog";
import type { ToolDefinition } from "./tool-gateway";

export interface AllowedToolsPolicy {
  allowedTools: readonly string[];
}

export type ModelReasoning = "low" | "high";

export interface ModelPolicy {
  provider: string;
  name: string;
  reasoning: ModelReasoning;
}

export type MemoryReadMode = "none" | "channel";
export type MemoryWriteMode = "disabled" | "propose";

export interface RunProfileMemoryPolicy {
  read: MemoryReadMode;
  write: MemoryWriteMode;
}

export interface ChannelMemoryPolicy {
  allowedReadModes: readonly MemoryReadMode[];
  allowedWriteModes: readonly MemoryWriteMode[];
}

export interface ChannelPolicy {
  toolPolicy: AllowedToolsPolicy;
  allowedSkillIds: readonly string[];
  allowedModels: readonly ModelPolicy[];
  budgetLimits: Budget;
  memoryPolicy: ChannelMemoryPolicy;
}

export type ArtifactVerification = "tests";

export interface ArtifactContract {
  kind: string;
  requiredFor: readonly RunOutcome["status"][];
  verification: ArtifactVerification;
}

export interface WorkerProfile {
  id: WorkerProfileId;
  version: string;
  instructions: string;
  allowedSkillIds: readonly string[];
  allowedTools: readonly string[];
  modelPolicy: {
    allowedModels: readonly ModelPolicy[];
  };
  budgetDefaults: Budget;
  artifactContract: ArtifactContract;
}

export type ContextTransformKind = "compact";
export type ContextPreservedField =
  | "goal"
  | "constraints"
  | "pending_tool_calls"
  | "provenance";

export interface ContextTransform {
  kind: ContextTransformKind;
  preserve: readonly ContextPreservedField[];
}

export interface EvalPolicy {
  contract: "disabled" | "required";
  quality: "disabled" | "human_on_risk";
}

export interface TerminalRules {
  allowedOutcomes: readonly RunOutcome["status"][];
  stopCondition: "artifact_or_terminal";
}

export interface RunProfile {
  id: RunProfileId;
  version: string;
  model: ModelPolicy;
  skillIds: readonly string[];
  contextTransforms: readonly ContextTransform[];
  toolPolicy: AllowedToolsPolicy;
  budget: Budget;
  memoryPolicy: RunProfileMemoryPolicy;
  evalPolicy: EvalPolicy;
  artifactContract: ArtifactContract;
  terminalRules: TerminalRules;
}

export interface ResolveRunProfileOptions {
  readonly catalog: readonly SkillCatalogEntry[];
  readonly channelPolicy: ChannelPolicy;
  readonly workerProfile: WorkerProfile;
  readonly runProfile: RunProfile;
}

export interface WorkerProfileSummary {
  readonly id: WorkerProfileId;
  readonly version: string;
  readonly instructions: string;
}

export interface ResolvedRunProfile {
  readonly id: RunProfileId;
  readonly version: string;
  readonly hash: string;
  readonly workerProfileId: WorkerProfileId;
  readonly workerProfile: Readonly<WorkerProfileSummary>;
  readonly model: Readonly<ModelPolicy>;
  readonly skills: readonly Readonly<SkillCatalogEntry>[];
  readonly allowedTools: readonly string[];
  readonly budget: Readonly<Budget>;
  readonly contextTransforms: readonly Readonly<ContextTransform>[];
  readonly memoryPolicy: Readonly<RunProfileMemoryPolicy>;
  readonly evalPolicy: Readonly<EvalPolicy>;
  readonly artifactContract: Readonly<ArtifactContract>;
  readonly terminalRules: Readonly<TerminalRules>;
}

const budgetKeys = [
  "wallTimeMs",
  "turns",
  "inputTokens",
  "outputTokens",
  "cost",
  "toolCalls",
  "retryAttempts",
  "concurrentChildLanes",
] as const satisfies readonly (keyof Budget)[];

const reasoningLevels = ["low", "high"] as const;
const memoryReadModes = ["none", "channel"] as const;
const memoryWriteModes = ["disabled", "propose"] as const;
const artifactVerifications = ["tests"] as const;
const contextTransformKinds = ["compact"] as const;
const contextPreservedFields = [
  "goal",
  "constraints",
  "pending_tool_calls",
  "provenance",
] as const;
const evalContracts = ["disabled", "required"] as const;
const evalQualities = ["disabled", "human_on_risk"] as const;
const runOutcomes = [
  "completed",
  "awaiting_input",
  "awaiting_approval",
  "failed",
  "timed_out",
  "cancelled",
] as const satisfies readonly RunOutcome["status"][];
const terminalStopConditions = ["artifact_or_terminal"] as const;

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

function requireEnum<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  name: string,
): Value {
  const candidate = requireNonEmptyString(value, name);
  if (!allowed.includes(candidate as Value)) {
    throw new Error(`${name} is not allowed`);
  }

  return candidate as Value;
}

function copyStringArray(
  values: unknown,
  name: string,
  required: boolean,
): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be an array`);
  }
  if (required && values.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  return values.map((value, index) =>
    requireNonEmptyString(value, `${name}[${index}]`),
  );
}

function copyEnumArray<Value extends string>(
  values: unknown,
  allowed: readonly Value[],
  name: string,
  required: boolean,
): Value[] {
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be an array`);
  }
  if (required && values.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  return values.map((value, index) =>
    requireEnum(value, allowed, `${name}[${index}]`),
  );
}

function snapshotModel(model: ModelPolicy, name: string): ModelPolicy {
  return {
    provider: requireNonEmptyString(model?.provider, `${name}.provider`),
    name: requireNonEmptyString(model?.name, `${name}.name`),
    reasoning: requireEnum(
      model?.reasoning,
      reasoningLevels,
      `${name}.reasoning`,
    ),
  };
}

function snapshotModels(
  models: readonly ModelPolicy[],
  name: string,
): ModelPolicy[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }

  return models.map((model, index) => snapshotModel(model, `${name}[${index}]`));
}

function snapshotSkill(skill: SkillCatalogEntry): SkillCatalogEntry {
  return {
    id: requireNonEmptyString(skill?.id, "Skill.id"),
    name: requireNonEmptyString(skill?.name, "Skill.name"),
    version: requireNonEmptyString(skill?.version, "Skill.version"),
    hash: requireNonEmptyString(skill?.hash, "Skill.hash"),
    provenance: {
      source: requireNonEmptyString(
        skill?.provenance?.source,
        "Skill.provenance.source",
      ),
      uri: requireNonEmptyString(skill?.provenance?.uri, "Skill.provenance.uri"),
    },
    content: requireNonEmptyString(skill?.content, "Skill.content"),
    allowedTools: copyStringArray(skill?.allowedTools, "Skill.allowedTools", false),
    forbiddenTools: copyStringArray(
      skill?.forbiddenTools,
      "Skill.forbiddenTools",
      false,
    ),
  };
}

function snapshotArtifactContract(
  contract: ArtifactContract,
  name: string,
): ArtifactContract {
  return {
    kind: requireNonEmptyString(contract?.kind, `${name}.kind`),
    requiredFor: copyEnumArray(
      contract?.requiredFor,
      runOutcomes,
      `${name}.requiredFor`,
      true,
    ),
    verification: requireEnum(
      contract?.verification,
      artifactVerifications,
      `${name}.verification`,
    ),
  };
}

function artifactContractsMatch(
  first: ArtifactContract,
  second: ArtifactContract,
): boolean {
  return first.kind === second.kind
    && first.verification === second.verification
    && first.requiredFor.length === second.requiredFor.length
    && first.requiredFor.every((outcome, index) => outcome === second.requiredFor[index]);
}

function modelIsAllowed(
  model: ModelPolicy,
  allowedModels: readonly ModelPolicy[],
): boolean {
  return allowedModels.some(
    (candidate) =>
      candidate.provider === model.provider
      && candidate.name === model.name
      && candidate.reasoning === model.reasoning,
  );
}

function resolveBudget(
  workerDefaults: Budget,
  runBudget: Budget,
  channelLimits: Budget,
): Budget {
  const budget: Budget = {};

  for (const key of budgetKeys) {
    const requested = runBudget[key] ?? workerDefaults[key];
    const limit = channelLimits[key];
    if (requested !== undefined) {
      budget[key] = limit === undefined ? requested : Math.min(requested, limit);
    }
  }

  return budget;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJson(record[key]);
    }
    return sorted;
  }

  return value;
}

function profileHash(snapshot: Omit<ResolvedRunProfile, "hash">): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortJson(snapshot)), "utf8")
    .digest("hex")}`;
}

function exactRecord(
  input: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  const value = allowedRecord(input, name, keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new SchemaValidationError(`${name}.${key} is required`);
    }
  }
  return value;
}

function allowedRecord(
  input: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  const value = expectRecord(input, name);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new SchemaValidationError(`${name}.${key} is not allowed`);
    }
  }
  return value;
}

function snapshotString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SchemaValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function snapshotEnum<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  name: string,
): Value {
  const candidate = snapshotString(value, name);
  if (!allowed.includes(candidate as Value)) {
    throw new SchemaValidationError(`${name} is not allowed`);
  }
  return candidate as Value;
}

function snapshotBudget(input: unknown, name: string): Budget {
  const value = allowedRecord(input, name, budgetKeys);
  const budget: Budget = {};
  const integerKeys = budgetKeys.filter((key) => key !== "cost");
  for (const key of integerKeys) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (
      typeof candidate !== "number"
      || !Number.isSafeInteger(candidate)
      || candidate < 1
    ) {
      throw new SchemaValidationError(`${name}.${key} must be a positive integer`);
    }
    budget[key] = candidate;
  }
  if (value.cost !== undefined) {
    if (typeof value.cost !== "number" || !Number.isFinite(value.cost) || value.cost <= 0) {
      throw new SchemaValidationError(`${name}.cost must be a positive finite number`);
    }
    budget.cost = value.cost;
  }
  if (Object.keys(budget).length === 0) {
    throw new SchemaValidationError(`${name} must define at least one limit`);
  }
  return budget;
}

function parseSnapshotModel(input: unknown, name: string): ModelPolicy {
  const value = exactRecord(input, name, ["provider", "name", "reasoning"]);
  return {
    provider: snapshotString(value.provider, `${name}.provider`),
    name: snapshotString(value.name, `${name}.name`),
    reasoning: snapshotEnum(value.reasoning, reasoningLevels, `${name}.reasoning`),
  };
}

function snapshotSkillEntry(input: unknown, name: string): SkillCatalogEntry {
  const value = exactRecord(input, name, [
    "id",
    "name",
    "version",
    "hash",
    "provenance",
    "content",
    "allowedTools",
    "forbiddenTools",
  ]);
  const provenance = exactRecord(value.provenance, `${name}.provenance`, ["source", "uri"]);
  return {
    id: snapshotString(value.id, `${name}.id`),
    name: snapshotString(value.name, `${name}.name`),
    version: snapshotString(value.version, `${name}.version`),
    hash: snapshotString(value.hash, `${name}.hash`),
    provenance: {
      source: snapshotString(provenance.source, `${name}.provenance.source`),
      uri: snapshotString(provenance.uri, `${name}.provenance.uri`),
    },
    content: snapshotString(value.content, `${name}.content`),
    allowedTools: copyStringArray(value.allowedTools, `${name}.allowedTools`, false),
    forbiddenTools: copyStringArray(value.forbiddenTools, `${name}.forbiddenTools`, false),
  };
}

/** Parses the immutable, content-addressed profile persisted with a Run. */
export function parseResolvedRunProfileSnapshot(input: unknown): ResolvedRunProfile {
  const value = exactRecord(input, "RunProfileSnapshot", [
    "id",
    "version",
    "hash",
    "workerProfileId",
    "workerProfile",
    "model",
    "skills",
    "allowedTools",
    "budget",
    "contextTransforms",
    "memoryPolicy",
    "evalPolicy",
    "artifactContract",
    "terminalRules",
  ]);
  const workerProfile = exactRecord(value.workerProfile, "RunProfileSnapshot.workerProfile", [
    "id",
    "version",
    "instructions",
  ]);
  const workerProfileId = snapshotString(
    value.workerProfileId,
    "RunProfileSnapshot.workerProfileId",
  ) as WorkerProfileId;
  const parsedWorkerProfile: WorkerProfileSummary = {
    id: snapshotString(workerProfile.id, "RunProfileSnapshot.workerProfile.id") as WorkerProfileId,
    version: snapshotString(workerProfile.version, "RunProfileSnapshot.workerProfile.version"),
    instructions: snapshotString(
      workerProfile.instructions,
      "RunProfileSnapshot.workerProfile.instructions",
    ),
  };
  if (workerProfileId !== parsedWorkerProfile.id) {
    throw new SchemaValidationError(
      "RunProfileSnapshot.workerProfileId must match RunProfileSnapshot.workerProfile.id",
    );
  }

  if (!Array.isArray(value.skills) || value.skills.length === 0) {
    throw new SchemaValidationError("RunProfileSnapshot.skills must be a non-empty array");
  }
  if (!Array.isArray(value.contextTransforms) || value.contextTransforms.length === 0) {
    throw new SchemaValidationError(
      "RunProfileSnapshot.contextTransforms must be a non-empty array",
    );
  }

  const memoryPolicy = exactRecord(value.memoryPolicy, "RunProfileSnapshot.memoryPolicy", [
    "read",
    "write",
  ]);
  const evalPolicy = exactRecord(value.evalPolicy, "RunProfileSnapshot.evalPolicy", [
    "contract",
    "quality",
  ]);
  const artifactContract = exactRecord(
    value.artifactContract,
    "RunProfileSnapshot.artifactContract",
    ["kind", "requiredFor", "verification"],
  );
  const terminalRules = exactRecord(value.terminalRules, "RunProfileSnapshot.terminalRules", [
    "allowedOutcomes",
    "stopCondition",
  ]);

  const snapshot: Omit<ResolvedRunProfile, "hash"> = {
    id: snapshotString(value.id, "RunProfileSnapshot.id") as RunProfileId,
    version: snapshotString(value.version, "RunProfileSnapshot.version"),
    workerProfileId,
    workerProfile: parsedWorkerProfile,
    model: parseSnapshotModel(value.model, "RunProfileSnapshot.model"),
    skills: value.skills.map((skill, index) =>
      snapshotSkillEntry(skill, `RunProfileSnapshot.skills[${index}]`),
    ),
    allowedTools: copyStringArray(
      value.allowedTools,
      "RunProfileSnapshot.allowedTools",
      false,
    ),
    budget: snapshotBudget(value.budget, "RunProfileSnapshot.budget"),
    contextTransforms: value.contextTransforms.map((transform, index) => {
      const parsed = exactRecord(
        transform,
        `RunProfileSnapshot.contextTransforms[${index}]`,
        ["kind", "preserve"],
      );
      return {
        kind: snapshotEnum(
          parsed.kind,
          contextTransformKinds,
          `RunProfileSnapshot.contextTransforms[${index}].kind`,
        ),
        preserve: copyEnumArray(
          parsed.preserve,
          contextPreservedFields,
          `RunProfileSnapshot.contextTransforms[${index}].preserve`,
          true,
        ),
      };
    }),
    memoryPolicy: {
      read: snapshotEnum(
        memoryPolicy.read,
        memoryReadModes,
        "RunProfileSnapshot.memoryPolicy.read",
      ),
      write: snapshotEnum(
        memoryPolicy.write,
        memoryWriteModes,
        "RunProfileSnapshot.memoryPolicy.write",
      ),
    },
    evalPolicy: {
      contract: snapshotEnum(
        evalPolicy.contract,
        evalContracts,
        "RunProfileSnapshot.evalPolicy.contract",
      ),
      quality: snapshotEnum(
        evalPolicy.quality,
        evalQualities,
        "RunProfileSnapshot.evalPolicy.quality",
      ),
    },
    artifactContract: {
      kind: snapshotString(artifactContract.kind, "RunProfileSnapshot.artifactContract.kind"),
      requiredFor: copyEnumArray(
        artifactContract.requiredFor,
        runOutcomes,
        "RunProfileSnapshot.artifactContract.requiredFor",
        true,
      ),
      verification: snapshotEnum(
        artifactContract.verification,
        artifactVerifications,
        "RunProfileSnapshot.artifactContract.verification",
      ),
    },
    terminalRules: {
      allowedOutcomes: copyEnumArray(
        terminalRules.allowedOutcomes,
        runOutcomes,
        "RunProfileSnapshot.terminalRules.allowedOutcomes",
        true,
      ),
      stopCondition: snapshotEnum(
        terminalRules.stopCondition,
        terminalStopConditions,
        "RunProfileSnapshot.terminalRules.stopCondition",
      ),
    },
  };
  const hash = snapshotString(value.hash, "RunProfileSnapshot.hash");
  if (hash !== profileHash(snapshot)) {
    throw new SchemaValidationError("RunProfileSnapshot.hash must match its canonical content");
  }

  return deepFreeze({ ...snapshot, hash }) as ResolvedRunProfile;
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value as Readonly<Value>;
}

export function resolveRunProfile(
  options: ResolveRunProfileOptions,
): ResolvedRunProfile {
  const runProfile = options.runProfile;
  const channelTools = copyStringArray(
    options.channelPolicy?.toolPolicy?.allowedTools,
    "ChannelPolicy.toolPolicy.allowedTools",
    true,
  );
  const channelSkillIds = copyStringArray(
    options.channelPolicy?.allowedSkillIds,
    "ChannelPolicy.allowedSkillIds",
    true,
  );
  const channelModels = snapshotModels(
    options.channelPolicy?.allowedModels,
    "ChannelPolicy.allowedModels",
  );
  const channelReadModes = copyEnumArray(
    options.channelPolicy?.memoryPolicy?.allowedReadModes,
    memoryReadModes,
    "ChannelPolicy.memoryPolicy.allowedReadModes",
    true,
  );
  const channelWriteModes = copyEnumArray(
    options.channelPolicy?.memoryPolicy?.allowedWriteModes,
    memoryWriteModes,
    "ChannelPolicy.memoryPolicy.allowedWriteModes",
    true,
  );
  const workerId = requireNonEmptyString(
    options.workerProfile?.id,
    "WorkerProfile.id",
  ) as WorkerProfileId;
  const workerVersion = requireNonEmptyString(
    options.workerProfile?.version,
    "WorkerProfile.version",
  );
  const workerInstructions = requireNonEmptyString(
    options.workerProfile?.instructions,
    "WorkerProfile.instructions",
  );
  const workerSkillIds = copyStringArray(
    options.workerProfile?.allowedSkillIds,
    "WorkerProfile.allowedSkillIds",
    true,
  );
  const workerTools = copyStringArray(
    options.workerProfile?.allowedTools,
    "WorkerProfile.allowedTools",
    true,
  );
  const workerModels = snapshotModels(
    options.workerProfile?.modelPolicy?.allowedModels,
    "WorkerProfile.modelPolicy.allowedModels",
  );
  const workerArtifactContract = snapshotArtifactContract(
    options.workerProfile?.artifactContract,
    "WorkerProfile.artifactContract",
  );
  const id = requireNonEmptyString(runProfile?.id, "RunProfile.id") as RunProfileId;
  const version = requireNonEmptyString(runProfile?.version, "RunProfile.version");
  const model = snapshotModel(runProfile?.model, "RunProfile.model");
  const runSkillIds = copyStringArray(
    runProfile?.skillIds,
    "RunProfile.skillIds",
    true,
  );
  const profileTools = copyStringArray(
    runProfile?.toolPolicy?.allowedTools,
    "RunProfile.toolPolicy.allowedTools",
    true,
  );
  const memoryPolicy: RunProfileMemoryPolicy = {
    read: requireEnum(
      runProfile?.memoryPolicy?.read,
      memoryReadModes,
      "RunProfile.memoryPolicy.read",
    ),
    write: requireEnum(
      runProfile?.memoryPolicy?.write,
      memoryWriteModes,
      "RunProfile.memoryPolicy.write",
    ),
  };
  const contextTransforms = runProfile?.contextTransforms;
  if (!Array.isArray(contextTransforms) || contextTransforms.length === 0) {
    throw new Error("RunProfile.contextTransforms must be a non-empty array");
  }
  const snapshotContextTransforms: ContextTransform[] = contextTransforms.map(
    (transform, index) => ({
      kind: requireEnum(
        transform?.kind,
        contextTransformKinds,
        `RunProfile.contextTransforms[${index}].kind`,
      ),
      preserve: copyEnumArray(
        transform?.preserve,
        contextPreservedFields,
        `RunProfile.contextTransforms[${index}].preserve`,
        true,
      ),
    }),
  );
  const evalPolicy: EvalPolicy = {
    contract: requireEnum(
      runProfile?.evalPolicy?.contract,
      evalContracts,
      "RunProfile.evalPolicy.contract",
    ),
    quality: requireEnum(
      runProfile?.evalPolicy?.quality,
      evalQualities,
      "RunProfile.evalPolicy.quality",
    ),
  };
  const artifactContract = snapshotArtifactContract(
    runProfile?.artifactContract,
    "RunProfile.artifactContract",
  );
  const terminalRules: TerminalRules = {
    allowedOutcomes: copyEnumArray(
      runProfile?.terminalRules?.allowedOutcomes,
      runOutcomes,
      "RunProfile.terminalRules.allowedOutcomes",
      true,
    ),
    stopCondition: requireEnum(
      runProfile?.terminalRules?.stopCondition,
      terminalStopConditions,
      "RunProfile.terminalRules.stopCondition",
    ),
  };

  if (!modelIsAllowed(model, channelModels) || !modelIsAllowed(model, workerModels)) {
    throw new Error("RunProfile.model must be allowed by ChannelPolicy and WorkerProfile");
  }
  if (!channelReadModes.includes(memoryPolicy.read)) {
    throw new Error("RunProfile.memoryPolicy.read is not allowed by ChannelPolicy");
  }
  if (!channelWriteModes.includes(memoryPolicy.write)) {
    throw new Error("RunProfile.memoryPolicy.write is not allowed by ChannelPolicy");
  }
  if (!artifactContractsMatch(artifactContract, workerArtifactContract)) {
    throw new Error("RunProfile.artifactContract must match WorkerProfile.artifactContract");
  }

  const skills = runSkillIds.map((skillId, index) => {
    if (!channelSkillIds.includes(skillId) || !workerSkillIds.includes(skillId)) {
      throw new Error(
        `RunProfile.skillIds[${index}] must be allowed by ChannelPolicy and WorkerProfile`,
      );
    }
    const skill = options.catalog.find((candidate) => candidate.id === skillId);
    if (skill === undefined) {
      throw new Error(`RunProfile.skillIds[${index}] does not exist in the catalog`);
    }

    return snapshotSkill(skill);
  });
  const skillAllowedTools = new Set(skills.flatMap((skill) => skill.allowedTools));
  const forbiddenTools = new Set(skills.flatMap((skill) => skill.forbiddenTools));
  const allowedTools = channelTools.filter(
    (tool) =>
      skillAllowedTools.has(tool)
      && workerTools.includes(tool)
      && profileTools.includes(tool)
      && !forbiddenTools.has(tool),
  );

  const snapshot: Omit<ResolvedRunProfile, "hash"> = {
    id,
    version,
    workerProfileId: workerId,
    workerProfile: {
      id: workerId,
      version: workerVersion,
      instructions: workerInstructions,
    },
    model,
    skills,
    allowedTools,
    budget: resolveBudget(
      options.workerProfile?.budgetDefaults,
      runProfile?.budget,
      options.channelPolicy?.budgetLimits,
    ),
    contextTransforms: snapshotContextTransforms,
    memoryPolicy,
    evalPolicy,
    artifactContract,
    terminalRules,
  };

  return deepFreeze({
    ...snapshot,
    hash: profileHash(snapshot),
  }) as ResolvedRunProfile;
}

export function selectResolvedToolCatalog(
  snapshot: Pick<ResolvedRunProfile, "allowedTools">,
  catalog: readonly ToolDefinition[],
): readonly ToolDefinition[] {
  return catalog.filter((definition) => snapshot.allowedTools.includes(definition.name));
}
