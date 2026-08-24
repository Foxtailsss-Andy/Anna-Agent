/**
 * deriveFocus · 焦点呼吸唯一性 reducer(F2 RED)
 *
 * P1 契约:唯一呼吸=「最近一次 transition 的执行中节点」——
 *   频道事件(seq 最大且 task_id 指向 running 任务)判定;
 *   退化=数组序最后一个 running(无频道线索);
 *   无 running → null(零呼吸,评审时刻全静,不装忙)。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import { deriveFocus } from "../graphMapping";

let n = 0;
const task = (over: Partial<CrewTask> = {}): CrewTask => ({
  id: `t${++n}`,
  project_id: "p1",
  key: `k${n}`,
  title: `任务${n}`,
  status: "todo",
  role_required: "产品",
  depends_on: [],
  is_gate: false,
  origin: "sop",
  ...over,
});

type Msg = { seq: number; task_id: string | null; kind: string };
const msg = (seq: number, task_id: string | null, kind = "event"): Msg => ({ seq, task_id, kind });

describe("deriveFocus(唯一呼吸判定)", () => {
  it("零执行 → null(零呼吸)", () => {
    const tasks = [task({ status: "done" }), task({ status: "todo" })];
    expect(deriveFocus(tasks, [msg(3, tasks[0].id)])).toBeNull();
  });

  it("单 running,无频道线索 → 该任务", () => {
    const r = task({ status: "running" });
    expect(deriveFocus([task({ status: "done" }), r], [])).toBe(r.id);
  });

  it("多 running:seq 最大且指向 running 任务的频道事件胜出", () => {
    const r1 = task({ status: "running" });
    const r2 = task({ status: "running" });
    const ch = [msg(1, r2.id), msg(5, r1.id), msg(3, r2.id)];
    expect(deriveFocus([r1, r2], ch)).toBe(r1.id);
  });

  it("最高 seq 指向非 running(如 done)→ 跳过,取次高指向 running 者", () => {
    const d = task({ status: "done" });
    const r = task({ status: "running" });
    const ch = [msg(2, r.id), msg(9, d.id)];
    expect(deriveFocus([d, r], ch)).toBe(r.id);
  });

  it("say/command 行不参与判定(人话与草案非 transition)", () => {
    const r1 = task({ status: "running" });
    const r2 = task({ status: "running" });
    const ch = [msg(2, r1.id, "event"), msg(8, r2.id, "say"), msg(9, r2.id, "command")];
    expect(deriveFocus([r1, r2], ch)).toBe(r1.id);
  });

  it("频道无线索 → 退化:数组序最后一个 running", () => {
    const r1 = task({ status: "running" });
    const r2 = task({ status: "running" });
    expect(deriveFocus([r1, r2], [])).toBe(r2.id);
    expect(deriveFocus([r1, r2], [msg(4, null)])).toBe(r2.id);
  });

  it("门任务即使 running 也不获焦点(呼吸只属任务卡)", () => {
    const g = task({ is_gate: true, status: "running" });
    expect(deriveFocus([g], [])).toBeNull();
  });

  it("C1:在飞任务(status 未翻 running)也算执行中,可获焦点", () => {
    const inflight = task({ status: "assigned", run_inflight: true });
    expect(deriveFocus([task({ status: "done" }), inflight], [])).toBe(inflight.id);
  });
});
