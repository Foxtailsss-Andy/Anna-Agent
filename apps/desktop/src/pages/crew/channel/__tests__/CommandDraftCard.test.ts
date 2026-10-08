/**
 * CommandDraftCard · 「＋任务」草案卡静态渲染:CONTRACTS §2 让草案带 insert_before
 * (「放在 X 之前」→ 确认后改既有任务依赖),卡片必须让确认人看见这项排序变更。
 * 旧草案(无 insert_before)明细行保持原样。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChannelMessage } from "../../../../lib/api/crew";
import { CommandDraftCard } from "../CommandDraftCard";

const strip = (html: string) => html.replace(/<!--.*?-->/g, "");

function command(drafts: unknown[]): ChannelMessage {
  return {
    id: "cmd_1",
    project_id: "p1",
    workspace_id: "w",
    seq: 2,
    author_kind: "member",
    author_member_id: "owner-1",
    kind: "command",
    body: "+任务",
    task_id: null,
    run_ref: null,
    mentions: [],
    audit_ref: "",
    created_at: "2026-10-08T02:00:00Z",
    payload: { drafts, text: "先做竞品调研，放在文案撰写之前" },
  };
}

const render = (message: ChannelMessage) =>
  strip(renderToStaticMarkup(createElement(CommandDraftCard, {
    author: { kind: "human", name: "Boss", initial: "B" },
    time: "10:00",
    message,
    tasks: [],
    projectId: "p1",
    isOwner: true,
    onRefresh: () => undefined,
  })));

describe("CommandDraftCard · draft ordering", () => {
  it("shows insert_before as 放在“X”之前 in the draft detail line", () => {
    const html = render(command([
      { title: "竞品调研", role: "设计", depends_on: ["营销 Brief"], insert_before: ["文案撰写", "海报"], acceptance: "列出 3 个竞品" },
    ]));
    expect(html).toContain("建议：设计 · 依赖：“营销 Brief” · 放在“文案撰写”、“海报”之前 · 验收：列出 3 个竞品");
  });

  it("legacy drafts without insert_before keep the original detail line", () => {
    const html = render(command([{ title: "竞品调研", role: "设计", depends_on: [], acceptance: "" }]));
    expect(html).toContain('<span class="ir-chan-draft__detail">建议：设计</span>');
  });
});
