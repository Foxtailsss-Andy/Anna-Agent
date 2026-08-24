import { expect, test } from "vitest";

import {
  resolveRunProfile,
  selectResolvedToolCatalog,
  type ChannelPolicy,
  type ModelPolicy,
  type RunProfile,
  type RunProfileId,
  type WorkerProfile,
  type WorkerProfileId,
  type ToolDefinition,
} from "../src/index";

test("a running Run keeps its resolved profile snapshot after configuration changes", () => {
  const catalog = [
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
  const allowedModel: ModelPolicy = {
    provider: "openai",
    name: "gpt-5.6-terra",
    reasoning: "high",
  };
  const channelPolicy: ChannelPolicy = {
    toolPolicy: { allowedTools: ["read_workspace"] },
    allowedSkillIds: ["release-review"],
    allowedModels: [allowedModel],
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
    modelPolicy: { allowedModels: [allowedModel] },
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
    model: { ...allowedModel },
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

  const snapshot = resolveRunProfile({
    catalog,
    channelPolicy,
    workerProfile,
    runProfile,
  });

  catalog[0] = {
    id: "release-review",
    name: "Changed release review",
    version: "2.0.0",
    hash: "sha256:changed",
    provenance: { source: "registry", uri: "registry://release-review/2.0.0" },
    content: "Changed after the Run started.",
    allowedTools: ["write_workspace"],
    forbiddenTools: [],
  };
  channelPolicy.toolPolicy.allowedTools = ["write_workspace"];
  channelPolicy.allowedSkillIds = [];
  channelPolicy.allowedModels = [];
  channelPolicy.budgetLimits.turns = 1;
  channelPolicy.memoryPolicy.allowedReadModes = ["none"];
  channelPolicy.memoryPolicy.allowedWriteModes = ["disabled"];
  workerProfile.version = "2.0.0";
  workerProfile.instructions = "Changed worker instructions.";
  workerProfile.allowedSkillIds = [];
  workerProfile.allowedTools = ["write_workspace"];
  workerProfile.modelPolicy.allowedModels = [];
  workerProfile.budgetDefaults.turns = 1;
  workerProfile.artifactContract.kind = "changed_artifact";
  runProfile.model = {
    provider: "anthropic",
    name: "claude-opus-4-1",
    reasoning: "low",
  };
  runProfile.skillIds = [];
  runProfile.contextTransforms = [];
  runProfile.toolPolicy.allowedTools = ["write_workspace"];
  runProfile.budget = { turns: 1, toolCalls: 1 };
  runProfile.memoryPolicy = { read: "none", write: "disabled" };
  runProfile.evalPolicy = { contract: "disabled", quality: "disabled" };
  runProfile.artifactContract.kind = "changed_artifact";
  runProfile.terminalRules.allowedOutcomes = ["completed"];

  expect(snapshot).toEqual({
    id: "release-review-run",
    version: "7",
    hash: "sha256:d1a1e88b117d1569661ea7dc68e00a017a1c8bce54645b879e5da846eed85020",
    workerProfileId: "release-manager" as WorkerProfileId,
    workerProfile: {
      id: "release-manager" as WorkerProfileId,
      version: "1.0.0",
      instructions: "Review release evidence and provide a validated release artifact.",
    },
    model: { provider: "openai", name: "gpt-5.6-terra", reasoning: "high" },
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
    budget: { turns: 4, toolCalls: 2 },
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
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
  });
});

test("resolves the complete policy bundle and narrows the typed T03 catalog", () => {
  const catalog = [
    {
      id: "source-reader",
      name: "Source reader",
      version: "1.0.0",
      hash: "sha256:source-reader-v1",
      provenance: {
        source: "workspace",
        uri: "skills/source-reader/SKILL.md",
      },
      content: "Read approved workspace sources and report their evidence.",
      allowedTools: ["read_workspace"],
      forbiddenTools: ["shell"],
    },
    {
      id: "bounded-editor",
      name: "Bounded editor",
      version: "2.0.0",
      hash: "sha256:bounded-editor-v2",
      provenance: {
        source: "registry",
        uri: "registry://skills/bounded-editor/2.0.0",
      },
      content:
        "Apply only the reviewed bounded patch and preserve verification evidence.",
      allowedTools: ["bounded_patch"],
      forbiddenTools: ["shell", "network"],
    },
  ];
  const allowedModel: ModelPolicy = {
    provider: "openai",
    name: "gpt-5.6-terra",
    reasoning: "high",
  };
  const channelPolicy: ChannelPolicy = {
    toolPolicy: {
      allowedTools: ["read_workspace", "bounded_patch", "shell"],
    },
    allowedSkillIds: ["source-reader", "bounded-editor"],
    allowedModels: [allowedModel],
    budgetLimits: {
      wallTimeMs: 60000,
      turns: 6,
      inputTokens: 12000,
      outputTokens: 4000,
      toolCalls: 3,
    },
    memoryPolicy: {
      allowedReadModes: ["channel"],
      allowedWriteModes: ["propose"],
    },
  };
  const workerProfile: WorkerProfile = {
    id: "review-worker" as WorkerProfileId,
    version: "3.1.0",
    instructions:
      "Review the source evidence, then prepare only a bounded patch artifact.",
    allowedSkillIds: ["source-reader", "bounded-editor"],
    allowedTools: ["bounded_patch", "read_workspace"],
    modelPolicy: { allowedModels: [allowedModel] },
    budgetDefaults: {
      wallTimeMs: 30000,
      turns: 4,
      inputTokens: 8000,
      toolCalls: 2,
    },
    artifactContract: {
      kind: "validated_patch",
      requiredFor: ["completed"],
      verification: "tests",
    },
  };
  const runProfile: RunProfile = {
    id: "review-patch-run" as RunProfileId,
    version: "9",
    model: { ...allowedModel },
    skillIds: ["source-reader", "bounded-editor"],
    contextTransforms: [
      {
        kind: "compact",
        preserve: ["goal", "constraints", "pending_tool_calls", "provenance"],
      },
    ],
    toolPolicy: {
      allowedTools: ["read_workspace", "bounded_patch", "shell"],
    },
    budget: {
      turns: 9,
      inputTokens: 16000,
      outputTokens: 4000,
      toolCalls: 4,
    },
    memoryPolicy: { read: "channel", write: "propose" },
    evalPolicy: { contract: "required", quality: "human_on_risk" },
    artifactContract: {
      kind: "validated_patch",
      requiredFor: ["completed"],
      verification: "tests",
    },
    terminalRules: {
      allowedOutcomes: ["completed", "failed", "awaiting_approval"],
      stopCondition: "artifact_or_terminal",
    },
  };
  const readWorkspaceSchema = { parse(input: unknown) { return input; } };
  const boundedPatchSchema = { parse(input: unknown) { return input; } };
  const shellSchema = { parse(input: unknown) { return input; } };
  const typedCatalog: ToolDefinition[] = [
    {
      name: "read_workspace",
      replayPolicy: "safe",
      inputSchema: readWorkspaceSchema,
    },
    {
      name: "bounded_patch",
      replayPolicy: "never",
      inputSchema: boundedPatchSchema,
    },
    { name: "shell", inputSchema: shellSchema },
  ];

  const snapshot = resolveRunProfile({
    catalog,
    channelPolicy,
    workerProfile,
    runProfile,
  });
  const resolvedCatalog = selectResolvedToolCatalog(snapshot, typedCatalog);

  expect(resolvedCatalog).toEqual([typedCatalog[0], typedCatalog[1]]);
  expect(resolvedCatalog[0]).toBe(typedCatalog[0]);
  expect(resolvedCatalog[1]).toBe(typedCatalog[1]);
  expect(resolvedCatalog[0]?.inputSchema).toBe(readWorkspaceSchema);
  expect(resolvedCatalog[1]?.inputSchema).toBe(boundedPatchSchema);

  catalog[0].content = "Changed after the Run started.";
  catalog[1].forbiddenTools = [];
  channelPolicy.toolPolicy.allowedTools = ["shell"];
  channelPolicy.allowedSkillIds = [];
  channelPolicy.allowedModels = [];
  channelPolicy.budgetLimits.turns = 1;
  channelPolicy.memoryPolicy.allowedReadModes = ["none"];
  workerProfile.version = "4.0.0";
  workerProfile.instructions = "Changed worker instructions.";
  workerProfile.allowedSkillIds = [];
  workerProfile.allowedTools = ["shell"];
  workerProfile.modelPolicy.allowedModels = [];
  workerProfile.budgetDefaults.wallTimeMs = 1;
  workerProfile.artifactContract.kind = "changed_artifact";
  runProfile.model = {
    provider: "anthropic",
    name: "claude-opus-4-1",
    reasoning: "low",
  };
  runProfile.skillIds = [];
  runProfile.contextTransforms = [];
  runProfile.toolPolicy.allowedTools = ["shell"];
  runProfile.budget = { turns: 1 };
  runProfile.memoryPolicy = { read: "none", write: "disabled" };
  runProfile.evalPolicy = { contract: "disabled", quality: "disabled" };
  runProfile.artifactContract.kind = "changed_artifact";
  runProfile.terminalRules.allowedOutcomes = ["completed"];

  // sha256 of recursively key-sorted snapshot JSON without this hash field.
  expect(snapshot).toEqual({
    id: "review-patch-run",
    version: "9",
    hash: "sha256:44e4646fe447c47a19c6673aabefb39e97acb62469a2a1a3d8d4636a7d238cca",
    workerProfileId: "review-worker",
    workerProfile: {
      id: "review-worker",
      version: "3.1.0",
      instructions:
        "Review the source evidence, then prepare only a bounded patch artifact.",
    },
    model: {
      provider: "openai",
      name: "gpt-5.6-terra",
      reasoning: "high",
    },
    skills: [
      {
        id: "source-reader",
        name: "Source reader",
        version: "1.0.0",
        hash: "sha256:source-reader-v1",
        provenance: {
          source: "workspace",
          uri: "skills/source-reader/SKILL.md",
        },
        content: "Read approved workspace sources and report their evidence.",
        allowedTools: ["read_workspace"],
        forbiddenTools: ["shell"],
      },
      {
        id: "bounded-editor",
        name: "Bounded editor",
        version: "2.0.0",
        hash: "sha256:bounded-editor-v2",
        provenance: {
          source: "registry",
          uri: "registry://skills/bounded-editor/2.0.0",
        },
        content:
          "Apply only the reviewed bounded patch and preserve verification evidence.",
        allowedTools: ["bounded_patch"],
        forbiddenTools: ["shell", "network"],
      },
    ],
    allowedTools: ["read_workspace", "bounded_patch"],
    budget: {
      wallTimeMs: 30000,
      turns: 6,
      inputTokens: 12000,
      outputTokens: 4000,
      toolCalls: 3,
    },
    contextTransforms: [
      {
        kind: "compact",
        preserve: ["goal", "constraints", "pending_tool_calls", "provenance"],
      },
    ],
    memoryPolicy: { read: "channel", write: "propose" },
    evalPolicy: { contract: "required", quality: "human_on_risk" },
    artifactContract: {
      kind: "validated_patch",
      requiredFor: ["completed"],
      verification: "tests",
    },
    terminalRules: {
      allowedOutcomes: ["completed", "failed", "awaiting_approval"],
      stopCondition: "artifact_or_terminal",
    },
  });
});
