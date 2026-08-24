/**
 * channelModel · 频道纯函数(F3;零捏造 —— 一切分派/聚合来自后端真消息)
 *
 * 覆盖:消息→五族分派 / 勾选聚合(n 项·0 禁用)/ @mentions→pill 片段切分
 *      / say·command·confirm 提交 payload 组装 / 命令已确认(任务血缘回链)。
 */
import { describe, expect, it } from "vitest";

import {
  allIndexes,
  buildCommandPayload,
  buildConfirmPayload,
  buildSayPayload,
  canConfirm,
  commandDrafts,
  commandSourceText,
  isCommandConfirmed,
  messageFamily,
  selectedCount,
  splitMentions,
  tasksFromCommand,
} from "../channelModel";

describe("messageFamily(五族分派;未知诚实降级为 event)", () => {
  it("五种 kind 各归其族", () => {
    for (const k of ["event", "artifact", "review", "say", "command"] as const) {
      expect(messageFamily({ kind: k })).toBe(k);
    }
  });
  it("未知 kind → event(不丢消息、不造卡)", () => {
    expect(messageFamily({ kind: "mystery" })).toBe("event");
    expect(messageFamily({ kind: "" })).toBe("event");
  });
});

describe("勾选聚合(n 项 / 0 禁用)", () => {
  it("selectedCount = 选中且在界内的数量", () => {
    expect(selectedCount(new Set([0, 1, 2]), 3)).toBe(3);
    expect(selectedCount(new Set([0, 2]), 3)).toBe(2);
    expect(selectedCount(new Set<number>(), 3)).toBe(0);
  });
  it("越界索引不计(防脏数据)", () => {
    expect(selectedCount(new Set([0, 5, -1]), 3)).toBe(1);
  });
  it("canConfirm:>0 可下推,0 禁用", () => {
    expect(canConfirm(new Set([0]), 2)).toBe(true);
    expect(canConfirm(new Set<number>(), 2)).toBe(false);
    expect(canConfirm(new Set([9]), 2)).toBe(false); // 全越界 = 0
  });
  it("allIndexes = 默认全勾", () => {
    expect(allIndexes(3)).toEqual(new Set([0, 1, 2]));
    expect(allIndexes(0)).toEqual(new Set());
  });
});

describe("splitMentions(@提及 → pill 片段;以 mentions 元数据为准)", () => {
  it("切出 @名 片段,余为纯文本", () => {
    const segs = splitMentions("『实施』已派给 @Andy。", [{ name: "Andy", isAgent: false }]);
    expect(segs).toEqual([
      { type: "text", text: "『实施』已派给 " },
      { type: "mention", name: "Andy", isAgent: false },
      { type: "text", text: "。" },
    ]);
  });
  it("最长名优先:@Agent·Design 不被 @Agent 误切", () => {
    const segs = splitMentions("请 @Agent·Design 开始。", [
      { name: "Agent", isAgent: false },
      { name: "Agent·Design", isAgent: true },
    ]);
    expect(segs).toContainEqual({ type: "mention", name: "Agent·Design", isAgent: true });
    // 不应出现被截断的 @Agent 片段
    expect(segs.some((s) => s.type === "mention" && s.name === "Agent")).toBe(false);
  });
  it("未在 mentions 列表的 @xxx 不高亮(不做自由文本解析)", () => {
    const segs = splitMentions("@Ghost 你好", [{ name: "Andy", isAgent: false }]);
    expect(segs).toEqual([{ type: "text", text: "@Ghost 你好" }]);
  });
  it("多次提及同一名:全部成 pill", () => {
    const segs = splitMentions("@Boss 与 @Boss", [{ name: "Boss", isAgent: false }]);
    expect(segs.filter((s) => s.type === "mention")).toHaveLength(2);
  });
  it("agent 提及标记 isAgent(供 delegate 色系)", () => {
    const segs = splitMentions("@Agent·Scribe 交付", [{ name: "Agent·Scribe", isAgent: true }]);
    expect(segs[0]).toEqual({ type: "mention", name: "Agent·Scribe", isAgent: true });
  });
  it("@Anna 提及标记为 coordinator,不是普通 unknown id", () => {
    const segs = splitMentions("@Anna 请协调一下", [
      { name: "Anna", isAgent: false, isCoordinator: true },
    ]);
    expect(segs[0]).toEqual({
      type: "mention",
      name: "Anna",
      isAgent: false,
      isCoordinator: true,
    });
  });
  it("空 body / 无 mentions 稳健", () => {
    expect(splitMentions("", [])).toEqual([]);
    expect(splitMentions("纯文本", [])).toEqual([{ type: "text", text: "纯文本" }]);
  });
});

describe("buildSayPayload(say 提交;@名被删则不再算提及)", () => {
  it("正文含 @名 → 保留该提及", () => {
    const p = buildSayPayload("交给 @Andy 处理", [{ id: "acc_andy", name: "Andy" }]);
    expect(p).toEqual({ body: "交给 @Andy 处理", mentions: ["acc_andy"] });
  });
  it("正文已无 @名 → 丢弃该提及(不虚报)", () => {
    const p = buildSayPayload("算了自己来", [{ id: "acc_andy", name: "Andy" }]);
    expect(p).toEqual({ body: "算了自己来", mentions: [] });
  });
  it("同一成员重复插入 → 去重", () => {
    const p = buildSayPayload("@Andy @Andy", [
      { id: "acc_andy", name: "Andy" },
      { id: "acc_andy", name: "Andy" },
    ]);
    expect(p.mentions).toEqual(["acc_andy"]);
  });
  it("手打全名不经拾取器 → 花名册精确匹配也算真提及(R4a 修)", () => {
    const roster = [
      { id: "acc_andy", display_name: "Andy" },
      { id: "acc_agent_design", display_name: "Agent·Design" },
    ];
    const p = buildSayPayload("@Andy 新任务:全功能回归测试", [], roster);
    expect(p.mentions).toEqual(["acc_andy"]);
  });
  it("长名优先:@Agent·Design 不被短前缀误吞,无匹配名仍是死文本", () => {
    const roster = [
      { id: "acc_agent", display_name: "Agent" },
      { id: "acc_agent_design", display_name: "Agent·Design" },
    ];
    const p = buildSayPayload("@Agent·Design 请重跑;@张三 你也看看", [], roster);
    expect(p.mentions).toEqual(["acc_agent_design"]);
  });
  it("拾取器插入与花名册匹配同人 → 仍去重", () => {
    const roster = [{ id: "acc_andy", display_name: "Andy" }];
    const p = buildSayPayload("@Andy 在吗", [{ id: "acc_andy", name: "Andy" }], roster);
    expect(p.mentions).toEqual(["acc_andy"]);
  });
  it("@Anna 精确匹配系统协调者 id", () => {
    const p = buildSayPayload("@Anna 请协调九屏回归", [], [
      { id: "anna", display_name: "Anna" },
      { id: "acc_agent", display_name: "Agent·Check" },
    ]);
    expect(p).toEqual({ body: "@Anna 请协调九屏回归", mentions: ["anna"] });
  });
});

describe("buildCommandPayload(+任务 提交)", () => {
  it("仅 text", () => {
    expect(buildCommandPayload("加个性能验收")).toEqual({ text: "加个性能验收" });
  });
  it("带来源消息 id", () => {
    expect(buildCommandPayload("加个性能验收", "msg_9")).toEqual({
      text: "加个性能验收",
      source_message_id: "msg_9",
    });
  });
  it("空来源 id 不塞字段", () => {
    expect(buildCommandPayload("x", null)).toEqual({ text: "x" });
  });
});

describe("buildConfirmPayload(确认下推;服务端按 index 解析)", () => {
  it("按选中集合升序输出 draft_indexes", () => {
    expect(buildConfirmPayload("cmd_1", new Set([2, 0]), 3)).toEqual({
      message_id: "cmd_1",
      draft_indexes: [0, 2],
    });
  });
  it("全勾 → 全部索引", () => {
    expect(buildConfirmPayload("cmd_1", new Set([0, 1]), 2)).toEqual({
      message_id: "cmd_1",
      draft_indexes: [0, 1],
    });
  });
});

describe("commandDrafts / commandSourceText(读命令行结构化 payload)", () => {
  const msg = {
    payload: {
      drafts: [
        { title: "性能验收:50 节点", role: "验收", depends_on: ["实施"], acceptance: "60fps" },
        { title: "无效", role: "工程" },
      ],
      text: "画布 50 节点内不掉帧",
      created_from_message_id: "msg_5",
    },
  };
  it("读出草案数组(缺字段补默认)", () => {
    const drafts = commandDrafts(msg);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toEqual({
      title: "性能验收:50 节点",
      role: "验收",
      depends_on: ["实施"],
      acceptance: "60fps",
    });
    expect(drafts[1]).toEqual({ title: "无效", role: "工程", depends_on: [], acceptance: "" });
  });
  it("无 payload / 非数组 → 空", () => {
    expect(commandDrafts({ payload: null })).toEqual([]);
    expect(commandDrafts({})).toEqual([]);
    expect(commandDrafts({ payload: { drafts: "x" } })).toEqual([]);
  });
  it("commandSourceText 读原话(缺 → null)", () => {
    expect(commandSourceText(msg)).toBe("画布 50 节点内不掉帧");
    expect(commandSourceText({ payload: null })).toBeNull();
  });
});

describe("isCommandConfirmed / tasksFromCommand(任务血缘回链)", () => {
  const tasks = [
    { id: "t1", origin: "sop", created_from_message_id: null },
    { id: "t2", origin: "channel", created_from_message_id: "cmd_1" },
    { id: "t3", origin: "channel", created_from_message_id: "cmd_1" },
    { id: "t4", origin: "channel", created_from_message_id: "cmd_9" },
  ];
  it("存在血缘回链 → 已确认", () => {
    expect(isCommandConfirmed("cmd_1", tasks)).toBe(true);
  });
  it("无血缘 → 未确认", () => {
    expect(isCommandConfirmed("cmd_2", tasks)).toBe(false);
  });
  it("tasksFromCommand 取新生任务 id(供确认后点名环)", () => {
    expect(tasksFromCommand("cmd_1", tasks)).toEqual(["t2", "t3"]);
    expect(tasksFromCommand("cmd_9", tasks)).toEqual(["t4"]);
    expect(tasksFromCommand("none", tasks)).toEqual([]);
  });
});
