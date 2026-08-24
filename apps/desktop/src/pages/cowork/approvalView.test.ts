import { describe, expect, it } from "vitest";
import { confirmProps, supplementProps } from "./approvalView";

/* 真跑形态(reality-check 2026-07-10,run_169 / 线上 ReimbursementRun.model_dump) */
const WAITING_RUN = {
  id: "run_169",
  status: "waiting_confirmation",
  input_text: "帮我报销一笔餐饮费…",
  missing_fields: [],
  agent_message: "草稿已创建成功…",
  draft: {
    category: "餐饮费",
    amount: 860.0,
    currency: "CNY",
    expense_date: "2026-06-14",
    merchant: "上海老正兴菜馆",
    reason: "客户拜访商务宴请",
    external_reimbursement_id: "cmqggt5do000yvbbnb1ml8166",
    external_status: "draft",
  },
  approval: {
    id: "approval_010",
    run_id: "run_169",
    action_type: "reimbursement.submit",
    risk_level: "low",
    status: "pending",
    payload: {
      amount: 860,
      currency: "CNY",
      external_reimbursement_id: "cmqggt5do000yvbbnb1ml8166",
      policy_summary: "草稿校验通过。",
      reason: "客户拜访商务宴请",
    },
    payload_hash: "cea9d082",
    draft_snapshot: {
      amount: 860.0,
      category: "餐饮费",
      currency: "CNY",
      expense_date: "2026-06-14",
      merchant: "上海老正兴菜馆",
      reason: "客户拜访商务宴请",
      external_reimbursement_id: "cmqggt5do000yvbbnb1ml8166",
      external_status: "draft",
    },
  },
} as Record<string, unknown>;

const COLLECTING_STRUCTURED = {
  id: "run_200",
  status: "collecting",
  missing_fields: ["amount", "expense_date"],
  agent_message: null,
  draft: { currency: "CNY" },
  approval: null,
} as Record<string, unknown>;

const COLLECTING_FREEFORM = {
  id: "run_316",
  status: "collecting",
  missing_fields: [],
  agent_message: "请补充费用类别、金额、日期与商户。",
  draft: {},
  approval: null,
} as Record<string, unknown>;

const COMPLETED_RUN = {
  id: "run_158",
  status: "completed",
  missing_fields: [],
  draft: { external_reimbursement_id: "cmqf4dbqw", external_status: "submitted" },
  approval: { id: "approval_004", status: "approved", risk_level: "low", payload: {} },
} as Record<string, unknown>;

describe("confirmProps(waiting_confirmation run → 对账卡 props)", () => {
  it("非 waiting_confirmation / 无 approval → null", () => {
    expect(confirmProps(COLLECTING_STRUCTURED)).toBeNull();
    expect(confirmProps(COMPLETED_RUN)).toBeNull(); // approval 已 approved,非 pending
    expect(confirmProps({ status: "waiting_confirmation", approval: null })).toBeNull();
  });

  it("variant=confirm;risk 直通 approval.risk_level", () => {
    const p = confirmProps(WAITING_RUN)!;
    expect(p).not.toBeNull();
    expect(p.variant).toBe("confirm");
    expect(p.risk).toBe("low");
  });

  it("字段网格来自 draft_snapshot:单据号/金额+币种/日期用 mono,事由/类别不 mono", () => {
    const p = confirmProps(WAITING_RUN)!;
    const by = (label: string) => p.fields!.find((f) => f.label === label);
    expect(by("单据号")!.value).toBe("cmqggt5do000yvbbnb1ml8166");
    expect(by("单据号")!.mono).not.toBe(false);
    expect(by("金额")!.value).toContain("860");
    expect(by("金额")!.value).toContain("CNY");
    expect(by("金额")!.mono).not.toBe(false);
    expect(by("发生日期")!.value).toBe("2026-06-14");
    expect(by("事由")!.value).toBe("客户拜访商务宴请");
    expect(by("事由")!.mono).toBe(false);
    expect(by("费用类别")!.value).toBe("餐饮费");
    expect(by("费用类别")!.mono).toBe(false);
  });

  it("payloadText = approval.payload 的 JSON 原文,一字不改(可逆解析回同一对象)", () => {
    const p = confirmProps(WAITING_RUN)!;
    expect(p.payloadText).toBe(JSON.stringify((WAITING_RUN.approval as Record<string, unknown>).payload, null, 2));
    expect(JSON.parse(p.payloadText!)).toEqual((WAITING_RUN.approval as Record<string, unknown>).payload);
  });

  it("risk_level 非 low/medium/high(未知值)→ risk 留空(不造假 chip),props 仍返回", () => {
    const weird = {
      ...WAITING_RUN,
      approval: { ...(WAITING_RUN.approval as Record<string, unknown>), risk_level: "critical" },
    } as Record<string, unknown>;
    const p = confirmProps(weird)!;
    expect(p).not.toBeNull();
    expect(p.risk).toBeUndefined();
  });
});

describe("supplementProps(collecting run → 补录卡 props)", () => {
  it("非 collecting → null", () => {
    expect(supplementProps(WAITING_RUN)).toBeNull();
    expect(supplementProps(COMPLETED_RUN)).toBeNull();
  });

  it("missing_fields 结构化 → 逐字段映射类型(金额=number,日期=date)", () => {
    const p = supplementProps(COLLECTING_STRUCTURED)!;
    expect(p.variant).toBe("supplement");
    const ids = p.supplementFields!.map((f) => f.id);
    expect(ids).toEqual(["amount", "expense_date"]);
    const amount = p.supplementFields!.find((f) => f.id === "amount")!;
    expect(amount.type).toBe("number");
    expect(amount.label).toBe("金额");
    expect(p.supplementFields!.find((f) => f.id === "expense_date")!.type).toBe("date");
  });

  it("附件字段 → type=file(页面级 AttachmentPicker 承接,卡内虚线站位)", () => {
    const p = supplementProps({ status: "collecting", missing_fields: ["attachments"] })!;
    expect(p.supplementFields!.find((f) => f.id === "attachments")!.type).toBe("file");
  });

  it("collecting 但 missing_fields 空(模型自由发问)→ 回退核心可编辑字段(D-R6-2,非空)", () => {
    const p = supplementProps(COLLECTING_FREEFORM)!;
    expect(p.variant).toBe("supplement");
    expect(p.supplementFields!.length).toBeGreaterThan(0);
    // 回退集为真实可编辑草稿字段
    expect(p.supplementFields!.map((f) => f.id)).toContain("amount");
    expect(p.supplementFields!.map((f) => f.id)).toContain("expense_date");
  });
});
