import { createHash } from "node:crypto";

export interface SkillProvenance {
  readonly source: string;
  readonly uri: string;
}

export interface SkillCatalogDocument {
  readonly id: string;
  readonly document: string;
  readonly provenance: SkillProvenance;
}

export interface SkillCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  readonly provenance: SkillProvenance;
  readonly allowedTools: readonly string[];
  readonly forbiddenTools: readonly string[];
  readonly content: string;
}

export const WORKBENCH_SKILL_CATALOG_VERSION = "workbench-skills-1";

export interface SkillCatalogSnapshot {
  readonly version: string;
  readonly skills: readonly SkillCatalogEntry[];
  readonly hash: string;
}

interface ParsedFrontmatter {
  readonly name: string;
  readonly version: string;
  readonly allowedTools: readonly string[];
  readonly forbiddenTools: readonly string[];
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

function parseFrontmatter(document: string): {
  readonly frontmatter: ParsedFrontmatter;
  readonly content: string;
} {
  if (!document.startsWith("---\n") && !document.startsWith("---\r\n")) {
    throw new Error("Skill.document must start with YAML frontmatter");
  }

  const openingEnd = document.indexOf("\n") + 1;
  const closing = /(?:^|\n)---\r?\n/.exec(document.slice(openingEnd));
  if (closing === null) {
    throw new Error("Skill.document frontmatter must be closed");
  }

  const frontmatterEnd = openingEnd + closing.index;
  const contentStart = frontmatterEnd + closing[0].length;
  const values: { name?: string; version?: string; allowedTools?: string[]; forbiddenTools?: string[] } = {};
  let currentList: "allowedTools" | "forbiddenTools" | "ignore" | undefined;

  for (const line of document.slice(openingEnd, frontmatterEnd).split(/\r?\n/)) {
    if (line === "") {
      continue;
    }

    const listItem = /^\s+-\s+(.+)$/.exec(line);
    if (listItem !== null) {
      if (currentList === undefined) {
        throw new Error("Skill.document frontmatter is not supported");
      }

      if (currentList !== "ignore") {
        values[currentList]!.push(
          requireNonEmptyString(listItem[1].trim(), `Skill.${currentList}`),
        );
      }
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new Error("Skill.document frontmatter is not supported");
    }

    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error("Skill.document frontmatter is not supported");
    }

    if (key === "name" || key === "version") {
      if (values[key] !== undefined) {
        throw new Error(`Skill.document frontmatter contains duplicate ${key}`);
      }
      values[key] = requireNonEmptyString(value, `Skill.${key}`);
      currentList = undefined;
      continue;
    }

    if (key === "allowed_tools" || key === "forbidden_tools") {
      const trackedKey = key === "allowed_tools" ? "allowedTools" : "forbiddenTools";
      if (value !== "") {
        throw new Error("Skill.document frontmatter is not supported");
      }
      if (values[trackedKey] !== undefined) {
        throw new Error(`Skill.document frontmatter contains duplicate ${key}`);
      }
      values[trackedKey] = [];
      currentList = trackedKey;
      continue;
    }

    currentList = value === "" ? "ignore" : undefined;
  }

  if (
    values.name === undefined ||
    values.version === undefined ||
    values.allowedTools === undefined ||
    values.forbiddenTools === undefined
  ) {
    throw new Error("Skill.document frontmatter is missing required fields");
  }

  return {
    frontmatter: {
      name: values.name,
      version: values.version,
      allowedTools: Object.freeze([...values.allowedTools]),
      forbiddenTools: Object.freeze([...values.forbiddenTools]),
    },
    content: requireNonEmptyString(document.slice(contentStart), "Skill.content"),
  };
}

export function loadSkillCatalogEntry(
  skill: SkillCatalogDocument,
): SkillCatalogEntry {
  const id = requireNonEmptyString(skill?.id, "Skill.id");
  const document = requireNonEmptyString(skill?.document, "Skill.document");
  const provenance = skill?.provenance;
  const { frontmatter, content } = parseFrontmatter(document);

  return Object.freeze({
    id,
    name: frontmatter.name,
    version: frontmatter.version,
    hash: `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`,
    provenance: Object.freeze({
      source: requireNonEmptyString(provenance?.source, "Skill.provenance.source"),
      uri: requireNonEmptyString(provenance?.uri, "Skill.provenance.uri"),
    }),
    allowedTools: frontmatter.allowedTools,
    forbiddenTools: frontmatter.forbiddenTools,
    content,
  });
}

export function buildSkillCatalog(
  skills: readonly SkillCatalogEntry[],
  version = WORKBENCH_SKILL_CATALOG_VERSION,
): SkillCatalogSnapshot {
  if (version !== WORKBENCH_SKILL_CATALOG_VERSION) {
    throw new Error(`unsupported Skill catalog version: ${version}`);
  }
  const sorted = [...skills].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const skill of sorted) {
    if (skill.id.trim() === "" || ids.has(skill.id)) {
      throw new Error(`duplicate or empty Skill id: ${skill.id}`);
    }
    ids.add(skill.id);
    validateSkillEntry(skill, `SkillCatalog.${skill.id}`);
  }
  const body = { version, skills: sorted };
  return Object.freeze({
    ...body,
    hash: `sha256:${createHash("sha256").update(stableJson(body), "utf8").digest("hex")}`,
  });
}

export function parseSkillCatalogSnapshot(input: unknown): SkillCatalogSnapshot {
  if (!isRecord(input)) throw new Error("SkillCatalogSnapshot must be an object");
  assertExactKeys(input, ["version", "skills", "hash"]);
  if (typeof input.version !== "string" || !Array.isArray(input.skills) || typeof input.hash !== "string") {
    throw new Error("SkillCatalogSnapshot is invalid");
  }
  const skills = input.skills.map((candidate, index) => parseSkillEntry(candidate, `SkillCatalogSnapshot.skills[${index}]`));
  const parsed = buildSkillCatalog(skills, input.version);
  if (parsed.hash !== input.hash) throw new Error("SkillCatalogSnapshot.hash mismatch");
  return parsed;
}

function parseSkillEntry(input: unknown, name: string): SkillCatalogEntry {
  if (!isRecord(input)) throw new Error(`${name} is invalid`);
  assertExactKeys(input, [
    "id",
    "name",
    "version",
    "hash",
    "provenance",
    "allowedTools",
    "forbiddenTools",
    "content",
  ]);
  const provenance = input.provenance;
  if (!isRecord(provenance)) throw new Error(`${name}.provenance is invalid`);
  const entry: SkillCatalogEntry = {
    id: requireNonEmptyString(input.id, `${name}.id`),
    name: requireNonEmptyString(input.name, `${name}.name`),
    version: requireNonEmptyString(input.version, `${name}.version`),
    hash: requireNonEmptyString(input.hash, `${name}.hash`),
    provenance: {
      source: requireNonEmptyString(provenance.source, `${name}.provenance.source`),
      uri: requireNonEmptyString(provenance.uri, `${name}.provenance.uri`),
    },
    allowedTools: stringArray(input.allowedTools, `${name}.allowedTools`),
    forbiddenTools: stringArray(input.forbiddenTools, `${name}.forbiddenTools`),
    content: requireNonEmptyString(input.content, `${name}.content`),
  };
  validateSkillEntry(entry, name);
  return Object.freeze({
    ...entry,
    provenance: Object.freeze(entry.provenance),
    allowedTools: Object.freeze([...entry.allowedTools]),
    forbiddenTools: Object.freeze([...entry.forbiddenTools]),
  });
}

function validateSkillEntry(skill: SkillCatalogEntry, name: string): void {
  requireNonEmptyString(skill.id, `${name}.id`);
  requireNonEmptyString(skill.name, `${name}.name`);
  requireNonEmptyString(skill.version, `${name}.version`);
  requireNonEmptyString(skill.hash, `${name}.hash`);
  requireNonEmptyString(skill.provenance.source, `${name}.provenance.source`);
  requireNonEmptyString(skill.provenance.uri, `${name}.provenance.uri`);
  requireNonEmptyString(skill.content, `${name}.content`);
  stringArray(skill.allowedTools, `${name}.allowedTools`);
  stringArray(skill.forbiddenTools, `${name}.forbiddenTools`);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => requireNonEmptyString(item, `${name}[${index}]`));
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Skill catalog contains unknown or missing fields");
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
