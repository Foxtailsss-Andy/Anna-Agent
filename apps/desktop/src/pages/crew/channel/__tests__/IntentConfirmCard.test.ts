/**
 * IntentConfirmCard · Coordination Proposal 卡(CONTRACTS §2 crew.propose_changes payload)
 * + 旧意图卡回归(静态渲染,真组件真数据,沿 TraceWaterfall.test.ts 的 renderToStaticMarkup 范式)。
 *
 * 旧卡回归的期望值 = 基线提交 4697d5c 的真组件对同一 payload 的渲染输出(fixtures/legacy-intent-*.html,
 * 改动前捕获),用以证明「无 assignments / insert_before 的旧 payload 渲染与今天逐字一致」。
 * 点击采纳是 DOM 事件,由 tests/frontend/crew_ui.test.mjs 在真浏览器里覆盖。
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChannelMessage, TeamMember } from "../../../../lib/api/crew";
import type { CrewTask } from "../../crewModel";
import { IntentConfirmCard } from "../IntentConfirmCard";

const strip = (html: string) => html.replace(/<!--.*?-->/g, "");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const members: TeamMember[] = [
  { id: "acc_andy", workspace_id: "w", email: "", display_name: "Andy", role: "工程", kind: "human" },
  { id: "acc_check", workspace_id: "w", email: "", display_name: "Agent·Check", role: "验收", kind: "agent" },
];

const tasks: CrewTask[] = [
  { id: "task_brief", project_id: "p1", key: "brief", title: "营销 Brief", status: "done", role_required: "策划" },
  { id: "task_2_copy", project_id: "p1", key: "copy", title: "文案撰写", status: "todo", role_required: "文案" },
];

const base: Omit<ChannelMessage, "id" | "payload"> = {
  project_id: "p1",
  workspace_id: "w",
  seq: 3,
  author_kind: "anna",
  author_member_id: null,
  kind: "command",
  body: "Anna 起草",
  task_id: null,
  run_ref: null,
  mentions: [],
  audit_ref: "",
  created_at: "2026-10-08T02:00:00Z",
};
const author = { kind: "anna" as const, name: "Anna", initial: "A" };

function render(message: ChannelMessage, opts: { isOwner?: boolean; taskList?: CrewTask[]; confirmedInChannel?: boolean } = {}) {
  return strip(renderToStaticMarkup(createElement(IntentConfirmCard, {
    confirmedInChannel: opts.confirmedInChannel ?? false,
    author,
    time: "10:00",
    message,
    members,
    tasks: opts.taskList ?? tasks,
    projectId: "p1",
    isOwner: opts.isOwner ?? true,
    originAuthorName: "Boss",
    onRefresh: () => undefined,
  })));
}

const proposal: ChannelMessage = {
  ...base,
  id: "cmd_prop",
  body: "Anna 提议：先做竞品调研再写文案",
  payload: {
    drafts: [
      {
        title: "竞品调研",
        role: "设计",
        depends_on: ["营销 Brief"],
        insert_before: ["文案撰写"],
        acceptance: "列出 3 个竞品",
        assignee_id: "acc_andy",
      },
      { title: "竞品对比表", role: "策划", depends_on: ["竞品调研"], insert_before: [], acceptance: "", assignee_id: "acc_ghost" },
    ],
    assignments: [{ task_id: "task_2_copy", member_id: "acc_check", reason: "文案需要验收视角" }],
    origin: "anna_coordination",
    source: { type: "workbench_run", run_id: "run_1", tool_call_id: "call_1" },
    text: "先做竞品调研再写文案",
    suggested_assignee: null,
  },
};

describe("IntentConfirmCard · Coordination Proposal", () => {
  it("renders every draft with role, depends_on, insert_before and assignee name/id", () => {
    const html = render(proposal);
    expect(html).toContain("竞品调研");
    expect(html).toContain("竞品对比表");
    expect(html).toContain("角色：设计");
    expect(html).toContain("依赖：“营销 Brief”");
    expect(html).toContain("放在“文案撰写”之前");
    expect(html).toContain("负责人：Andy");
    // 花名册里没有的 id 原样显示,不臆造名字
    expect(html).toContain("负责人：acc_ghost");
    expect(html).toContain("依赖：“竞品调研”");
  });

  it("lists assignments as task title → member name with the reason", () => {
    const html = render(proposal);
    expect(html).toContain("指派");
    expect(html).toContain("文案撰写 → Agent·Check");
    expect(html).toContain("文案需要验收视角");
  });

  it("shows provenance for proposals coming from an Anna conversation run", () => {
    const html = render(proposal);
    expect(html).toContain("来自 Anna 对话");
    expect(html).toContain("先做竞品调研再写文案");
  });

  it("adopt control counts drafts + assignments and is owner-only", () => {
    expect(render(proposal)).toContain("采纳 · 3 项");
    const notOwner = render(proposal, { isOwner: false });
    expect(notOwner).toMatch(/<button[^>]*disabled=""[^>]*>采纳 · 3 项<\/button>/);
    expect(notOwner).toContain("只有项目负责人可以采纳");
  });

  it("assignment-only proposal renders without a drafts section", () => {
    const html = render({
      ...proposal,
      id: "cmd_assign_only",
      payload: { ...proposal.payload, drafts: [], source: { type: "workbench_run", run_id: "r", tool_call_id: "c" } },
    });
    expect(html).toContain("文案撰写 → Agent·Check");
    expect(html).not.toContain("新任务");
    expect(html).toContain("采纳 · 1 项");
  });

  it("assignment-only proposal stays confirmed after a remount when the channel holds its confirmation row", () => {
    const message = {
      ...proposal,
      id: "cmd_assign_only_done",
      payload: { ...proposal.payload, drafts: [], source: { type: "workbench_run", run_id: "r", tool_call_id: "c" } },
    };
    const fresh = render(message);
    const afterConfirm = render(message, { confirmedInChannel: true });
    expect(fresh).toContain("采纳 · 1 项");
    expect(afterConfirm).not.toContain("采纳 · 1 项");
    expect(afterConfirm).toContain("已确认");
  });

  it("unknown task id in an assignment falls back to the id", () => {
    const html = render({
      ...proposal,
      id: "cmd_unknown_task",
      payload: { ...proposal.payload, assignments: [{ task_id: "task_gone", member_id: "acc_andy", reason: "" }] },
    });
    expect(html).toContain("task_gone → Andy");
  });

  it("proposal without workbench_run source shows no Anna-conversation provenance", () => {
    const html = render({
      ...proposal,
      id: "cmd_from_say",
      payload: { ...proposal.payload, source: undefined, origin_message_id: "say_1" },
    });
    expect(html).not.toContain("来自 Anna 对话");
    expect(html).toContain("文案撰写 → Agent·Check");
  });

  it("@Anna intent card that gained insert_before keeps showing the speech-mentioned assignee", () => {
    const html = render({
      ...base,
      id: "cmd_intent_order",
      payload: {
        drafts: [{ title: "竞品调研", role: "设计", depends_on: [], insert_before: ["文案撰写"], acceptance: "", assignee_id: null }],
        origin: "anna_coordination",
        origin_message_id: "say_9",
        suggested_assignee: "acc_andy",
        text: "@Andy 先做竞品调研，放在文案之前",
      },
    });
    expect(html).toContain("放在“文案撰写”之前");
    expect(html).toContain("发言中 @ 指定：Andy（首个采纳的新任务）");
    expect(html).not.toContain("来自 Anna 对话");
  });
});

describe("IntentConfirmCard · legacy payloads render exactly as before", () => {
  const legacyBase = { ...base };

  it("human assignee, two drafts, origin=intent", () => {
    const message: ChannelMessage = {
      ...legacyBase,
      id: "cmd_1",
      payload: {
        drafts: [
          { title: "全功能回归测试", role: "验收", depends_on: ["实施"], acceptance: "覆盖九屏主流程" },
          { title: "补充说明", role: "工程", depends_on: [], acceptance: "" },
        ],
        origin: "intent",
        origin_message_id: "say_1",
        created_from_message_id: "say_1",
        suggested_assignee: "acc_andy",
        text: "帮我把九屏都回归测一遍",
      },
    };
    expect(render(message, { taskList: [] })).toBe(fixture("legacy-intent-human.html"));
  });

  it("agent assignee, non-owner, origin=anna_coordination", () => {
    const message: ChannelMessage = {
      ...legacyBase,
      id: "cmd_2",
      payload: {
        drafts: [{ title: "验收清单", role: "验收", depends_on: [], acceptance: "" }],
        origin: "anna_coordination",
        origin_message_id: "say_2",
        suggested_assignee: "acc_check",
        text: "x",
      },
    };
    expect(render(message, { isOwner: false, taskList: [] })).toBe(fixture("legacy-intent-agent.html"));
  });
});
