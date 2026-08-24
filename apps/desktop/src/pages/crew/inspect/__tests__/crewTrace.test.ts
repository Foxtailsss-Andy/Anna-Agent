/**
 * crewTrace · 薄适配器契约(RED 先行)
 *   RAW crew 帧 → LoopCard turns;丢脚手架事件;抽 memory_hits 溯源;终态映射。
 */
import { describe, expect, it } from "vitest";

import { framesToTrace } from "../crewTrace";

const doneRun = [
  { type: "event", event: { type: "crew.run.created", run_ref: "crew_run_001", task_id: "t1" } },
  { type: "step", phase: "analyze", intent: "读取项目共识 + PRD v2", turn: 1 },
  { type: "event", event: { type: "model.call.started", payload: { model_name: "m" }, created_at: "2026-07-17T10:00:00Z" } },
  { type: "tool_start", name: "search", turn: 1 },
  { type: "tool_done", name: "search", turn: 1 },
  { type: "step", phase: "deliver", intent: "三态布局草案 → 产物 v1", turn: 2 },
  { type: "done", run: { run_ref: "crew_run_001", status: "done", task_id: "t1", memory_hits: ["m1", "m2"] } },
] as Record<string, unknown>[];

describe("framesToTrace · crew run 帧 → LoopCard", () => {
  it("终帧 memory_hits → 命中溯源(共识 chips 读路)", () => {
    expect(framesToTrace(doneRun).memoryHits).toEqual(["m1", "m2"]);
  });

  it("done 终帧 → state=done · terminalStatus=done", () => {
    const tr = framesToTrace(doneRun);
    expect(tr.state).toBe("done");
    expect(tr.terminalStatus).toBe("done");
  });

  it("回合真算:turn1 + turn2 归约成回合(nowIntent = 最近 step 原文)", () => {
    const tr = framesToTrace(doneRun);
    const turns = tr.turns.filter((t) => t.index >= 1);
    expect(turns.length).toBe(2);
    expect(tr.nowIntent).toBe("三态布局草案 → 产物 v1");
  });

  it("丢弃 crew manager 脚手架事件(crew.run.created 不成过程步)", () => {
    const tr = framesToTrace(doneRun);
    const labels = tr.turns.flatMap((t) => t.steps.map((s) => s.label));
    expect(labels.some((l) => l.includes("crew.run.created"))).toBe(false);
  });

  it("event.created_at → 起始时刻(耗时基准);无时戳帧 → null", () => {
    expect(framesToTrace(doneRun).startedAtMs).toBe(Date.parse("2026-07-17T10:00:00Z"));
    const noStamp = [{ type: "step", phase: "analyze", intent: "x", turn: 1 }] as Record<string, unknown>[];
    expect(framesToTrace(noStamp).startedAtMs).toBeNull();
  });

  it("blocked 终帧(run.status=blocked)→ state=error · terminalStatus=blocked · 携 memory_hits", () => {
    const blocked = [
      { type: "step", phase: "analyze", intent: "尝试", turn: 1 },
      { type: "error", run: { run_ref: "crew_run_002", status: "blocked", task_id: "t2", error: "model unavailable", memory_hits: ["m9"] } },
    ] as Record<string, unknown>[];
    const tr = framesToTrace(blocked);
    expect(tr.state).toBe("error");
    expect(tr.terminalStatus).toBe("blocked");
    expect(tr.memoryHits).toEqual(["m9"]);
  });

  it("运行中(无终帧)→ state=running · terminalStatus=null", () => {
    const live = [
      { type: "step", phase: "analyze", intent: "撰写文案", turn: 1 },
      { type: "tool_start", name: "read", turn: 1 },
    ] as Record<string, unknown>[];
    const tr = framesToTrace(live);
    expect(tr.state).toBe("running");
    expect(tr.terminalStatus).toBeNull();
  });

  it("frameCount = L2 步数(流式微帧折进所属步,不虚增;真机曾显 1373 帧即此噪音)", () => {
    // doneRun 归约后:turn1(step+tool)+turn2(step)→ 步数与 turns.steps 同源
    const tr = framesToTrace(doneRun);
    const stepTotal = tr.turns.reduce((n, t) => n + t.steps.length, 0);
    expect(tr.frameCount).toBe(stepTotal);
    expect(tr.frameCount).toBeGreaterThan(0);
    expect(framesToTrace([]).frameCount).toBe(0);
  });

  it("modelName 抽自 model.call.started.payload.model_name;无 → null(不猜)", () => {
    expect(framesToTrace(doneRun).modelName).toBe("m");
    const noModel = [{ type: "step", phase: "analyze", intent: "x", turn: 1 }] as Record<string, unknown>[];
    expect(framesToTrace(noModel).modelName).toBeNull();
  });

  it("endedAtMs = 最晚带时戳帧(终态耗时上界);无时戳 → null", () => {
    expect(framesToTrace(doneRun).endedAtMs).toBe(Date.parse("2026-07-17T10:00:00Z"));
    const noStamp = [{ type: "step", phase: "analyze", intent: "x", turn: 1 }] as Record<string, unknown>[];
    expect(framesToTrace(noStamp).endedAtMs).toBeNull();
  });
});
