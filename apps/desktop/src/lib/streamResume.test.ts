import { describe, expect, it } from "vitest";

import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  detectSuspension,
  initResumeState,
  nextReconnect,
  registerAttempt,
  trackSeq,
  type ResumeState,
} from "./streamResume";

describe("streamResume · trackSeq(记录 seq / 终帧 / 收帧归零重连计数)", () => {
  it("带 seq 的帧更新 lastSeq;无 seq 的帧保持不变", () => {
    let s = initResumeState();
    expect(s.lastSeq).toBe(0);
    s = trackSeq(s, { type: "step", seq: 3 });
    expect(s.lastSeq).toBe(3);
    s = trackSeq(s, { type: "text_delta" }); // 无 seq → 不动
    expect(s.lastSeq).toBe(3);
    s = trackSeq(s, { type: "text_delta", seq: 5 });
    expect(s.lastSeq).toBe(5);
  });

  it("非数值 seq(异常帧)视作无 seq,lastSeq 保持不变", () => {
    let s = trackSeq(initResumeState(), { type: "step", seq: 4 });
    s = trackSeq(s, { type: "step", seq: "oops" as unknown });
    expect(s.lastSeq).toBe(4);
  });

  it("done / error 帧置 sawTerminal;过程帧不置", () => {
    expect(trackSeq(initResumeState(), { type: "done", seq: 9 }).sawTerminal).toBe(true);
    expect(trackSeq(initResumeState(), { type: "error", seq: 9 }).sawTerminal).toBe(true);
    expect(trackSeq(initResumeState(), { type: "step", seq: 1 }).sawTerminal).toBe(false);
  });

  it("sawTerminal 一旦置真便黏住(后续过程帧不翻回)", () => {
    let s = trackSeq(initResumeState(), { type: "done", seq: 9 });
    s = trackSeq(s, { type: "step", seq: 10 });
    expect(s.sawTerminal).toBe(true);
  });

  it("收到任一帧即把 attempts 归零(重连计数复位)", () => {
    let s: ResumeState = { lastSeq: 4, sawTerminal: false, attempts: 3, suspended: false };
    s = trackSeq(s, { type: "step", seq: 5 });
    expect(s.attempts).toBe(0);
  });

  it("续帧出现 seq 断档时记录 gap，并停止自动重连", () => {
    let s: ResumeState = { ...initResumeState(), lastSeq: 4 };
    s = trackSeq(s, { type: "step", seq: 6 });
    expect(s.sequenceGap).toEqual({ expected: 5, actual: 6 });
    expect(nextReconnect(s)).toBeNull();
  });
});

describe("streamResume · detectSuspension(挂起识别归约:真凭证才认,畸形→null)", () => {
  it("流内 wire 事件帧 run.suspended → 命中,携 turns_used", () => {
    const hit = detectSuspension({
      type: "event",
      seq: 12,
      event: { type: "run.suspended", payload: { reason: "max_turns", turns_used: 8 } },
    });
    expect(hit).toEqual({ turnsUsed: 8 });
  });

  it("回看裸审计事件 run.suspended → 命中,携 turns_used(run.audit_events 形态)", () => {
    const hit = detectSuspension({
      type: "run.suspended",
      run_id: "chat_run_1",
      payload: { reason: "max_turns", turns_used: 3 },
    });
    expect(hit).toEqual({ turnsUsed: 3 });
  });

  it("run.suspended 但 payload 无 turns_used → 命中但省略 turnsUsed(不猜)", () => {
    expect(detectSuspension({ type: "event", event: { type: "run.suspended", payload: {} } })).toEqual({});
    expect(detectSuspension({ type: "event", event: { type: "run.suspended" } })).toEqual({});
  });

  it("非数值 turns_used(异常载荷)→ 命中但省略 turnsUsed", () => {
    const hit = detectSuspension({
      type: "event",
      event: { type: "run.suspended", payload: { turns_used: "oops" } },
    });
    expect(hit).toEqual({});
  });

  it("非挂起事件 / 过程帧 / 畸形 → null(不伪判)", () => {
    expect(detectSuspension({ type: "event", event: { type: "model.call.started" } })).toBeNull();
    expect(detectSuspension({ type: "step", seq: 1 })).toBeNull();
    expect(detectSuspension({ type: "done", seq: 9 })).toBeNull();
    expect(detectSuspension({ type: "event" })).toBeNull(); // 无 event 子对象
    expect(detectSuspension({ type: "event", event: null })).toBeNull();
    expect(detectSuspension({})).toBeNull();
  });
});

describe("streamResume · 挂起短路重连(L4b:诚实暂停 ≠ 断线)", () => {
  it("trackSeq 遇 run.suspended wire 帧 → 置 suspended;过程帧不置", () => {
    expect(trackSeq(initResumeState(), { type: "step", seq: 1 }).suspended).toBe(false);
    const s = trackSeq(initResumeState(), {
      type: "event",
      seq: 5,
      event: { type: "run.suspended", payload: { turns_used: 8 } },
    });
    expect(s.suspended).toBe(true);
    expect(s.lastSeq).toBe(5); // 挂起帧的 seq 仍记入,续办从此续帧
  });

  it("suspended 一旦置真便黏住(后续过程帧不翻回)", () => {
    let s = trackSeq(initResumeState(), { type: "event", seq: 5, event: { type: "run.suspended", payload: {} } });
    s = trackSeq(s, { type: "step", seq: 6 });
    expect(s.suspended).toBe(true);
  });

  it("suspended → nextReconnect 立即 null(哪怕未见终帧、次数未耗尽)", () => {
    const s = trackSeq(initResumeState(), { type: "event", seq: 5, event: { type: "run.suspended", payload: {} } });
    expect(s.sawTerminal).toBe(false);
    expect(s.attempts).toBe(0);
    expect(nextReconnect(s)).toBeNull(); // 不退避、不重连 —— 交给续办卡
  });
});

describe("streamResume · nextReconnect(退避序列 / 耗尽 / 终帧停 / fromSeq)", () => {
  it("退避序列 500/1000/2000/4000/8000,5 次后耗尽 → null", () => {
    let s = initResumeState();
    const delays: number[] = [];
    for (;;) {
      const plan = nextReconnect(s);
      if (!plan) break;
      delays.push(plan.delayMs);
      s = registerAttempt(s);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(delays).toEqual([...RECONNECT_BACKOFF_MS]);
    expect(s.attempts).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(nextReconnect(s)).toBeNull();
  });

  it("见过终帧 → 立即 null(不再重连,哪怕次数未耗尽)", () => {
    const s = trackSeq(initResumeState(), { type: "done", seq: 2 });
    expect(nextReconnect(s)).toBeNull();
  });

  it("fromSeq 携带最近 seq(精确续帧,重连不重不漏)", () => {
    let s = trackSeq(initResumeState(), { type: "step", seq: 7 });
    expect(nextReconnect(s)?.fromSeq).toBe(7);
    s = registerAttempt(s); // 退避一次后仍从 7 续
    expect(nextReconnect(s)?.fromSeq).toBe(7);
  });

  it("收帧后重连计数复位 → 退避从 500 重新起算,fromSeq 跟到新 seq", () => {
    let s = registerAttempt(registerAttempt(initResumeState())); // attempts=2 → 本应 2000
    expect(nextReconnect(s)?.delayMs).toBe(2000);
    s = trackSeq(s, { type: "text_delta", seq: 10 }); // 成功收帧 → 复位
    expect(nextReconnect(s)?.delayMs).toBe(500);
    expect(nextReconnect(s)?.fromSeq).toBe(10);
  });
});
