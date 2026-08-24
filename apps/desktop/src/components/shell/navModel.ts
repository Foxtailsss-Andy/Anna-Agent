/**
 * navModel · 三段外壳导航模型(纯函数,无 React/CSS —— 可单测)
 *
 * 段:Home | Cowork | Crew(第三段)。段外区(hub/settings/agents)沿用当前段。
 * 保活 key:cowork/crew 带子项(cowork:hiker / crew:inbox / crew:project),
 *   其余 = section 名。CrewProjectDetail 用单一 key `crew:project`,projectId 由 prop 携带
 *   (切项目=同 key 换 prop,不无界增长)。
 *
 * 类型从 AnnaShell 以 `import type` 引入(编译期擦除,不引入运行时/CSS 依赖)。
 */

import type { CoworkItem, ShellSection, SidebarSegment } from "./AnnaShell";

/** Crew 段子导航项;`project` = 详情页(projectId 另行携带) */
export type CrewItem = "inbox" | "projects" | "project" | "team" | "templates";

/** section → 所属侧栏段;段外区保持传入的 prev 段 */
export function segmentOfSection(section: ShellSection, prev: SidebarSegment): SidebarSegment {
  if (section === "home" || section === "cowork" || section === "crew") return section;
  return prev;
}

/** section(+ 子项)→ 保活 key */
export function sectionKey(
  section: ShellSection,
  coworkItem: CoworkItem,
  crewItem: CrewItem,
): string {
  if (section === "cowork") return `cowork:${coworkItem}`;
  if (section === "crew") return `crew:${crewItem}`;
  return section;
}

/** 保活 key → section(+ 子项);未知前缀回落普通 section */
export function parseKey(key: string): {
  section: ShellSection;
  coworkItem: CoworkItem;
  crewItem: CrewItem;
} {
  if (key.startsWith("cowork:")) {
    return {
      section: "cowork",
      coworkItem: key.slice("cowork:".length) as CoworkItem,
      crewItem: "projects",
    };
  }
  if (key.startsWith("crew:")) {
    return {
      section: "crew",
      coworkItem: "hiker",
      crewItem: key.slice("crew:".length) as CrewItem,
    };
  }
  return { section: key as ShellSection, coworkItem: "hiker", crewItem: "projects" };
}

export const CREW_LABEL: Record<CrewItem, string> = {
  inbox: "收件箱",
  projects: "项目",
  project: "项目",
  team: "团队",
  templates: "SOP 模板",
};
