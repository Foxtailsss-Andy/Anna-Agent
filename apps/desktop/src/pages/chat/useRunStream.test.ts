import { describe, expect, it } from "vitest";
import { createNormalizer } from "../../lib/api/normalize";
import type { Frame } from "../../lib/frames";
import { reduceTurns } from "../../lib/turns";
import { usedPercent } from "./useRunStream";

describe("usedPercent(剩余 % → 已用 %,复审修复:CTX 环语义反转)", () => {
  it("left 88(剩余)→ used 12(已用),同一真值仅单位翻转", () => {
    expect(usedPercent(88)).toBe(12);
  });
  it("left null(无审计)→ undefined(不猜、不显示)", () => {
    expect(usedPercent(null)).toBeUndefined();
  });
  it("边界:left 0(耗尽)→ used 100;left 100(全新)→ used 0", () => {
    expect(usedPercent(0)).toBe(100);
    expect(usedPercent(100)).toBe(0);
  });
  it("越界防御:left 为负或 >100(不该发生,但夹在 [0,100])", () => {
    expect(usedPercent(-5)).toBe(100);
    expect(usedPercent(120)).toBe(0);
  });
});

/**
 * start(open, { append }) 续流契约(R6 Task 1)。
 *
 * 环境说明:vitest 跑在 node 环境(仓库约定:纯逻辑单测,无 jsdom/testing-library、无组件/hook
 * 渲染 —— 见 vitest.config.ts 注释)。故此处不 renderHook,而是对 hook 所编排的**可观测不变量**做单测:
 * append 分支 = 沿用同一 `createNormalizer()` 实例 + 不清 frames → reduceTurns 得到一条累进时间线;
 * 默认分支 = 新 normalizer + 清 frames → 时间线重置。这正是 `start` 里 append 判定所切换的两种行为。
 * hook 的真实续流由 R6 walkthrough(approve/stream 真恢复段)端到端验证。
 *
 * 帧取自真跑形态(reality-check 2026-07-10):创建段止于 awaiting_approval + done(waiting_confirmation);
 * 恢复段(approve/stream 遗留路径)仅审计帧 + done(completed)。
 */
type Raw = Record<string, unknown>;

const SEG_CREATE_TO_AWAITING: Raw[] = [
  { type: "step", phase: "tool", tool: "reimbursement.create_draft", intent: "正在创建报销单据", turn: 1 },
  { type: "tool_start", name: "reimbursement.create_draft" },
  { type: "event", event: { type: "mcp.tool.called", payload: { tool_name: "reimbursement.create_draft", status: "success" }, created_at: "2026-06-15T11:17:48Z" } },
  { type: "tool_done", name: "reimbursement.create_draft" },
  { type: "awaiting_approval", reason: "awaiting_approval", detail: { approval_id: "approval_010" } },
];
const DONE_WAITING: Raw = { type: "done", run: { id: "run_169", status: "waiting_confirmation" } };
const SEG_APPROVE_RESUME: Raw[] = [
  { type: "event", event: { type: "approval.approved", payload: {}, created_at: "2026-06-15T11:18:57Z" } },
  { type: "event", event: { type: "reimbursement.submitted", payload: {}, created_at: "2026-06-15T11:18:57Z" } },
  { type: "event", event: { type: "reimbursement.verified", payload: {}, created_at: "2026-06-15T11:18:58Z" } },
  { type: "done", run: { id: "run_169", status: "completed" } },
];

const countSteps = (frames: Frame[]) =>
  reduceTurns(frames).turns.reduce((n, t) => n + t.steps.length, 0);

describe("start append 续流(归一化实例复用 → 一条时间线;reduceTurns 累计不重置)", () => {
  it("创建段止于 awaiting_approval(未收 done)→ tree.state = awaiting", () => {
    const norm = createNormalizer();
    const frames = SEG_CREATE_TO_AWAITING.flatMap((r) => norm(r));
    expect(reduceTurns(frames).state).toBe("awaiting");
  });

  it("append:同一 normalizer + 累积 frames → 创建段的工具步保留、系统步累加、state 收敛 done", () => {
    // ── hook 的 append 分支:同一 normalizer 实例贯穿两段,frames 不清空 ──
    const norm = createNormalizer();
    const seg1 = [...SEG_CREATE_TO_AWAITING, DONE_WAITING].flatMap((r) => norm(r));
    // 第一段:awaiting 后紧跟 done(waiting_confirmation)→ 最终 state done,approval 已在树上
    const tree1 = reduceTurns(seg1);
    expect(tree1.state).toBe("done");
    expect(tree1.approval).toBeDefined();
    expect(tree1.run?.runId).toBe("run_169");
    const steps1 = countSteps(seg1);

    // 第二段(append):恢复段帧经同一 normalizer 追加到既有 frames 之后
    const seg2 = SEG_APPROVE_RESUME.flatMap((r) => norm(r));
    const merged = [...seg1, ...seg2];
    const treeAll = reduceTurns(merged);

    expect(treeAll.state).toBe("done");
    // 创建段的 create_draft 工具步未被重置,仍在时间线上
    expect(merged.some((f) => f.type === "tool_done")).toBe(true);
    // 恢复段的审计系统步累加,总步数增长(时间线累进)
    expect(countSteps(merged)).toBeGreaterThan(steps1);
  });

  it("默认(不 append):新 normalizer + 清 frames → 只反映第二段,时间线重置", () => {
    // ── hook 默认分支:每次 start 新建 normalizer 且 setFrames([]) ──
    createNormalizer(); // 第一段的 normalizer(被丢弃)
    const norm2 = createNormalizer(); // 默认分支的新 normalizer
    const only2 = SEG_APPROVE_RESUME.flatMap((r) => norm2(r));
    // 第一段的工具步不复存在(frames 已清)
    expect(only2.some((f) => f.type === "tool_done")).toBe(false);
    expect(reduceTurns(only2).state).toBe("done");
  });
});
