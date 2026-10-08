/**
 * WorkbenchChatPanel · 静态渲染测试(react-dom/server,真组件,沿 TraceWaterfall.test.ts 范式)。
 *
 * 覆盖 F2 验收:历史只渲染一次且有序 · 乐观 prompt 仅在投影缺该 Run 用户消息时出现 ·
 * live_output 作为进行中的助手气泡(含 Markdown)并在持久化/终态后让位 · 思考中 ·
 * 计划(n/m 完成)与工具活动 · 沙箱徽标与权限 chip · Goal 卡(全部 7 个状态的中文标签与可用动作)·
 * 目标续跑标注 · 执行过程入口。
 * 点击/轮询等交互由 tests/frontend/home_workbench_ui.test.mjs 在真浏览器里验证。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkbenchGoal, WorkbenchGoalStatus, WorkbenchMessage, WorkbenchRun, WorkbenchSession } from "../../../lib/api/workbench";
import { WorkbenchChatPanel } from "../WorkbenchChatPanel";

const strip = (html: string) => html.replace(/<!--.*?-->/g, "");
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

function message(runId: string, role: "user" | "assistant", content: string, seq: number): WorkbenchMessage {
  return { run_id: runId, event_id: `${runId}:${role}:${seq}`, seq, role, content };
}

function sessionWith(messages: WorkbenchMessage[], runs: WorkbenchRun[] = [], goal?: WorkbenchGoal): WorkbenchSession {
  return { session_id: "session-12345678", surface: "chat", messages, runs, ...(goal === undefined ? {} : { goal }) };
}

function render(props: {
  session: WorkbenchSession | null;
  run?: WorkbenchRun | null;
  prompt?: string;
  status?: string;
  runId?: string | null;
  onGoalAction?: () => void;
}) {
  return strip(renderToStaticMarkup(createElement(WorkbenchChatPanel, {
    session: props.session,
    run: props.run ?? null,
    prompt: props.prompt ?? "",
    status: props.status ?? props.run?.status ?? "not_started",
    runId: props.runId === undefined ? props.run?.run_id ?? null : props.runId,
    error: null,
    capabilities: [],
    events: [],
    onStop: () => {},
    composer: null,
    ...(props.onGoalAction === undefined ? {} : { onGoalAction: props.onGoalAction }),
  })));
}

const userBubbles = (html: string) => count(html, /ir-workbench-chat__message--user/g);

describe("WorkbenchChatPanel · 历史", () => {
  it("renders every prompt once and in session order even when the latest prompt is still the optimistic prompt", () => {
    const run2: WorkbenchRun = { run_id: "run-2", status: "running", permission_mode: "readonly" };
    const html = render({
      session: sessionWith([
        message("run-1", "user", "第一个问题", -1),
        message("run-1", "assistant", "第一个回答", 4),
        message("run-2", "user", "第二个问题", -1),
      ], [{ run_id: "run-1", status: "completed" }, run2]),
      run: run2,
      prompt: "第二个问题",
    });

    expect(userBubbles(html)).toBe(2);
    expect(html).not.toContain("ir-workbench-chat__message--optimistic");
    // Everything below the run head (whose title may echo the prompt) is the conversation column.
    const column = html.slice(html.indexOf("ir-home__scroll"));
    expect(count(column, /第二个问题/g)).toBe(1);
    expect(column.indexOf("第一个问题")).toBeLessThan(column.indexOf("第一个回答"));
    expect(column.indexOf("第一个回答")).toBeLessThan(column.indexOf("第二个问题"));
  });

  it("shows the optimistic prompt after the history only until the projection has that Run's user message", () => {
    const html = render({
      session: sessionWith([message("run-1", "user", "旧问题", -1), message("run-1", "assistant", "旧回答", 3)]),
      prompt: "刚发出的新问题",
      runId: null,
      status: "queued",
    });

    expect(userBubbles(html)).toBe(2);
    expect(html).toContain("ir-workbench-chat__message--optimistic");
    expect(html.indexOf("旧回答")).toBeLessThan(html.indexOf("刚发出的新问题"));
  });

  it("renders assistant messages as Markdown bubbles", () => {
    const html = render({
      session: sessionWith([message("run-1", "user", "问", -1), message("run-1", "assistant", "结论是 **可行**", 2)]),
      run: { run_id: "run-1", status: "completed" },
    });
    expect(html).toMatch(/ir-workbench-chat__message--assistant[^"]*"><div class="crew-md/);
    expect(html).toContain("<strong>可行</strong>");
  });

  it("labels a goal continuation Run as Host-initiated instead of a user bubble", () => {
    const continuation: WorkbenchRun = { run_id: "run-2", status: "running", trigger: "goal_continuation", goal_id: "goal-1" };
    const html = render({
      session: sessionWith([
        message("run-1", "user", "写完调研报告", -1),
        message("run-1", "assistant", "第一轮完成了大纲", 5),
        message("run-2", "user", "【目标续跑 2/4】请继续完成计划中未完成的任务", -1),
      ], [{ run_id: "run-1", status: "completed", trigger: "user", goal_id: "goal-1" }, continuation]),
      run: continuation,
    });

    expect(html).toContain("目标续跑 · Host 自动");
    expect(userBubbles(html)).toBe(1);
  });
});

describe("WorkbenchChatPanel · 流式输出", () => {
  it("renders live output of the running Run as an in-progress Markdown assistant bubble", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      live_output: { text: "正在写的 **答案**", reasoning_chars: 0, request_index: 1, updated_at: "2026-10-08T00:00:01.000Z" },
    };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });

    expect(html).toContain("ir-workbench-chat__message--live");
    expect(html).toContain("<strong>答案</strong>");
    expect(html).toContain("正在生成");
  });

  it("drops the live bubble once the Run's persisted assistant message carries the streamed text", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      live_output: { text: "完整的答案", reasoning_chars: 0, request_index: 1, updated_at: "2026-10-08T00:00:02.000Z" },
    };
    const html = render({
      session: sessionWith([message("run-1", "user", "问", -1), message("run-1", "assistant", "完整的答案", 7)], [run]),
      run,
    });

    expect(html).not.toContain("ir-workbench-chat__message--live");
    expect(count(html, /完整的答案/g)).toBe(1);
  });

  it("keeps streaming a later model request after an earlier assistant message was persisted", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      live_output: { text: "第二次请求的新文本", reasoning_chars: 0, request_index: 2, updated_at: "2026-10-08T00:00:03.000Z" },
    };
    const html = render({
      session: sessionWith([message("run-1", "user", "问", -1), message("run-1", "assistant", "先读一下文件", 4)], [run]),
      run,
    });
    expect(html).toContain("ir-workbench-chat__message--live");
    expect(html).toContain("第二次请求的新文本");
  });

  it("never renders live output for a terminal Run", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "cancelled",
      live_output: { text: "被停止前的半句", reasoning_chars: 0, request_index: 1, updated_at: "2026-10-08T00:00:04.000Z" },
    };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });
    expect(html).not.toContain("被停止前的半句");
    expect(html).toContain("已停止");
  });

  it("says 思考中…… while only reasoning is streaming", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      live_output: { text: "", reasoning_chars: 240, request_index: 1, updated_at: "2026-10-08T00:00:05.000Z" },
    };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });
    expect(html).toContain("思考中……");
    expect(html).not.toContain("ir-workbench-chat__message--live");
  });
});

describe("WorkbenchChatPanel · 过程", () => {
  it("shows the plan phases and tasks with status and an n/m 完成 count", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      plan: {
        updated_seq: 9,
        phases: [
          { name: "调研", tasks: [{ content: "收集竞品", status: "completed" }, { content: "整理表格", status: "in_progress" }] },
          { name: "交付", tasks: [{ content: "写报告", status: "blocked", blocker: "缺少销售数据" }] },
        ],
      },
    };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });

    expect(html).toContain("1/3 完成");
    for (const text of ["调研", "交付", "收集竞品", "整理表格", "写报告", "缺少销售数据"]) expect(html).toContain(text);
    expect(html).toContain("ir-workbench-chat__task--completed");
    expect(html).toContain("ir-workbench-chat__task--in_progress");
    expect(html).toContain("ir-workbench-chat__task--blocked");
  });

  it("lists tool activity with status, Host summary and a duration only when both timestamps exist", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      tools: [
        { call_id: "c1", name: "workdir.write_file", status: "succeeded", started_at: "2026-10-08T00:00:00.000Z", ended_at: "2026-10-08T00:00:01.500Z", summary: "wrote notes.md (2.1 KB)" },
        { call_id: "c2", name: "sandbox.exec", status: "running", started_at: "2026-10-08T00:00:02.000Z" },
      ],
    };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });

    expect(html).toContain("workdir.write_file");
    expect(html).toContain("wrote notes.md (2.1 KB)");
    expect(html).toContain("1.5s");
    expect(html).toContain("sandbox.exec");
    expect(html).toContain("运行中");
    expect(count(html, /ir-workbench-chat__tool-ms/g)).toBe(1);
  });

  it("shows no process section when the Run has neither plan nor tools", () => {
    const run: WorkbenchRun = { run_id: "run-1", status: "running" };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });
    expect(html).not.toContain("ir-workbench-chat__process");
  });

  it("shows the sandbox badge and the contained-write permission chip from the projection", () => {
    const run: WorkbenchRun = {
      run_id: "run-1",
      status: "running",
      permission_mode: "contained-write",
      sandbox: { kind: "macos-seatbelt", network: "denied", writable_roots: ["/tmp/wd"] },
    };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });
    expect(html).toContain("沙箱 · macOS seatbelt · 无网络 · 仅工作目录可写");
    expect(html).toContain("可修改工作目录");
  });

  it("shows the readonly permission chip and no sandbox badge for a readonly Run", () => {
    const run: WorkbenchRun = { run_id: "run-1", status: "completed", permission_mode: "readonly" };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });
    expect(html).toContain("只读");
    expect(html).not.toContain("沙箱 ·");
  });

  it("offers the 执行过程 trace entry for the current Run", () => {
    const run: WorkbenchRun = { run_id: "run-1", status: "completed" };
    const html = render({ session: sessionWith([message("run-1", "user", "问", -1)], [run]), run });
    expect(html).toMatch(/<button[^>]*>执行过程<\/button>/);
  });
});

describe("WorkbenchChatPanel · Goal 卡", () => {
  const goal = (status: WorkbenchGoalStatus, extra: Partial<WorkbenchGoal> = {}): WorkbenchGoal => ({
    goal_id: "goal-1",
    objective: "写完竞品调研报告",
    status,
    max_runs: 4,
    runs_used: 2,
    run_ids: ["run-1", "run-2"],
    permission_mode: "readonly",
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:01:00.000Z",
    ...extra,
  });
  const actions = (html: string) =>
    [...html.matchAll(/<button[^>]*class="ir-workbench-chat__goal-action[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
  const cardFor = (status: WorkbenchGoalStatus, extra: Partial<WorkbenchGoal> = {}) => {
    const run: WorkbenchRun = { run_id: "run-2", status: status === "active" ? "running" : "completed", goal_id: "goal-1" };
    return render({
      session: sessionWith([message("run-2", "user", "写完竞品调研报告", -1)], [run], goal(status, extra)),
      run,
      onGoalAction: () => {},
    });
  };

  it.each([
    ["active", "进行中", ["暂停", "停止"]],
    ["paused", "已暂停", ["继续", "停止"]],
    ["awaiting_review", "待你确认", ["确认完成"]],
    ["completed", "已完成", []],
    ["stopped", "已停止", []],
    ["budget_exhausted", "轮数已用完", ["继续"]],
    ["failed", "未能完成", ["继续"]],
  ] as Array<[WorkbenchGoalStatus, string, string[]]>)("%s → %s with actions %j", (status, label, expected) => {
    const html = cardFor(status);
    expect(html).toContain(`ir-workbench-chat__goal--${status}`);
    expect(html).toContain(label);
    expect(actions(html)).toEqual(expected);
  });

  it("shows objective, runs_used/max_runs, plan progress and a readable last reason", () => {
    const html = cardFor("active", { plan_progress: { completed: 3, total: 5 }, last_reason: "plan_incomplete" });
    expect(html).toContain("写完竞品调研报告");
    expect(html).toContain("第 2/4 轮");
    expect(html).toContain("计划 3/5");
    expect(html).toContain("计划未完成，继续下一轮");
  });

  it("keeps an unmapped failure code visible instead of hiding it", () => {
    const html = cardFor("failed", { last_reason: "run_failed:tool_denied" });
    expect(html).toContain("tool_denied");
  });

  it("omits plan progress when the Host did not report it", () => {
    const html = cardFor("active");
    expect(html).not.toContain("计划 ");
  });
});
