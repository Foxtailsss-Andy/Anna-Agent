import { describe, expect, it, vi } from "vitest";
import { createNormalizer } from "./normalize";
import type { Frame } from "../frames";
import live from "./fixtures/live-chat-frames.json";
import liveSuccess from "./fixtures/live-chat-frames-success.json";

const runAll = (raws: Record<string, unknown>[]): Frame[] => {
  const n = createNormalizer();
  return raws.flatMap((r) => n(r));
};

describe("createNormalizer(v1→v2,真数据形态映射)", () => {
  it("text/delta 改名 + step 直通并更新 turn 上下文", () => {
    const out = runAll([
      { type: "step", phase: "analyze", intent: "理解需求", tool: null, turn: 1 },
      { type: "text_delta", text: "你" },
      { type: "delta", text: "好" },
      { type: "tool_start", name: "plan.update" },
    ]);
    expect(out[0]).toMatchObject({ type: "step", intent: "理解需求", turn: 1 });
    expect(out[1]).toMatchObject({ type: "text_delta", delta: "你" });
    expect(out[2]).toMatchObject({ type: "text_delta", delta: "好" });
    expect(out[3]).toMatchObject({ type: "tool_start", tool: "plan.update", turn: 1 });
  });
  it("plan.updated 审计事件解包为一等帧;其余审计事件转 EventFrame{name}", () => {
    const out = runAll([
      { type: "event", event: { type: "run.created", run_id: "r", payload: {}, created_at: "2026-07-09T00:00:00Z" } },
      { type: "event", event: { type: "plan.updated", run_id: "r", payload: { count: 2, done_count: 1, items: [{ id: "1", title: "a", status: "done" }, { id: "2", title: "b", status: "in_progress" }] }, created_at: "2026-07-09T00:00:01Z" } },
    ]);
    expect(out[0]).toMatchObject({ type: "event", name: "run.created" });
    expect(out[1]).toMatchObject({ type: "plan.updated", plan: [{ id: "1", status: "done" }, { id: "2", status: "in_progress" }] });
  });
  it("tool_done 的 ok 来自 mcp.tool.called 审计;无审计默认 true", () => {
    const out = runAll([
      { type: "tool_start", name: "erp.query" },
      { type: "event", event: { type: "mcp.tool.called", run_id: "r", payload: { tool_name: "erp.query", input_hash: "x", status: "error", error: "timeout" }, created_at: "t" } },
      { type: "tool_done", name: "erp.query" },
      { type: "tool_start", name: "plan.update" },
      { type: "tool_done", name: "plan.update" },
    ]);
    const dones = out.filter((f) => f.type === "tool_done");
    expect(dones[0]).toMatchObject({ tool: "erp.query", ok: false });
    expect(dones[1]).toMatchObject({ tool: "plan.update", ok: true });
  });
  it("done(成功)聚合 usage(审计真报)+ 缺省字段兜底;failed run 收敛为 error 帧", () => {
    const okOut = runAll([
      { type: "event", event: { type: "model.call.started", run_id: "r", payload: { model_name: "deepseek-chat", context_percent_left: 88 }, created_at: "t" } },
      { type: "event", event: { type: "model.call.completed", run_id: "r", payload: { input_tokens: 100, output_tokens: 50 }, created_at: "t" } },
      { type: "done", run: { id: "run1", status: "succeeded", artifacts: [{ id: "a1", kind: "page", title: "x", content: "<p/>" }], plan: [] } },
    ]);
    const done = okOut.find((f) => f.type === "done");
    expect(done).toMatchObject({ run: { runId: "run1", usage: { tokens: 150, model: "deepseek-chat" } } });
    const failOut = runAll([{ type: "done", run: { id: "run2", status: "failed", error_code: "model_not_configured", error_message: "上游未配置" } }]);
    expect(failOut).toHaveLength(1);
    expect(failOut[0]).toMatchObject({ type: "error", message: "上游未配置" });
  });
  it("usage 无审计 → tokens null(不显示,不猜)", () => {
    const out = runAll([{ type: "done", run: { id: "r", status: "succeeded" } }]);
    expect(out[0]).toMatchObject({ run: { usage: { tokens: null } } });
  });
  it("getUsage:无审计 → tokens null;model.call.started 填 model;completed 累加真报", () => {
    const n = createNormalizer();
    expect(n.getUsage()).toEqual({ tokens: null });
    n({ type: "event", event: { type: "model.call.started", run_id: "r", payload: { model_name: "deepseek-v4-pro", context_percent_left: 90 }, created_at: "t" } });
    // model 已知,但无 completed 真报 → tokens 仍 null(诚实,不伪造 0)
    expect(n.getUsage()).toEqual({ tokens: null, model: "deepseek-v4-pro" });
    n({ type: "event", event: { type: "model.call.completed", run_id: "r", payload: { input_tokens: 100, output_tokens: 50 }, created_at: "t" } });
    expect(n.getUsage()).toEqual({ tokens: 150, model: "deepseek-v4-pro" });
    // 多次 model.call.completed 累加(与 done.usage 同源)
    n({ type: "event", event: { type: "model.call.completed", run_id: "r", payload: { input_tokens: 30, output_tokens: 20 }, created_at: "t" } });
    expect(n.getUsage()).toEqual({ tokens: 200, model: "deepseek-v4-pro" });
  });
  it("getCtxPercentLeft:原始透传 model.call.started 的 context_percent_left(剩余,非已用);无审计 → null", () => {
    const n = createNormalizer();
    expect(n.getCtxPercentLeft()).toBeNull();
    n({ type: "event", event: { type: "model.call.started", run_id: "r", payload: { model_name: "deepseek-chat", context_percent_left: 88 }, created_at: "t" } });
    expect(n.getCtxPercentLeft()).toBe(88);
    // 后续一帧刷新为最新真值(不累加,直接覆盖)
    n({ type: "event", event: { type: "model.call.started", run_id: "r", payload: { model_name: "deepseek-chat", context_percent_left: 62 }, created_at: "t" } });
    expect(n.getCtxPercentLeft()).toBe(62);
  });
  it("getUsage 与 done.run.usage 同源:成功流 fixture tokens 一致(6792)", () => {
    const n = createNormalizer();
    (liveSuccess as Record<string, unknown>[]).forEach((r) => n(r));
    expect(n.getUsage()).toMatchObject({ tokens: 6792, model: "deepseek-v4-pro" });
  });
  it("真流 fixture 端到端:全帧可归一,无 throw,终止帧恰一个", () => {
    const out = runAll(live as Record<string, unknown>[]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.filter((f) => f.type === "done" || f.type === "error")).toHaveLength(1);
  });
  it("成功流 fixture(live-chat-frames-success)端到端:done 聚合 plan/artifacts/usage 真数据", () => {
    const out = runAll(liveSuccess as Record<string, unknown>[]);
    const terminal = out.filter((f) => f.type === "done" || f.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      type: "done",
      run: {
        runId: "chat_run_002",
        // 4 次 model.call.completed 真报 input+output 累加:(1136+162)+(1320+367)+(1728+138)+(1898+43) = 6792
        usage: { tokens: 6792 },
      },
    });
    const done = terminal[0] as Extract<Frame, { type: "done" }>;
    expect(done.run.plan).toHaveLength(2);
    expect(done.run.artifacts).toHaveLength(1);
    expect(out.filter((f) => f.type === "plan.updated").length).toBeGreaterThanOrEqual(1);
    const toolDones = out.filter((f) => f.type === "tool_done");
    expect(toolDones.length).toBeGreaterThan(0);
    expect(toolDones).toContainEqual(expect.objectContaining({ ok: true }));
  });
  it("awaiting_approval 直通 turn 上下文;detail 缺失 → {}", () => {
    const withDetail = runAll([
      { type: "step", phase: "tool", intent: "等待审批", turn: 2 },
      { type: "awaiting_approval", reason: "approval", detail: { approval_id: "ap_1" } },
    ]);
    expect(withDetail[1]).toMatchObject({
      type: "awaiting_approval",
      reason: "approval",
      detail: { approval_id: "ap_1" },
      turn: 2,
    });
    const noDetail = runAll([
      { type: "step", phase: "tool", intent: "等待审批", turn: 2 },
      { type: "awaiting_approval", reason: "approval" },
    ]);
    expect(noDetail[1]).toMatchObject({
      type: "awaiting_approval",
      reason: "approval",
      detail: {},
      turn: 2,
    });
  });
  it("M-2:text_delta 形态容错 —— v2 原生 raw.delta 优先,v1 raw.text 回落不变", () => {
    const v2 = runAll([{ type: "text_delta", delta: "你好" }]);
    expect(v2[0]).toMatchObject({ type: "text_delta", delta: "你好" });
    const v1 = runAll([{ type: "text_delta", text: "你好" }]);
    expect(v1[0]).toMatchObject({ type: "text_delta", delta: "你好" });
    // 两键并存(灰度期过渡形态):v2 delta 优先
    const both = runAll([{ type: "text_delta", delta: "v2", text: "v1" }]);
    expect(both[0]).toMatchObject({ type: "text_delta", delta: "v2" });
  });
  it("M-2:tool_start/tool_done 形态容错 —— v2 原生 raw.tool 优先,v1 raw.name 回落不变", () => {
    const startV2 = runAll([{ type: "tool_start", tool: "erp.query" }]);
    expect(startV2[0]).toMatchObject({ type: "tool_start", tool: "erp.query" });
    const startV1 = runAll([{ type: "tool_start", name: "erp.query" }]);
    expect(startV1[0]).toMatchObject({ type: "tool_start", tool: "erp.query" });
    const doneV2 = runAll([{ type: "tool_done", tool: "erp.query" }]);
    expect(doneV2[0]).toMatchObject({ type: "tool_done", tool: "erp.query", ok: true });
    const doneV1 = runAll([{ type: "tool_done", name: "erp.query" }]);
    expect(doneV1[0]).toMatchObject({ type: "tool_done", tool: "erp.query", ok: true });
  });
  it("M-2:done run id 形态容错 —— v2 原生 run.runId 优先,v1 run.id 回落不变", () => {
    const v2 = runAll([{ type: "done", run: { runId: "run_v2", status: "succeeded" } }]);
    expect(v2[0]).toMatchObject({ type: "done", run: { runId: "run_v2" } });
    const v1 = runAll([{ type: "done", run: { id: "run_v1", status: "succeeded" } }]);
    expect(v1[0]).toMatchObject({ type: "done", run: { runId: "run_v1" } });
  });
  it("M-2:thinking 帧真透传(turns.ts 已消费)——有 turn 用真值,缺省回落当前上下文 turn", () => {
    const withTurn = runAll([
      { type: "step", phase: "analyze", intent: "理解需求", turn: 3 },
      { type: "thinking", delta: "推理片段", turn: 3 },
    ]);
    expect(withTurn[1]).toMatchObject({ type: "thinking", delta: "推理片段", turn: 3 });
    const noTurn = runAll([
      { type: "step", phase: "analyze", intent: "理解需求", turn: 2 },
      { type: "thinking", delta: "推理片段" },
    ]);
    expect(noTurn[1]).toMatchObject({ type: "thinking", delta: "推理片段", turn: 2 });
  });
  it("未知帧 type 丢弃 + console.warn,不 throw", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = runAll([{ type: "mystery" }]);
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
  it("空流:构造+零帧不 throw;随后 done 用最小 run 兜底", () => {
    const n = createNormalizer();
    const empty = ([] as Record<string, unknown>[]).flatMap((r) => n(r));
    expect(empty).toEqual([]);
    const out = n({ type: "done", run: { id: "r" } });
    expect(out[0]).toMatchObject({
      type: "done",
      run: { runId: "r", artifacts: [], plan: [], usage: { tokens: null } },
    });
  });
});

describe("C2:plan.update L3 合成(校对基准 P-03)", () => {
  it("plan.updated 审计真值 → tool_done(plan.update).drilldown(resultPreview 逐字 + pendingNote 缺口说明)", () => {
    const out = runAll([
      { type: "tool_start", name: "plan.update" },
      {
        type: "event",
        event: {
          type: "plan.updated",
          run_id: "r",
          payload: {
            count: 2,
            done_count: 1,
            items: [
              { id: "1", title: "列出执行计划", status: "done" },
              { id: "2", title: "输出团队协作金句", status: "in_progress" },
            ],
          },
          created_at: "2026-07-10T00:00:00Z",
        },
      },
      { type: "tool_done", name: "plan.update" },
    ]);
    const done = out.find((f) => f.type === "tool_done") as {
      drilldown?: { resultPreview?: string; pendingNote?: string };
    };
    expect(done.drilldown?.resultPreview).toContain("plan.updated · 2 项写入 · 1 项已完成");
    expect(done.drilldown?.resultPreview).toContain("- 列出执行计划");
    expect(done.drilldown?.resultPreview).toContain("- 输出团队协作金句");
    expect(done.drilldown?.pendingNote).toContain("待审计载荷扩展（B2）");
  });

  it("无 plan.updated 审计 → 不合成;非 plan.update 工具 → 不合成(不编造)", () => {
    const a = runAll([{ type: "tool_done", name: "plan.update" }]) as {
      drilldown?: unknown;
    }[];
    expect(a[0].drilldown).toBeUndefined();
    const b = runAll([
      {
        type: "event",
        event: { type: "plan.updated", run_id: "r", payload: { count: 1, items: [{ id: "1", title: "x", status: "pending" }] }, created_at: "t" },
      },
      { type: "tool_done", name: "erp.query" },
    ]);
    const done = b.find((f) => f.type === "tool_done") as { drilldown?: unknown };
    expect(done.drilldown).toBeUndefined();
  });
});
