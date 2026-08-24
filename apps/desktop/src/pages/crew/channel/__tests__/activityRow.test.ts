/**
 * activityRow · R2 活动行纯函数测试
 * 覆盖:执行中 agent 任务选择(running / run_inflight / 门排除)· elapsed 格式(校准/无值/封顶)。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import { elapsedLabel, selectActiveTasks } from "../activityRow";

function task(partial: Partial<CrewTask> & { id: string }): CrewTask {
  return {
    project_id: "p1",
    key: partial.id,
    title: partial.id,
    status: "todo",
    role_required: "工程",
    ...partial,
  } as CrewTask;
}

describe("selectActiveTasks(执行中 agent 任务)", () => {
  it("status==running 或 run_inflight 皆入选", () => {
    const tasks = [
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "assigned", run_inflight: true }),
      task({ id: "c", status: "assigned" }),
      task({ id: "d", status: "done" }),
    ];
    expect(selectActiveTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
  });
  it("评审门排除(门不是被执行的产出任务)", () => {
    const tasks = [task({ id: "g", status: "running", is_gate: true }), task({ id: "a", status: "running" })];
    expect(selectActiveTasks(tasks).map((t) => t.id)).toEqual(["a"]);
  });
  it("无在飞 → 空", () => {
    expect(selectActiveTasks([task({ id: "a", status: "assigned" })])).toEqual([]);
    expect(selectActiveTasks([])).toEqual([]);
  });
  it("给了 agentIds → 人类执行中任务排除(真机 Andy 案:人干活不挂「刚刚开始」)", () => {
    const agents = new Set(["acc_agent_design"]);
    const tasks = [
      task({ id: "h", status: "running", assignee_member_id: "acc_andy" }),
      task({ id: "a", status: "running", assignee_member_id: "acc_agent_design" }),
      task({ id: "u", status: "running" }), // 无 assignee 也排除
    ];
    expect(selectActiveTasks(tasks, agents).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("elapsedLabel(本地推进 + run_started_at 校准)", () => {
  const start = "2026-07-20T16:38:00.000Z";
  const startMs = Date.parse(start);
  it("24 秒 → 已运行 00:24", () => {
    expect(elapsedLabel(start, startMs + 24_000)).toBe("已运行 00:24");
  });
  it("分秒补零", () => {
    expect(elapsedLabel(start, startMs + (5 * 60 + 3) * 1000)).toBe("已运行 05:03");
  });
  it("无起跑时刻 → 刚刚开始", () => {
    expect(elapsedLabel(null, startMs)).toBe("刚刚开始");
    expect(elapsedLabel(undefined, startMs)).toBe("刚刚开始");
  });
  it("非法时刻 → 刚刚开始", () => {
    expect(elapsedLabel("not-a-date", startMs)).toBe("刚刚开始");
  });
  it("负值(时钟漂移)夹到 00:00", () => {
    expect(elapsedLabel(start, startMs - 5000)).toBe("已运行 00:00");
  });
  it(">99:59 封顶", () => {
    expect(elapsedLabel(start, startMs + 100 * 60 * 1000)).toBe("已运行 99:59");
  });
});
