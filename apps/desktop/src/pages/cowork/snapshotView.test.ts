import { describe, expect, it } from "vitest";

import { dashboardFailKind, hikerView } from "./snapshotView";
import type { HikerSnapshotIn } from "./snapshotView";

/* Synthetic fixture matching the public Anna-side connector schema. */

const HIKER: HikerSnapshotIn = {
  source: "Hiker MCP",
  kpis: [
    { id: "contract_count", label: "合同数", value: 8, unit: "个" },
    { id: "contract_amount", label: "合同总额", value: 12487573, unit: "¥" },
    { id: "unreceived", label: "未收款", value: 699625.01, unit: "¥" },
  ],
  collection: { planned_amount: 2682868.7, actual_amount: 1983243.69, unreceived_amount: 699625.01 },
  aging_buckets: [
    { id: "not_due", label: "未到期", count: 1, amount: 300000 },
    { id: "overdue_1_30", label: "逾期 1-30", count: 7, amount: 94979 },
    { id: "overdue_31_60", label: "逾期 31-60", count: 0, amount: 0 },
  ],
  risk_due_soon_count: 0,
  risk_overdue_count: 7,
  top_customers: [
    { customer_name: "示例客户甲", contract_count: 1, contract_amount: 9000000, planned_receipt_amount: 2000000, actual_receipt_amount: 1700000, unreceived_amount: 300000 },
  ],
  anomalies: [
    { id: "concentration", title: "客户集中度高", severity: "high", explanation: "单一客户占 72%。" },
  ],
};

describe("dashboardFailKind", () => {
  it("connector 类 error_code → offline", () => {
    expect(dashboardFailKind("erp_not_connected")).toBe("offline");
    expect(dashboardFailKind("not_ready")).toBe("offline");
    expect(dashboardFailKind("hiker_not_configured")).toBe("offline");
  });
  it("model 类失败 → error(模型不该阻断代码计算的看板)", () => {
    expect(dashboardFailKind("model_not_configured", "缺少 API key")).toBe("error");
    expect(dashboardFailKind("model_not_ready")).toBe("error");
  });
  it("连接层拒绝(WinError 10061 / refused)→ offline", () => {
    expect(dashboardFailKind("mcp_call_failed", "[WinError 10061] No connection could be made because the target machine actively refused it")).toBe("offline");
    expect(dashboardFailKind("mcp_call_failed", "Connection refused")).toBe("offline");
  });
  it("其余失败 → error(如实呈原文)", () => {
    expect(dashboardFailKind("not_found", "期间无数据")).toBe("error");
    expect(dashboardFailKind("model_not_configured", "缺少 API key")).toBe("error");
    expect(dashboardFailKind("mcp_call_failed", "tool arg invalid")).toBe("error");
    expect(dashboardFailKind("")).toBe("error");
  });
});

describe("hikerView", () => {
  it("hero = kpis[0];金额 unit ¥ → 压缩,个数 → 原样", () => {
    const v = hikerView(HIKER);
    expect(v.kpis[0].hero).toBe(true);
    expect(v.kpis[0].id).toBe("contract_count");
    expect(v.kpis[0].value).toBe("8个");
    expect(v.kpis.find((k) => k.id === "contract_amount")!.value).toBe("¥1248.8万");
  });

  it("risk 计数 >0 → alert;均 0 → null", () => {
    const v = hikerView(HIKER);
    expect(v.alert?.explanation).toContain("已逾期 7 笔");
    expect(v.alert?.explanation).not.toContain("即将到期"); // due_soon=0 不出
    const zero = hikerView({ ...HIKER, risk_overdue_count: 0, risk_due_soon_count: 0 });
    expect(zero.alert).toBeNull();
  });

  it("collection → 3 条 MetricBar,对计划额归一", () => {
    const v = hikerView(HIKER);
    expect(v.collection.map((b) => b.name)).toEqual(["计划收款", "实际收款", "未收款"]);
    expect(v.collection[0].ratio).toBe(1); // 计划 = 基准
    expect(v.collection[1].ratio).toBeCloseTo(1983243.69 / 2682868.7);
    expect(v.collection[2].tone).toBe("warn"); // 未收 = 风险色
  });

  it("aging_buckets → MetricBar 列,对最大额归一;逾期桶有额=warn", () => {
    const v = hikerView(HIKER);
    expect(v.aging[0].ratio).toBe(1); // not_due 300000 = max
    expect(v.aging[1].tone).toBe("warn"); // overdue_1_30 有额
    expect(v.aging[0].tone).toBe("iris"); // not_due
  });

  it("top_customers → ir-table 行(首列名 + mono 数字列)", () => {
    const v = hikerView(HIKER);
    expect(v.topCustomers.columns[0]).toBe("客户");
    expect(v.topCustomers.rows[0][0]).toBe("示例客户甲");
    expect(v.topCustomers.rows[0]).toContain("¥900万");
  });

  it("anomalies → 洞察", () => {
    const v = hikerView(HIKER);
    expect(v.insights.map((i) => i.id)).toEqual(["concentration"]);
  });

  it("字段全缺省不 throw", () => {
    expect(() => hikerView({})).not.toThrow();
    const v = hikerView({});
    expect(v.alert).toBeNull();
    expect(v.kpis).toEqual([]);
    expect(v.collection).toEqual([]);
    expect(v.topCustomers.rows).toEqual([]);
  });
});
