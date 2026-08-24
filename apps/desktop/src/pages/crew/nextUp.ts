/**
 * nextUp · 「该你了」向导条派生(可用性收束 · 第一性:新手唯一的问题是
 * 「现在轮到我做什么、点哪里」——所以永远只给一件最该办的事 + 一个按钮)。
 *
 * 优先级(高→低):
 *   1 rework  我的返工(被驳回,最紧急的欠账)
 *   2 review  活跃评审门(Boss 裁定;流程卡在人身上)
 *   3 submit  我手上执行中的任务(完成后提交)
 *   4 start   已派给我还没开工的任务
 * 零即隐:一件没有 → null(不装忙)。total = 全部命中数(>1 时显「共 N 件」)。
 * 纯函数零捏造:一切派生自快照;gate 判定与画布同源(gateVisual)。
 */

import type { CrewTask } from "./crewModel";
import { gateVisual } from "./graph/graphMapping";

export type NextUpKind = "rework" | "review" | "submit" | "start";

export interface NextUpItem {
  kind: NextUpKind;
  taskId: string;
  title: string;
  /** 主文案(一句话说清"这是什么、为什么轮到你") */
  text: string;
  /** 主按钮文案 */
  action: string;
}

export interface NextUp {
  item: NextUpItem | null;
  /** 全部待办命中数(item 计入;0 → item 必为 null) */
  total: number;
}

function mine(t: CrewTask, sessionUserId: string | null): boolean {
  return !!sessionUserId && t.assignee_member_id === sessionUserId;
}

export function deriveNextUp(
  tasks: readonly CrewTask[],
  sessionUserId: string | null,
  isOwner: boolean,
): NextUp {
  const reworks = tasks.filter((t) => !t.is_gate && t.status === "rework" && mine(t, sessionUserId));
  const reviews = isOwner
    ? tasks.filter((t) => t.is_gate && gateVisual(t) === "active")
    : [];
  const submits = tasks.filter((t) => !t.is_gate && t.status === "running" && mine(t, sessionUserId));
  const starts = tasks.filter((t) => !t.is_gate && t.status === "assigned" && mine(t, sessionUserId));

  const total = reworks.length + reviews.length + submits.length + starts.length;
  if (total === 0) return { item: null, total: 0 };

  if (reworks.length > 0) {
    const t = reworks[0];
    return {
      total,
      item: {
        kind: "rework",
        taskId: t.id,
        title: t.title,
        text: `“${t.title}”被驳回——按批注改好，重新提交`,
        action: "改好重交",
      },
    };
  }
  if (reviews.length > 0) {
    const t = reviews[0];
    return {
      total,
      item: {
        kind: "review",
        taskId: t.id,
        title: t.title,
        text: `“${t.title}”待你裁定——读产物，然后通过或驳回`,
        action: "去评审",
      },
    };
  }
  if (submits.length > 0) {
    const t = submits[0];
    return {
      total,
      item: {
        kind: "submit",
        taskId: t.id,
        title: t.title,
        text: `“${t.title}”在你手上——完成后提交，下游就能接力`,
        action: "去提交",
      },
    };
  }
  const t = starts[0];
  return {
    total,
    item: {
      kind: "start",
      taskId: t.id,
      title: t.title,
      text: `“${t.title}”已派给你——可以开工了`,
      action: "开始",
    },
  };
}
