/**
 * AnnaShell · 外壳(Home 合并轮 M1 · Crew 增补 F1 第三段)
 *
 * 布局:左 Sidebar + 右 <main>(页面背景纵向微渐变)。
 * 侧栏三段 = Home | Cowork | Crew(Crew 增补 F1;Chat/Create 收为 Home 页内的 HomeMode)。
 * visited-mounted 保活:切走的 section 保留在 DOM 里(display:none),不卸载。
 * 折叠导轨(2b):collapsed 由 railReducer 驱动 —— 断点 <1280 自动折叠,快捷键 [ 手动优先。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { AnnaIdentity } from "../../lib/api/identity";
import { StateNote } from "../anna/StateNote";
import { initialRailState, railReducer } from "./railState";
import { parseKey, sectionKey, segmentOfSection } from "./navModel";
import type { CrewItem } from "./navModel";
import { CrewNotificationsProvider } from "./crewNotifications";
import { NotificationBell } from "./NotificationBell";
import { Sidebar } from "./Sidebar";
import "./AnnaShell.css";

export type ShellSection = "home" | "cowork" | "crew" | "hub" | "review" | "settings" | "agents";
export type CoworkItem = "hiker" | "reimbursement";
export type { CrewItem } from "./navModel";
/** Home 页内双模式(V2 H-01/H-02):会话绑定出生管线,pill 只在问候页 */
export type HomeMode = "chat" | "create";
/** 侧栏三段(H-13 + Crew 增补 F1):hub/settings/agents 是段外独立区,不改变当前段 */
export type SidebarSegment = "home" | "cowork" | "crew";

/* ================= ShellBus(壳扩展 · R7,C1 信号,M1 适配 Home) =================
 * 跨区导航 + 「在 Chat 使用」预填 + 侧栏历史/新建的唯一通路。
 * 信号模式:pendingRef 存值 + seq 自增;保活常驻页面依 seq 反应式一次性 consume。 */
export interface ShellBus {
  navigate: (section: ShellSection, cw?: CoworkItem, crew?: CrewItem, projectId?: string) => void;
  /** Crew:打开项目详情(sugar → navigate("crew", _, "project", id)) */
  openCrewProject: (projectId: string) => void;
  /** Home 当前模式(侧栏历史组联动 + 问候页 pill 共享) */
  homeMode: HomeMode;
  setHomeMode: (m: HomeMode) => void;
  /** 预填 Home composer 并切到 Chat 模式(产物中心「在 Chat 使用」) */
  prefillChat: (text: string) => void;
  prefillSeq: number;
  consumePrefill: () => string | null;
  /** 侧栏「历史对话」点击 → Home(Chat 模式)打开该 run 回看 */
  openChatRun: (runId: string) => void;
  openChatRunSeq: number;
  consumeOpenChatRun: () => string | null;
  /** 侧栏「＋新建任务」→ Home 回到问候空态,携带当前模式(H-13 ④) */
  newChat: () => void;
  newChatSeq: number;
  /** 侧栏「构建记录」点击 → Home(Create 模式)打开该 run 回看 */
  openCreateRun: (runId: string) => void;
  openCreateRunSeq: number;
  consumeOpenCreateRun: () => string | null;
  /** 页面通知侧栏刷新列表(run 完成 / 注册后) */
  refreshSidebar: () => void;
  sidebarSeq: number;
}

const NOOP_BUS: ShellBus = {
  navigate: () => {},
  openCrewProject: () => {},
  homeMode: "chat",
  setHomeMode: () => {},
  prefillChat: () => {},
  prefillSeq: 0,
  consumePrefill: () => null,
  openChatRun: () => {},
  openChatRunSeq: 0,
  consumeOpenChatRun: () => null,
  newChat: () => {},
  newChatSeq: 0,
  openCreateRun: () => {},
  openCreateRunSeq: 0,
  consumeOpenCreateRun: () => null,
  refreshSidebar: () => {},
  sidebarSeq: 0,
};

const ShellBusContext = createContext<ShellBus>(NOOP_BUS);

/** 壳外(单测)无 Provider 时回落 no-op,不抛错。 */
export const useShellBus = (): ShellBus => useContext(ShellBusContext);

export const SECTION_LABEL: Record<ShellSection, string> = {
  home: "Home",
  cowork: "Hiker",
  crew: "Crew",
  hub: "产物中心",
  review: "Review Inspector",
  settings: "设置",
  agents: "Agent 中心",
};

/** section → 所属侧栏段;纯函数迁至 navModel(可单测),此处再导出保持导入路径不变 */
export { segmentOfSection } from "./navModel";

export const COWORK_LABEL: Record<CoworkItem, string> = {
  hiker: "Hiker",
  reimbursement: "报销",
};

/** 区占位屏:瓷面卡 + StateNote stub + 区名 */
export function SectionPlaceholder({
  section,
  coworkItem,
}: {
  section: ShellSection;
  coworkItem: CoworkItem;
}) {
  const label =
    section === "cowork" ? `${SECTION_LABEL.cowork} · ${COWORK_LABEL[coworkItem]}` : SECTION_LABEL[section];
  return (
    <div className="ir-placeholder">
      <div className="ir-placeholder__card">
        <div className="ir-placeholder__eyebrow">{section.toUpperCase()}</div>
        <div className="ir-placeholder__title">{label}</div>
        <StateNote kind="stub" text={label} />
      </div>
    </div>
  );
}

export function AnnaShell({
  identity,
  onLogout,
  renderSection,
}: {
  identity: AnnaIdentity | null;
  onLogout: () => void;
  renderSection: (
    section: ShellSection,
    coworkItem: CoworkItem,
    crewItem: CrewItem,
    crewProjectId: string | null,
  ) => React.ReactNode;
}) {
  const [section, setSection] = useState<ShellSection>("home");
  const [coworkItem, setCoworkItem] = useState<CoworkItem>("hiker");
  const [crewItem, setCrewItem] = useState<CrewItem>("projects");
  const [crewProjectId, setCrewProjectId] = useState<string | null>(null);
  const [segment, setSegment] = useState<SidebarSegment>("home");
  const [homeMode, setHomeMode] = useState<HomeMode>("chat");
  const [rail, dispatchRail] = useReducer(
    railReducer,
    undefined,
    () => initialRailState(typeof window !== "undefined" ? window.innerWidth : 1440),
  );
  const collapsed = rail.collapsed;
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["home"]));
  const pendingPrefillRef = useRef<string | null>(null);
  const [prefillSeq, setPrefillSeq] = useState(0);
  const pendingChatRunRef = useRef<string | null>(null);
  const [openChatRunSeq, setOpenChatRunSeq] = useState(0);
  const [newChatSeq, setNewChatSeq] = useState(0);
  const pendingCreateRunRef = useRef<string | null>(null);
  const [openCreateRunSeq, setOpenCreateRunSeq] = useState(0);
  const [sidebarSeq, setSidebarSeq] = useState(0);

  /* 折叠导轨(2b):视口断点(未手动时)+ 快捷键 [(手动优先,输入框内不劫持) */
  useEffect(() => {
    const onResize = () => dispatchRail({ type: "viewport", width: window.innerWidth });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      dispatchRail({ type: "toggle" });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const currentKey = sectionKey(section, coworkItem, crewItem);

  const onNavigate = useCallback(
    (s: ShellSection, cw?: CoworkItem, crew?: CrewItem, projectId?: string) => {
      const nextCowork = s === "cowork" ? cw ?? coworkItem : coworkItem;
      const nextCrew = s === "crew" ? crew ?? crewItem : crewItem;
      setSection(s);
      setSegment((prev) => segmentOfSection(s, prev));
      if (s === "cowork" && cw) setCoworkItem(cw);
      if (s === "crew" && crew) setCrewItem(crew);
      if (s === "crew" && projectId) setCrewProjectId(projectId);
      const key = sectionKey(s, nextCowork, nextCrew);
      setVisited((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    [coworkItem, crewItem],
  );

  const openCrewProject = useCallback(
    (projectId: string) => onNavigate("crew", undefined, "project", projectId),
    [onNavigate],
  );

  const keys = useMemo(() => [...visited], [visited]);

  const prefillChat = useCallback(
    (text: string) => {
      pendingPrefillRef.current = text;
      setPrefillSeq((n) => n + 1);
      setHomeMode("chat");
      onNavigate("home");
    },
    [onNavigate],
  );

  const consumePrefill = useCallback((): string | null => {
    const text = pendingPrefillRef.current;
    pendingPrefillRef.current = null;
    return text;
  }, []);

  const openChatRun = useCallback(
    (runId: string) => {
      pendingChatRunRef.current = runId;
      setOpenChatRunSeq((n) => n + 1);
      setHomeMode("chat");
      onNavigate("home");
    },
    [onNavigate],
  );
  const consumeOpenChatRun = useCallback((): string | null => {
    const id = pendingChatRunRef.current;
    pendingChatRunRef.current = null;
    return id;
  }, []);

  /** 新建任务:回 Home 问候页,携带当前模式(H-13 ④,不弹菜单) */
  const newChat = useCallback(() => {
    setNewChatSeq((n) => n + 1);
    onNavigate("home");
  }, [onNavigate]);

  const openCreateRun = useCallback(
    (runId: string) => {
      pendingCreateRunRef.current = runId;
      setOpenCreateRunSeq((n) => n + 1);
      setHomeMode("create");
      onNavigate("home");
    },
    [onNavigate],
  );
  const consumeOpenCreateRun = useCallback((): string | null => {
    const id = pendingCreateRunRef.current;
    pendingCreateRunRef.current = null;
    return id;
  }, []);

  const refreshSidebar = useCallback(() => setSidebarSeq((n) => n + 1), []);

  const bus = useMemo<ShellBus>(
    () => ({
      navigate: onNavigate,
      openCrewProject,
      homeMode,
      setHomeMode,
      prefillChat,
      prefillSeq,
      consumePrefill,
      openChatRun,
      openChatRunSeq,
      consumeOpenChatRun,
      newChat,
      newChatSeq,
      openCreateRun,
      openCreateRunSeq,
      consumeOpenCreateRun,
      refreshSidebar,
      sidebarSeq,
    }),
    [onNavigate, openCrewProject, homeMode, prefillChat, prefillSeq, consumePrefill, openChatRun, openChatRunSeq, consumeOpenChatRun, newChat, newChatSeq, openCreateRun, openCreateRunSeq, consumeOpenCreateRun, refreshSidebar, sidebarSeq],
  );

  return (
    <ShellBusContext.Provider value={bus}>
    {/* 有身份即拉:token 与桌面免登录(local-runtime)同为一等 —— 后端 crew 路由对
        local_session 有 fallback(main.py「not a permanent 401」),故免登录也点亮铃,
        不再是永久暗铃。无身份(未装载/登出)→ 不拉,诚实空态。 */}
    <CrewNotificationsProvider enabled={identity != null}>
    <div className="ir-shell">
      <Sidebar
        section={section}
        coworkItem={coworkItem}
        crewItem={crewItem}
        crewProjectId={crewProjectId}
        segment={segment}
        homeMode={homeMode}
        collapsed={collapsed}
        onNavigate={onNavigate}
        onToggleCollapsed={() => dispatchRail({ type: "toggle" })}
        identity={identity}
        onLogout={onLogout}
      />
      <main className="ir-shell__main">
        {keys.map((key) => {
          const { section: s, coworkItem: cw, crewItem: ci } = parseKey(key);
          const active = key === currentKey;
          return (
            <div
              key={key}
              className={`ir-shell__page${active ? "" : " ir-shell__page--hidden"}`}
              aria-hidden={active ? undefined : true}
            >
              {renderSection(s, cw, ci, crewProjectId)}
            </div>
          );
        })}
      </main>
      {/* 通知铃:外壳右上,三段全程可见(不随侧栏折叠) */}
      <NotificationBell />
    </div>
    </CrewNotificationsProvider>
    </ShellBusContext.Provider>
  );
}

export default AnnaShell;
