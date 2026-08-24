/**
 * MemberBits · 人/Agent 身份图元(1g:人=圆 · Agent=方圆角+几何图元+delegate 色)
 *   抽屉署名行 / popover 执行者行 / 列表 assignee / 改派选人共用。
 */

import type { TeamMember } from "../../../lib/api/crew";

/** Agent 职能图元(三横=文案 · 圆+方=设计 · 对勾=验收);其余无图元回退首字。 */
export function agentGlyph(role: string | undefined): React.ReactNode {
  switch ((role ?? "").trim()) {
    case "文案":
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M5 7h14M5 12h9M5 17h14" />
        </svg>
      );
    case "设计":
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="9.5" cy="9.5" r="4" />
          <rect x="11.5" y="11.5" width="8" height="8" rx="1.5" />
        </svg>
      );
    case "验收":
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    default:
      return null;
  }
}

function initialOf(m: TeamMember): string {
  return (m.display_name ?? m.id ?? "·").trim().charAt(0).toUpperCase() || "·";
}

/** 头像:human=圆(Boss=深 iris)· agent=方圆角 delegate 色 + 几何图元。 */
export function MemberAvatar({
  member,
  isOwner = false,
  size = 22,
}: {
  member: TeamMember;
  isOwner?: boolean;
  size?: number;
}) {
  const style = { width: size, height: size } as React.CSSProperties;
  if (member.kind === "agent") {
    const glyph = agentGlyph(member.role);
    return (
      <span className="ir-insp-ava ir-insp-ava--agent" style={style} aria-hidden="true">
        {glyph ?? initialOf(member)}
      </span>
    );
  }
  return (
    <span
      className={`ir-insp-ava${isOwner ? " ir-insp-ava--owner" : ""}`}
      style={style}
      aria-hidden="true"
    >
      {initialOf(member)}
    </span>
  );
}

/** 名 + (agent) AGENT mono 章 + (可选)职能后缀。 */
export function MemberName({ member, roleSuffix = false }: { member: TeamMember; roleSuffix?: boolean }) {
  const agent = member.kind === "agent";
  return (
    <span className="ir-insp-who">
      <span className={`ir-insp-who__name${agent ? " ir-insp-who__name--agent" : ""}`}>
        {member.display_name ?? member.id}
      </span>
      {agent && <span className="ir-insp-who__tag">AGENT</span>}
      {roleSuffix && member.role && <span className="ir-insp-who__role">· {member.role}职能</span>}
    </span>
  );
}
