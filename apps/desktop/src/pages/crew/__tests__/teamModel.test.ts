/**
 * 花名册纯逻辑(F5)· 负载真值聚合 · Agent 图元 · 职能派生技能
 * 零捏造:负载从 projects 任务真聚合;技能字段后端无 → 由职能派生(登记偏差)。
 */
import { describe, expect, it } from "vitest";

import type { CrewProject } from "../crewModel";
import { agentGlyph, deriveMemberLoad, deriveSkills, isOperationalProject, loadChips } from "../teamModel";

function proj(over: Partial<CrewProject> & { id: string; owner_user_id: string }): CrewProject {
  return {
    workspace_id: "ws1",
    goal_text: "项目",
    sop_template_id: "feature_iteration",
    status: "active",
    ...over,
    tasks: over.tasks ?? [],
  } as CrewProject;
}
const task = (over: Record<string, unknown>) =>
  ({ id: "t", project_id: "p", key: "k", title: "任务", status: "todo", role_required: "工程", ...over }) as never;

describe("deriveMemberLoad · 在手负载真聚合", () => {
  const projects = [
    proj({
      id: "p1",
      owner_user_id: "acc_boss",
      tasks: [
        task({ id: "t1", assignee_member_id: "acc_andy", status: "running", title: "实施" }),
        task({ id: "t2", assignee_member_id: "acc_andy", status: "rework", title: "初稿" }),
        task({ id: "t3", assignee_member_id: "acc_andy", status: "blocked", title: "验收" }),
        task({ id: "t4", assignee_member_id: "acc_andy", status: "assigned", title: "补丁" }),
        task({ id: "g1", assignee_member_id: null, status: "todo", is_gate: true, title: "设计评审" }),
        task({ id: "t5", assignee_member_id: "acc_andy", status: "done", title: "旧活" }),
      ],
    }),
  ];

  it("Andy:进行中=1(running)· 返工=1 · 排队=1(blocked)· done 不计在手", () => {
    const load = deriveMemberLoad("acc_andy", projects);
    expect(load.active).toBe(1);
    expect(load.rework).toBe(1);
    expect(load.queued).toBe(1);
    // 在手圆点:running→active,rework→rework,assigned→idle(blocked=排队不占在手点)
    expect(load.dots.filter((d) => d === "active")).toHaveLength(1);
    expect(load.dots.filter((d) => d === "rework")).toHaveLength(1);
    expect(load.dots.filter((d) => d === "idle")).toHaveLength(1);
    expect(load.executingTitle).toBe("实施");
  });

  it("Boss:owner 的就绪评审门计入 awaiting(等他处理)", () => {
    const load = deriveMemberLoad("acc_boss", projects);
    expect(load.awaiting).toBe(1); // 设计评审门 todo 且我 owner
    expect(load.executingTitle).toBeNull();
  });

  it("无任务成员 → 全零,dots 空", () => {
    const load = deriveMemberLoad("acc_ghost", projects);
    expect(load).toMatchObject({ active: 0, rework: 0, queued: 0, awaiting: 0, dots: [] });
  });

  it("source=showcase 的内置案例不计入成员负载或 owner 待处理", () => {
    const mixed = [
      proj({
        id: "demo",
        owner_user_id: "acc_boss",
        source: "showcase",
        tasks: [
          task({ id: "demo_run", assignee_member_id: "acc_andy", status: "running", title: "示例执行中" }),
          task({ id: "demo_gate", assignee_member_id: null, status: "todo", is_gate: true, title: "示例评审门" }),
        ],
      }),
      proj({
        id: "real",
        owner_user_id: "acc_boss",
        tasks: [task({ id: "real_idle", assignee_member_id: "acc_andy", status: "assigned", title: "真实任务" })],
      }),
    ];

    expect(isOperationalProject(mixed[0])).toBe(false);
    expect(isOperationalProject(mixed[1])).toBe(true);

    expect(deriveMemberLoad("acc_andy", mixed)).toMatchObject({
      active: 0,
      rework: 0,
      queued: 0,
      dots: ["idle"],
      executingTitle: null,
    });
    expect(deriveMemberLoad("acc_boss", mixed).awaiting).toBe(0);
  });
});

describe("loadChips · 负载 → chips(零值隐藏)", () => {
  it("human:返工+排队 → danger chip;awaiting → warn chip", () => {
    const chips = loadChips({ dots: [], active: 0, rework: 1, queued: 2, awaiting: 0, executingTitle: null, total: 0 }, false);
    expect(chips.some((c) => c.tone === "danger" && c.text.includes("返工 1") && c.text.includes("排队 2"))).toBe(true);
  });
  it("agent 执行中 → shimmer chip 带任务名", () => {
    const chips = loadChips({ dots: ["active"], active: 1, rework: 0, queued: 0, awaiting: 0, executingTitle: "设计稿", total: 1 }, true);
    expect(chips[0].tone).toBe("exec");
    expect(chips[0].text).toContain("设计稿");
  });
  it("agent 待命 → 单数 · 待命", () => {
    const chips = loadChips({ dots: [], active: 0, rework: 0, queued: 0, awaiting: 0, executingTitle: null, total: 0 }, true);
    expect(chips[0].text).toContain("待命");
  });
});

describe("agentGlyph · 三 Agent 图元由职能识别", () => {
  it("文案→scribe(三横)· 设计→design(圆叠方)· 验收→check(对勾)", () => {
    expect(agentGlyph({ role: "文案", display_name: "Agent·Scribe" })).toBe("scribe");
    expect(agentGlyph({ role: "设计", display_name: "Agent·Design" })).toBe("design");
    expect(agentGlyph({ role: "验收", display_name: "Agent·Check" })).toBe("check");
  });
  it("名称兜底识别", () => {
    expect(agentGlyph({ role: "", display_name: "Agent·Scribe" })).toBe("scribe");
  });
  it("未知 → generic", () => {
    expect(agentGlyph({ role: "工程", display_name: "X" })).toBe("generic");
  });
});

describe("deriveSkills · 职能派生最小技能 chips(后端无 skills 列)", () => {
  it("已知职能给 1-2 个派生技能", () => {
    expect(deriveSkills("文案").length).toBeGreaterThan(0);
    expect(deriveSkills("设计").length).toBeGreaterThan(0);
  });
  it("未知职能 → 空(不造假)", () => {
    expect(deriveSkills("")).toEqual([]);
  });
});
