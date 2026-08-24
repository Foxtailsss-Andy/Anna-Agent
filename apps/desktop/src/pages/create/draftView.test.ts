import { describe, expect, it } from "vitest";

import {
  ceremonyFacts,
  groupHubItems,
  hubItems,
  ledgerLines,
  quotePrefill,
  toDraftView,
  useInChatPrefill,
  verificationRows,
} from "./draftView";

/* 真实字段形态取自 services/create/app/schemas.py + 一条实跑 run(create_run_001):
 *   artifact = { kind, path, preview, skill_id/prompt_id/tool_id }(无 title / 无 content,内容在 preview)
 *   status ∈ generating|validating|ready_for_review|saved|failed(非 draft/activated) */

const SKILL_PREVIEW = [
  "---",
  "name: CSV to Markdown Table Converter",
  "description: Convert CSV data into Markdown tables.",
  "version: 1.0.0",
  "owner: Anna Create",
  "domain: generated",
  "allowed_tools:",
  "forbidden_tools:",
  "---",
  "",
  "# CSV to Markdown Table Converter",
  "",
  "Convert raw CSV into a GFM table.",
  "",
].join("\n");

const draftSkillRun = {
  id: "create_run_001",
  workspace_id: "local-workspace",
  actor_user_id: "local-user",
  prompt: "一个把 CSV 转成 Markdown 表格的技能",
  kind: "skill",
  status: "ready_for_review",
  artifact: {
    kind: "skill",
    path: "C:/.../create_run_001/skill/csv_to_markdown/SKILL.md",
    preview: SKILL_PREVIEW,
    skill_id: "csv_to_markdown",
    prompt_id: null,
    tool_id: null,
  },
  validation: { valid: true, loaded_skill_id: "csv_to_markdown", allowed_tools: [], forbidden_tools: [], errors: [] },
  sandbox_result: null,
  activation_eligibility: null,
  audit_events: [],
  error_code: null,
  error_message: null,
};

const savedSkillRun = { ...draftSkillRun, status: "saved" };

// frontmatter 真含 allowed_tools/forbidden_tools 列表项(orchestrator._skill_markdown 真形态)
const SKILL_PREVIEW_WITH_TOOLS = [
  "---",
  "name: Approval Router",
  "description: Routes reimbursement approvals to the right approver.",
  "version: 1.0.0",
  "owner: Anna Create",
  "domain: generated",
  "allowed_tools:",
  "  - plan.update",
  "  - chat.emit_page",
  "forbidden_tools:",
  "  - fs.write",
  "---",
  "",
  "# Approval Router",
  "",
].join("\n");

const draftSkillRunWithTools = {
  ...draftSkillRun,
  id: "create_run_004",
  artifact: { ...draftSkillRun.artifact, preview: SKILL_PREVIEW_WITH_TOOLS },
};

// prompt kind frontmatter(orchestrator._prompt_markdown 真形态):无 allowed_tools/forbidden_tools 键
const PROMPT_PREVIEW = [
  "---",
  "title: Weekly Report Prompt",
  "description: Summarize weekly progress into a short report.",
  "owner: Anna Create",
  "variables:",
  "  - project_name",
  "---",
  "",
  "Please summarize this week's progress for {{project_name}}.",
  "",
].join("\n");

const draftPromptRun = {
  id: "create_run_005",
  workspace_id: "local-workspace",
  actor_user_id: "local-user",
  prompt: "a weekly report prompt",
  kind: "prompt",
  status: "ready_for_review",
  artifact: {
    kind: "prompt",
    path: "C:/.../create_run_005/prompt/weekly_report.md",
    preview: PROMPT_PREVIEW,
    skill_id: null,
    prompt_id: "weekly_report",
    tool_id: null,
  },
  validation: { valid: true, errors: [] },
  sandbox_result: null,
  activation_eligibility: null,
  audit_events: [],
  error_code: null,
  error_message: null,
};

const failedToolRun = {
  id: "create_run_002",
  workspace_id: "local-workspace",
  actor_user_id: "local-user",
  prompt: "a python tool that adds two integers",
  kind: "python_tool",
  status: "failed",
  artifact: {
    kind: "python_tool",
    path: "C:/.../create_run_002/python_tool/add_integers.py",
    preview: "def add(a: int, b: int) -> int:\n    return a + b\n",
    skill_id: null,
    prompt_id: null,
    tool_id: "add_integers",
  },
  validation: { valid: true, errors: [] },
  sandbox_result: { passed: true, exit_code: 0, stdout: "", stderr: "" },
  activation_eligibility: { activation_allowed: false },
  audit_events: [],
  error_code: "python_tool_activation_blocked",
  error_message:
    "Python tool activation requires a hardened sandbox and activation review path; the current fixture runner is review-only",
};

// failed BEFORE artifact was written (e.g. model error / invalid kind) → 无 artifact
const failedNoArtifactRun = {
  id: "create_run_003",
  prompt: "broken",
  kind: "skill",
  status: "failed",
  artifact: null,
  error_code: "model_call_failed",
  error_message: "model endpoint and API key are required",
};

describe("toDraftView", () => {
  it("ready_for_review skill → 待激活 / name+version from frontmatter", () => {
    const v = toDraftView(draftSkillRun);
    expect(v.runId).toBe("create_run_001");
    expect(v.runTag).toBe("run 001");
    expect(v.kind).toBe("skill");
    expect(v.kindLabel).toBe("技能");
    expect(v.status).toBe("ready_for_review");
    expect(v.statusLabel).toBe("待激活");
    expect(v.statusTone).toBe("run");
    expect(v.name).toBe("CSV to Markdown Table Converter"); // frontmatter name, not skill_id
    expect(v.version).toBe("1.0.0");
    expect(v.hasArtifact).toBe(true);
    expect(v.previewKind).toBe("markdown");
    expect(v.preview).toContain("# CSV to Markdown");
  });

  it("saved → 已激活 / ok tone", () => {
    const v = toDraftView(savedSkillRun);
    expect(v.statusLabel).toBe("已激活");
    expect(v.statusTone).toBe("ok");
  });

  it("failed python_tool → 构建未通过 / fail tone / name from tool_id (no frontmatter) / code preview", () => {
    const v = toDraftView(failedToolRun);
    expect(v.kindLabel).toBe("Python 工具");
    expect(v.statusLabel).toBe("构建未通过");
    expect(v.statusTone).toBe("fail");
    expect(v.name).toBe("add_integers"); // 无 frontmatter → 回落 tool_id
    expect(v.version).toBe("");
    expect(v.previewKind).toBe("code");
    expect(v.errorMessage).toContain("hardened sandbox");
  });

  it("字段缺省不 throw:回落 prompt 摘要 / 无 artifact", () => {
    const v = toDraftView(failedNoArtifactRun);
    expect(v.hasArtifact).toBe(false);
    expect(v.name).toContain("broken"); // 无 artifact → prompt 摘要
    expect(() => toDraftView({})).not.toThrow();
    const empty = toDraftView({});
    expect(empty.name).not.toBe(""); // 兜底非空
    expect(empty.hasArtifact).toBe(false);
  });
});

describe("ledgerLines", () => {
  it("draft(ready_for_review):首行 runTag·name·状态 + kind 行 + 状态行「草稿 · 待激活」", () => {
    const lines = ledgerLines(draftSkillRun);
    expect(lines[0]).toBe("run 001 · CSV to Markdown Table Converter · 待激活");
    expect(lines.some((l) => l === "kind: skill")).toBe(true);
    expect(lines.some((l) => l.includes("artifacts 1"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("草稿 · 待激活");
  });

  it("saved:状态行「已激活」", () => {
    const lines = ledgerLines(savedSkillRun);
    expect(lines[lines.length - 1]).toContain("已激活");
  });

  it("failed:状态行 = error_message 原文(一字不改)", () => {
    const lines = ledgerLines(failedToolRun);
    expect(lines[lines.length - 1]).toBe(failedToolRun.error_message);
  });

  it("无 artifact 的 run:artifacts 0,不 throw", () => {
    const lines = ledgerLines(failedNoArtifactRun);
    expect(lines.some((l) => l.includes("artifacts 0"))).toBe(true);
    expect(() => ledgerLines({})).not.toThrow();
  });

  it("frontmatter 含 allowed_tools/forbidden_tools 列表 → 账本行原样呈现(权限字段可见,复审 Fix 1)", () => {
    const lines = ledgerLines(draftSkillRunWithTools);
    expect(lines).toContain("allowed_tools: plan.update、chat.emit_page");
    expect(lines).toContain("forbidden_tools: fs.write");
    expect(lines).toContain("description: Routes reimbursement approvals to the right approver.");
    expect(lines).toContain("owner: Anna Create");
    expect(lines).toContain("domain: generated");
  });

  it("frontmatter 不含 allowed_tools/forbidden_tools(prompt 无该键)→ 无对应账本行", () => {
    const lines = ledgerLines(draftPromptRun);
    expect(lines.some((l) => l.startsWith("allowed_tools:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("forbidden_tools:"))).toBe(false);
    expect(lines).toContain("description: Summarize weekly progress into a short report.");
    expect(lines).toContain("owner: Anna Create");
    expect(lines).toContain("variables: project_name");
    // title 已消费为展示名,不重复入账本
    expect(lines.some((l) => l.startsWith("title:"))).toBe(false);
  });

  it("无 frontmatter(python_tool 代码预览)→ 账本不生成额外键值行", () => {
    const lines = ledgerLines(failedToolRun);
    expect(lines.filter((l) => /^[a-z_]+: /.test(l))).toEqual(["kind: python_tool", "id: add_integers"]);
  });
});

describe("hubItems", () => {
  it("有 artifact 的 run 进网格;无 artifact 的 failed run 不进网格", () => {
    const items = hubItems([draftSkillRun, savedSkillRun, failedToolRun, failedNoArtifactRun]);
    expect(items.map((i) => i.runId)).toEqual([
      "create_run_001",
      "create_run_001",
      "create_run_002",
    ]);
    expect(items.find((i) => i.runId === "create_run_003")).toBeUndefined();
  });

  it("卡片字段:name / metaText(类型·版本·状态)/ sourceText", () => {
    const [draft] = hubItems([draftSkillRun]);
    expect(draft.name).toBe("CSV to Markdown Table Converter");
    expect(draft.metaText).toBe("技能 · v1.0.0 · 待激活");
    expect(draft.sourceText).toBe("来源 Create · run 001");
  });

  it("saved 卡状态中文 = 已激活", () => {
    const [saved] = hubItems([savedSkillRun]);
    expect(saved.metaText).toContain("已激活");
  });

  it("无版本时 metaText 省略版本段", () => {
    const [tool] = hubItems([failedToolRun]);
    expect(tool.metaText).toBe("Python 工具 · 构建未通过");
  });
});

describe("groupHubItems", () => {
  it("按状态分组:已激活 → 草稿 → 其他(仅非空组,保序)", () => {
    const items = hubItems([draftSkillRun, savedSkillRun, failedToolRun]);
    const groups = groupHubItems(items);
    expect(groups.map((g) => g.label)).toEqual(["已激活", "草稿 · 待激活", "其他"]);
    expect(groups[0].items[0].runId).toBe("create_run_001"); // saved
    expect(groups[2].items[0].runId).toBe("create_run_002"); // failed-with-artifact
  });

  it("单一状态 → 单组", () => {
    const groups = groupHubItems(hubItems([savedSkillRun]));
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("已激活");
  });
});

describe("prefill 文案（ShellBus 引用）", () => {
  it("useInChatPrefill = 基于产物《name》（run tag）：", () => {
    const [item] = hubItems([draftSkillRun]);
    expect(useInChatPrefill(item)).toBe("基于产物《CSV to Markdown Table Converter》（run 001）：");
  });

  it("quotePrefill:引用块 + 剥离 frontmatter 的真内容首段(截断加省略号)", () => {
    const [item] = hubItems([draftSkillRun]);
    const q = quotePrefill(item);
    expect(q.startsWith("引用《CSV to Markdown Table Converter》的内容：\n> ")).toBe(true);
    expect(q).not.toContain("version: 1.0.0"); // frontmatter 已剥离
    expect(q).toContain("CSV"); // 正文真内容
  });

  it("quotePrefill:python_tool 无 frontmatter → 直接取代码", () => {
    const [item] = hubItems([failedToolRun]);
    const q = quotePrefill(item);
    expect(q).toContain("def add");
  });
});

describe("C3:verificationRows / ceremonyFacts(真字段,缺省不编)", () => {
  it("三面齐全 → 三行;valid=false/passed=false/blocked 如实标记", () => {
    const rows = verificationRows({
      validation: { valid: true, errors: [] },
      sandbox_result: { passed: false, exit_code: 1 },
      activation_eligibility: { activation_allowed: false, blocking_reasons: ["python_tool 激活未开放"] },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ ok: true, text: "读回校验通过" });
    expect(rows[1].ok).toBe(false);
    expect(rows[1].text).toContain("沙箱评测 未通过 · exit 1");
    expect(rows[2].ok).toBe(false);
    expect(rows[2].text).toContain("python_tool 激活未开放");
  });

  it("字段 null/缺失 → 不出行;全缺 → [](卡不渲染)", () => {
    expect(verificationRows({ validation: null, sandbox_result: null, activation_eligibility: null })).toHaveLength(0);
    expect(verificationRows({})).toHaveLength(0);
    const only = verificationRows({ activation_eligibility: { activation_allowed: true } });
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ ok: true, text: "激活资格 · ready" });
  });

  it("ceremonyFacts:瞬间=audit_events 数;时长=首末差;无时间戳=空", () => {
    const f = ceremonyFacts({
      audit_events: [
        { created_at: "2026-07-10T00:00:00Z" },
        { created_at: "2026-07-10T00:00:05.500Z" },
      ],
    });
    expect(f.moments).toBe(2);
    expect(f.durationText).toBe("5.5s");
    expect(ceremonyFacts({}).moments).toBe(0);
    expect(ceremonyFacts({}).durationText).toBe("");
  });
});
