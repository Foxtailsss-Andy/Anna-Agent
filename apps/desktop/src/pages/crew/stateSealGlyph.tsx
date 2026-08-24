/**
 * StateSealGlyph · 七态章的内层图元(色盲安全形状的 SVG 笔画),1c §形状表。
 *
 * 画布节点章(graph/TaskNode 的 crewg-badge · 16px · 含落笔动画)与 inspect 章
 * (inspect/StateSeal 的 ir-insp-seal · 13px)共用同一套图元,消除 SVG 坐标重复
 * ——形状语汇是一套系统(1c),两处必须同形。外框尺寸/配色/落笔动画各由自己的
 * CSS(ChartingTable.css / inspect.css)owns;此处只出内层内容,不硬统一外框。
 *
 * innerRingClassName / donePathClassName 承接两处不同前缀 class(尺寸/动画各异)。
 * pending / ready / review 为空章(形状靠外框 CSS 描边),返回 null。
 */

import type { TaskVisual } from "./graph/graphMapping";

export function StateSealGlyph({
  visual,
  innerRingClassName,
  donePathClassName,
}: {
  visual: TaskVisual;
  innerRingClassName: string;
  donePathClassName?: string;
}) {
  switch (visual) {
    case "running":
      return <span className={innerRingClassName} />;
    case "blocked":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 6.5v7M12 17.2h.01" />
        </svg>
      );
    case "rework":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 10a7.5 7.5 0 1 1 1.8 7.8" />
          <path d="M4.5 5.5V10H9" />
        </svg>
      );
    case "done":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path className={donePathClassName} d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    default:
      return null; // pending / ready / review: 空章(形状靠外框 CSS)
  }
}

export default StateSealGlyph;
