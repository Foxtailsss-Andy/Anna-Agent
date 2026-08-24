/**
 * CrewNotificationsProvider · 通知共享数据源(F5 · U-C 可用性三轮)
 *
 * 单一轮询源(12s,壳级不锤后端):铃(外壳右上,三段全程)与侧栏收件箱徽标共用,
 * 避免双拉(计划要求);面板开启另触发一次即时刷新(见 NotificationBell)。
 * ``enabled`` 由外壳按「有身份即拉」给出 —— token 与桌面免登录(local-runtime)同为
 * 一等回落(后端 crew._session 对 local_session 有 fallback,不打 401);无身份 → 诚实空态。
 * 一切来自 GET /api/crew/notifications;失败静默空,零捏造。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { listNotifications, markNotificationRead, type CrewNotification } from "../../lib/api/crew";

const POLL_MS = 12000;

export interface CrewNotificationsCtx {
  notifications: CrewNotification[];
  unreadCount: number;
  loaded: boolean;
  reload: () => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const EMPTY_CTX: CrewNotificationsCtx = {
  notifications: [],
  unreadCount: 0,
  loaded: false,
  reload: () => {},
  markRead: async () => {},
  markAllRead: async () => {},
};

const Ctx = createContext<CrewNotificationsCtx>(EMPTY_CTX);

/** 壳外(单测)无 Provider 时回落空态,不抛错。 */
export const useCrewNotifications = (): CrewNotificationsCtx => useContext(Ctx);

export function CrewNotificationsProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [notifications, setNotifications] = useState<CrewNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const aliveRef = useRef(true);

  const fetchNow = useCallback(() => {
    if (!enabled) {
      setNotifications([]);
      setLoaded(true);
      return;
    }
    listNotifications(false)
      .then((list) => {
        if (aliveRef.current) setNotifications(list);
      })
      .catch(() => {
        if (aliveRef.current) setNotifications([]); // 失败静默空,不造数
      })
      .finally(() => {
        if (aliveRef.current) setLoaded(true);
      });
  }, [enabled]);

  useEffect(() => {
    aliveRef.current = true;
    fetchNow();
    if (!enabled) return () => {};
    const timer = window.setInterval(fetchNow, POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [enabled, fetchNow]);

  const markRead = useCallback(async (id: string) => {
    // 乐观置读:先本地翻读,再回源刷新
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && n.read_at == null ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    try {
      await markNotificationRead(id);
    } catch {
      /* 失败下次轮询自愈 */
    }
    fetchNow();
  }, [fetchNow]);

  const markAllRead = useCallback(async () => {
    // 无批量端点 → 逐条 PATCH(登记为实现说明);先乐观全读
    const unread = notifications.filter((n) => n.read_at == null);
    setNotifications((prev) => prev.map((n) => (n.read_at == null ? { ...n, read_at: new Date().toISOString() } : n)));
    await Promise.allSettled(unread.map((n) => markNotificationRead(n.id)));
    fetchNow();
  }, [notifications, fetchNow]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.read_at == null).length,
    [notifications],
  );

  const value = useMemo<CrewNotificationsCtx>(
    () => ({ notifications, unreadCount, loaded, reload: fetchNow, markRead, markAllRead }),
    [notifications, unreadCount, loaded, fetchNow, markRead, markAllRead],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
