/**
 * composerRoute · Crew composer 的 Enter / 纸飞机路由(review C2)。
 *
 * 判定与「发频道」同一 mentions 解析(buildSayPayload):拾取器插入且 `@名` 仍在正文,
 * ∪ 正文中与花名册精确匹配的 `@显示名`。只要解析出任一**非 Anna** 成员 → 这句话是
 * 给人的,走 Channel(落频道行 + 通知被 @ 的成员);否则交给 Anna(Workbench Run)。
 * Anna 是频道协调者,不是被通知的频道成员 —— 只 @Anna 仍然是问 Anna。
 */

import type { TeamMember } from "../../../lib/api/crew";
import { buildSayPayload, type InsertedMention } from "./channelModel";
import { SYSTEM_ANNA_MENTION_ID } from "./pickerModel";

export type ComposerSendRoute = "channel" | "anna";

/** 发频道 / 路由共用的 mentions 花名册:系统 Anna + 真成员(去掉与系统 Anna 撞 id 的行)。 */
export function composerRoster(members: readonly TeamMember[]): { id: string; display_name: string }[] {
  return [
    { id: SYSTEM_ANNA_MENTION_ID, display_name: "Anna" },
    ...members.filter((m) => m.id !== SYSTEM_ANNA_MENTION_ID),
  ];
}

export function composerSendRoute(
  text: string,
  inserted: readonly InsertedMention[],
  members: readonly TeamMember[],
): ComposerSendRoute {
  const { mentions } = buildSayPayload(text, [...inserted], composerRoster(members));
  return mentions.some((id) => id !== SYSTEM_ANNA_MENTION_ID) ? "channel" : "anna";
}
