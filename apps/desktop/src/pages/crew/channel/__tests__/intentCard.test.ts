/**
 * intentCard · R4b Anna 监察确认卡纯函数测试
 * 覆盖:origin anna_coordination/intent vs manual 判别 · 被派者 id 读取 · 经花名册的 agent 判定 · 溯源字段。
 */
import { describe, expect, it } from "vitest";

import type { TeamMember } from "../../../../lib/api/crew";
import {
  intentAssigneeIsAgent,
  intentOriginMessageId,
  intentSourceText,
  intentSuggestedAssignee,
  isIntentCommand,
} from "../intentCard";

const members: TeamMember[] = [
  { id: "acc_andy", workspace_id: "w", email: "", display_name: "Andy", role: "工程", kind: "human" },
  { id: "acc_check", workspace_id: "w", email: "", display_name: "Agent·Check", role: "验收", kind: "agent" },
];

const intentMsg = {
  payload: {
    drafts: [{ title: "全功能回归测试", role: "验收", depends_on: ["实施"], acceptance: "覆盖九屏主流程" }],
    origin: "intent",
    origin_message_id: "say_1",
    created_from_message_id: "say_1",
    suggested_assignee: "acc_andy",
    text: "帮我把九屏都回归测一遍",
  },
};

describe("isIntentCommand(origin 判别)", () => {
  it("origin==anna_coordination → true", () => {
    expect(isIntentCommand({
      payload: { ...intentMsg.payload, origin: "anna_coordination" },
    })).toBe(true);
  });
  it("旧 origin==intent → true(兼容历史数据)", () => {
    expect(isIntentCommand(intentMsg)).toBe(true);
  });
  it("manual +任务(无 origin)→ false", () => {
    expect(isIntentCommand({ payload: { drafts: [], text: "x" } })).toBe(false);
    expect(isIntentCommand({ payload: null })).toBe(false);
    expect(isIntentCommand({})).toBe(false);
  });
  it("origin 为其他值 → false", () => {
    expect(isIntentCommand({ payload: { origin: "manual" } })).toBe(false);
  });
});

describe("被派者读取 + 溯源", () => {
  it("suggested_assignee / origin_message_id / text", () => {
    expect(intentSuggestedAssignee(intentMsg)).toBe("acc_andy");
    expect(intentOriginMessageId(intentMsg)).toBe("say_1");
    expect(intentSourceText(intentMsg)).toBe("帮我把九屏都回归测一遍");
  });
  it("缺字段 → null", () => {
    expect(intentSuggestedAssignee({ payload: {} })).toBeNull();
    expect(intentSuggestedAssignee({ payload: { suggested_assignee: "" } })).toBeNull();
    expect(intentOriginMessageId({ payload: null })).toBeNull();
    expect(intentSourceText({ payload: {} })).toBeNull();
  });
});

describe("intentAssigneeIsAgent(经花名册解析)", () => {
  it("被派者是 agent → true(采纳并开跑)", () => {
    const m = { payload: { ...intentMsg.payload, suggested_assignee: "acc_check" } };
    expect(intentAssigneeIsAgent(m, members)).toBe(true);
  });
  it("被派者是人 → false(采纳上图)", () => {
    expect(intentAssigneeIsAgent(intentMsg, members)).toBe(false);
  });
  it("无被派者 / 非成员 → false", () => {
    expect(intentAssigneeIsAgent({ payload: {} }, members)).toBe(false);
    expect(intentAssigneeIsAgent({ payload: { suggested_assignee: "ghost" } }, members)).toBe(false);
  });
});
