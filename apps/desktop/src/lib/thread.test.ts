import { describe, expect, it } from "vitest";
import { threadTurnLabel } from "./thread";

describe("threadTurnLabel", () => {
  it("有 chat.thread.continued 且 prior_turns=2 → 「会话第 3 轮」(N = prior_turns + 1)", () => {
    const events = [
      { type: "chat.run.created", run_id: "r2", payload: {} },
      { type: "chat.thread.continued", run_id: "r2", payload: { thread_id: "r1", prior_turns: 2 } },
    ];
    expect(threadTurnLabel(events)).toBe("会话第 3 轮");
  });

  it("prior_turns=1(单轮续聊)→ 「会话第 2 轮」", () => {
    const events = [
      { type: "chat.thread.continued", run_id: "r2", payload: { thread_id: "r1", prior_turns: 1 } },
    ];
    expect(threadTurnLabel(events)).toBe("会话第 2 轮");
  });

  it("无 chat.thread.continued(首轮 / 未续聊)→ null(不出 chip)", () => {
    const events = [{ type: "chat.run.created", run_id: "r1", payload: {} }];
    expect(threadTurnLabel(events)).toBeNull();
  });

  it("载荷缺 prior_turns → null(不猜、不出 chip)", () => {
    const events = [{ type: "chat.thread.continued", run_id: "r2", payload: { thread_id: "r1" } }];
    expect(threadTurnLabel(events)).toBeNull();
  });

  it("prior_turns 非数字(异常载荷)→ null", () => {
    const events = [
      { type: "chat.thread.continued", run_id: "r2", payload: { prior_turns: "2" } },
    ];
    expect(threadTurnLabel(events)).toBeNull();
  });

  it("prior_turns < 1(无既往对)→ null(诚实红线:不显示第 1 轮)", () => {
    const events = [
      { type: "chat.thread.continued", run_id: "r2", payload: { prior_turns: 0 } },
    ];
    expect(threadTurnLabel(events)).toBeNull();
  });

  it("非数组入参(undefined / 缺 audit_events)→ null", () => {
    expect(threadTurnLabel(undefined)).toBeNull();
    expect(threadTurnLabel(null)).toBeNull();
    expect(threadTurnLabel({})).toBeNull();
  });
});
