/**
 * egressModel(J4)· 数据出境披露的呈现映射
 *
 * 这张卡的唯一价值是「可信」,所以映射层的断言几乎都是**不许说假话**:
 * 未配置的目的地不许出现主机名或连接状态、坏掉的探针不许被渲染成绿点、
 * 后端没给的字段不许由前端补一个体面的默认值 —— 包括那三条「无遥测/无训练回传/
 * 记忆在本机」的声明:它们必须来自载荷,后端不说就不说,后端说了不诚实的值就报警。
 */
import { describe, expect, it } from "vitest";

import {
  egressClaims,
  egressDesc,
  egressRows,
  egressScopeNote,
  egressSummary,
  egressWarning,
} from "./egressModel";

const PAYLOAD = {
  destinations: [
    {
      id: "model_api",
      label: "模型 API",
      destination: "https://model.example/v1/chat/completions",
      data_categories: ["对话内容", "工具调用结果"],
      configured: true,
      last_probe_status: null,
    },
    {
      id: "erp_mcp",
      label: "ERP MCP",
      destination: "https://erp.example/mcp",
      data_categories: ["查询参数"],
      configured: true,
      last_probe_status: "connected",
    },
    {
      id: "hiker_mcp",
      label: "Hiker MCP",
      destination: "https://hiker.example/mcp",
      data_categories: ["查询参数"],
      configured: true,
      last_probe_status: "unhealthy",
    },
    {
      id: "reimbursement_mcp",
      label: "报销 MCP",
      destination: null,
      data_categories: ["报销单字段"],
      configured: false,
      last_probe_status: null,
    },
  ],
  telemetry: false,
  training_feedback: false,
  memory_location: "local",
  counts_available: false,
  disclosure_version: 1,
};

/* 路由不再探针(探一次页面就自己造一次出境),探针态由设置页手上那份
   /api/admin/runtime/status 合并进来 —— 同一份真值,零额外请求。 */
const NO_PROBE_PAYLOAD = {
  destinations: PAYLOAD.destinations.map((d) => ({ ...d, last_probe_status: null })),
};

const RUNTIME_STATUS = {
  reimbursement_mcp: { status: "connected", tool_count: 3 },
  erp_mcp: { status: "connected", tool_count: 2 },
  hiker_mcp: { status: "unhealthy", error_code: "mcp_error" },
};

describe("egressRows", () => {
  it("已配置的目的地显示真实主机与它会收到什么", () => {
    const byId = Object.fromEntries(egressRows(PAYLOAD)!.map((r) => [r.id, r]));
    expect(byId.model_api.destinationText).toBe("https://model.example/v1/chat/completions");
    expect(byId.model_api.categoriesText).toBe("对话内容 · 工具调用结果");
    expect(byId.model_api.configured).toBe(true);
  });

  it("未配置 → 不显示主机、不显示连接态、点是灰的", () => {
    const row = egressRows(PAYLOAD)!.find((r) => r.id === "reimbursement_mcp")!;
    expect(row.destinationText).toBe("未配置");
    expect(row.stateText).toBe("未配置");
    expect(row.tone).toBe("off");
    // 未配置也要说清「一旦配置会送什么」——这是披露不是隐藏。
    expect(row.categoriesText).toBe("报销单字段");
  });

  it("探针失败 → 警告色,如实回显后端状态(不粉饰成已连接)", () => {
    const row = egressRows(PAYLOAD)!.find((r) => r.id === "hiker_mcp")!;
    expect(row.tone).toBe("warn");
    expect(row.stateText).toContain("unhealthy");
  });

  it("探针已连接 → ok", () => {
    const row = egressRows(PAYLOAD)!.find((r) => r.id === "erp_mcp")!;
    expect(row.tone).toBe("ok");
    expect(row.stateText).toBe("已连接");
  });

  it("已配置但没有探针(模型 API 无探针)→ 只说已配置,不谎称已连接", () => {
    const row = egressRows(PAYLOAD)!.find((r) => r.id === "model_api")!;
    expect(row.stateText).toBe("已配置");
    expect(row.tone).toBe("ok");
  });

  it("载荷读不到 → null(与「后端给了空清单」区分开,不都塌成空数组)", () => {
    expect(egressRows(null)).toBeNull();
    expect(egressRows(undefined)).toBeNull();
    expect(egressRows({})).toBeNull();
    expect(egressRows({ destinations: "nope" })).toBeNull();
  });

  it("清单在、但条目全是畸形 → 空数组(读到了,只是没有可信的行)", () => {
    expect(egressRows({ destinations: [] })).toEqual([]);
    expect(egressRows({ destinations: [null, 3] })).toEqual([]);
  });

  it("后端没给 data_categories → 不编一个,留空", () => {
    const rows = egressRows({
      destinations: [{ id: "x", label: "X", configured: true, destination: "https://x.example" }],
    })!;
    expect(rows[0].categoriesText).toBe("");
  });
});

describe("egressRows · 探针态由运行时状态合并(路由不再自己探)", () => {
  it("三个 MCP 行各取自己的状态;model_api 不受影响(它本就没有探针)", () => {
    const byId = Object.fromEntries(
      egressRows(NO_PROBE_PAYLOAD, RUNTIME_STATUS)!.map((r) => [r.id, r]),
    );
    expect(byId.erp_mcp.stateText).toBe("已连接");
    expect(byId.erp_mcp.tone).toBe("ok");
    expect(byId.hiker_mcp.stateText).toContain("unhealthy");
    expect(byId.hiker_mcp.tone).toBe("warn");
    expect(byId.model_api.stateText).toBe("已配置");
  });

  it("未配置的目的地即使状态表里有话也不显示连接态", () => {
    const row = egressRows(NO_PROBE_PAYLOAD, RUNTIME_STATUS)!.find(
      (r) => r.id === "reimbursement_mcp",
    )!;
    expect(row.stateText).toBe("未配置");
    expect(row.tone).toBe("off");
  });

  it("没有状态表 → 只说已配置,不猜连接", () => {
    const row = egressRows(NO_PROBE_PAYLOAD)!.find((r) => r.id === "erp_mcp")!;
    expect(row.stateText).toBe("已配置");
  });

  it("后端自己给了探针态 → 以后端为准(状态表只是补位)", () => {
    const row = egressRows(PAYLOAD, {
      ...RUNTIME_STATUS,
      hiker_mcp: { status: "connected" },
    })!.find((r) => r.id === "hiker_mcp")!;
    expect(row.stateText).toContain("unhealthy");
  });

  it("状态表畸形 → 当作没有,不崩", () => {
    expect(egressRows(NO_PROBE_PAYLOAD, "nope")!.length).toBe(4);
    expect(egressRows(NO_PROBE_PAYLOAD, { erp_mcp: 7 })!.length).toBe(4);
  });
});

describe("egressClaims · 三条声明必须来自载荷", () => {
  it("后端真值原样读出", () => {
    expect(egressClaims(PAYLOAD)).toEqual({
      telemetry: false,
      trainingFeedback: false,
      memoryLocation: "local",
      countsAvailable: false,
      disclosureVersion: 1,
    });
  });

  it("后端没给 → null 字段,绝不补一个「诚实」的默认值", () => {
    expect(egressClaims({ destinations: [] })).toEqual({
      telemetry: null,
      trainingFeedback: null,
      memoryLocation: null,
      countsAvailable: null,
      disclosureVersion: null,
    });
  });

  it("读不到载荷 → null", () => {
    expect(egressClaims(null)).toBeNull();
    expect(egressClaims("nope")).toBeNull();
  });
});

describe("egressDesc / egressWarning · 卡片文案由数据生成", () => {
  it("三条都诚实 → 三句都说,无警示", () => {
    const desc = egressDesc(PAYLOAD);
    expect(desc).toContain("只向下面这些你自己配置的端点发送数据");
    expect(desc).toContain("无遥测");
    expect(desc).toContain("无训练回传");
    expect(desc).toContain("记忆全部留在本机");
    expect(egressWarning(PAYLOAD)).toBeNull();
  });

  it("后端没给三条 → 一句都不许承诺(宁可少说)", () => {
    const desc = egressDesc({ destinations: [] });
    expect(desc).not.toContain("无遥测");
    expect(desc).not.toContain("无训练回传");
    expect(desc).not.toContain("记忆全部留在本机");
    expect(egressWarning({ destinations: [] })).toBeNull();
  });

  it("遥测被打开 → 不承诺无遥测,并给出醒目警示", () => {
    const payload = { ...PAYLOAD, telemetry: true };
    expect(egressDesc(payload)).not.toContain("无遥测");
    expect(egressWarning(payload)).toContain("遥测");
  });

  it("训练回传被打开 → 警示", () => {
    const payload = { ...PAYLOAD, training_feedback: true };
    expect(egressDesc(payload)).not.toContain("无训练回传");
    expect(egressWarning(payload)).toContain("训练回传");
  });

  it("记忆不在本机 → 如实说出它在哪,并警示", () => {
    const payload = { ...PAYLOAD, memory_location: "cloud" };
    expect(egressDesc(payload)).toContain("cloud");
    expect(egressDesc(payload)).not.toContain("记忆全部留在本机");
    expect(egressWarning(payload)).toContain("记忆");
  });

  it("读不到载荷 → 不说任何话(卡片自己会说读不到)", () => {
    expect(egressDesc(null)).toBe("");
    expect(egressWarning(null)).toBeNull();
  });
});

describe("egressScopeNote · v1 自述范围", () => {
  it("披露版本与计数能力如实标注", () => {
    const note = egressScopeNote(PAYLOAD);
    expect(note).toContain("v1");
    expect(note).toContain("计数");
  });

  it("后端没给 → 留白", () => {
    expect(egressScopeNote({ destinations: [] })).toBe("");
    expect(egressScopeNote(null)).toBe("");
  });
});

describe("egressSummary", () => {
  it("按真实计数汇总(已配置/全部)", () => {
    expect(egressSummary(PAYLOAD)).toBe("3/4 已配置");
  });

  it("无数据 → 不报 0/0 之类的假汇总", () => {
    expect(egressSummary(null)).toBe("");
  });
});
