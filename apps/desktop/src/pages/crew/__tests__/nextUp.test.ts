/**
 * nextUp · 「该你了」派生契约:一件事一个按钮;优先级 rework > review > submit > start;
 * 零即隐;total 真计数;非 Boss 不派评审;门永不进「我的活」。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../crewModel";
import { deriveNextUp } from "../nextUp";

const T = (p: Partial<CrewTask>): CrewTask =>
  ({
    id: "t1",
    project_id: "p",
    key: "k",
    title: "任务",
    status: "todo",
    role_required: "产品",
    ...p,
  }) as CrewTask;

const ME = "acc_boss";

describe("deriveNextUp · 该你了", () => {
  it("零待办 → item null 且 total 0(零即隐)", () => {
    const r = deriveNextUp([T({ status: "done" })], ME, true);
    expect(r.item).toBeNull();
    expect(r.total).toBe(0);
  });

  it("活跃评审门(Boss)→ review 去评审;非 Boss 不派", () => {
    const gate = T({ id: "g1", title: "PRD 评审", is_gate: true, status: "todo" });
    const boss = deriveNextUp([gate], ME, true);
    expect(boss.item?.kind).toBe("review");
    expect(boss.item?.taskId).toBe("g1");
    expect(boss.item?.action).toBe("去评审");
    const member = deriveNextUp([gate], ME, false);
    expect(member.item).toBeNull();
  });

  it("优先级:我的返工压过评审;评审压过提交/开工;total 全计", () => {
    const rework = T({ id: "r", status: "rework", assignee_member_id: ME });
    const gate = T({ id: "g", is_gate: true, status: "todo" });
    const running = T({ id: "u", status: "running", assignee_member_id: ME });
    const assigned = T({ id: "a", status: "assigned", assignee_member_id: ME });
    const all = deriveNextUp([gate, running, assigned, rework], ME, true);
    expect(all.item?.kind).toBe("rework");
    expect(all.total).toBe(4);
    const noRework = deriveNextUp([gate, running, assigned], ME, true);
    expect(noRework.item?.kind).toBe("review");
    const noGate = deriveNextUp([running, assigned], ME, true);
    expect(noGate.item?.kind).toBe("submit");
    const onlyStart = deriveNextUp([assigned], ME, true);
    expect(onlyStart.item?.kind).toBe("start");
  });

  it("别人的任务不算我的;休眠门(blocked)不催审", () => {
    const others = T({ id: "o", status: "assigned", assignee_member_id: "acc_andy" });
    const dormant = T({ id: "gd", is_gate: true, status: "blocked" });
    const r = deriveNextUp([others, dormant], ME, true);
    expect(r.item).toBeNull();
    expect(r.total).toBe(0);
  });
});
