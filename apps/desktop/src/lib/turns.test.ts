import { describe, expect, it } from "vitest";
import { reduceTurns, turnSummary, fmtDuration } from "./turns";
import { framesRunning, framesDone, framesFailed, framesAwaiting, TOOL_LABELS_DEMO } from "../fixtures/demo-run";

describe("reduceTurns(交接包纯函数,copy-in 后行为锁定)", () => {
  it("running:状态 running,最后回合展开语义(status running)", () => {
    const t = reduceTurns(framesRunning, TOOL_LABELS_DEMO);
    expect(t.state).toBe("running");
    expect(t.turns.at(-1)?.status).toBe("running");
    expect(t.nowIntent).not.toBe("");
  });
  it("done:state done + run 摘要在场", () => {
    const t = reduceTurns(framesDone, TOOL_LABELS_DEMO);
    expect(t.state).toBe("done");
    expect(t.run?.runId).toBeTruthy();
  });
  it("failed:失败步 defaultOpen 且所在回合 fail", () => {
    const t = reduceTurns(framesFailed, TOOL_LABELS_DEMO);
    expect(t.state).toBe("error");
    const failTurn = t.turns.find((x) => x.status === "fail");
    expect(failTurn).toBeDefined();
    expect(failTurn!.steps.some((s) => s.status === "fail" && s.defaultOpen)).toBe(true);
  });
  it("awaiting:审批帧置 approval 并加「等您示下」步(有 L3 可掀)", () => {
    const t = reduceTurns(framesAwaiting, TOOL_LABELS_DEMO);
    expect(t.state).toBe("awaiting");
    expect(t.approval?.reason).toBeTruthy();
    const wait = t.turns.flatMap((x) => x.steps).find((s) => s.status === "waiting");
    expect(wait?.l3).toBeDefined();
  });
  it("系统步永无 l3(硬规则:不可掀)", () => {
    for (const frames of [framesRunning, framesDone, framesFailed]) {
      const t = reduceTurns(frames, TOOL_LABELS_DEMO);
      for (const s of t.turns.flatMap((x) => x.steps)) {
        if (s.kind === "system" && s.status !== "waiting") expect(s.l3).toBeUndefined();
      }
    }
  });
  it("turnSummary 真值聚合;fmtDuration 三段", () => {
    expect(fmtDuration(50)).toBe("50ms");
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(94_000)).toBe("1m34s");
    const t = reduceTurns(framesRunning, TOOL_LABELS_DEMO);
    expect(turnSummary(t.turns[t.turns.length - 1]!)).toMatch(/思考|工具|步/);
  });
});

/**
 * J2×J3:判断层内部段返回空文本时,capability 会写下一条**真实的**
 * `chat.run.failed {error_code: chat_response_empty}`;紧接着 orchestrator 还原
 * 已交付的终态(Wave 1 fix 7)并补一条 `run.evaluation.skipped {reason:
 * continuation_*}`。run 本身没失败 —— 卡片仍是「办妥」,时间线上却孤零零一行
 * 「运行失败」:真事件,假印象。
 */
describe("J3:被还原的续办段失败 —— 事件是真的,标签不许制造假印象", () => {
  const failedEvent = (code: string) =>
    ({ type: "event", name: "chat.run.failed", turn: 1, payload: { error_code: code } }) as const;
  const skipped = (reason: string) =>
    ({ type: "event", name: "run.evaluation.skipped", turn: 1, payload: { reason } }) as const;
  const labels = (frames: Parameters<typeof reduceTurns>[0]) =>
    reduceTurns(frames).turns.flatMap((t) => t.steps).map((s) => s.label);

  it("空产出 + 续办被跳过 → 自解释标签,而不是裸「运行失败」", () => {
    const out = labels([failedEvent("chat_response_empty"), skipped("continuation_incomplete")]);
    expect(out).toContain("补办一轮未产出 · 已保留原答案");
    expect(out).not.toContain("运行失败");
  });

  it("续办撞了轮数预算(continuation_exhausted)同样成立", () => {
    const out = labels([failedEvent("chat_response_empty"), skipped("continuation_exhausted")]);
    expect(out).toContain("补办一轮未产出 · 已保留原答案");
  });

  it("run 真的失败了(没有随后的续办跳过)→ 仍然是「运行失败」", () => {
    expect(labels([failedEvent("chat_response_empty")])).toContain("运行失败");
    expect(labels([failedEvent("model_call_failed"), skipped("continuation_incomplete")])).toContain(
      "运行失败",
    );
  });

  it("判断层因别的原因跳过 → 不认领,不改写", () => {
    expect(labels([failedEvent("chat_response_empty"), skipped("evaluator_error")])).toContain(
      "运行失败",
    );
  });

  it("顺序反了(先跳过后失败)→ 不改写:改写的依据是「失败之后被还原」", () => {
    expect(labels([skipped("continuation_incomplete"), failedEvent("chat_response_empty")])).toContain(
      "运行失败",
    );
  });

  it("跳过事件保留自己的标签(两行各说各的事)", () => {
    const out = labels([failedEvent("chat_response_empty"), skipped("continuation_incomplete")]);
    expect(out).toContain("判断 · 本次未评估");
  });

  it("卡片状态由帧决定,不由事件名决定 —— 审计事件永远翻不动它", () => {
    const tree = reduceTurns([
      failedEvent("chat_response_empty"),
      skipped("continuation_incomplete"),
      { type: "done", run: { runId: "r1", artifacts: [], plan: [], usage: { tokens: null } } },
    ]);
    expect(tree.state).toBe("done");
    expect(tree.error).toBeUndefined();
  });
});
