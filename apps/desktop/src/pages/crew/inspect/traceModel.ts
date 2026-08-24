/**
 * traceModel · 三级 Trace 的纯视图归约(可 vitest 单测,零 React;文件名避 TraceLevels.tsx 大小写冲突)
 *
 * §3j 三级下钻(抽屉「执行过程」内):
 *   L1 执行摘要(吸顶,即点即关)= 模型 · N 帧 · 耗时 · 结果
 *   L2 步骤列表(每帧一行)   = 类型 tag(思考/调用/生成/错误)+ 首行摘要 + chevron
 *   L3 展开帧(原文)         = text/thinking → markdown 渲染;工具 args/result → 等宽降噪
 *
 * 本模块只出「帧 → 行」的纯映射;渲染在 TraceLevels.tsx。原文一字不改(零捏造),
 * 类型 tag 是呈现映射(ADR-002 允许:标签映射,不编造内容)。
 */

import type { Step, StepKind, StepL3, StepStatus, Turn } from "../../../lib/turns";

/** StepKind → 中文类型 tag(§3j:思考/调用/生成/错误;system=生成态事件)。 */
export function stepTypeTag(kind: StepKind): string {
  switch (kind) {
    case "thinking":
      return "思考";
    case "tool":
      return "调用";
    case "error":
      return "错误";
    case "system":
      return "生成";
  }
}

/**
 * L3 原文的呈现类型(§3j 裁定③:text/thinking 帧 markdown 渲染,工具帧等宽降噪)。
 *   markdown = 思考/文本原文(CrewMarkdown);mono = 工具 args/result 等宽降噪;null = 无 L3,不可掀。
 */
export function l3Kind(step: Step): "markdown" | "mono" | null {
  if (!step.l3) return null;
  return step.l3.form === "text" ? "markdown" : "mono";
}

/** 单行摘要:取 label 首行并去空白(省略号交给 CSS)。 */
export function firstLine(s: string): string {
  const line = (s ?? "").split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

/**
 * 「结果」文案(L1 摘要末段;零捏造):
 *   done + 有版本 → 「产物 vN」;done 无版本 → 「完成」;blocked → 「阻塞」;
 *   failed/error → 「失败」;运行中(null)→ 「进行中」。
 */
export function traceResultText(terminalStatus: string | null, version: number | null): string {
  switch (terminalStatus) {
    case "done":
      return version != null ? `产物 v${version}` : "完成";
    case "blocked":
      return "阻塞";
    case null:
      return "进行中";
    default:
      return "失败";
  }
}

/** L2 行(每帧一行的扁平投影;保留 l3 供三级渲染)。 */
export interface L2Row {
  id: string;
  /** 类型 tag(思考/调用/生成/错误) */
  tag: string;
  kind: StepKind;
  status: StepStatus;
  /** 首行摘要(label 首行) */
  summary: string;
  /** 三级原文(无 → 不可掀) */
  l3: StepL3 | undefined;
  /** L3 呈现类型(markdown/mono/null) */
  l3kind: "markdown" | "mono" | null;
  /** 失败步默认掀开留证 */
  defaultOpen: boolean;
}

/** 回合列 → 扁平 L2 行列(§3j「每帧一行」;准备回合 index 0 的系统步也计入)。 */
export function toL2Rows(turns: readonly Turn[]): L2Row[] {
  const rows: L2Row[] = [];
  for (const turn of turns) {
    for (const step of turn.steps) {
      rows.push({
        id: step.id,
        tag: stepTypeTag(step.kind),
        kind: step.kind,
        status: step.status,
        summary: firstLine(step.label),
        l3: step.l3,
        l3kind: l3Kind(step),
        defaultOpen: !!step.defaultOpen,
      });
    }
  }
  return rows;
}
