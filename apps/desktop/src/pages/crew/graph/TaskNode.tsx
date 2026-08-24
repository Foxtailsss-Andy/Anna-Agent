/**
 * TaskNode · 任务卡自定义节点(R5 三层状态语言:左缘色条(远读)× 卡面轻染(氛围)× 20px 章(近读))
 *
 * 硬规格(裁定 #1/#2):188×min66 · r14 · 内边距 11/13/10/**16**(让位 5px 色条)·
 *   标题 13.5/600 · 职能点 4px · 头像 16px · **章 20px** · 状态词 mono 9.5 · 端口桩 8px。
 * 执行中(R2/C1:status running 或在飞):strokeFlow 描边流光(伪层 inset:-1.5 遮罩挖空,
 *   强度<呼吸,可多节点同屏)+ 实心章 + 左缘 iris 色条;焦点者另叠呼吸环(全屏唯一)+ 状态词微光。
 * 阻塞:卡点原因随卡直陈。新生(频道生长):溯源行「由频道生长 · #aN」。完成:章勾落笔一次 300ms。
 * 色盲安全:章形状即状态(虚环/加号/实心内白环/菱形/叹号/回环/勾)。
 */

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { TeamMember } from "../../../lib/api/crew";
import { StateSealGlyph } from "../stateSealGlyph";
import {
  artifactBadge,
  nodeStateClass,
  roleColorSlug,
  statusWord,
  type GraphNode,
  type NodePrimaryAction,
  type TaskVisual,
} from "./graphMapping";

export interface TaskNodeData extends Record<string, unknown> {
  node: GraphNode;
  assignee: TeamMember | null;
  /** assignee 即项目 owner(Boss)→ 深 iris 圆(1a 头像语汇) */
  assigneeIsOwner: boolean;
  /** origin=channel 的溯源审计号("#a12";无法回链 → null 只写来源) */
  originAudit: string | null;
  /** 生长四幕 幕三/幕四(新生节点,一次性) */
  born: boolean;
  /** 完成落笔(既有节点转 done,一次性 300ms) */
  ink: boolean;
  /** P6 点名环(单次:入场 240 · 驻留 2.4s · 淡出 600) */
  ringing: boolean;
  /** F4 轻检视选中:选中环接管 + 呼吸暂歇(样式在 inspect.css) */
  selected?: boolean;
  /** #2 就地主动作(状态→唯一主动作);null → 无按钮 */
  primary: NodePrimaryAction | null;
  /** 主动作点击(hover/选中显形;stopPropagation 不干扰单击开 popover) */
  onPrimary?: (e: ReactMouseEvent) => void;
}

type TaskFlowNode = Node<TaskNodeData, "crewTask">;

/* ---------------- 章(20px,形状即状态;裁定 #2 近读层升级) ---------------- */

function StateBadge({ visual, ink }: { visual: TaskVisual; ink: boolean }) {
  return (
    <span className={`crewg-badge crewg-badge--${visual}`} aria-hidden="true">
      {visual === "ready" ? (
        // 就绪待认领:iris 加号(章在 graph 端独出,不改共享 StateSealGlyph 而波及 inspect)
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 6v12M6 12h12" />
        </svg>
      ) : (
        <StateSealGlyph
          visual={visual}
          innerRingClassName="crewg-badge__innerring"
          donePathClassName={ink ? "crewg-inkpath crewg-inkpath--draw" : "crewg-inkpath"}
        />
      )}
    </span>
  );
}

/* ---------------- 头像 16px(人=圆 · Agent=方 r5 · Boss=深 iris 圆) ---------------- */

function agentGlyph(role: string | undefined) {
  switch ((role ?? "").trim()) {
    case "文案":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M5 7h14M5 12h9M5 17h14" />
        </svg>
      );
    case "设计":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <circle cx="9.5" cy="9.5" r="4" />
          <rect x="11.5" y="11.5" width="8" height="8" rx="1.5" />
        </svg>
      );
    case "验收":
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    default:
      return null;
  }
}

function Avatar({
  member,
  isOwner,
  visual,
}: {
  member: TeamMember;
  isOwner: boolean;
  visual: TaskVisual;
}) {
  const initial = (member.display_name ?? member.id ?? "·").trim().charAt(0).toUpperCase() || "·";
  const dim = visual === "pending" ? " crewg-ava--dim" : visual === "done" ? " crewg-ava--soft" : "";
  if (member.kind === "agent") {
    const glyph = agentGlyph(member.role);
    return (
      <span className={`crewg-ava crewg-ava--agent${dim}`} aria-hidden="true">
        {glyph ?? initial}
      </span>
    );
  }
  return (
    <span className={`crewg-ava${isOwner ? " crewg-ava--owner" : ""}${dim}`} aria-hidden="true">
      {initial}
    </span>
  );
}

/* ---------------- 产物徽记(有产物 → 文件图标 + vN;ink-3 静默近读,非交互) ---------------- */

function DocBadge({ version }: { version: number }) {
  return (
    <span
      className="crewg-card__doc"
      title={`有产物 · v${version}——频道与抽屉可读`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-5-5z" />
        <path d="M13 3v5h5" />
      </svg>
      <span className="crewg-card__docv">v{version}</span>
    </span>
  );
}

/* ---------------- 认领位(就绪待认领:空圆虚线 + 加号) ---------------- */

function ClaimSlot() {
  return (
    <span className="crewg-ava crewg-ava--claim" aria-hidden="true">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </span>
  );
}

/* ---------------- 节点 ---------------- */

export function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { node, assignee, assigneeIsOwner, originAudit, born, ink, ringing, selected, primary, onPrimary } = data;
  const t = node.task;
  const visual = node.visual;
  const word = statusWord(visual);
  const role = (t.role_required ?? "").trim();
  const slug = roleColorSlug(role);
  const running = visual === "running";
  const badge = artifactBadge(t);

  return (
    <div
      className={[
        "crewg-node",
        nodeStateClass(visual),
        node.focus ? "crewg-node--focus" : "",
        selected ? "crewg-node--selected" : "",
        born ? "crewg-node--born" : "",
        ringing ? "crewg-node--ringing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={word ? `${t.title} · ${word}` : `${t.title} · 完成`}
    >
      {node.focus && <span className="crewg-node__breath" aria-hidden="true" />}
      {ringing && <span className="crewg-node__ring" aria-hidden="true" />}
      {/* R2 执行流光:渐变盒 + 遮罩挖空 1.5px 描边环(状态层,强度<呼吸,可多节点同屏) */}
      {running && <span className="crewg-strokeflow" aria-hidden="true" />}
      <div className="crewg-card">
        <div className="crewg-card__titlerow">
          <span className="crewg-card__title">{t.title}</span>
          {badge && <DocBadge version={badge.version} />}
          {role && (
            <span className="crewg-card__role">
              <span className={`crewg-roledot crewg-roledot--${slug}`} aria-hidden="true" />
              {role}
            </span>
          )}
        </div>
        <div className="crewg-card__meta">
          {assignee ? (
            <Avatar member={assignee} isOwner={assigneeIsOwner} visual={visual} />
          ) : visual === "ready" ? (
            <ClaimSlot />
          ) : null}
          <span className={`crewg-card__who${!assignee && visual === "ready" ? " crewg-card__who--claim" : ""}`}>
            {assignee ? assignee.display_name : visual === "ready" ? "待认领" : "未指派"}
          </span>
          {word && (
            <span
              className={`crewg-card__word crewg-card__word--${visual}${
                node.focus ? " crewg-card__word--shimmer" : ""
              }`}
            >
              {word}
            </span>
          )}
          <StateBadge visual={visual} ink={ink} />
        </div>
        {visual === "blocked" && t.blocker && (
          <div className="crewg-card__note">卡点：{t.blocker}</div>
        )}
        {t.origin === "channel" && (
          <div className="crewg-card__origin">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="6" cy="6" r="2.6" />
              <circle cx="6" cy="18" r="2.6" />
              <circle cx="18" cy="12" r="2.6" />
              <path d="M6 8.6v6.8M8.6 6.8c4.8 1 8 2.4 8 5.2" />
            </svg>
            <span>由频道生长{originAudit ? ` · ${originAudit}` : ""}</span>
          </div>
        )}
      </div>
      {primary && (
        <button
          type="button"
          className={`crewg-act crewg-act--${primary.tone}`}
          onClick={(e) => {
            e.stopPropagation();
            onPrimary?.(e);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={primary.label}
          aria-label={`${t.title} · ${primary.label}`}
        >
          {primary.label}
        </button>
      )}
      <Handle type="target" position={Position.Left} className="crewg-port" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="crewg-port" isConnectable={false} />
      {/* 返工回路上弧的落点(隐形桩,仅供 rework 边锚定) */}
      <Handle id="loop-in" type="target" position={Position.Top} className="crewg-port crewg-port--ghost" isConnectable={false} />
    </div>
  );
}

export default TaskNode;
