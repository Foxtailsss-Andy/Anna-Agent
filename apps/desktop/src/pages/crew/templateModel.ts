/**
 * 模板库纯逻辑(F5 · 设计稿 1g)· DAG 骨架小图 + 真实计数
 * 零捏造:节点与计数从模板真结构派生(不用 mock 的「9 任务」)。
 */

import type { SopTemplate } from "../../lib/api/crew";

export const FLAGSHIP_ID = "feature_iteration";

export function isFlagship(templateId: string): boolean {
  return templateId === FLAGSHIP_ID;
}

/** 计数:任务(非门)与评审门分离,均由真结构算。 */
export function templateCounts(template: SopTemplate): { tasks: number; gates: number } {
  const gates = template.tasks.filter((t) => t.is_gate).length;
  return { tasks: template.tasks.length - gates, gates };
}

/* ---------------- DAG 骨架小图节点 ---------------- */

export type SkeletonKind =
  | "task" /* 白 rect:人任务 */
  | "agent" /* delegate 底 rect:默认派 Agent(文案/设计/验收职能) */
  | "gate" /* 金菱:评审门 */
  | "grow"; /* dashed rect:可生长(旗舰模板尾部) */

export interface SkeletonNode {
  key: string;
  title: string;
  kind: SkeletonKind;
}

/** 默认派 Agent 的职能(设计 1g:紫 rect = 模板 role 为文案/设计/验收者) */
const AGENT_ROLES = new Set(["文案", "设计", "验收"]);

/** 模板 → DAG 骨架节点序列(横排;旗舰尾部追加可生长占位) */
export function templateSkeleton(template: SopTemplate): SkeletonNode[] {
  const nodes: SkeletonNode[] = template.tasks.map((t) => ({
    key: t.key,
    title: t.title,
    kind: t.is_gate ? "gate" : AGENT_ROLES.has(t.role_required) ? "agent" : "task",
  }));
  if (isFlagship(template.id)) {
    nodes.push({ key: "__grow__", title: "可生长", kind: "grow" });
  }
  return nodes;
}
