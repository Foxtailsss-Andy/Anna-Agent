import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { createSkillArtifact } from "../src/create-artifact";

const validPreview = [
  "---",
  "name: CSV Converter",
  "version: 1.0.0",
  "allowed_tools:",
  "forbidden_tools:",
  "---",
  "",
  "Convert CSV to Markdown.",
  "",
].join("\n");

describe("Create artifact Tool adapter", () => {
  test("writes a bounded skill artifact and returns its validation/hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-create-artifact-"));
    try {
      const result = await createSkillArtifact({
        workspaceRoot: directory,
        runId: "run:create:command-1",
        input: { kind: "skill", skill_id: "csv_to_markdown", preview: validPreview },
      });

      expect(result.status).toBe("succeeded");
      if (result.status !== "succeeded" || typeof result.output !== "object" || result.output === null) {
        throw new Error("expected a successful Create artifact result");
      }
      expect(result.output.validation).toEqual({
        valid: true,
        loaded_skill_id: "csv_to_markdown",
        errors: [],
      });
      const artifact = result.output.artifact;
      expect(artifact).toMatchObject({
        kind: "skill",
        skill_id: "csv_to_markdown",
        path: "create-runs/run_create_command-1/skill/csv_to_markdown/SKILL.md",
        hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      const path = join(directory, String((artifact as { path: string }).path));
      await expect(readFile(path, "utf8")).resolves.toBe(validPreview);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid Skill content without writing outside the workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anna-create-artifact-"));
    try {
      const result = await createSkillArtifact({
        workspaceRoot: directory,
        runId: "run-1",
        input: {
          kind: "skill",
          skill_id: "../escape",
          preview: "not a skill",
        },
      });

      expect(result).toEqual({
        status: "failed",
        output: {
          reason: "invalid_create_artifact",
          validation: {
            valid: false,
            errors: ["skill_id must be a lowercase identifier", "Skill preview frontmatter is invalid"],
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
