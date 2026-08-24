/**
 * inspectModel · F4 纯函数契约(RED 先行)
 *   操作组状态映射 / popover 定位翻转 / 估算可用性(无历史→null)/ 依赖链(还差 n 道门)。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import {
  ARTIFACT_BINARY_REJECT,
  ARTIFACT_UPLOAD_MAX_BYTES,
  canRunAgent,
  computePopoverPosition,
  criteriaSourceLabel,
  decodeTextFile,
  dependencyChain,
  drawerOps,
  estimateRemaining,
  gateOps,
  inHandCount,
  opsForTask,
  PRECHECK_OPS,
  pendingGateCount,
  popoverOps,
  precheckOp,
  processSectionVisible,
  resolveConsensusHits,
  sectionNumbers,
  selectPopoverCard,
  traceProgress,
  validateArtifactFile,
  withAgentRun,
} from "../inspectModel";

let n = 0;
const task = (over: Partial<CrewTask> = {}): CrewTask => ({
  id: `t${++n}`,
  project_id: "p1",
  key: `k${n}`,
  title: `任务${n}`,
  status: "todo",
  role_required: "产品",
  depends_on: [],
  is_gate: false,
  origin: "sop",
  ...over,
});

describe("selectPopoverCard · 双卡态", () => {
  it("执行中 → live(Agent 执行白盒)", () => {
    expect(selectPopoverCard("running")).toBe("live");
  });
  it("其余七态 → dossier(待就绪档案白盒)", () => {
    for (const v of ["pending", "ready", "review", "blocked", "rework", "done"] as const) {
      expect(selectPopoverCard(v)).toBe("dossier");
    }
  });
});

describe("canRunAgent · Agent 执行触发判定(终审 #1)", () => {
  const roster = [
    { id: "acc_agent_design", kind: "agent" },
    { id: "acc_andy", kind: "human" },
  ];

  it("agent assignee 且 assigned → 可执行", () => {
    expect(
      canRunAgent(task({ status: "assigned", assignee_member_id: "acc_agent_design" }), roster),
    ).toBe(true);
  });
  it("agent assignee 且 rework → 可执行(批注注入后重跑)", () => {
    expect(
      canRunAgent(task({ status: "rework", assignee_member_id: "acc_agent_design" }), roster),
    ).toBe(true);
  });
  it("agent assignee 但其余态(running/todo/submitted/done/blocked)→ 不可执行", () => {
    for (const status of ["running", "todo", "submitted", "in_review", "done", "blocked"]) {
      expect(
        canRunAgent(task({ status, assignee_member_id: "acc_agent_design" }), roster),
      ).toBe(false);
    }
  });
  it("human assignee 即便 assigned → 不可执行(人任务不变)", () => {
    expect(
      canRunAgent(task({ status: "assigned", assignee_member_id: "acc_andy" }), roster),
    ).toBe(false);
  });
  it("无 assignee → 不可执行", () => {
    expect(canRunAgent(task({ status: "assigned", assignee_member_id: null }), roster)).toBe(false);
  });
  it("assignee 不在花名册 → 不可执行(诚实降级)", () => {
    expect(canRunAgent(task({ status: "assigned", assignee_member_id: "ghost" }), roster)).toBe(false);
  });
  it("门任务永不可执行", () => {
    expect(
      canRunAgent(
        task({ status: "assigned", assignee_member_id: "acc_agent_design", is_gate: true }),
        roster,
      ),
    ).toBe(false);
  });
});

describe("withAgentRun · 双按钮收敛(DEV-1 / 诊断 2a)", () => {
  it("agent × rework → 执行替换提交位,保留次级『没空』(无并行开始)", () => {
    const out = withAgentRun(drawerOps("rework"), true);
    expect(out.map((b) => b.label)).toEqual(["执行", "没空"]);
    expect(out[0].id).toBe("execute");
    expect(out[0].variant).toBe("primary");
  });
  it("agent × assigned(ready)→ 执行为唯一推进,剔除并行『开始』(执行 ONLY)", () => {
    expect(withAgentRun(drawerOps("ready"), true).map((b) => b.label)).toEqual(["执行"]);
    expect(withAgentRun(drawerOps("ready"), true).every((b) => b.id !== "start")).toBe(true);
  });
  it("human × assigned(canRun=false)→ 原样保留『开始』(人保留开始)", () => {
    expect(withAgentRun(drawerOps("ready"), false).map((b) => b.label)).toEqual(["认领", "开始"]);
  });
  it("human × rework(canRun=false)→ 原样返回(提交 / 没空)", () => {
    expect(withAgentRun(drawerOps("rework"), false)).toEqual(drawerOps("rework"));
  });
});

describe("precheckOp · DEV-1 动作前置校验(陈旧竞态守门)", () => {
  const roster = [
    { id: "agent", kind: "agent" },
    { id: "andy", kind: "human" },
  ];

  it("PRECHECK_OPS = {start, execute, submit}", () => {
    expect([...PRECHECK_OPS].sort()).toEqual(["execute", "start", "submit"]);
  });

  it("非校验动作(认领/改派/说话/导航)→ 恒 ok(不拦)", () => {
    for (const op of ["claim", "preclaim", "reassign", "noTime", "toReview", "toChannel", "seeDeps", "fullDossier"] as const) {
      expect(precheckOp(op, task({ status: "done" }), roster).ok).toBe(true);
    }
  });

  it("start:fresh=assigned|rework → ok", () => {
    expect(precheckOp("start", task({ status: "assigned" }), roster).ok).toBe(true);
    expect(precheckOp("start", task({ status: "rework" }), roster).ok).toBe(true);
  });
  it("start:auto-pilot 已推进(submitted/running)→ 陈旧 + 人话导向刷新", () => {
    const s = precheckOp("start", task({ status: "submitted" }), roster);
    expect(s.ok).toBe(false);
    expect(s.message).toContain("待审"); // statusWordCn(submitted)
    expect(s.message).toContain("开始");
    expect(precheckOp("start", task({ status: "running" }), roster).message).toContain("执行中");
  });

  it("execute:agent+assigned → ok;推进到 submitted → 陈旧", () => {
    expect(precheckOp("execute", task({ status: "assigned", assignee_member_id: "agent" }), roster).ok).toBe(true);
    const s = precheckOp("execute", task({ status: "submitted", assignee_member_id: "agent" }), roster);
    expect(s.ok).toBe(false);
    expect(s.message).toContain("待审");
  });

  it("submit:fresh=running|rework → ok;submitted → 陈旧", () => {
    expect(precheckOp("submit", task({ status: "running" }), roster).ok).toBe(true);
    expect(precheckOp("submit", task({ status: "rework" }), roster).ok).toBe(true);
    expect(precheckOp("submit", task({ status: "submitted" }), roster).ok).toBe(false);
  });

  it("任务在最新快照中消失(undefined)→ 陈旧 + 提示已刷新", () => {
    const gone = precheckOp("start", undefined, roster);
    expect(gone.ok).toBe(false);
    expect(gone.message).toContain("最新快照");
  });
});

describe("gateOps / opsForTask · 门只剩裁定(真机事故:门曾被认领→开始→提交误导)", () => {
  it("活跃门 → 唯一「去评审」;休眠门 → 看依赖;已通过 → 无操作", () => {
    expect(gateOps("active")).toEqual([{ id: "toReview", label: "去评审", variant: "primary" }]);
    expect(gateOps("dormant")).toEqual([{ id: "seeDeps", label: "看依赖", variant: "default" }]);
    expect(gateOps("passed")).toEqual([]);
  });

  it("opsForTask:门走 gateOps——todo 门绝不出「认领/开始」;done 门无操作", () => {
    const activeGate = task({ is_gate: true, status: "todo" });
    const ops = opsForTask(activeGate, "ready", []);
    expect(ops.map((b) => b.id)).toEqual(["toReview"]);
    const passedGate = task({ is_gate: true, status: "done" });
    expect(opsForTask(passedGate, "done", [])).toEqual([]);
  });

  it("opsForTask:非门任务维持 drawerOps + 双按钮收敛(agent assigned → 仅执行)", () => {
    const members = [{ id: "agent1", kind: "agent" }];
    const agentTask = task({ status: "assigned", assignee_member_id: "agent1" });
    const ops = opsForTask(agentTask, "ready", members);
    expect(ops[0]).toEqual({ id: "execute", label: "执行", variant: "primary" });
    expect(ops.some((b) => b.id === "start")).toBe(false);
  });
});

describe("drawerOps · 操作组随状态(1h 底注)", () => {
  it("就绪 = 认领 / 开始", () => {
    expect(drawerOps("ready").map((o) => o.label)).toEqual(["认领", "开始"]);
    expect(drawerOps("ready")[0].variant).toBe("primary");
  });
  it("执行 = 提交 / 没空", () => {
    expect(drawerOps("running").map((o) => o.label)).toEqual(["提交", "没空"]);
  });
  it("待审 = 去评审 / 改派", () => {
    expect(drawerOps("review").map((o) => o.label)).toEqual(["去评审", "改派"]);
  });
  it("待就绪 = 提前认领 / 看依赖(2a 右卡)", () => {
    expect(drawerOps("pending").map((o) => o.label)).toEqual(["提前认领", "看依赖"]);
  });
  it("完成 = 无操作(墨迹已干)", () => {
    expect(drawerOps("done")).toEqual([]);
  });
});

describe("popoverOps · 轻检视操作组", () => {
  it("live 卡 = 全档案 / 去频道(暂停不渲染:后端无能力)", () => {
    const ops = popoverOps("live", "running");
    expect(ops.map((o) => o.label)).toEqual(["全档案", "去频道"]);
    expect(ops.some((o) => o.label === "暂停")).toBe(false);
  });
  it("dossier 卡 = 复用 drawerOps", () => {
    expect(popoverOps("dossier", "pending").map((o) => o.label)).toEqual(
      drawerOps("pending").map((o) => o.label),
    );
  });
});

describe("computePopoverPosition · 定位与近缘翻转", () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: 372, height: 300 };

  it("上方有空间 → 置于节点上方,水平居中", () => {
    const anchor = { left: 600, top: 500, width: 188, height: 66 };
    const pos = computePopoverPosition(anchor, size, viewport, { gap: 12 });
    expect(pos.placement).toBe("above");
    expect(pos.top).toBe(500 - 300 - 12);
    // 居中:节点中心 694,浮层左 = 694 - 186 = 508
    expect(pos.left).toBe(508);
  });

  it("近上缘 → 翻转到节点下方", () => {
    const anchor = { left: 600, top: 40, width: 188, height: 66 };
    const pos = computePopoverPosition(anchor, size, viewport, { gap: 12, margin: 12 });
    expect(pos.placement).toBe("below");
    expect(pos.top).toBe(40 + 66 + 12);
  });

  it("近左缘 → 水平夹逼进视口(不贴边)", () => {
    const anchor = { left: 10, top: 500, width: 188, height: 66 };
    const pos = computePopoverPosition(anchor, size, viewport, { margin: 12 });
    expect(pos.left).toBe(12);
    // caret 仍指向节点中心(104),夹逼在卡内
    expect(pos.caretLeft).toBeGreaterThanOrEqual(16);
    expect(pos.caretLeft).toBe(104 - 12);
  });

  it("近右缘 → 夹逼,caret 夹在卡内 ≤ width-16", () => {
    const anchor = { left: 1400, top: 500, width: 188, height: 66 };
    const pos = computePopoverPosition(anchor, size, viewport, { margin: 12 });
    expect(pos.left).toBe(1440 - 372 - 12);
    expect(pos.caretLeft).toBeLessThanOrEqual(size.width - 16);
  });
});

describe("estimateRemaining · 诚实估算(无历史→null)", () => {
  it("空历史 → null(只显已耗时)", () => {
    expect(estimateRemaining([], 60_000)).toBeNull();
  });
  it("有历史 → 均值减已耗时,带「非承诺」与样本数", () => {
    const est = estimateRemaining([600_000, 800_000], 400_000);
    expect(est).not.toBeNull();
    expect(est?.sampleSize).toBe(2);
    // 均值 700_000 - 已耗 400_000 = 300_000ms ≈ 5m
    expect(est?.remainingMs).toBe(300_000);
    expect(est?.text).toContain("非承诺");
    expect(est?.text).toContain("同类 2 单");
  });
  it("已耗时超过均值 → 剩余夹逼为 0", () => {
    const est = estimateRemaining([100_000], 999_000);
    expect(est?.remainingMs).toBe(0);
  });
});

describe("dependencyChain · 还差 n 道门", () => {
  it("线性链 设计稿(待审)→ 设计评审◇(活跃)→ 实施(本任务):还差 1 道门", () => {
    const draft = task({ id: "draft", status: "submitted", title: "设计稿" });
    const gate = task({ id: "gate", is_gate: true, status: "todo", title: "设计评审", depends_on: ["draft"], reviews_task_id: "draft" });
    const impl = task({ id: "impl", status: "blocked", title: "实施", depends_on: ["gate"] });
    const byId = new Map([draft, gate, impl].map((t) => [t.id, t]));

    const { chain, gateCount } = dependencyChain(impl, byId);
    expect(gateCount).toBe(1);
    expect(pendingGateCount(impl, byId)).toBe(1);
    // 链尾 = 本任务
    expect(chain[chain.length - 1]).toMatchObject({ id: "impl", self: true });
    // 远→近:draft 在 gate 之前
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf("draft")).toBeLessThan(ids.indexOf("gate"));
    expect(ids.indexOf("gate")).toBeLessThan(ids.indexOf("impl"));
  });

  it("已完成的上游不入链(不造门)", () => {
    const dep = task({ id: "dep", status: "done" });
    const gate = task({ id: "g", is_gate: true, status: "done", depends_on: ["dep"] });
    const me = task({ id: "me", status: "ready", depends_on: ["g"] });
    const byId = new Map([dep, gate, me].map((t) => [t.id, t]));
    expect(pendingGateCount(me, byId)).toBe(0);
    expect(dependencyChain(me, byId).chain).toEqual([{ id: "me", isGate: false, self: true }]);
  });

  it("悬空依赖跳过", () => {
    const me = task({ id: "me", depends_on: ["ghost"] });
    const byId = new Map([[me.id, me]]);
    expect(dependencyChain(me, byId).chain).toEqual([{ id: "me", isGate: false, self: true }]);
  });
});

describe("inHandCount · 执行者在手负载", () => {
  it("统计该成员 running|rework 的非门任务", () => {
    const tasks = [
      task({ assignee_member_id: "a", status: "running" }),
      task({ assignee_member_id: "a", status: "rework" }),
      task({ assignee_member_id: "a", status: "done" }),
      task({ assignee_member_id: "b", status: "running" }),
      task({ assignee_member_id: "a", status: "running", is_gate: true }),
    ];
    expect(inHandCount("a", tasks)).toBe(2);
  });
});

describe("resolveConsensusHits · memory_hits → 条目", () => {
  const items = [
    { id: "m1", kind: "口径", text: "已发布版视觉=暖 terracotta" },
    { id: "m2", kind: "决策", text: "三态需真图验收" },
    { id: "m3", kind: "约束", text: "无关" },
  ];
  it("按命中顺序解析,未解析的丢弃", () => {
    const hits = resolveConsensusHits(["m2", "m1", "ghost"], items);
    expect(hits.map((h) => h.id)).toEqual(["m2", "m1"]);
    expect(hits[0].kind).toBe("决策");
  });
  it("空命中 → 空", () => {
    expect(resolveConsensusHits([], items)).toEqual([]);
  });
});

describe("traceProgress · 回合 N · 步骤 M(真值)", () => {
  it("准备回合 index 0 不计回合;步骤全求和", () => {
    const turns = [
      { index: 0, steps: [{}, {}] },
      { index: 1, steps: [{}, {}, {}] },
      { index: 2, steps: [{}] },
    ];
    const p = traceProgress(turns);
    expect(p.turnCount).toBe(2);
    expect(p.stepCount).toBe(6);
  });
});

/* ---------------- 可用性收束二批(O-A)---------------- */

describe("criteriaSourceLabel · ②验收标准来源(用户二检「基于什么制定?」)", () => {
  it("origin=channel → Anna 起草 · 源自频道", () => {
    expect(criteriaSourceLabel("channel")).toBe("Anna 起草 · 源自频道");
  });
  it("origin=sop → 来自 SOP 模板", () => {
    expect(criteriaSourceLabel("sop")).toBe("来自 SOP 模板");
  });
  it("origin=undefined → 来自 SOP 模板(诚实默认)", () => {
    expect(criteriaSourceLabel(undefined)).toBe("来自 SOP 模板");
  });
});

describe("processSectionVisible · ③执行过程只属 Agent 任务(用户二检)", () => {
  const members = [
    { id: "agent1", kind: "agent" },
    { id: "andy", kind: "human" },
  ];
  it("门 → 不显(裁定席无执行过程;即便有 run_ref)", () => {
    expect(
      processSectionVisible(task({ is_gate: true, assignee_member_id: "agent1" }), members, false),
    ).toBe(false);
    expect(processSectionVisible(task({ is_gate: true }), members, true)).toBe(false);
  });
  it("人类任务无 run → 隐藏", () => {
    expect(processSectionVisible(task({ assignee_member_id: "andy" }), members, false)).toBe(false);
  });
  it("Agent 任务未跑 → 显(留位待执行)", () => {
    expect(processSectionVisible(task({ assignee_member_id: "agent1" }), members, false)).toBe(true);
  });
  it("人类任务但有历史 run_ref → 显(改派后历史仍在)", () => {
    expect(processSectionVisible(task({ assignee_member_id: "andy" }), members, true)).toBe(true);
  });
  it("无 assignee 无 run → 隐藏", () => {
    expect(processSectionVisible(task({ assignee_member_id: null }), members, false)).toBe(false);
  });
});

describe("sectionNumbers · 段编号动态续(元信息不在隐藏的3后显4)", () => {
  it("验收+过程全在 → 1/2/3/4", () => {
    expect(sectionNumbers({ hasCriteria: true, hasProcess: true })).toEqual({
      artifact: 1,
      criteria: 2,
      process: 3,
      meta: 4,
    });
  });
  it("无验收 → 过程前移到2,元信息3", () => {
    expect(sectionNumbers({ hasCriteria: false, hasProcess: true })).toEqual({
      artifact: 1,
      criteria: null,
      process: 2,
      meta: 3,
    });
  });
  it("无过程 → 元信息3(不跳4)", () => {
    expect(sectionNumbers({ hasCriteria: true, hasProcess: false })).toEqual({
      artifact: 1,
      criteria: 2,
      process: null,
      meta: 3,
    });
  });
  it("皆无 → 产物1 元信息2", () => {
    expect(sectionNumbers({ hasCriteria: false, hasProcess: false })).toEqual({
      artifact: 1,
      criteria: null,
      process: null,
      meta: 2,
    });
  });
});

describe("validateArtifactFile · ①交付区上传校验(放开扩展名 → 内容判定 + 1MB)", () => {
  it("任意文本类扩展名 → 通过(md/txt/markdown/html/rst)", () => {
    expect(validateArtifactFile("prd.md", 1024)).toEqual({ ok: true, message: null });
    expect(validateArtifactFile("notes.txt", 10).ok).toBe(true);
    expect(validateArtifactFile("readme.markdown", 10).ok).toBe(true);
    expect(validateArtifactFile("page.html", 10).ok).toBe(true);
    expect(validateArtifactFile("spec.rst", 10).ok).toBe(true);
  });
  it("无扩展名 → 通过(内容判定接管,不再靠白名单)", () => {
    expect(validateArtifactFile("README", 10).ok).toBe(true);
  });
  it("扩展名大小写不敏感(.HTML 也过)", () => {
    expect(validateArtifactFile("PAGE.HTML", 10).ok).toBe(true);
  });
  it("已知二进制扩展名短路拒绝(docx/doc/pdf/png/jpg/jpeg/zip/pptx/xlsx)", () => {
    for (const name of [
      "a.docx", "a.doc", "a.pdf", "a.png", "a.jpg", "a.jpeg", "a.zip", "a.pptx", "a.xlsx",
    ]) {
      const r = validateArtifactFile(name, 10);
      expect(r.ok, name).toBe(false);
      expect(r.message).toBe(ARTIFACT_BINARY_REJECT);
    }
  });
  it("拒绝人话含「二进制」与「P1」", () => {
    const r = validateArtifactFile("shot.png", 10);
    expect(r.message).toContain("二进制");
    expect(r.message).toContain("P1");
  });
  it("恰 1MB → 通过(边界含)", () => {
    expect(ARTIFACT_UPLOAD_MAX_BYTES).toBe(1024 * 1024);
    expect(validateArtifactFile("edge.md", ARTIFACT_UPLOAD_MAX_BYTES).ok).toBe(true);
  });
  it("超 1MB → 文件过大(≤1MB)", () => {
    const r = validateArtifactFile("big.md", ARTIFACT_UPLOAD_MAX_BYTES + 1);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("过大");
    expect(r.message).toContain("1MB");
  });
  it("二进制扩展名先于体积(超限 .png 报二进制而非过大)", () => {
    expect(validateArtifactFile("huge.png", ARTIFACT_UPLOAD_MAX_BYTES + 999).message).toBe(
      ARTIFACT_BINARY_REJECT,
    );
  });
});

describe("decodeTextFile · 内容判定(UTF-8 严格 + NUL 拒)", () => {
  const bufOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

  it("干净 UTF-8(含中文)→ 原样解出", () => {
    const buf = new TextEncoder().encode("产物正文 hello 你好").buffer;
    expect(decodeTextFile(buf)).toBe("产物正文 hello 你好");
  });
  it("空 buffer → 空串(非 null)", () => {
    expect(decodeTextFile(new ArrayBuffer(0))).toBe("");
  });
  it("含 NUL 字节 → 判二进制 → null", () => {
    // "hi" + NUL + "!"
    expect(decodeTextFile(bufOf([104, 105, 0, 33]))).toBeNull();
  });
  it("非法 UTF-8 字节序列 → null(fatal 抛)", () => {
    // 0xFF 不是合法 UTF-8 起始字节
    expect(decodeTextFile(bufOf([0xff, 0xfe, 0xff]))).toBeNull();
  });
});
