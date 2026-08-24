/**
 * readerModel · 阅读器纯逻辑测试
 * 覆盖:canvasView reducer 三迁移 · resolveArtifact(选版/退化/无产物/产出者) ·
 *   面包屑去重 · 提交时刻格式 · 页脚组串(字数 + 时刻)。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import {
  INITIAL_CANVAS_VIEW,
  canvasViewReducer,
  formatReaderFooter,
  formatSubmittedAt,
  readerBreadcrumb,
  resolveArtifact,
  reviewReadiness,
  type CanvasView,
} from "../readerModel";

function task(partial: Partial<CrewTask> & { id: string }): CrewTask {
  return {
    project_id: "p1",
    key: partial.id,
    title: partial.id,
    status: "todo",
    role_required: "产品",
    ...partial,
  } as CrewTask;
}

const members = [
  { id: "m-scribe", display_name: "Agent·Scribe", kind: "agent" },
  { id: "m-andy", display_name: "Andy", kind: "human" },
];

describe("canvasViewReducer(图 ↔ 阅读器)", () => {
  it("初始态 = 图", () => {
    expect(INITIAL_CANVAS_VIEW).toEqual({ kind: "graph" });
  });

  it("openReader → 进入阅读器(带版本)", () => {
    const next = canvasViewReducer(INITIAL_CANVAS_VIEW, {
      type: "openReader",
      taskId: "t1",
      version: 2,
    });
    expect(next).toEqual({ kind: "reader", taskId: "t1", version: 2 });
  });

  it("openReader 无版本 → version 缺省(最新)", () => {
    const next = canvasViewReducer(INITIAL_CANVAS_VIEW, { type: "openReader", taskId: "t1" });
    expect(next).toEqual({ kind: "reader", taskId: "t1", version: undefined });
  });

  it("openReader 携 gateId → 对照评审态;switchVersion 保 gateId", () => {
    const opened = canvasViewReducer(INITIAL_CANVAS_VIEW, {
      type: "openReader",
      taskId: "t1",
      gateId: "g1",
    });
    expect(opened).toEqual({ kind: "reader", taskId: "t1", version: undefined, gateId: "g1" });
    const switched = canvasViewReducer(opened, { type: "switchVersion", version: 3 });
    expect(switched).toEqual({ kind: "reader", taskId: "t1", version: 3, gateId: "g1" });
  });

  it("switchVersion 仅在阅读器态改版本、保 taskId", () => {
    const reader: CanvasView = { kind: "reader", taskId: "t1", version: 2 };
    const next = canvasViewReducer(reader, { type: "switchVersion", version: 1 });
    expect(next).toEqual({ kind: "reader", taskId: "t1", version: 1 });
  });

  it("switchVersion 在图态被忽略(不越权造态)", () => {
    const next = canvasViewReducer(INITIAL_CANVAS_VIEW, { type: "switchVersion", version: 1 });
    expect(next).toEqual({ kind: "graph" });
  });

  it("backToGraph → 回图(ESC / 回到图)", () => {
    const reader: CanvasView = { kind: "reader", taskId: "t1", version: 2 };
    expect(canvasViewReducer(reader, { type: "backToGraph" })).toEqual({ kind: "graph" });
  });
});

describe("resolveArtifact(选中版本 → 阅读器数据)", () => {
  it("缺省取最新版本;字数 = 字符数;产出者 = assignee 显示名;时刻取该版", () => {
    const t = task({
      id: "prd",
      title: "PRD-登录页重设计",
      assignee_member_id: "m-scribe",
      artifact_versions: [
        { version: 1, content: "一二三", submitted_at: "2026-07-19T10:00:00" },
        { version: 2, content: "一二三四五", submitted_at: "2026-07-20T16:31:00" },
      ],
    });
    const r = resolveArtifact(t, members)!;
    expect(r.version).toBe(2);
    expect(r.content).toBe("一二三四五");
    expect(r.charCount).toBe(5);
    expect(r.producer).toBe("Agent·Scribe");
    expect(r.submittedAt).toBe("2026-07-20T16:31:00");
    expect(r.versions.map((v) => v.version)).toEqual([2, 1]); // 降序
    expect(r.artifactName).toBe("PRD-登录页重设计");
  });

  it("requestedVersion 命中 → 取该版正文与时刻", () => {
    const t = task({
      id: "prd",
      artifact_versions: [
        { version: 1, content: "旧稿", submitted_at: "2026-07-19T10:00:00" },
        { version: 2, content: "新稿", submitted_at: "2026-07-20T16:31:00" },
      ],
    });
    const r = resolveArtifact(t, members, 1)!;
    expect(r.version).toBe(1);
    expect(r.content).toBe("旧稿");
    expect(r.submittedAt).toBe("2026-07-19T10:00:00");
  });

  it("requestedVersion 未命中 → 回落最新", () => {
    const t = task({
      id: "prd",
      artifact_versions: [{ version: 2, content: "新稿", submitted_at: "b" }],
    });
    expect(resolveArtifact(t, members, 99)!.version).toBe(2);
  });

  it("跳过空白正文的版本", () => {
    const t = task({
      id: "x",
      artifact_versions: [
        { version: 2, content: "   ", submitted_at: "b" },
        { version: 1, content: "有料", submitted_at: "a" },
      ],
    });
    const r = resolveArtifact(t, members)!;
    expect(r.version).toBe(1);
    expect(r.content).toBe("有料");
  });

  it("无版本历史但有扁平 artifact → version=null、无时刻", () => {
    const t = task({ id: "x", artifact: "扁平正文", assignee_member_id: "m-andy" });
    const r = resolveArtifact(t, members)!;
    expect(r.version).toBeNull();
    expect(r.content).toBe("扁平正文");
    expect(r.submittedAt).toBeNull();
    expect(r.versions).toEqual([]);
    expect(r.producer).toBe("Andy");
  });

  it("产出者:无 assignee → 回落职能 role", () => {
    const t = task({ id: "x", role_required: "工程", artifact: "正文" });
    expect(resolveArtifact(t, members)!.producer).toBe("工程");
  });

  it("完全无产物 / 无任务 → null", () => {
    expect(resolveArtifact(task({ id: "x" }), members)).toBeNull();
    expect(resolveArtifact(task({ id: "x", artifact: "  " }), members)).toBeNull();
    expect(resolveArtifact(null, members)).toBeNull();
    expect(resolveArtifact(undefined, members)).toBeNull();
  });
});

describe("readerBreadcrumb(项目 › 任务 › 产物名)", () => {
  it("三段齐全", () => {
    expect(readerBreadcrumb("登录页重设计", "PRD 起草", "PRD-登录页重设计")).toEqual([
      "登录页重设计",
      "PRD 起草",
      "PRD-登录页重设计",
    ]);
  });
  it("任务名 = 产物名 → 去连续重复", () => {
    expect(readerBreadcrumb("登录页重设计", "PRD 起草", "PRD 起草")).toEqual([
      "登录页重设计",
      "PRD 起草",
    ]);
  });
  it("空段剔除", () => {
    expect(readerBreadcrumb("  ", "任务", "产物")).toEqual(["任务", "产物"]);
  });
});

describe("reviewReadiness · #1 评审就绪度(镜像后端门 readiness)", () => {
  const byId = (ts: CrewTask[]) => new Map(ts.map((t) => [t.id, t]));

  it("全部父任务已交付(submitted/in_review/done)→ ready、missing 空", () => {
    const design = task({ id: "design", title: "设计稿", status: "submitted" });
    const tech = task({ id: "tech", title: "技术预研", status: "done" });
    const gate = task({
      id: "gate",
      title: "设计评审",
      is_gate: true,
      depends_on: ["design", "tech"],
    });
    const r = reviewReadiness(gate, byId([design, tech, gate]));
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("一个父未交付 → not ready、missing 列其标题", () => {
    const design = task({ id: "design", title: "设计稿", status: "submitted" });
    const tech = task({ id: "tech", title: "技术预研", status: "running" });
    const gate = task({ id: "gate", is_gate: true, depends_on: ["design", "tech"] });
    const r = reviewReadiness(gate, byId([design, tech, gate]));
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["技术预研"]);
  });

  it("in_review 也算已交付(门就绪门槛)", () => {
    const a = task({ id: "a", status: "in_review" });
    const gate = task({ id: "g", is_gate: true, depends_on: ["a"] });
    expect(reviewReadiness(gate, byId([a, gate])).ready).toBe(true);
  });

  it("多个未交付 → missing 按 depends_on 序", () => {
    const a = task({ id: "a", title: "甲", status: "assigned" });
    const b = task({ id: "b", title: "乙", status: "done" });
    const c = task({ id: "c", title: "丙", status: "todo" });
    const gate = task({ id: "g", is_gate: true, depends_on: ["a", "b", "c"] });
    const r = reviewReadiness(gate, byId([a, b, c, gate]));
    expect(r.missing).toEqual(["甲", "丙"]); // 乙 done 跳过,顺序随 depends_on
    expect(r.ready).toBe(false);
  });

  it("悬空依赖(byId 无)跳过、不计入 missing", () => {
    const a = task({ id: "a", status: "submitted" });
    const gate = task({ id: "g", is_gate: true, depends_on: ["a", "ghost"] });
    const r = reviewReadiness(gate, byId([a, gate]));
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("无 depends_on → ready、missing 空", () => {
    const gate = task({ id: "g", is_gate: true });
    expect(reviewReadiness(gate, byId([gate]))).toEqual({ ready: true, missing: [] });
  });

  it("无标题父任务 → 回落 id", () => {
    const a = task({ id: "a", title: "  ", status: "todo" });
    const gate = task({ id: "g", is_gate: true, depends_on: ["a"] });
    expect(reviewReadiness(gate, byId([a, gate])).missing).toEqual(["a"]);
  });
});

describe("formatSubmittedAt / formatReaderFooter", () => {
  it("ISO → YYYY-MM-DD HH:MM", () => {
    expect(formatSubmittedAt("2026-07-20T16:31:00")).toBe("2026-07-20 16:31");
  });
  it("空 → 空串;非 ISO → 回落原串", () => {
    expect(formatSubmittedAt(null)).toBe("");
    expect(formatSubmittedAt("")).toBe("");
    expect(formatSubmittedAt("待定")).toBe("待定");
  });
  it("页脚:全段 = 「vN · N 字 · 产出者 M · 时刻」", () => {
    expect(
      formatReaderFooter({
        version: 2,
        charCount: 2005,
        producer: "Agent·Scribe",
        submittedAt: "2026-07-20T16:31:00",
      }),
    ).toBe("v2 · 2,005 字 · 产出者 Agent·Scribe · 2026-07-20 16:31");
  });
  it("页脚:缺版本 / 缺产出者 / 缺时刻 → 自动略段", () => {
    expect(
      formatReaderFooter({ version: null, charCount: 320, producer: null, submittedAt: null }),
    ).toBe("320 字");
  });
});
