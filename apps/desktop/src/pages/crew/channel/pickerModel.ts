/**
 * pickerModel · R4a @拾取器纯函数(键位/过滤/光标插入,与组件解耦便于 node 单测)
 *
 * - toPickerMember:TeamMember → 拾取器行(名/职能/人或 Agent)。
 * - filterMembers:随 `@` 后文本实时过滤(大小写不敏感子串,保持花名册序)。
 * - cycleIndex:↑↓ 循环(两端回绕)。
 * - activeMentionQuery:光标处正在键入的 `@partial`(前置须为行首或空白,规避邮箱 a@b)。
 * - insertMentionAtCaret:以 `@名 ` 替换正在键入的 `@partial`(纯文本,消息渲染侧才成 pill)。
 * - insertAtSign:「@ 成员」pill → 光标处插入裸 `@`(必要时补前导空格)触发同一浮层。
 */

import type { TeamMember } from "../../../lib/api/crew";

export interface PickerMember {
  id: string;
  name: string;
  role?: string;
  isAgent: boolean;
  isCoordinator?: boolean;
}

export const SYSTEM_ANNA_MENTION_ID = "anna";
export const ANNA_COORDINATOR_PICKER_MEMBER: PickerMember = {
  id: SYSTEM_ANNA_MENTION_ID,
  name: "Anna",
  role: "协调者",
  isAgent: false,
  isCoordinator: true,
};

export function toPickerMember(m: TeamMember): PickerMember {
  const name = (m.display_name ?? "").trim() !== "" ? m.display_name : m.id;
  return { id: m.id, name, role: m.role, isAgent: m.kind === "agent" };
}

export function withAnnaCoordinator(members: readonly TeamMember[]): PickerMember[] {
  return [
    ANNA_COORDINATOR_PICKER_MEMBER,
    ...members
      .filter((m) => m.id !== SYSTEM_ANNA_MENTION_ID)
      .map(toPickerMember),
  ];
}

/**
 * 随 `@` 后文本过滤:大小写不敏感子串匹配 name,保持原花名册顺序。
 * 空 query → 整册(空 @ 显示全部成员)。
 */
export function filterMembers<T extends { name: string }>(
  roster: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return roster.slice();
  return roster.filter((m) => m.name.toLowerCase().includes(q));
}

/** ↑↓ 循环索引(两端回绕);len<=0 → 0。dir=+1 下,-1 上。 */
export function cycleIndex(len: number, cur: number, dir: 1 | -1): number {
  if (len <= 0) return 0;
  return (((cur + dir) % len) + len) % len;
}

export interface ActiveMention {
  /** `@` 在 text 中的下标 */
  at: number;
  /** `@` 与光标之间的已键入串(过滤用) */
  query: string;
}

/**
 * 光标处正在键入的 `@mention` 片段:自光标回扫到最近的 `@`;其与光标间不得含空白;
 * `@` 前须为行首或空白(避免 `a@b` 之类误触发)。命中返回 {at, query},否则 null。
 */
export function activeMentionQuery(text: string, caret: number): ActiveMention | null {
  const c = Math.max(0, Math.min(caret, text.length));
  let at = -1;
  for (let i = c - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      at = i;
      break;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
  }
  if (at === -1) return null;
  if (at > 0) {
    const prev = text[at - 1];
    if (prev !== " " && prev !== "\n" && prev !== "\t") return null;
  }
  return { at, query: text.slice(at + 1, c) };
}

export interface CaretInsertResult {
  text: string;
  caret: number;
}

/**
 * 以 `@名 `(尾随空格)替换正在键入的 `@partial`(光标结束处);无活跃片段时于光标处插入。
 * 返回新文本与新光标位。textarea 内始终纯文本 —— pill 只在消息渲染侧兑现。
 */
export function insertMentionAtCaret(
  text: string,
  caret: number,
  name: string,
): CaretInsertResult {
  const c = Math.max(0, Math.min(caret, text.length));
  const token = `@${name} `;
  const active = activeMentionQuery(text, c);
  if (!active) {
    return { text: text.slice(0, c) + token + text.slice(c), caret: c + token.length };
  }
  const next = text.slice(0, active.at) + token + text.slice(c);
  return { text: next, caret: active.at + token.length };
}

/**
 * 「@ 成员」pill 路径:于光标处插入裸 `@`(触发同一浮层);若前一字符是非空白词字,
 * 先补一个空格,保证 `@` 被 activeMentionQuery 认作片段起点。
 */
export function insertAtSign(text: string, caret: number): CaretInsertResult {
  const c = Math.max(0, Math.min(caret, text.length));
  const prev = c > 0 ? text[c - 1] : "";
  const needsSpace = prev !== "" && prev !== " " && prev !== "\n" && prev !== "\t";
  const ins = needsSpace ? " @" : "@";
  return { text: text.slice(0, c) + ins + text.slice(c), caret: c + ins.length };
}
