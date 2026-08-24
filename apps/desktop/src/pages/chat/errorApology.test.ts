import { describe, expect, it } from "vitest";
import { errorApology } from "./errorApology";

describe("errorApology(error 原文 → 卡外致歉,先致歉再归因,不甩锅用户)", () => {
  it("超时类:命中 timeout / timed out / 超时 → 执行超时归因", () => {
    for (const msg of ["timeout", "request timed out after 30s", "上游调用超时(30s)"]) {
      const t = errorApology(msg);
      expect(t).toContain("抱歉");
      expect(t).toContain("超时");
    }
  });
  it("模型未配置:命中 model_not_configured / model endpoint and API key → 模型未配置归因", () => {
    for (const msg of [
      "model_not_configured",
      "model endpoint and API key are required before running Anna Chat",
    ]) {
      const t = errorApology(msg);
      expect(t).toContain("抱歉");
      expect(t).toContain("模型");
      expect(t).toContain("配置");
    }
  });
  it("连接中断:命中 client_disconnected / disconnected → 连接中断归因", () => {
    for (const msg of ["client_disconnected", "client disconnected before the chat run finished"]) {
      const t = errorApology(msg);
      expect(t).toContain("抱歉");
      expect(t).toContain("连接中断");
    }
  });
  it("其余:通用致歉(先致歉,不甩锅),不臆造具体缘由", () => {
    const t = errorApology("ERP MCP connector is not connected");
    expect(t).toContain("抱歉");
    // 通用文案不臆断为超时/配置/断连
    expect(t).not.toContain("超时");
    expect(t).not.toContain("连接中断");
  });
  it("空串也给通用致歉,不抛错", () => {
    expect(() => errorApology("")).not.toThrow();
    expect(errorApology("")).toContain("抱歉");
  });
  it("语体红线:每个分支都先致歉(以『抱歉』起头),不甩锅用户", () => {
    for (const msg of ["timeout", "model_not_configured", "client_disconnected", "weird"]) {
      const t = errorApology(msg);
      // 先致歉:开头即『抱歉』
      expect(t.startsWith("抱歉")).toBe(true);
      // 不甩锅:若提及『您的吩咐』,必以否定语气(并非/不是)出现,而非归咎
      if (/您的吩咐/.test(t)) expect(t).toMatch(/(并非|不是).{0,3}您的吩咐/);
    }
  });
});
