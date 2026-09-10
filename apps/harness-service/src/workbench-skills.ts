import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildSkillCatalog,
  loadSkillCatalogEntry,
  type SkillCatalogSnapshot,
} from "@anna/harness-v2";

export interface RegisteredWorkbenchSkillSource {
  readonly id: string;
  readonly relativePath: string;
}

export const registeredWorkbenchSkills: readonly RegisteredWorkbenchSkillSource[] = Object.freeze([
  { id: "skill:harness-v2/general-assistant", relativePath: "skills/harness-v2/general-assistant/SKILL.md" },
  { id: "skill:harness-v2/create-assistant", relativePath: "skills/harness-v2/create-assistant/SKILL.md" },
  { id: "skill:chat/general-assistant", relativePath: "skills/chat/general-assistant/SKILL.md" },
  { id: "skill:crew/project-management", relativePath: "skills/crew/project-management/SKILL.md" },
  { id: "skill:hiker/global-customer", relativePath: "skills/hiker/global-customer/SKILL.md" },
  { id: "skill:reimbursement/travel-expense", relativePath: "skills/reimbursement/travel-expense/SKILL.md" },
  { id: "skill:associate/receivables-recovery", relativePath: "skills/associate/receivables-recovery/SKILL.md" },
]);

/**
 * Reads only the fixed repository Skill sources. A caller can supply a test
 * repository root, but the source list and canonical IDs remain Host-owned.
 */
export async function loadWorkbenchSkillCatalog(
  repositoryRoot = resolve(import.meta.dirname, "../../../"),
): Promise<SkillCatalogSnapshot> {
  const entries = await Promise.all(registeredWorkbenchSkills.map(async (source) => {
    const document = await readFile(join(repositoryRoot, source.relativePath), "utf8");
    return loadSkillCatalogEntry({
      id: source.id,
      document,
      provenance: {
        source: "anna-repository",
        uri: `anna-repository://${source.relativePath}`,
      },
    });
  }));
  return buildSkillCatalog(entries);
}
