/**
 * 模板库纯逻辑(F5)· DAG 骨架小图节点 · 真实计数(不用 mock 的 9)
 * 零捏造:节点与计数从模板真结构派生。
 */
import { describe, expect, it } from "vitest";

import type { SopTemplate, SopTaskSpec } from "../../../lib/api/crew";
import { isFlagship, templateCounts, templateSkeleton } from "../templateModel";

const spec = (over: Partial<SopTaskSpec> & { key: string }): SopTaskSpec => ({
  key: over.key,
  title: over.title ?? over.key,
  role_required: over.role_required ?? "产品",
  depends_on: over.depends_on ?? [],
  is_gate: over.is_gate ?? false,
  reviews: over.reviews ?? null,
  acceptance_criteria: over.acceptance_criteria ?? null,
});

const feature: SopTemplate = {
  id: "feature_iteration",
  name: "功能迭代与设计",
  description: "从简报到验收",
  tasks: [
    spec({ key: "brief", title: "需求简报", role_required: "产品" }),
    spec({ key: "prd", title: "PRD 起草", role_required: "文案" }),
    spec({ key: "prd_review", title: "PRD 评审", is_gate: true, role_required: "产品" }),
    spec({ key: "design", title: "设计稿", role_required: "设计" }),
    spec({ key: "design_review", title: "设计评审", is_gate: true, role_required: "产品" }),
    spec({ key: "impl", title: "实施", role_required: "工程" }),
    spec({ key: "code_review", title: "代码评审", is_gate: true, role_required: "产品" }),
    spec({ key: "accept", title: "验收合并", role_required: "产品" }),
  ],
};

describe("templateCounts · 真实计数(任务/评审门,零门与任务分离)", () => {
  it("功能迭代:8 节点 → 5 任务 · 3 评审门(不写死 9)", () => {
    expect(templateCounts(feature)).toEqual({ tasks: 5, gates: 3 });
  });
  it("空模板 → 0/0", () => {
    expect(templateCounts({ ...feature, tasks: [] })).toEqual({ tasks: 0, gates: 0 });
  });
});

describe("templateSkeleton · DAG 骨架节点(任务/派 Agent/门/可生长)", () => {
  it("门→gate;派 Agent 职能(文案/设计/验收)→agent;其余→task", () => {
    const nodes = templateSkeleton(feature);
    const byTitle = (t: string) => nodes.find((n) => n.title === t)!;
    expect(byTitle("需求简报").kind).toBe("task"); // 产品
    expect(byTitle("PRD 起草").kind).toBe("agent"); // 文案 → 默认派 Agent
    expect(byTitle("设计稿").kind).toBe("agent"); // 设计
    expect(byTitle("PRD 评审").kind).toBe("gate");
    expect(byTitle("实施").kind).toBe("task"); // 工程
  });

  it("旗舰模板尾部追加可生长节点", () => {
    const nodes = templateSkeleton(feature);
    expect(nodes[nodes.length - 1].kind).toBe("grow");
  });

  it("非旗舰模板不追加可生长", () => {
    const marketing: SopTemplate = { ...feature, id: "marketing_collateral", tasks: [spec({ key: "a", title: "简报" })] };
    const nodes = templateSkeleton(marketing);
    expect(nodes.some((n) => n.kind === "grow")).toBe(false);
  });
});

describe("isFlagship", () => {
  it("feature_iteration 为旗舰", () => {
    expect(isFlagship("feature_iteration")).toBe(true);
    expect(isFlagship("marketing_collateral")).toBe(false);
  });
});
