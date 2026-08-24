/**
 * edges · 依赖边三型 + 供电流(1c:SVG 1.5px · 终点 2.5px 港点着目标态色)
 *
 * powered    已通电:实线 var(--edge)
 * dormant    休眠:虚线 5-4 var(--edge-dormant)
 * flow       供电流:全图唯一流动,iris dash 5-7 dashFlow 1.1s,指向焦点执行节点
 * reviewLive 评审直通(1b「供电边转移」):活跃门入边,亮 iris,不流动
 * rework     返工回路:danger 1.3px dash 3-3 上弧带箭头,驳回时画入,通过后消隐
 *
 * 新生边(生长幕二):画入 300ms —— 实线族走 pathLength 归一化 dashoffset 落笔,
 * 虚线族走 dashoffset 行进;着 iris,3s 归常(幕四配套)。
 */

import { getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

import type { EdgeKind } from "./graphMapping";

export interface CrewEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  /** 生长幕二(新出现的边,一次性画入) */
  born: boolean;
}

export type CrewFlowEdge = Edge<CrewEdgeData, "crew">;

/** 返工上弧的抬升高度(gate 顶 → 任务顶,弧过行间) */
const REWORK_LIFT = 56;

export function CrewEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<CrewFlowEdge>) {
  const kind: EdgeKind = data?.kind ?? "dormant";
  const born = data?.born === true;
  const cls = `crewg-edge crewg-edge--${kind}${born ? " crewg-edge--born" : ""}`;

  if (kind === "rework") {
    const path = `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY - REWORK_LIFT}, ${targetX} ${
      targetY - REWORK_LIFT
    }, ${targetX} ${targetY}`;
    return (
      <g className={cls}>
        <path d={path} className="crewg-edge__line" fill="none" />
        {/* 回流箭头(指回返工任务) */}
        <path
          className="crewg-edge__arrow"
          d={`M ${targetX - 3.5} ${targetY - 6.5} L ${targetX} ${targetY - 0.5} L ${targetX + 3.5} ${targetY - 6.5}`}
          fill="none"
        />
      </g>
    );
  }

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32,
  });
  // 实线族新生边:pathLength 归一化,dashoffset 100→0 落笔(终态=完整实线,无疤)
  const usePathLen = born && (kind === "powered" || kind === "reviewLive");
  return (
    <g className={cls}>
      <path
        d={path}
        className="crewg-edge__line"
        fill="none"
        {...(usePathLen ? { pathLength: 100 } : {})}
      />
      {/* 终点港点着目标态色(随边型):通电 r2.8 / 其余 r2.5(§3c 四型对比) */}
      <circle className="crewg-edge__dot" cx={targetX} cy={targetY} r={kind === "powered" ? 2.8 : 2.5} />
    </g>
  );
}

export const crewEdgeTypes = { crew: CrewEdge };
