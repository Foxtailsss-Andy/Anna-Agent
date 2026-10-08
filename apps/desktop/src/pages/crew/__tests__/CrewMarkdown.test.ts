/**
 * CrewMarkdown · 静态渲染测试(react-dom/server,真组件,沿 TraceWaterfall.test.ts 范式)。
 * 覆盖:GFM 表格进横向滚动容器 · GFM 扩展(删除线/任务列表/自动链接)· chart 代码块 → 可访问 SVG
 * + 数据表 · 非法 chart 回落原代码块 + 「图表数据无效」· 原始 HTML 不渲染。
 * 列宽 / 横向滚动是布局行为,由 tests/frontend/crew_ui.test.mjs 在真浏览器里量。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CrewMarkdown } from "../CrewMarkdown";

const strip = (html: string) => html.replace(/<!--.*?-->/g, "");
const render = (source: string) => strip(renderToStaticMarkup(createElement(CrewMarkdown, { source })));
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const chartBlock = (spec: unknown) => ["结论如下：", "", "```chart", JSON.stringify(spec), "```"].join("\n");

describe("CrewMarkdown · GFM", () => {
  const table = [
    "| 任务 | 负责人 | 状态 | 截止 | 备注 |",
    "| --- | :---: | --- | ---: | --- |",
    "| 登录页 **重设计** | Andy | 进行中 | 10-12 | 依赖设计评审 |",
    "| 文案 | Agent·Copy | 待开始 | 10-15 | |",
  ].join("\n");

  it("renders a pipe table as a real table inside the horizontal scroll wrapper", () => {
    const html = render(`## 进度\n\n${table}\n\n结论：按期。`);
    expect(html).toMatch(/<div class="crew-md__tablewrap"[^>]*><table class="crew-md__table"><thead><tr><th>任务<\/th>/);
    expect(count(html, /<th[ >]/g)).toBe(5);
    expect(count(html, /<td[ >]/g)).toBe(10);
    expect(html).toContain("<strong>重设计</strong>");
    expect(html).toContain('<th style="text-align:center">负责人</th>');
    expect(html).toContain("<h2>进度</h2>");
    expect(html).toContain("<p>结论：按期。</p>");
  });

  it("the scroll wrapper is keyboard-reachable and labelled", () => {
    const html = render(table);
    expect(html).toMatch(/<div class="crew-md__tablewrap" tabindex="0" role="region" aria-label="表格（可横向滚动）">/);
  });

  it("renders strikethrough, task lists and autolinks", () => {
    const html = render("~~旧方案~~\n\n- [x] 已完成\n- [ ] 待办\n\n见 https://example.com/spec");
    expect(html).toContain("<del>旧方案</del>");
    expect(count(html, /type="checkbox"/g)).toBe(2);
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/>/);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/spec" target="_blank" rel="noreferrer noopener">https:\/\/example\.com\/spec<\/a>/);
  });

  it("does not render raw HTML (no rehype-raw)", () => {
    const html = render("<script>alert(1)</script>\n\n正文");
    expect(html).not.toContain("<script>");
    expect(html).toContain("正文");
  });

  it("empty source renders nothing", () => {
    expect(render("   \n")).toBe("");
  });
});

describe("CrewMarkdown · chart blocks", () => {
  const bar = {
    type: "bar",
    title: "各渠道线索",
    labels: ["官网", "展会", "转介绍"],
    series: [
      { name: "9 月", values: [120, 45, 30] },
      { name: "10 月", values: [150, 60, 42] },
    ],
    unit: "条",
  };

  it("bar chart → accessible inline SVG with one bar per value, legend and data table", () => {
    const html = render(chartBlock(bar));
    expect(html).toContain("<p>结论如下：</p>");
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="柱状图：各渠道线索"/);
    expect(count(html, /class="crew-chart__bar /g)).toBe(6);
    // 悬停可读:每根柱子的 <title> 带标签 · 系列 · 值 + 单位
    expect(html).toContain("<title>官网 · 10 月：150 条</title>");
    // 坐标轴标签
    expect(html).toContain(">转介绍</text>");
    // >1 系列 → 图例
    expect(html).toMatch(/<ul class="crew-chart__legend"[^>]*>.*9 月.*10 月.*<\/ul>/);
    // <details> 数据表(值原样,不改写)
    expect(html).toMatch(/<details class="crew-chart__data"><summary>数据表<\/summary>/);
    expect(html).toContain("<th scope=\"row\">展会</th><td>45</td><td>60</td>");
    expect(html).not.toContain("图表数据无效");
    expect(html).not.toContain("language-chart");
  });

  it("line chart → one line per series; single series has no legend", () => {
    const html = render(chartBlock({ type: "line", labels: ["W1", "W2", "W3", "W4"], series: [{ name: "完成率", values: [10, 35, 60, 90] }], unit: "%" }));
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="折线图：完成率"/);
    expect(count(html, /class="crew-chart__line /g)).toBe(1);
    expect(count(html, /class="crew-chart__point /g)).toBe(4);
    expect(html).toContain("<title>W3 · 完成率：60 %</title>");
    expect(html).not.toContain("crew-chart__legend");
  });

  it("negative values are drawn below a zero baseline, not clipped", () => {
    const html = render(chartBlock({ type: "bar", title: "利润", labels: ["Q1", "Q2"], series: [{ name: "利润", values: [-20, 40] }] }));
    expect(count(html, /class="crew-chart__bar /g)).toBe(2);
    expect(html).toContain("<title>Q1 · 利润：-20</title>");
    expect(html).toContain('class="crew-chart__zero"');
  });

  const invalidCases: Array<[string, string]> = [
    ["broken JSON", "{\"type\": \"bar\", \"labels\": ["],
    ["unknown type", JSON.stringify({ type: "pie", labels: ["a"], series: [{ name: "s", values: [1] }] })],
    ["values length ≠ labels length", JSON.stringify({ type: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] })],
    ["non-numeric value", JSON.stringify({ type: "bar", labels: ["a"], series: [{ name: "s", values: ["1"] }] })],
    ["more than 50 labels", JSON.stringify({ type: "line", labels: Array.from({ length: 51 }, (_, i) => `d${i}`), series: [{ name: "s", values: Array.from({ length: 51 }, () => 1) }] })],
    ["more than 8 series", JSON.stringify({ type: "bar", labels: ["a"], series: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, values: [i] })) })],
    ["no series", JSON.stringify({ type: "bar", labels: ["a"], series: [] })],
  ];

  for (const [name, body] of invalidCases) {
    it(`invalid chart (${name}) → original code block + short note`, () => {
      const html = render(["```chart", body, "```"].join("\n"));
      expect(html).not.toContain('role="img"');
      expect(html).toContain('<code class="language-chart">');
      expect(html).toContain("图表数据无效");
    });
  }

  it("other fenced languages stay ordinary code blocks", () => {
    const html = render("```json\n{\"a\":1}\n```");
    expect(html).toContain('<pre><code class="language-json">');
    expect(html).not.toContain("图表数据无效");
  });
});
