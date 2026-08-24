/**
 * GateNode · 评审门 ◇(1c 门三态:44×44 r8 rotate45 · serif「审」)
 *
 * 待就绪门=虚线 ·「审」灰;活跃门=金线 1.5px + goldPulse 4s(全屏金预算之一,
 * 评审时刻的唯一动静);已通过=绿描边 + 勾,mono「通过 HH:MM」(时刻来自
 * audit_events 真事件,取不到只写「已通过」,不猜时间)。
 */

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { GraphNode, NodePrimaryAction } from "./graphMapping";

export interface GateNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** 通过时刻 HH:MM(audit 溯源;null → 只写「已通过」) */
  passedAt: string | null;
  born: boolean;
  ringing: boolean;
  /** #2 就地主动作(活跃门 → 评审;其余 null) */
  primary: NodePrimaryAction | null;
  /** 主动作点击(开评审面;stopPropagation) */
  onPrimary?: (e: ReactMouseEvent) => void;
}

type GateFlowNode = Node<GateNodeData, "crewGate">;

export function GateNode({ data }: NodeProps<GateFlowNode>) {
  const { node, passedAt, born, ringing, primary, onPrimary } = data;
  const gate = node.gate ?? "dormant";
  const title = node.task.title;
  const mono =
    gate === "passed" ? (passedAt ? `通过 ${passedAt}` : "已通过") : gate === "active" ? "待审" : "待就绪";

  return (
    <div
      className={[
        "crewg-gate",
        `crewg-gate--${gate}`,
        born ? "crewg-gate--born" : "",
        ringing ? "crewg-gate--ringing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={`${title} · ${mono}`}
    >
      {ringing && <span className="crewg-gate__ringlayer" aria-hidden="true" />}
      <div className="crewg-gate__diamondbox">
        <div className="crewg-gate__diamond">
          {gate === "passed" ? (
            <svg
              className="crewg-gate__check"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          ) : (
            <span className="crewg-gate__shen">审</span>
          )}
        </div>
      </div>
      <div className="crewg-gate__label">{title} ◇</div>
      <div className="crewg-gate__mono">{mono}</div>
      {primary && (
        <button
          type="button"
          className={`crewg-act crewg-act--gate crewg-act--${primary.tone}`}
          onClick={(e) => {
            e.stopPropagation();
            onPrimary?.(e);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={primary.label}
          aria-label={`${title} · ${primary.label}`}
        >
          {primary.label}
        </button>
      )}
      <Handle type="target" position={Position.Left} className="crewg-port crewg-port--gate" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="crewg-port crewg-port--gate" isConnectable={false} />
      {/* 返工回路上弧的出发点(隐形桩) */}
      <Handle id="loop-out" type="source" position={Position.Top} className="crewg-port crewg-port--ghost" isConnectable={false} />
    </div>
  );
}

export default GateNode;
