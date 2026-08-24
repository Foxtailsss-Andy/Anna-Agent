import { describe, expect, it } from "vitest";
import { rawFramesFromRun } from "./historyFrames";
import { createNormalizer } from "../../lib/api/normalize";
import { reduceTurns } from "../../lib/turns";
import type { Frame } from "../../lib/frames";

/** 把一条已落库 run 走「重放 → 归一化 → 归约」的真链路(与页面回看同路)。 */
function replay(run: Record<string, unknown>) {
  const n = createNormalizer();
  const frames: Frame[] = rawFramesFromRun(run).flatMap((r) => n(r));
  return { frames, tree: reduceTurns(frames), usage: n.getUsage() };
}

const doneRun = {
  id: "chat_run_002",
  workspace_id: "w",
  actor_user_id: "u",
  message: "生成一个问候页",
  status: "ready",
  assistant_message: "都办妥了。",
  audit_events: [
    { type: "chat.run.created", run_id: "chat_run_002", payload: {}, created_at: "2026-07-09T15:54:09Z" },
    { type: "skill.loaded", run_id: "chat_run_002", payload: { skill_id: "chat/general-assistant" }, created_at: "2026-07-09T15:54:09Z" },
    { type: "model.call.started", run_id: "chat_run_002", payload: { model_name: "deepseek-v4-pro", context_percent_left: 100 }, created_at: "2026-07-09T15:54:10Z" },
    { type: "model.call.completed", run_id: "chat_run_002", payload: { input_tokens: 100, output_tokens: 50 }, created_at: "2026-07-09T15:54:13Z" },
    { type: "plan.updated", run_id: "chat_run_002", payload: { items: [{ id: "1", title: "建立计划", status: "done" }, { id: "2", title: "生成问候页", status: "done" }] }, created_at: "2026-07-09T15:54:13Z" },
  ],
  artifacts: [{ id: "art_1", kind: "page", title: "你好", content: "<h1>你好</h1>" }],
  plan: [
    { id: "1", title: "建立计划", status: "done" },
    { id: "2", title: "生成问候页", status: "done" },
  ],
  error_code: null,
  error_message: null,
};

describe("rawFramesFromRun(已落库 run → 真数据重放,非编造)", () => {
  it("done run → 终帧 done;plan / artifacts 透传;usage 由重放的审计累加", () => {
    const { tree, frames, usage } = replay(doneRun);
    expect(tree.state).toBe("done");
    expect(tree.run?.artifacts).toHaveLength(1);
    expect(tree.run?.artifacts[0]).toMatchObject({ id: "art_1", kind: "page", title: "你好" });
    expect(tree.plan).toHaveLength(2);
    expect(usage).toMatchObject({ tokens: 150, model: "deepseek-v4-pro" });
    // 恰一个终止帧
    expect(frames.filter((f) => f.type === "done" || f.type === "error")).toHaveLength(1);
    // plan.updated 解包为一等帧(不是系统步)
    expect(frames.some((f) => f.type === "plan.updated")).toBe(true);
  });

  it("failed run(status:failed)→ 归一化收敛为 error 帧,tree.state = error,携 error_message", () => {
    const failed = {
      ...doneRun,
      status: "failed",
      assistant_message: null,
      artifacts: [],
      error_code: "model_not_configured",
      error_message: "model endpoint and API key are required before running Anna Chat",
    };
    const { tree, frames } = replay(failed);
    expect(tree.state).toBe("error");
    expect(tree.error?.message).toContain("model endpoint and API key");
    expect(frames.filter((f) => f.type === "error")).toHaveLength(1);
    expect(frames.filter((f) => f.type === "done")).toHaveLength(0);
  });

  it("普通审计事件 → 系统步(kind system,无 l3、不可掀)", () => {
    const { tree } = replay(doneRun);
    const allSteps = tree.turns.flatMap((t) => t.steps);
    const systemSteps = allSteps.filter((s) => s.kind === "system");
    expect(systemSteps.length).toBeGreaterThan(0);
    // 系统步永不可掀:无 l3
    expect(systemSteps.every((s) => s.l3 === undefined)).toBe(true);
  });

  it("audit_events 缺失 → 只合成终帧,不抛错", () => {
    const bare = { id: "r", status: "ready", plan: [], artifacts: [] };
    const { tree } = replay(bare);
    expect(tree.state).toBe("done");
    expect(tree.run?.runId).toBe("r");
  });

  it("重放帧顺序:审计帧在前,终帧在末", () => {
    const raws = rawFramesFromRun(doneRun);
    expect(raws[raws.length - 1]).toMatchObject({ type: "done" });
    expect(raws.slice(0, -1).every((r) => r.type === "event")).toBe(true);
  });
});
