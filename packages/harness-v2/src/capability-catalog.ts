import { createHash } from "node:crypto";

import type { JsonValue } from "./contracts";

export const WORKBENCH_CAPABILITY_POLICY_VERSION = "workbench-capabilities-1";

export interface CapabilityDefinitionSnapshot {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly source: string;
  readonly effect: "read";
  readonly replayPolicy: "safe";
  readonly inputSchema: Record<string, JsonValue>;
  readonly hash: string;
}

export interface CapabilityCatalogSnapshot {
  readonly version: string;
  readonly capabilities: readonly CapabilityDefinitionSnapshot[];
  readonly hash: string;
}

export interface CapabilityPolicySnapshot {
  readonly version: string;
  readonly catalog: CapabilityCatalogSnapshot;
}

export function capabilityDefinitionHash(
  definition: Omit<CapabilityDefinitionSnapshot, "hash">,
): string {
  return `sha256:${createHash("sha256").update(stableJson(definition), "utf8").digest("hex")}`;
}

export function buildCapabilityDefinition(
  definition: Omit<CapabilityDefinitionSnapshot, "hash">,
): CapabilityDefinitionSnapshot {
  return Object.freeze({
    ...definition,
    hash: capabilityDefinitionHash(definition),
  });
}

export function buildCapabilityCatalog(
  capabilities: readonly CapabilityDefinitionSnapshot[],
  version = WORKBENCH_CAPABILITY_POLICY_VERSION,
): CapabilityCatalogSnapshot {
  if (version !== WORKBENCH_CAPABILITY_POLICY_VERSION) {
    throw new Error(`unsupported capability policy version: ${version}`);
  }
  const sorted = [...capabilities].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const capability of sorted) {
    if (capability.id.trim() === "" || ids.has(capability.id)) {
      throw new Error(`duplicate or empty capability id: ${capability.id}`);
    }
    ids.add(capability.id);
    const { hash: _hash, ...withoutHash } = capability;
    if (capabilityDefinitionHash(withoutHash) !== capability.hash) {
      throw new Error(`capability definition hash mismatch: ${capability.id}`);
    }
  }
  const body = { version, capabilities: sorted };
  return Object.freeze({
    ...body,
    hash: `sha256:${createHash("sha256").update(stableJson(body), "utf8").digest("hex")}`,
  });
}

export function parseCapabilityPolicySnapshot(input: unknown): CapabilityPolicySnapshot {
  if (!isRecord(input)) throw new Error("CapabilityPolicySnapshot must be an object");
  assertExactKeys(input, ["version", "catalog"]);
  if (typeof input.version !== "string" || !isRecord(input.catalog)) {
    throw new Error("CapabilityPolicySnapshot is invalid");
  }
  if (input.version !== WORKBENCH_CAPABILITY_POLICY_VERSION) {
    throw new Error(`unsupported capability policy version: ${input.version}`);
  }
  const catalog = input.catalog;
  assertExactKeys(catalog, ["version", "capabilities", "hash"]);
  if (typeof catalog.version !== "string" || typeof catalog.hash !== "string" || !Array.isArray(catalog.capabilities)) {
    throw new Error("CapabilityCatalogSnapshot is invalid");
  }
  const capabilities = catalog.capabilities.map((candidate, index) => parseCapabilityDefinition(candidate, index));
  const parsed = buildCapabilityCatalog(capabilities, catalog.version);
  if (parsed.hash !== catalog.hash) throw new Error("CapabilityCatalogSnapshot.hash mismatch");
  if (input.version !== parsed.version) throw new Error("CapabilityPolicySnapshot.version mismatch");
  return Object.freeze({ version: input.version, catalog: parsed });
}

function parseCapabilityDefinition(input: unknown, index: number): CapabilityDefinitionSnapshot {
  if (!isRecord(input)
    || typeof input.id !== "string"
    || typeof input.version !== "string"
    || typeof input.description !== "string"
    || typeof input.source !== "string"
    || input.effect !== "read"
    || input.replayPolicy !== "safe"
    || !isRecord(input.inputSchema)
    || typeof input.hash !== "string") {
    throw new Error(`CapabilityDefinitionSnapshot[${index}] is invalid`);
  }
  assertExactKeys(input, ["id", "version", "description", "source", "effect", "replayPolicy", "inputSchema", "hash"]);
  const definition = {
    id: input.id,
    version: input.version,
    description: input.description,
    source: input.source,
    effect: "read" as const,
    replayPolicy: "safe" as const,
    inputSchema: input.inputSchema as Record<string, JsonValue>,
  };
  const hash = capabilityDefinitionHash(definition);
  if (hash !== input.hash) throw new Error(`CapabilityDefinitionSnapshot[${index}] hash mismatch`);
  return Object.freeze({ ...definition, hash });
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("capability snapshot contains unknown or missing fields");
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
