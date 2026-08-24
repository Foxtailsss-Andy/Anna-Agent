import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { JsonValue, ToolResult } from "@anna/harness-v2";

export interface CreateSkillArtifactInput {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly input: {
    readonly kind: "skill";
    readonly skill_id: string;
    readonly preview: string;
  };
}

export async function createSkillArtifact(
  request: CreateSkillArtifactInput,
): Promise<ToolResult> {
  const normalizedPreview = request.input.preview.replace(/\r\n?/g, "\n");
  const validation = validateSkillInput(request.input.skill_id, normalizedPreview);
  if (!validation.valid) {
    return {
      status: "failed",
      output: {
        reason: "invalid_create_artifact",
        validation,
      },
    };
  }

  const runSegment = safePathSegment(request.runId);
  const skillSegment = request.input.skill_id;
  const relativePath = [
    "create-runs",
    runSegment,
    "skill",
    skillSegment,
    "SKILL.md",
  ].join("/");
  const absolutePath = resolve(request.workspaceRoot, ...relativePath.split("/"));
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, normalizedPreview, { encoding: "utf8", flag: "wx" });
  } catch {
    return {
      status: "failed",
      output: { reason: "create_artifact_write_failed" },
    };
  }

  const artifact = {
    kind: "skill",
    skill_id: request.input.skill_id,
    path: relativePath,
    preview: normalizedPreview,
    hash: `sha256:${createHash("sha256").update(normalizedPreview, "utf8").digest("hex")}`,
  } satisfies Record<string, JsonValue>;
  return {
    status: "succeeded",
    output: { artifact, validation },
  };
}

function validateSkillInput(
  skillId: string,
  preview: string,
): { valid: boolean; loaded_skill_id?: string; errors: string[] } {
  const errors: string[] = [];
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62})$/.test(skillId)) {
    errors.push("skill_id must be a lowercase identifier");
  }
  if (!isSkillFrontmatter(preview)) {
    errors.push("Skill preview frontmatter is invalid");
  }
  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length === 0 ? { loaded_skill_id: skillId } : {}),
  };
}

function isSkillFrontmatter(preview: string): boolean {
  const lines = preview.split("\n");
  if (lines[0] !== "---") {
    return false;
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) {
    return false;
  }
  const keys = new Set<string>();
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (match !== null) {
      keys.add(match[1]);
    }
  }
  return ["name", "version", "allowed_tools", "forbidden_tools"]
    .every((key) => keys.has(key));
}

function safePathSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return normalized === "" ? "run" : normalized;
}
