/**
 * 通知铃纯逻辑(F5 · 设计稿 1f + 设计说明 §四/§五 P5 · U-C 可用性三轮)
 *
 * 第一性(P5「铃的秩序」+ 设计说明「归位:不消失、不催促」):
 *   · 登录时刻未读≥1 → 弹卡堆叠(≤3,新在上),驻留 6s 后「收进铃里」,徽标 +1 归位。
 *   · 会话中收到新未读(未读数较上次轮询「增加」)→ 徽标 +1 + 铃单摆 ±9°,永不弹卡不打断。
 *   · 面板:按项目分组,未读顶、已读沉底但留存(历史通知);展示上限 30 条。
 *   · 徽标 = 尚在铃里的未读数,>9 收敛为「9+」,零即隐。
 * 一切来自真通知(GET /api/crew/notifications);零捏造,零就是零。
 */

import type { CrewNotification } from "../../lib/api/crew";

/* ---------------- reducer 状态 ---------------- */

export interface PopCard {
  /** 通知 id(渲染时回 provider 列表取全量字段) */
  id: string;
  /** 入场时刻(ms)—— 驻留 6s 判定 */
  enteredAt: number;
}

export interface BellState {
  /** initial=尚未见过首帧通知(登录时刻);live=会话进行中 */
  phase: "initial" | "live";
  /** 弹卡堆叠,新在上(index0=最新);≤3 */
  popcards: PopCard[];
  /** 已摄入的通知 id —— 避免二次弹卡 */
  seen: string[];
}

export const initialBellState: BellState = {
  phase: "initial",
  popcards: [],
  seen: [],
};

export type BellAction =
  | { type: "ingest"; notifications: CrewNotification[]; now: number }
  | { type: "collect"; id: string }
  | { type: "clear" };

const MAX_POPCARDS = 3;

const isUnread = (n: CrewNotification) => n.read_at == null;
const byNewest = (a: CrewNotification, b: CrewNotification) =>
  (b.created_at || "").localeCompare(a.created_at || "");

/**
 * 摆动触发(会话中新通知):未读数较上次轮询「增加」→ true(单次摆动)。
 * 持平/减少(含读掉、面板开启批量置读)→ false;绝不循环、绝不弹卡。
 */
export function shouldSwing(prevUnread: number, nextUnread: number): boolean {
  return nextUnread > prevUnread;
}

export function bellReducer(state: BellState, action: BellAction): BellState {
  switch (action.type) {
    case "collect": {
      const popcards = state.popcards.filter((c) => c.id !== action.id);
      if (popcards.length === state.popcards.length) return state;
      return { ...state, popcards };
    }
    case "clear":
      return state.popcards.length ? { ...state, popcards: [] } : state;
    case "ingest": {
      const { notifications, now } = action;
      const seenSet = new Set(state.seen);
      const newAny = notifications.filter((n) => !seenSet.has(n.id));
      // 幂等:无任何新通知 → 同一引用(不重渲染、不重置计时器)
      if (newAny.length === 0 && state.phase === "live") return state;

      const allIds = notifications.map((n) => n.id);
      const nextSeen = Array.from(new Set([...state.seen, ...allIds]));

      if (state.phase === "initial") {
        // 登录时刻:未读取最新 ≤3 张作弹卡(新在上);会话中永不弹卡(摆动由组件按未读数增量驱动)
        const popcards = newAny
          .filter(isUnread)
          .sort(byNewest)
          .slice(0, MAX_POPCARDS)
          .map((n) => ({ id: n.id, enteredAt: now }));
        return { phase: "live", popcards, seen: nextSeen };
      }

      return { ...state, seen: nextSeen };
    }
    default:
      return state;
  }
}

/* ---------------- 徽标 ---------------- */

/**
 * 徽标 = 「已在铃里」的未读数 = 未读总数 − 正在展示的弹卡数。
 * 弹卡当面呈现时不计入徽标;每收进铃一张,徽标 +1 落定(设计 1f)。
 * 计数 >9 收敛为「9+」(mono 单字宽);≤0 → null(零即隐,绝不造数)。
 */
export function bellBadge(unreadCount: number, popcardCount: number): string | null {
  const n = Math.max(0, unreadCount - popcardCount);
  if (n <= 0) return null;
  return n > 9 ? "9+" : String(n);
}

/* ---------------- 分组(面板) ---------------- */

export type NotifGroupKind = "project" | "cowork";

export interface NotifGroup {
  key: string;
  label: string;
  kind: NotifGroupKind;
  items: CrewNotification[];
}

const COWORK_KEY = "cowork:reimbursement";

/** 面板展示上限:超出则折叠为「仅显示最近 N 条」页脚(历史全存后端,不丢)。 */
export const PANEL_CAP = 30;

/** 归属 Cowork·报销 组:approval kind,或深链指向报销页 */
function isCowork(n: CrewNotification): boolean {
  return n.kind === "approval" || (n.deep_link || "").startsWith("/cowork/reimbursement");
}

/** 未读判定源:默认看 read_at;面板可传「开启时刻的未读快照」保住点与序(读掉不即隐)。 */
export type UnreadPredicate = (n: CrewNotification) => boolean;
const unreadByReadAt: UnreadPredicate = (n) => n.read_at == null;

/** 未读优先 → 各自最新在前(面板历史序:未读顶,已读沉底但留存)。 */
function unreadFirst(a: CrewNotification, b: CrewNotification, un: UnreadPredicate): number {
  const rank = (n: CrewNotification) => (un(n) ? 0 : 1);
  const d = rank(a) - rank(b);
  return d !== 0 ? d : byNewest(a, b);
}

/**
 * 面板分组:按项目分组 + 独立「Cowork · 报销」组(排最后)。
 * 组内未读顶、已读沉底(各自最新在前);带未读的项目组排在纯已读组之上。
 * ``un`` 缺省按 read_at 判未读;面板传入开启快照,使置读后点与序仍稳住本次浏览。
 */
export function groupNotifications(
  notifications: CrewNotification[],
  projectTitle: (projectId: string) => string,
  un: UnreadPredicate = unreadByReadAt,
): NotifGroup[] {
  const projectGroups = new Map<string, CrewNotification[]>();
  const cowork: CrewNotification[] = [];

  for (const n of notifications) {
    if (isCowork(n)) {
      cowork.push(n);
      continue;
    }
    const key = n.project_id ?? "misc";
    const bucket = projectGroups.get(key);
    if (bucket) bucket.push(n);
    else projectGroups.set(key, [n]);
  }

  const groups: NotifGroup[] = [];
  for (const [key, items] of projectGroups) {
    items.sort((a, b) => unreadFirst(a, b, un));
    groups.push({
      key,
      label: key === "misc" ? "通知" : projectTitle(key),
      kind: "project",
      items,
    });
  }
  // 项目组:带未读的在上,再按最新活动降序
  groups.sort((a, b) => {
    const d = (a.items.some(un) ? 0 : 1) - (b.items.some(un) ? 0 : 1);
    return d !== 0 ? d : byNewest(a.items[0], b.items[0]);
  });

  if (cowork.length) {
    cowork.sort((a, b) => unreadFirst(a, b, un));
    groups.push({ key: COWORK_KEY, label: "Cowork · 报销", kind: "cowork", items: cowork });
  }
  return groups;
}

export interface PanelModel {
  groups: NotifGroup[];
  /** 通知总数(未截断) */
  total: number;
  /** 实际渲染的条数(≤ cap) */
  shown: number;
  /** 是否被 cap 截断(→ 渲染「仅显示最近 N 条」页脚) */
  clipped: boolean;
}

/**
 * 面板视图:全局未读优先排序 → 取前 ``cap`` 条(默认 30)→ 再分组。
 * 未读始终排在已读之上,故截断先牺牲最旧的已读(历史仍全存后端,深链可达)。
 */
export function buildPanel(
  notifications: CrewNotification[],
  projectTitle: (projectId: string) => string,
  opts?: { unread?: UnreadPredicate; cap?: number },
): PanelModel {
  const un = opts?.unread ?? unreadByReadAt;
  const cap = opts?.cap ?? PANEL_CAP;
  const total = notifications.length;
  const shownList = [...notifications].sort((a, b) => unreadFirst(a, b, un)).slice(0, cap);
  return {
    groups: groupNotifications(shownList, projectTitle, un),
    total,
    shown: shownList.length,
    clipped: total > shownList.length,
  };
}

/* ---------------- 深链解析 ---------------- */

export type NavTarget =
  | { section: "crew"; projectId: string; taskId: string | null }
  | { section: "reimbursement" }
  | { section: "inbox" };

/** kind/字段 → 导航目标(点击弹卡或面板项时用) */
export function resolveDeepLink(n: {
  kind: string;
  project_id: string | null;
  task_id: string | null;
  deep_link: string;
}): NavTarget {
  if (n.kind === "approval" || (n.deep_link || "").startsWith("/cowork/reimbursement")) {
    return { section: "reimbursement" };
  }
  if (n.project_id) {
    return { section: "crew", projectId: n.project_id, taskId: n.task_id };
  }
  return { section: "inbox" };
}

/* ---------------- 事件图元与文案 ---------------- */

export type BellIcon = "petal" | "target" | "diamond" | "redo" | "bang" | "branch" | "unlock";

export interface KindMeta {
  label: string;
  icon: BellIcon;
  /** 语气:iris(常规)/ gold(评审)/ danger(驳回/阻塞)/ delegate(生长) */
  tone: "iris" | "gold" | "danger" | "delegate";
}

const KIND_META: Record<string, KindMeta> = {
  assigned: { label: "派工", icon: "petal", tone: "iris" },
  mention: { label: "@你", icon: "target", tone: "iris" },
  review_due: { label: "待你审", icon: "diamond", tone: "gold" },
  approval: { label: "待你审", icon: "diamond", tone: "gold" },
  rejected: { label: "被驳回", icon: "redo", tone: "danger" },
  blocked: { label: "阻塞", icon: "bang", tone: "danger" },
  unlocked: { label: "已解锁", icon: "unlock", tone: "iris" },
  grown: { label: "由频道生长", icon: "branch", tone: "delegate" },
};

export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] ?? { label: "通知", icon: "petal", tone: "iris" };
}

/* ---------------- 相对时间 ---------------- */

/** 相对时间:<1min「刚刚」/ <60min「N 分钟前」/ 更早「时:分」(跨日退化为月-日) */
export function relTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
