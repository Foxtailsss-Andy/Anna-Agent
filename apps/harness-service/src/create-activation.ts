import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { CreateArtifactProjection } from "./create-projection";

export interface CreateActivationInput {
  readonly workspaceRoot: string;
  readonly artifact: CreateArtifactProjection;
}

export interface CreateActivationResult {
  readonly targetPath: string;
}

export async function activateCreateSkill(
  input: CreateActivationInput,
): Promise<CreateActivationResult | { readonly error: string }> {
  if (input.artifact.kind !== "skill" || input.artifact.skill_id === undefined) {
    return { error: "create_activation_kind_unsupported" };
  }
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62})$/.test(input.artifact.skill_id)) {
    return { error: "create_activation_skill_id_invalid" };
  }
  const root = await realpath(resolve(input.workspaceRoot)).catch(() => undefined);
  if (root === undefined) return { error: "create_activation_workspace_unavailable" };

  const sourcePath = resolve(root, input.artifact.path);
  const sourceRelative = relative(root, sourcePath);
  if (sourceRelative === "" || sourceRelative.startsWith("..") || sourceRelative.startsWith("/")) {
    return { error: "create_activation_source_outside_workspace" };
  }
  const resolvedSource = await realpath(sourcePath).catch(() => undefined);
  if (resolvedSource === undefined) return { error: "create_activation_source_unavailable" };
  const resolvedSourceRelative = relative(root, resolvedSource);
  if (resolvedSourceRelative === "" || resolvedSourceRelative.startsWith("..") || resolvedSourceRelative.startsWith("/")) {
    return { error: "create_activation_source_outside_workspace" };
  }
  const metadata = await stat(resolvedSource).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.size > 64 * 1024) {
    return { error: "create_activation_source_not_bounded" };
  }
  const content = await readFile(resolvedSource, "utf8").catch(() => undefined);
  if (content === undefined) return { error: "create_activation_source_unavailable" };
  const hash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  if (hash !== input.artifact.hash) return { error: "create_activation_hash_mismatch" };

  const targetRelative = `skills/${input.artifact.skill_id}/SKILL.md`;
  const targetPath = resolve(root, targetRelative);
  const targetRoot = resolve(root, "skills");
  const targetCheck = relative(targetRoot, targetPath);
  if (targetCheck === "" || targetCheck.startsWith("..") || targetCheck.startsWith("/")) {
    return { error: "create_activation_target_outside_workspace" };
  }
  try {
    await mkdir(resolve(root, "skills", input.artifact.skill_id), { recursive: true });
    await copyFile(resolvedSource, targetPath, constants.COPYFILE_EXCL);
  } catch {
    return { error: "create_activation_target_exists_or_write_failed" };
  }
  return { targetPath: targetRelative };
}
