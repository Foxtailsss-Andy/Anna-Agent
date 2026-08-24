/**
 * channelModel · 频道纯函数(F3)—— 零捏造:分派/聚合/组装皆源自后端真消息
 *
 * - messageFamily:kind → 五族(event/artifact/review/say/command);未知诚实降级 event。
 * - splitMentions:正文 @提及 → pill 片段(以 mentions 元数据为准,不做自由文本解析)。
 * - 勾选聚合:selectedCount / canConfirm / allIndexes(命令草案批量下推)。
 * - 提交组装:buildSayPayload / buildCommandPayload / buildConfirmPayload。
 * - 命令行读取:commandDrafts / commandSourceText(结构化 payload)。
 * - 血缘回链:isCommandConfirmed / tasksFromCommand(新任务 created_from_message_id
 *   指回命令行 id —— confirm 服务端以 command.id 作 source_message_id 写入)。
 */

export type MessageFamily = "event" | "artifact" | "review" | "say" | "command";

const FAMILIES: ReadonlySet<string> = new Set([
  "event",
  "artifact",
  "review",
  "say",
  "command",
]);

/** 消息 → 五族分派;未知 kind 诚实降级为 event 编年行(不丢消息、不造卡)。 */
export function messageFamily(msg: { kind: string }): MessageFamily {
  return (FAMILIES.has(msg.kind) ? msg.kind : "event") as MessageFamily;
}

/* ---------------- @提及 片段切分 ---------------- */

export interface MentionMeta {
  name: string;
  isAgent: boolean;
  isCoordinator?: boolean;
}

export type BodySegment =
  | { type: "text"; text: string }
  | { type: "mention"; name: string; isAgent: boolean; isCoordinator?: boolean };

/**
 * @提及 高亮:在 body 中切出 `@{name}` 片段(name 来自 mentions 元数据),其余为纯文本。
 * 不做自由文本解析 —— 未在 mentions 列表的 @xxx 不高亮。最长名优先,避免
 * 「@Agent」误切「@Agent·Design」。indexOf 切分,规避正则转义(名含「·」)。
 */
export function splitMentions(body: string, mentions: MentionMeta[]): BodySegment[] {
  if (!body) return [];
  const names = mentions
    .filter((m) => m.name)
    .slice()
    .sort((a, b) => b.name.length - a.name.length);
  if (names.length === 0) return [{ type: "text", text: body }];

  let segments: BodySegment[] = [{ type: "text", text: body }];
  for (const m of names) {
    const token = `@${m.name}`;
    const next: BodySegment[] = [];
    for (const seg of segments) {
      if (seg.type !== "text") {
        next.push(seg);
        continue;
      }
      let rest = seg.text;
      let idx = rest.indexOf(token);
      while (idx !== -1) {
        if (idx > 0) next.push({ type: "text", text: rest.slice(0, idx) });
        const mention: Extract<BodySegment, { type: "mention" }> = {
          type: "mention",
          name: m.name,
          isAgent: m.isAgent,
        };
        if (m.isCoordinator) mention.isCoordinator = true;
        next.push(mention);
        rest = rest.slice(idx + token.length);
        idx = rest.indexOf(token);
      }
      if (rest) next.push({ type: "text", text: rest });
    }
    segments = next;
  }
  return segments;
}

/* ---------------- 勾选聚合(命令草案批量下推) ---------------- */

/** 选中且在 [0,total) 内的草案数(防脏索引)。 */
export function selectedCount(selected: ReadonlySet<number>, total: number): number {
  let n = 0;
  for (const i of selected) if (i >= 0 && i < total) n++;
  return n;
}

/** 可下推 = 选中数 > 0(0 项时确认钮禁用)。 */
export function canConfirm(selected: ReadonlySet<number>, total: number): boolean {
  return selectedCount(selected, total) > 0;
}

/** 默认全勾(草案卡初始态)。 */
export function allIndexes(total: number): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < total; i++) s.add(i);
  return s;
}

/* ---------------- 提交 payload 组装 ---------------- */

export interface SayPayload {
  body: string;
  mentions: string[];
}

export interface InsertedMention {
  id: string;
  name: string;
}

/**
 * say 提交:mentions = 拾取器插入且 @名 仍在正文(用户删了就不再算提及,不虚报)
 * ∪ 正文中与花名册**精确匹配**的 `@显示名`(R4a 修:手打全名不经拾取器也算真提及——
 * 匹配→token、无匹配→死文本,与设计 3h 语义一致;服务端另有成员校验兜底)。
 * 同一成员去重;长名优先匹配(防「@Agent」误吞「@Agent·Design」前缀)。
 */
export function buildSayPayload(
  text: string,
  inserted: InsertedMention[],
  roster: readonly { id: string; display_name: string }[] = [],
): SayPayload {
  const seen = new Set<string>();
  const mentions: string[] = [];
  const consumed = "@__MENTION_CONSUMED__";
  for (const m of inserted) {
    if (seen.has(m.id)) continue;
    if (text.includes(`@${m.name}`)) {
      mentions.push(m.id);
      seen.add(m.id);
    }
  }
  const byLen = [...roster].sort((a, b) => b.display_name.length - a.display_name.length);
  let scan = text;
  for (const m of byLen) {
    if (!m.display_name) continue;
    if (scan.includes(`@${m.display_name}`)) {
      if (!seen.has(m.id)) {
        mentions.push(m.id);
        seen.add(m.id);
      }
      scan = scan.split(`@${m.display_name}`).join(consumed); // 消耗掉,防短名重复命中
    }
  }
  return { body: text, mentions };
}

export interface CommandPayload {
  text: string;
  source_message_id?: string;
}

/** +任务 提交:当前正文文本(可带触发它的来源消息 id)。 */
export function buildCommandPayload(
  text: string,
  sourceMessageId?: string | null,
): CommandPayload {
  const payload: CommandPayload = { text };
  if (sourceMessageId) payload.source_message_id = sourceMessageId;
  return payload;
}

export interface ConfirmPayload {
  message_id: string;
  draft_indexes: number[];
}

/** 确认下推:message_id + 升序的选中索引(服务端按 index 从命令行解析真草案)。 */
export function buildConfirmPayload(
  messageId: string,
  selected: ReadonlySet<number>,
  total: number,
): ConfirmPayload {
  const indexes: number[] = [];
  for (let i = 0; i < total; i++) if (selected.has(i)) indexes.push(i);
  return { message_id: messageId, draft_indexes: indexes };
}

/* ---------------- 命令行结构化 payload 读取 ---------------- */

export interface DraftView {
  title: string;
  role: string;
  depends_on: string[];
  acceptance: string;
}

interface HasPayload {
  payload?: Record<string, unknown> | null;
}

/** 从命令行 payload 读草案数组(缺字段补默认;非数组 → 空)。 */
export function commandDrafts(msg: HasPayload): DraftView[] {
  const raw = msg.payload?.drafts;
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    const o = (d ?? {}) as Record<string, unknown>;
    return {
      title: typeof o.title === "string" ? o.title : "",
      role: typeof o.role === "string" ? o.role : "",
      depends_on: Array.isArray(o.depends_on)
        ? o.depends_on.filter((x): x is string => typeof x === "string")
        : [],
      acceptance: typeof o.acceptance === "string" ? o.acceptance : "",
    };
  });
}

/** 命令来源原话(payload.text;缺 → null)。 */
export function commandSourceText(msg: HasPayload): string | null {
  const t = msg.payload?.text;
  return typeof t === "string" ? t : null;
}

/* ---------------- 命令确认血缘回链 ---------------- */

interface TaskLineage {
  id?: string;
  origin?: string;
  created_from_message_id?: string | null;
}

/** 命令是否已确认下推:存在 origin=channel 且回链本命令 id 的任务(后端已回写)。 */
export function isCommandConfirmed(
  commandId: string,
  tasks: readonly TaskLineage[],
): boolean {
  return tasks.some(
    (t) => t.origin === "channel" && t.created_from_message_id === commandId,
  );
}

/** 由该命令生长的任务 id(供确认后逐一发起点名环)。 */
export function tasksFromCommand(
  commandId: string,
  tasks: readonly TaskLineage[],
): string[] {
  return tasks
    .filter((t) => t.origin === "channel" && t.created_from_message_id === commandId)
    .map((t) => t.id ?? "")
    .filter((id) => id !== "");
}
