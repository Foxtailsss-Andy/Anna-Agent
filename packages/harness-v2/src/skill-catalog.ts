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
