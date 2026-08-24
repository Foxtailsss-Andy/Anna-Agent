/**
 * NotificationBell · 外壳通知铃(F5 · 设计稿 1f + 设计说明 §四/§五 P5 · U-C 可用性三轮)
 *
 * 挂 AnnaShell 右上,三段全程可见(fixed 顶层,不随侧栏折叠)。
 *   · 登录时刻未读≥1 → 弹卡堆叠(≤3,新在上),驻留 6s「收进铃」+ 徽标 pop。
 *   · 会话中新未读(未读数较上次轮询增加)→ 徽标 +1 + 铃单摆 ±9° 240ms,永不弹卡不打断。
 *   · 点铃开面板:按项目分组、未读顶已读沉底但留存(历史,≤30 条),开启即置读清徽标 +
 *     刷新;每行 = 事件图元/词 + 标题 + 时间,点项 = 深链导航(bus)。
 * 数据来自 CrewNotificationsProvider(单一 12s 轮询源 + 开面板即时刷新);零捏造,
 * 有身份即拉(token 与桌面免登录同等,后端有 local_session fallback)。
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { CrewNotification } from "../../lib/api/crew";
import { listProjects } from "../../lib/api/crew";
import { IrisPetal } from "../anna/IrisPetal";
import { useShellBus } from "./AnnaShell";
import { useCrewNotifications } from "./crewNotifications";
import {
  bellBadge,
  bellReducer,
  buildPanel,
  initialBellState,
  kindMeta,
  PANEL_CAP,
  relTime,
  resolveDeepLink,
  shouldSwing,
  type BellIcon,
} from "./bellModel";
import "./NotificationBell.css";

const POP_DWELL_MS = 6000;
const POP_FLY_MS = 340;

/** 广播点名环(F2 画布监听 window CustomEvent "crew:ring-call")—— 导航后稍延时,待详情挂载。 */
function dispatchRingCall(taskId: string) {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("crew:ring-call", { detail: { taskId } }));
  }, 360);
}

/* ---------------- 事件图元(内联 SVG 1.5px 描边 currentColor) ---------------- */

function Glyph({ icon }: { icon: BellIcon }) {
  if (icon === "petal") return <IrisPetal size={14} />;
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const body: Record<Exclude<BellIcon, "petal">, React.ReactNode> = {
    target: (
      <>
        <circle cx="12" cy="12" r="7.5" {...p} />
        <circle cx="12" cy="12" r="3" {...p} />
        <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
      </>
    ),
    diamond: <path d="M12 4.5 19.5 12 12 19.5 4.5 12z" {...p} />,
    redo: (
      <>
        <path d="M18 8.5a6.5 6.5 0 1 0 1.2 5" {...p} />
        <path d="M18.5 4.5V9H14" {...p} />
      </>
    ),
    bang: (
      <>
        <path d="M12 4 21 19.5H3z" {...p} />
        <path d="M12 10v4" {...p} />
        <circle cx="12" cy="16.6" r="0.8" fill="currentColor" stroke="none" />
      </>
    ),
    branch: (
      <>
        <circle cx="6.5" cy="6" r="2" {...p} />
        <circle cx="6.5" cy="18" r="2" {...p} />
        <circle cx="17.5" cy="12" r="2" {...p} />
        <path d="M6.5 8v8M6.5 12h4.5a4 4 0 0 0 4-2.2M6.5 12h4.5a4 4 0 0 1 4 2.2" {...p} />
      </>
    ),
    unlock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" {...p} />
        <path d="M8 11V8a4 4 0 0 1 7.6-1.8" {...p} />
      </>
    ),
  };
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      {body[icon]}
    </svg>
  );
}

function BellIconSvg() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.5a5.2 5.2 0 0 0-5.2 5.2c0 4.2-1.3 6-2 6.8-.3.4 0 1 .5 1h13.4c.5 0 .8-.6.5-1-.7-.8-2-2.6-2-6.8A5.2 5.2 0 0 0 12 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M10 19.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------- 弹卡 ---------------- */

function PopCardView({
  note,
  leaving,
  stagger,
  onOpen,
  onDismiss,
}: {
  note: CrewNotification;
  leaving: boolean;
  stagger: number;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const meta = kindMeta(note.kind);
  return (
    <div
      className={`ir-bell-pop ir-bell-pop--${meta.tone}${leaving ? " ir-bell-pop--leaving" : ""}`}
      style={{ animationDelay: `${stagger * 60}ms` }}
      role="alert"
    >
      <button type="button" className="ir-bell-pop__body" onClick={onOpen}>
        <div className="ir-bell-pop__head">
          <span className={`ir-bell-pop__icon ir-bell-pop__icon--${meta.tone}`}>
            <Glyph icon={meta.icon} />
          </span>
          <span className="ir-bell-pop__kind">{meta.label}</span>
          <span className="ir-bell-pop__time">{relTime(note.created_at)}</span>
        </div>
        <div className="ir-bell-pop__title">{note.title}</div>
        <div className="ir-bell-pop__deep">点击深链直达 →</div>
      </button>
      <button type="button" className="ir-bell-pop__x" onClick={onDismiss} aria-label="收进铃">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

export function NotificationBell() {
  const bus = useShellBus();
  const { notifications, unreadCount, loaded, markRead, markAllRead, reload } = useCrewNotifications();
  const [state, dispatch] = useReducer(bellReducer, initialBellState);
  const [panelOpen, setPanelOpen] = useState(false);
  const [swinging, setSwinging] = useState(false);
  const [badgePop, setBadgePop] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [projTitles, setProjTitles] = useState<Record<string, string>>({});
  /** 面板开启时刻的未读快照:置读后仍以此渲染 iris 点与未读优先序,稳住本次浏览。 */
  const [openUnread, setOpenUnread] = useState<ReadonlySet<string>>(() => new Set());
  const timersRef = useRef<Map<string, number>>(new Map());

  /* 摄入通知(provider 每次刷新 → 走 reducer;仅 initial 相位铸弹卡)。
   * 必须等 provider 首帧真正 loaded 后再摄入 —— 否则初始空数组会把 phase 抢先翻到 live,
   * 登录时刻的真未读就永远不弹卡了。 */
  useEffect(() => {
    if (!loaded) return;
    dispatch({ type: "ingest", notifications, now: Date.now() });
  }, [notifications, loaded]);

  /* 每张弹卡:驻留 6s → 收进铃(fly 340ms 后 collect) */
  useEffect(() => {
    const timers = timersRef.current;
    for (const card of state.popcards) {
      if (timers.has(card.id)) continue;
      const wait = Math.max(0, POP_DWELL_MS - (Date.now() - card.enteredAt));
      const t1 = window.setTimeout(() => {
        setLeaving((s) => new Set(s).add(card.id));
        const t2 = window.setTimeout(() => {
          dispatch({ type: "collect", id: card.id });
          setLeaving((s) => {
            const n = new Set(s);
            n.delete(card.id);
            return n;
          });
          timers.delete(card.id);
        }, POP_FLY_MS);
        timers.set(card.id, t2);
      }, wait);
      timers.set(card.id, t1);
    }
    // 清理已移除弹卡的计时器
    for (const [id, timer] of timers) {
      if (!state.popcards.some((c) => c.id === id)) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    }
  }, [state.popcards]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  /* 会话中新未读 → 单摆 ±9°(未读数较上次轮询「增加」时触发一次;CSS keyframe 永不循环,
   * reduced-motion 由 CSS 降级)。首帧只登记基线不摆 —— 登录时刻由弹卡承担,不叠摆动。 */
  const prevUnread = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const prev = prevUnread.current;
    prevUnread.current = unreadCount;
    if (prev === null) return;
    if (!shouldSwing(prev, unreadCount)) return;
    setSwinging(true);
    const t = window.setTimeout(() => setSwinging(false), 260);
    return () => window.clearTimeout(t);
  }, [unreadCount, loaded]);

  /* 徽标 pop(弹卡收进铃使 badge 增大时)*/
  const prevLen = useRef(state.popcards.length);
  useEffect(() => {
    if (state.popcards.length < prevLen.current) {
      setBadgePop(true);
      const t = window.setTimeout(() => setBadgePop(false), 260);
      prevLen.current = state.popcards.length;
      return () => window.clearTimeout(t);
    }
    prevLen.current = state.popcards.length;
  }, [state.popcards.length]);

  /* 面板开启时取项目名(分组头用;仅有通知时才拉,免登录不打 401) */
  useEffect(() => {
    if (!panelOpen || notifications.length === 0) return;
    let alive = true;
    listProjects()
      .then((ps) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const p of ps) map[p.id] = (p.goal_text ?? "").trim() || p.id;
        setProjTitles(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [panelOpen, notifications.length]);

  const badge = bellBadge(unreadCount, state.popcards.length);

  const popNotifs = useMemo(
    () =>
      state.popcards
        .map((c) => ({ card: c, note: notifications.find((n) => n.id === c.id) }))
        .filter((x): x is { card: typeof x.card; note: CrewNotification } => Boolean(x.note)),
    [state.popcards, notifications],
  );

  const panel = useMemo(
    () =>
      buildPanel(notifications, (id) => projTitles[id] ?? id, {
        unread: (n) => openUnread.has(n.id),
        cap: PANEL_CAP,
      }),
    [notifications, projTitles, openUnread],
  );

  /** 开面板:快照未读(点与序稳住本次浏览)→ 置读清徽标 + 刷新历史。 */
  const openPanel = () => {
    const snap = new Set(notifications.filter((n) => n.read_at == null).map((n) => n.id));
    setOpenUnread(snap);
    setPanelOpen(true);
    if (snap.size > 0) void markAllRead(); // 置读 → 徽标归零(内部随即刷新)
    else reload(); // 无未读也刷新一次,历史保持新鲜
  };

  const go = (n: CrewNotification) => {
    const target = resolveDeepLink(n);
    void markRead(n.id);
    setPanelOpen(false);
    dispatch({ type: "collect", id: n.id });
    if (target.section === "crew") {
      bus.openCrewProject(target.projectId);
      if (target.taskId) dispatchRingCall(target.taskId);
    } else if (target.section === "reimbursement") {
      bus.navigate("cowork", "reimbursement");
    } else {
      bus.navigate("crew", undefined, "inbox");
    }
  };

  return (
    <>
      <div className="ir-bell">
        <button
          type="button"
          className={`ir-bell__btn${swinging ? " ir-bell__btn--swing" : ""}`}
          aria-label={badge ? `通知 · 未读 ${badge}` : "通知"}
          aria-expanded={panelOpen}
          onClick={() => (panelOpen ? setPanelOpen(false) : openPanel())}
        >
          <BellIconSvg />
          {badge && <span className={`ir-bell__badge${badgePop ? " ir-bell__badge--pop" : ""}`}>{badge}</span>}
        </button>

        {/* 登录弹卡堆叠(新在上) */}
        {popNotifs.length > 0 && (
          <div className="ir-bell__stack" aria-live="polite">
            {popNotifs.map(({ card, note }, i) => (
              <PopCardView
                key={card.id}
                note={note}
                leaving={leaving.has(card.id)}
                stagger={i}
                onOpen={() => go(note)}
                onDismiss={() => dispatch({ type: "collect", id: card.id })}
              />
            ))}
          </div>
        )}
      </div>

      {/* 通知面板 */}
      {panelOpen && (
        <>
          <button
            type="button"
            className="ir-bell__scrim"
            aria-label="关闭通知面板"
            onClick={() => setPanelOpen(false)}
          />
          <div className="ir-bell__panel" role="dialog" aria-label="通知">
            <div className="ir-bell__panel-head">
              <span className="ir-bell__panel-title">通知</span>
              {panel.total > 0 && <span className="ir-bell__panel-count">{panel.total}</span>}
            </div>
            {panel.groups.length === 0 ? (
              <div className="ir-bell__panel-empty">没有通知 —— 安静即真没事。</div>
            ) : (
              <>
                <div className="ir-bell__panel-body">
                  {panel.groups.map((g) => (
                    <section key={g.key} className={`ir-bell__group ir-bell__group--${g.kind}`}>
                      <div className="ir-bell__group-head">
                        <span className="ir-bell__group-label">{g.label}</span>
                        <span className="ir-bell__group-n">{g.items.length}</span>
                      </div>
                      {g.items.map((n) => {
                        const unread = openUnread.has(n.id);
                        const meta = kindMeta(n.kind);
                        return (
                          <button
                            key={n.id}
                            type="button"
                            className={`ir-bell__item${unread ? " ir-bell__item--unread" : ""}`}
                            onClick={() => go(n)}
                          >
                            <span
                              className={`ir-bell__item-dot${unread ? " ir-bell__item-dot--on" : ""}`}
                              aria-hidden="true"
                            />
                            <span
                              className={`ir-bell__item-glyph ir-bell__item-glyph--${meta.tone}`}
                              aria-hidden="true"
                            >
                              <Glyph icon={meta.icon} />
                            </span>
                            <span className="ir-bell__item-main">
                              <span className="ir-bell__item-title">{n.title}</span>
                              <span className="ir-bell__item-sub">
                                {meta.label}
                                {!unread && " · 已读"}
                              </span>
                            </span>
                            <span className="ir-bell__item-time">{relTime(n.created_at)}</span>
                          </button>
                        );
                      })}
                    </section>
                  ))}
                </div>
                {panel.clipped && (
                  <div className="ir-bell__panel-foot">仅显示最近 {PANEL_CAP} 条</div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

export default NotificationBell;
