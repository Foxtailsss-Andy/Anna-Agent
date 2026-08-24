/**
 * NextUpStrip · 「该你了」向导条(可用性收束)
 *   健康条之下、内容区之上;永远只显一件最该办的事 + 一个主按钮。
 *   评审件 = 金调左缘(与活跃门同语义);其余 = iris 左缘。零即隐,不装忙。
 *   零捏造:内容全来自 deriveNextUp(快照派生);「共 N 件」为真计数。
 */

import type { NextUp, NextUpKind } from "./nextUp";

export function NextUpStrip({
  next,
  onAction,
}: {
  next: NextUp;
  onAction: (taskId: string, kind: NextUpKind) => void;
}) {
  const item = next.item;
  if (!item) return null;
  return (
    <div
      className={`ir-crew-nextup ir-crew-nextup--${item.kind === "review" ? "gold" : "iris"}`}
      role="status"
      aria-label="该你了"
    >
      <span className="ir-crew-nextup__k">该你了</span>
      <span className="ir-crew-nextup__text">{item.text}</span>
      <span className="ir-crew-nextup__spacer" />
      {next.total > 1 && <span className="ir-crew-nextup__more">共 {next.total} 件</span>}
      <button
        type="button"
        className="ir-crew-nextup__btn"
        onClick={() => onAction(item.taskId, item.kind)}
      >
        {item.action}
      </button>
    </div>
  );
}

export default NextUpStrip;
