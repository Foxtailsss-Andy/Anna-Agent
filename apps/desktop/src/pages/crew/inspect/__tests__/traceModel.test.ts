/**
 * traceModel · 三级 Trace 纯归约契约
 *   StepKind → 类型 tag / L3 呈现类型判别 / 首行摘要 / 结果文案 / 回合→扁平 L2 行。
 */
import { describe, expect, it } from "vitest";

import type { Step, Turn } from "../../../../lib/turns";
import { firstLine, l3Kind, stepTypeTag, toL2Rows, traceResultText } from "../traceModel";

const step = (over: Partial<Step> = {}): Step => ({
  id: "s1",
  kind: "thinking",
  label: "读取 PRD",
  status: "ok",
  ...over,
});

describe("stepTypeTag · StepKind → 类型 tag(思考/调用/生成/错误)", () => {
  it("四类映射", () => {
    expect(stepTypeTag("thinking")).toBe("思考");
    expect(stepTypeTag("tool")).toBe("调用");
    expect(stepTypeTag("system")).toBe("生成");
    expect(stepTypeTag("error")).toBe("错误");
  });
});

describe("l3Kind · L3 呈现类型判别(§3j 裁定③)", () => {
  it("text/thinking 原文 → markdown 渲染", () => {
    expect(l3Kind(step({ l3: { form: "text", text: "# 标题" } }))).toBe("markdown");
  });
  it("工具 args/result → mono 等宽降噪", () => {
    expect(l3Kind(step({ kind: "tool", l3: { form: "tool", argsPreview: "{...}" } }))).toBe("mono");
  });
  it("无 L3 → null(不可掀,不出箭头)", () => {
    expect(l3Kind(step({ l3: undefined }))).toBeNull();
  });
});

describe("firstLine · 单行摘要", () => {
  it("多行取第一行并去空白", () => {
    expect(firstLine("  第一行  \n第二行")).toBe("第一行");
  });
  it("空串 → 空串(不猜)", () => {
    expect(firstLine("")).toBe("");
  });
});

describe("traceResultText · 结果文案(零捏造)", () => {
  it("done + 版本 → 产物 vN", () => {
    expect(traceResultText("done", 2)).toBe("产物 v2");
  });
  it("done 无版本 → 完成", () => {
    expect(traceResultText("done", null)).toBe("完成");
  });
  it("blocked → 阻塞", () => {
    expect(traceResultText("blocked", null)).toBe("阻塞");
  });
  it("运行中(null)→ 进行中", () => {
    expect(traceResultText(null, null)).toBe("进行中");
  });
  it("其他终态(failed)→ 失败", () => {
    expect(traceResultText("failed", null)).toBe("失败");
  });
});

describe("toL2Rows · 回合 → 扁平 L2 行(每帧一行)", () => {
  const turn = (over: Partial<Turn> = {}): Turn => ({
    id: "t1",
    index: 1,
    status: "ok",
    steps: [],
    toolCount: 0,
    hasThinking: false,
    ...over,
  });

  it("跨回合扁平化,携 id/tag/kind/summary/l3kind/defaultOpen", () => {
    const turns = [
      turn({ index: 0, steps: [step({ id: "a", kind: "system", label: "接下任务", status: "ok" })] }),
      turn({
        index: 1,
        steps: [
          step({ id: "b", kind: "thinking", label: "分析\n多行", status: "ok", l3: { form: "text", text: "推理原文" } }),
          step({ id: "c", kind: "tool", label: "search", status: "ok" }),
          step({ id: "d", kind: "error", label: "模型不可用", status: "fail", defaultOpen: true, l3: { form: "text", text: "err", tone: "danger" } }),
        ],
      }),
    ];
    const rows = toL2Rows(turns);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(rows[0].tag).toBe("生成"); // system
    expect(rows[1].tag).toBe("思考");
    expect(rows[1].summary).toBe("分析"); // 首行截断
    expect(rows[1].l3kind).toBe("markdown");
    expect(rows[1].defaultOpen).toBe(false);
    expect(rows[2].l3kind).toBeNull(); // tool 无 l3 → 不可掀
    expect(rows[3].tag).toBe("错误");
    expect(rows[3].defaultOpen).toBe(true); // 失败步默认掀开留证
  });

  it("空回合 → 空行列", () => {
    expect(toL2Rows([])).toEqual([]);
  });
});
