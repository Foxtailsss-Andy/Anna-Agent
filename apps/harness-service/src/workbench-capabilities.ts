import type {
  CapabilityDefinitionSnapshot,
  CapabilityPolicySnapshot,
  JsonValue,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  ToolRequest,
  ToolResult,
} from "@anna/harness-v2";
import {
  buildCapabilityCatalog,
  buildCapabilityDefinition,
  WORKBENCH_CAPABILITY_POLICY_VERSION,
} from "@anna/harness-v2";

export const capabilitySearchTool = "capabilities.search" as const;
export const capabilityLoadTool = "capabilities.load" as const;
export const skillLoadTool = "skills.load" as const;

export type WorkbenchCapabilityDefinition = CapabilityDefinitionSnapshot;

export interface WorkbenchCapabilityController {
  readonly loadedIds: readonly string[];
  execute(request: ToolRequest, signal: AbortSignal): Promise<ToolResult>;
}

const projectReadSchema = {
  type: "object",
  properties: { project_id: { type: "string" } },
  required: ["project_id"],
  additionalProperties: false,
} as const satisfies Record<string, JsonValue>;

const channelReadSchema = {
  type: "object",
  properties: { project_id: { type: "string" } },
  required: ["project_id"],
  additionalProperties: false,
} as const satisfies Record<string, JsonValue>;

const capabilitySearchSchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
} as const satisfies Record<string, JsonValue>;

const capabilityLoadSchema = {
  type: "object",
  properties: { ids: { type: "array", items: { type: "string" }, minItems: 1 } },
  required: ["ids"],
  additionalProperties: false,
} as const satisfies Record<string, JsonValue>;

const skillLoadSchema = {
  type: "object",
  properties: { skill_id: { type: "string" } },
  required: ["skill_id"],
  additionalProperties: false,
} as const satisfies Record<string, JsonValue>;

function projectSkillMetadata(
  skill: SkillCatalogEntry,
  allowed: ReadonlySet<string>,
) {
  return {
    skill_id: skill.id,
    loader_capability_id: skillLoadTool,
    name: skill.name,
    version: skill.version,
    source: skill.provenance.source,
    uri: skill.provenance.uri,
    hash: skill.hash,
    allowed_tools: [...skill.allowedTools],
    forbidden_tools: [...skill.forbiddenTools],
    missing_dependencies: skill.allowedTools.filter((dependency) => !allowed.has(dependency)),
  };
}

export function capabilityToolParameters(
  name: string,
  policy?: CapabilityPolicySnapshot,
): Record<string, JsonValue> | undefined {
  if (name === capabilitySearchTool) return capabilitySearchSchema;
  if (name === capabilityLoadTool) return capabilityLoadSchema;
  return capabilityDefinitionById(name, policy)?.inputSchema;
}

export function capabilityToolDescription(
  name: string,
  policy?: CapabilityPolicySnapshot,
): string | undefined {
  if (name === capabilitySearchTool) return "Search capabilities admitted to this Workbench scope.";
  if (name === capabilityLoadTool) return "Load a selected admitted capability for the next model request.";
  return capabilityDefinitionById(name, policy)?.description;
}

const fixedCapabilities: readonly WorkbenchCapabilityDefinition[] = Object.freeze([
  buildCapabilityDefinition({
    id: skillLoadTool,
    version: "1.0.0",
    description: "Read a frozen registered Skill method and report its declared dependencies.",
    source: "anna.workbench.skills",
    effect: "read",
    replayPolicy: "safe",
    inputSchema: skillLoadSchema,
  }),
  buildCapabilityDefinition({
    id: "crew.project.read",
    version: "1.0.0",
    description: "Read the authenticated Crew project facts for the current Workbench project.",
    source: "anna.workbench.crew",
    effect: "read",
    replayPolicy: "safe",
    inputSchema: projectReadSchema,
  }),
  buildCapabilityDefinition({
    id: "crew.channel.read",
    version: "1.0.0",
    description: "Read the authenticated Crew channel messages for the current Workbench project.",
    source: "anna.workbench.crew",
    effect: "read",
    replayPolicy: "safe",
    inputSchema: channelReadSchema,
  }),
]);

export function createWorkbenchCapabilityPolicy(): CapabilityPolicySnapshot {
  return {
    version: WORKBENCH_CAPABILITY_POLICY_VERSION,
    catalog: buildCapabilityCatalog(fixedCapabilities, WORKBENCH_CAPABILITY_POLICY_VERSION),
  };
}

export function createWorkbenchCapabilityController(
  options: {
    readonly projectId?: string;
    readonly loadedIds?: readonly string[];
    readonly capabilityPolicy?: CapabilityPolicySnapshot;
    readonly skillCatalog?: SkillCatalogSnapshot;
    readonly allowedTools?: readonly string[];
    readonly dynamicToolCall?: (request: ToolRequest, signal: AbortSignal) => Promise<ToolResult>;
  },
): WorkbenchCapabilityController {
  const catalog = options.capabilityPolicy?.catalog.capabilities ?? fixedCapabilities;
  const allowed = options.allowedTools === undefined
    ? new Set(catalog.map((item) => item.id))
    : new Set(options.allowedTools);
  const visible = catalog.filter((item) =>
    allowed.has(item.id) && (options.projectId !== undefined || item.id === skillLoadTool));
  const byId = new Map(visible.map((item) => [item.id, item]));
  const loaded = new Set<string>();
  for (const id of options.loadedIds ?? []) {
    if (!byId.has(id)) throw new Error(`capability loaded ID is not admitted: ${id}`);
    loaded.add(id);
  }

  return {
    get loadedIds() {
      return [...loaded];
    },
    async execute(request, signal): Promise<ToolResult> {
      if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
      if (request.name === capabilitySearchTool) {
        const input = request.input as { query: string };
        const query = input.query.trim().toLowerCase();
        const results = visible
          .filter((item) => query === "" || `${item.id} ${item.description}`.toLowerCase().includes(query))
          .map((item) => ({
            id: item.id,
            version: item.version,
            description: item.description,
            source: item.source,
            effect: item.effect,
            replay_policy: item.replayPolicy,
            schema_hash: item.hash,
            input_schema: item.inputSchema,
            status: loaded.has(item.id) ? "loaded" : "available",
          }));
        const skills = allowed.has(skillLoadTool)
          ? (options.skillCatalog?.skills ?? [])
            .filter((item) => query === "" || `${item.id} ${item.name}`.toLowerCase().includes(query))
            .map((item) => projectSkillMetadata(item, allowed))
          : [];
        return { status: "succeeded", output: { query: input.query, results, skills } };
      }
      if (request.name === capabilityLoadTool) {
        const input = request.input as { ids: string[] };
        const ids = [...new Set(input.ids)];
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          return { status: "failed", output: { reason: "capability_not_available", ids: missing } };
        }
        for (const id of ids) loaded.add(id);
        const definitions = ids.map((id) => byId.get(id)!).map((item) => ({
          id: item.id,
          version: item.version,
          hash: item.hash,
          source: item.source,
          effect: item.effect,
          input_schema: item.inputSchema,
        }));
        return {
          status: "succeeded",
          output: {
            accepted: true,
            loaded: definitions,
            receipt: {
              kind: "capability.load",
              capabilities: definitions,
            },
          },
        };
      }
      if (request.name === skillLoadTool && loaded.has(skillLoadTool)) {
        const input = request.input as { skill_id: string };
        const skill = options.skillCatalog?.skills.find((item) => item.id === input.skill_id);
        if (skill === undefined) {
          return { status: "failed", output: { reason: "skill_not_available", skill_id: input.skill_id } };
        }
        return {
          status: "succeeded",
          output: {
            accepted: true,
            skill: {
              ...projectSkillMetadata(skill, allowed),
              content: skill.content,
            },
          },
        };
      }
      if (byId.has(request.name) && loaded.has(request.name)) {
        const input = request.input as { project_id?: unknown };
        if (input.project_id !== options.projectId) {
          return { status: "failed", output: { reason: "capability_scope_not_authorized" } };
        }
        if (options.dynamicToolCall === undefined) {
          return { status: "failed", output: { reason: "business_adapter_not_configured" } };
        }
        return options.dynamicToolCall(request, signal);
      }
      return { status: "failed", output: { reason: "capability_not_loaded" } };
    },
  };
}

export function capabilityDefinitionFromPolicy(
  policy: CapabilityPolicySnapshot,
  id: string,
): WorkbenchCapabilityDefinition | undefined {
  return policy.catalog.capabilities.find((item) => item.id === id);
}

export function capabilityDefinitionById(
  id: string,
  policy?: CapabilityPolicySnapshot,
): WorkbenchCapabilityDefinition | undefined {
  return policy === undefined
    ? fixedCapabilities.find((item) => item.id === id)
    : capabilityDefinitionFromPolicy(policy, id);
}
