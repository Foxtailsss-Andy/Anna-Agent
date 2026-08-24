/**
 * 通知铃纯逻辑(F5)· 弹卡→收铃归位 reducer(6s/≤3/新在上)· 分组 · 深链 · 徽标
 * 零捏造:一切来自真通知;登录时刻弹卡,会话中跨段仅摆动。
 */
import { describe, expect, it } from "vitest";

import type { CrewNotification } from "../../../lib/api/crew";
import {
  bellBadge,
  bellReducer,
  buildPanel,
  groupNotifications,
  initialBellState,
  kindMeta,
  PANEL_CAP,
  relTime,
  resolveDeepLink,
  shouldSwing,
} from "../bellModel";

/** 造一条通知(真契约形状;测试内自足) */
function note(over: Partial<CrewNotification> & { id: string }): CrewNotification {
  return {
    workspace_id: "ws_1",
    to_member_id: "acc_boss",
    kind: "assigned",
    title: "标题",
    deep_link: "/crew",
    project_id: "p1",
    task_id: "t1",
    read_at: null,
    idempotency_key: over.id,
    created_at: "2026-07-17T10:00:00Z",
    ...over,
  };
}

describe("bellReducer · 登录弹卡堆叠(≤3,新在上)", () => {
  it("登录时刻:未读 5 → 弹卡取最新 3 张,新在上(index0=最新)", () => {
    const notes = [1, 2, 3, 4, 5].map((n) =>
      note({ id: `n${n}`, created_at: `2026-07-17T10:0${n}:00Z` }),
    );
    const s = bellReducer(initialBellState, {
      type: "ingest",
      notifications: notes,
      now: 1000,
    });
    expect(s.phase).toBe("live");
    expect(s.popcards.map((c) => c.id)).toEqual(["n5", "n4", "n3"]);
    // 全部标记 seen —— 不再二次弹卡
    expect(s.seen).toEqual(expect.arrayContaining(["n1", "n2", "n3", "n4", "n5"]));
  });

  it("登录时刻未读为 0 → 无弹卡,phase 转 live", () => {
    const s = bellReducer(initialBellState, {
      type: "ingest",
      notifications: [note({ id: "r1", read_at: "2026-07-17T09:00:00Z" })],
      now: 1,
    });
    expect(s.popcards).toHaveLength(0);
    expect(s.phase).toBe("live");
  });

  it("collect:弹卡驻留到期 → 从堆叠移除(归位入铃)", () => {
    const notes = [1, 2, 3].map((n) => note({ id: `n${n}`, created_at: `2026-07-17T10:0${n}:00Z` }));
    let s = bellReducer(initialBellState, { type: "ingest", notifications: notes, now: 0 });
    expect(s.popcards).toHaveLength(3);
    s = bellReducer(s, { type: "collect", id: "n3" });
    expect(s.popcards.map((c) => c.id)).toEqual(["n2", "n1"]);
    s = bellReducer(s, { type: "collect", id: "n1" });
    expect(s.popcards.map((c) => c.id)).toEqual(["n2"]);
  });
});

describe("bellReducer · 会话中不弹卡(只记账,永不打断)", () => {
  // 首帧一条已读通知 → initial 转 live 且不产生弹卡,便于隔离验证 live 行为
  const seed = [note({ id: "a", read_at: "2026-07-17T09:00:00Z", created_at: "2026-07-17T10:00:00Z" })];

  it("live 期新未读 → 只入 seen,不铸弹卡(摆动交组件按未读增量驱动)", () => {
    let s = bellReducer(initialBellState, { type: "ingest", notifications: seed, now: 0 });
    expect(s.phase).toBe("live");
    expect(s.popcards).toHaveLength(0);
    const next = [...seed, note({ id: "b", created_at: "2026-07-17T11:00:00Z" })];
    s = bellReducer(s, { type: "ingest", notifications: next, now: 1 });
    expect(s.popcards).toHaveLength(0); // live 期永不弹卡
    expect(s.seen).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("无新未读 → 同一引用(幂等,不触发重渲染/计时器重置)", () => {
    const s0 = bellReducer(initialBellState, { type: "ingest", notifications: seed, now: 0 });
    const s1 = bellReducer(s0, { type: "ingest", notifications: seed, now: 5 });
    expect(s1).toBe(s0);
  });
});

describe("shouldSwing · 未读数增量 → 单次摆动", () => {
  it("增加 → true;持平/减少/置读归零 → false", () => {
    expect(shouldSwing(2, 3)).toBe(true); // 新通知到
    expect(shouldSwing(0, 1)).toBe(true);
    expect(shouldSwing(3, 3)).toBe(false); // 无变化
    expect(shouldSwing(3, 2)).toBe(false); // 读掉一条
    expect(shouldSwing(5, 0)).toBe(false); // 开面板批量置读:不摆
  });
});

describe("bellBadge · 徽标 = 尚在铃里的未读(弹卡不计,收进铃 +1)", () => {
  it("未读 5,弹卡 3 张显示中 → 徽标 2;收进铃后递增", () => {
    expect(bellBadge(5, 3)).toBe("2");
    expect(bellBadge(5, 2)).toBe("3");
    expect(bellBadge(5, 0)).toBe("5");
  });
  it("零或负 → null(隐藏,不造数);>9 → 9+(mono 单字宽)", () => {
    expect(bellBadge(0, 0)).toBeNull();
    expect(bellBadge(2, 3)).toBeNull(); // 全在弹卡里
    expect(bellBadge(9, 0)).toBe("9"); // 恰 9 仍精确
    expect(bellBadge(10, 0)).toBe("9+"); // >9 收敛
    expect(bellBadge(120, 0)).toBe("9+");
  });
});

describe("groupNotifications · 按项目分组 + Cowork·报销 组", () => {
  it("approval → Cowork·报销组;其余按 project_id 分组;组内计数", () => {
    const notes = [
      note({ id: "m1", kind: "review_due", project_id: "p1", created_at: "2026-07-17T10:00:00Z" }),
      note({ id: "m2", kind: "mention", project_id: "p1", created_at: "2026-07-17T09:00:00Z" }),
      note({ id: "a1", kind: "approval", project_id: null, deep_link: "/cowork/reimbursements/runs/r1", created_at: "2026-07-17T08:00:00Z" }),
    ];
    const groups = groupNotifications(notes, (id) => (id === "p1" ? "登录页重设计" : id));
    const proj = groups.find((g) => g.kind === "project");
    const cowork = groups.find((g) => g.kind === "cowork");
    expect(proj?.label).toBe("登录页重设计");
    expect(proj?.items).toHaveLength(2);
    // 组内最新在前
    expect(proj?.items.map((n) => n.id)).toEqual(["m1", "m2"]);
    expect(cowork?.label).toContain("报销");
    expect(cowork?.items).toHaveLength(1);
    // Cowork 组排在最后
    expect(groups[groups.length - 1].kind).toBe("cowork");
  });
});

describe("groupNotifications · 未读顶、已读沉底但留存(历史序)", () => {
  it("组内未读在前、已读在后;带未读的项目组排在纯已读组之上", () => {
    const notes = [
      // p1:一条已读(较新)+ 一条未读(较旧)→ 未读应顶到已读之上
      note({ id: "p1-read", project_id: "p1", read_at: "2026-07-17T10:30:00Z", created_at: "2026-07-17T10:00:00Z" }),
      note({ id: "p1-unread", project_id: "p1", read_at: null, created_at: "2026-07-17T09:00:00Z" }),
      // p2:全已读(且最新)→ 该组整体沉到带未读的 p1 之下
      note({ id: "p2-read", project_id: "p2", read_at: "2026-07-17T12:00:00Z", created_at: "2026-07-17T11:00:00Z" }),
    ];
    const groups = groupNotifications(notes, (id) => id);
    expect(groups.map((g) => g.key)).toEqual(["p1", "p2"]); // 带未读的 p1 在上
    const p1 = groups.find((g) => g.key === "p1")!;
    expect(p1.items.map((n) => n.id)).toEqual(["p1-unread", "p1-read"]); // 未读顶,已读沉但留存
  });

  it("显式未读谓词(开启快照):置读后仍按快照排未读优先", () => {
    const notes = [
      note({ id: "x", project_id: "p1", read_at: "2026-07-17T10:00:00Z", created_at: "2026-07-17T09:00:00Z" }),
      note({ id: "y", project_id: "p1", read_at: "2026-07-17T10:00:00Z", created_at: "2026-07-17T08:00:00Z" }),
    ];
    // 两条 read_at 均非空,但快照把 y 视为「本次浏览未读」→ y 应排到 x 之上
    const snap = new Set(["y"]);
    const groups = groupNotifications(notes, (id) => id, (n) => snap.has(n.id));
    expect(groups[0].items.map((n) => n.id)).toEqual(["y", "x"]);
  });
});

describe("buildPanel · 全局未读优先 + 30 上限 + 截断标记", () => {
  it("总数 ≤ cap → 全展示、不截断", () => {
    const notes = [1, 2, 3].map((n) =>
      note({ id: `n${n}`, project_id: "p1", created_at: `2026-07-17T10:0${n}:00Z` }),
    );
    const p = buildPanel(notes, (id) => id, { cap: PANEL_CAP });
    expect(p.total).toBe(3);
    expect(p.shown).toBe(3);
    expect(p.clipped).toBe(false);
  });

  it("超过 cap → 截断到 cap 并置 clipped;未读优先保留(先牺牲最旧已读)", () => {
    const cap = 3;
    const notes = [
      note({ id: "u", project_id: "p1", read_at: null, created_at: "2026-07-17T09:00:00Z" }), // 未读但最旧
      ...[1, 2, 3, 4].map((n) =>
        note({
          id: `r${n}`,
          project_id: "p1",
          read_at: "2026-07-17T12:00:00Z",
          created_at: `2026-07-17T1${n}:00:00Z`,
        }),
      ),
    ];
    const p = buildPanel(notes, (id) => id, { cap });
    expect(p.total).toBe(5);
    expect(p.shown).toBe(3);
    expect(p.clipped).toBe(true);
    // 未读 u 必在展示内(即便最旧),被牺牲的是最旧的已读
    const shownIds = p.groups.flatMap((g) => g.items.map((n) => n.id));
    expect(shownIds).toContain("u");
    expect(shownIds).toHaveLength(3);
  });
});

describe("resolveDeepLink · kind → 导航目标", () => {
  it("approval / 报销深链 → 报销页", () => {
    expect(resolveDeepLink(note({ id: "x", kind: "approval", project_id: null, deep_link: "/cowork/reimbursements/runs/r1" }))).toEqual({
      section: "reimbursement",
    });
  });
  it("带 project_id → Crew 项目 + 任务锚点", () => {
    expect(resolveDeepLink(note({ id: "x", kind: "assigned", project_id: "p9", task_id: "t7" }))).toEqual({
      section: "crew",
      projectId: "p9",
      taskId: "t7",
    });
  });
  it("无 project 无报销深链 → 收件箱兜底", () => {
    expect(resolveDeepLink(note({ id: "x", kind: "blocked", project_id: null, task_id: null, deep_link: "/crew/inbox" }))).toEqual({
      section: "inbox",
    });
  });
});

describe("kindMeta · 五类 + grown 图元与文案", () => {
  it("每类给出 label 与 icon(派工/@你/待你审/被驳回/阻塞/生长/解锁)", () => {
    expect(kindMeta("assigned").label).toBe("派工");
    expect(kindMeta("mention").label).toBe("@你");
    expect(kindMeta("review_due").label).toBe("待你审");
    expect(kindMeta("rejected").label).toBe("被驳回");
    expect(kindMeta("blocked").label).toBe("阻塞");
    expect(kindMeta("grown").icon).toBe("branch");
    expect(kindMeta("assigned").icon).toBe("petal");
    expect(kindMeta("review_due").icon).toBe("diamond");
  });
});

describe("relTime · 相对时间", () => {
  const now = Date.parse("2026-07-17T12:00:00Z");
  it("< 1 分钟 → 刚刚", () => {
    expect(relTime("2026-07-17T11:59:40Z", now)).toBe("刚刚");
  });
  it("< 60 分钟 → N 分钟前", () => {
    expect(relTime("2026-07-17T11:58:00Z", now)).toBe("2 分钟前");
  });
  it("更早 → 时:分(含数字)", () => {
    expect(relTime("2026-07-17T08:00:00Z", now)).toMatch(/\d/);
  });
});
