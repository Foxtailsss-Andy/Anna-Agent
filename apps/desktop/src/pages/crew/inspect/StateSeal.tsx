/**
 * StateSeal · 七态章 + 门章(色盲安全:章形状即状态,1c §形状表)
 *   列表视图行章 / 依赖链 chip / popover·抽屉状态 pill 共用。样式在 inspect.css。
 *   —— 内层图元(SVG 笔画)与画布 TaskNode 的 StateBadge 共用 StateSealGlyph(消除
 *      坐标重复);外框尺寸(13px vs 画布 16px)/配色/落笔动画各自 CSS owns,不硬统一。
 */

import { StateSealGlyph } from "../stateSealGlyph";
import { statusWord, type TaskVisual } from "../graph/graphMapping";

export function StateSeal({ visual }: { visual: TaskVisual }) {
  return (
    <span className={`ir-insp-seal ir-insp-seal--${visual}`} aria-hidden="true">
      <StateSealGlyph visual={visual} innerRingClassName="ir-insp-seal__innerring" />
    </span>
  );
}

/** 状态 pill(章 + 状态词,态色描边)—— popover/抽屉头部共用。 */
export function StatusPill({ visual }: { visual: TaskVisual }) {
  const word = statusWord(visual) || "完成";
  return (
    <span className={`ir-insp-statuspill ir-insp-statuspill--${visual}`}>
      <StateSeal visual={visual} />
      {word}
    </span>
  );
}

/** 门章(◇ 菱形「审」)—— 依赖链 chip 中的评审门。 */
export function GateSeal({ tone = "active" }: { tone?: "active" | "passed" | "dormant" }) {
  return (
    <span className={`ir-insp-gateseal ir-insp-gateseal--${tone}`} aria-hidden="true">
      <span className="ir-insp-gateseal__c">审</span>
    </span>
  );
}

export default StateSeal;
