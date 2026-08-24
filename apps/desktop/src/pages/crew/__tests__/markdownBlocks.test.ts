/**
 * markdownBlocks · R-F1 纯函数测试:GFM 管道表格剥离(react-markdown 无 remark-gfm 兜底)。
 * 覆盖:表格解析(表头/对齐/补齐/转义)、非法拒绝(不造表)、源分段(文本↔表格交错保序)。
 */
import { describe, expect, it } from "vitest";

import {
  parsePipeTable,
  splitMarkdownSegments,
  type MarkdownSegment,
} from "../markdownBlocks";

describe("parsePipeTable(候选块 → 结构化表格 / 非法 → null)", () => {
  it("标准表格:表头 + 体行", () => {
    const t = parsePipeTable(["| 项目 | 状态 |", "| --- | --- |", "| 登录页 | 进行中 |"]);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["项目", "状态"]);
    expect(t!.rows).toEqual([["登录页", "进行中"]]);
  });

  it("列对齐:左 / 中 / 右 / 默认", () => {
    const t = parsePipeTable(["| a | b | c | d |", "| :--- | :---: | ---: | --- |", "| 1 | 2 | 3 | 4 |"]);
    expect(t!.align).toEqual(["left", "center", "right", null]);
  });

  it("无外围管道也可解析", () => {
    const t = parsePipeTable(["a | b", "--- | ---", "1 | 2"]);
    expect(t!.headers).toEqual(["a", "b"]);
    expect(t!.rows).toEqual([["1", "2"]]);
  });

  it("体行列数不足 → 补空;超出 → 截断到表头列数", () => {
    const t = parsePipeTable(["| a | b | c |", "| --- | --- | --- |", "| 1 |", "| 1 | 2 | 3 | 4 |"]);
    expect(t!.rows).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
  });

  it("转义管道 `\\|` 视作字面量,不切分单元格", () => {
    const t = parsePipeTable(["| 键 | 值 |", "| --- | --- |", "| a \\| b | c |"]);
    expect(t!.rows).toEqual([["a | b", "c"]]);
  });

  it("仅表头+分隔(无体行)→ rows 为空但仍是表格", () => {
    const t = parsePipeTable(["| a | b |", "| --- | --- |"]);
    expect(t!.rows).toEqual([]);
  });

  it("表头与分隔列数不一致 → null(不造表)", () => {
    expect(parsePipeTable(["| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 |"])).toBeNull();
  });

  it("第二行不是分隔行 → null", () => {
    expect(parsePipeTable(["| a | b |", "| 1 | 2 |"])).toBeNull();
  });

  it("不足两行 → null", () => {
    expect(parsePipeTable(["| a | b |"])).toBeNull();
  });
});

describe("splitMarkdownSegments(源 → 有序段;文本与表格交错保序)", () => {
  const kinds = (segs: MarkdownSegment[]) => segs.map((s) => s.kind);

  it("纯文本(无表格)→ 单个 markdown 段", () => {
    const segs = splitMarkdownSegments("# 标题\n\n一段正文。");
    expect(kinds(segs)).toEqual(["markdown"]);
    expect((segs[0] as { text: string }).text).toContain("# 标题");
  });

  it("纯表格 → 单个 table 段", () => {
    const segs = splitMarkdownSegments("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(kinds(segs)).toEqual(["table"]);
  });

  it("文本 + 表格 + 文本 → 三段保序", () => {
    const src = ["## 指标", "", "| 名 | 值 |", "| --- | --- |", "| PV | 100 |", "", "结论:达标。"].join("\n");
    const segs = splitMarkdownSegments(src);
    expect(kinds(segs)).toEqual(["markdown", "table", "markdown"]);
    expect((segs[0] as { text: string }).text).toContain("## 指标");
    expect((segs[2] as { text: string }).text).toContain("结论");
  });

  it("两张表格之间夹文本 → 表/文本/表", () => {
    const src = ["| a |", "| --- |", "| 1 |", "", "中间说明", "", "| b |", "| --- |", "| 2 |"].join("\n");
    const segs = splitMarkdownSegments(src);
    expect(kinds(segs)).toEqual(["table", "markdown", "table"]);
  });

  it("空源 / 纯空白 → 无段(不造内容)", () => {
    expect(splitMarkdownSegments("")).toEqual([]);
    expect(splitMarkdownSegments("   \n\n  ")).toEqual([]);
  });

  it("散文里的竖线不误判为表格(无分隔行)", () => {
    const segs = splitMarkdownSegments("方案 A | 方案 B 二选一。\n继续说明。");
    expect(kinds(segs)).toEqual(["markdown"]);
  });
});
