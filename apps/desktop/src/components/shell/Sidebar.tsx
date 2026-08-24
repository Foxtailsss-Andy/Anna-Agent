/**
 * Sidebar · Iris 外壳左栏(Home 合并轮 M1 · Crew 增补 F1 第三段 + 折叠导轨 2b)
 *
 * 展开态结构(上→下):品牌行 → Home|Cowork|Crew 三段 pill →
 *   [Home] ＋新建任务 · 资源 · 历史组随模式联动
 *   [Cowork] Hiker(客户与合同/报销助理) · 资源
 *   [Crew] 收件箱(未读徽标)· 项目(子列表 x/y 进度)· 团队 · SOP 模板 · 资源
 *   → Agent 中心 → 自检 chip → UserChip。
 * 折叠导轨(collapsed):64px icon rail —— 鸢尾章 → 竖排 segmented 三段 icon →
 *   导航 icon(激活=soft 底+左缘 2px;徽标保留)→ Agent 中心 / 自检绿点 / 头像;
 *   tooltip 350ms 延迟,项目 hover 飞出层。数据全真,失败静默空(徽标失败即隐藏,不造数)。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AnnaIdentity } from "../../lib/api/identity";
import { listChatRuns } from "../../lib/api/chat";
import { listDrafts } from "../../lib/api/create";
import { getRuntimeStatus } from "../../lib/api/admin";
import { listProjects } from "../../lib/api/crew";
import type { CrewProject } from "../../lib/api/crew";
import { deriveUnreadBadge, projectProgress } from "../../pages/crew/crewModel";
import { IrisPetal } from "../anna/IrisPetal";
import type { CoworkItem, CrewItem, HomeMode, ShellSection, SidebarSegment } from "./AnnaShell";
import { useShellBus } from "./AnnaShell";
import { useCrewNotifications } from "./crewNotifications";
import { UserChip } from "./UserChip";
import "./Sidebar.css";

export interface SidebarProps {
  section: ShellSection;
  coworkItem: CoworkItem;
  crewItem: CrewItem;
  crewProjectId: string | null;
  segment: SidebarSegment;
  homeMode: HomeMode;
  collapsed: boolean;
  onNavigate: (s: ShellSection, cw?: CoworkItem, crew?: CrewItem, projectId?: string) => void;
  onToggleCollapsed: () => void;
  identity: AnnaIdentity | null;
  onLogout: () => void;
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/* ---------------- 侧栏数据(真值;失败静默空,空态即空态) ---------------- */

interface RunEntry {
  id: string;
  title: string;
  status: string;
}

function chatEntry(run: Rec): RunEntry {
  const q = str(run.user_message) || str(run.message) || str(run.id);
  return { id: str(run.id), title: q.length > 14 ? `${q.slice(0, 14)}…` : q, status: str(run.status) };
}

function draftEntry(run: Rec): RunEntry {
  const art = (run.artifact ?? {}) as Rec;
  const prompt = str(run.prompt);
  const name = str(art.skill_id) || str(art.prompt_id) || str(art.tool_id) || prompt;
  return {
    id: str(run.id),
    title: name.length > 14 ? `${name.slice(0, 14)}…` : name || str(run.id),
    status: str(run.status),
  };
}

/** 项目显示名 = goal_text(截断);登录页重设计等短名直出。 */
function projectName(p: CrewProject): string {
  const g = (p.goal_text ?? "").trim() || p.id;
  return g.length > 10 ? `${g.slice(0, 10)}…` : g;
}

function initialOf(name: string): string {
  const t = name.trim();
  return t ? t[0].toUpperCase() : "·";
}

/** 自检 chip 三态:ok(全通过)/ warn(N 项待处理)/ 未知(取不到) */
type SelfCheck = { tone: "ok" | "warn" | "dim"; text: string };

function deriveSelfCheck(status: Rec): SelfCheck {
  const model = ((status.model ?? {}) as Rec).status === "configured";
  const mcps = ["reimbursement_mcp", "erp_mcp", "hiker_mcp"].map(
    (k) => ((status[k] ?? {}) as Rec).status === "connected",
  );
  const failing = (model ? 0 : 1) + mcps.filter((ok) => !ok).length;
  if (failing === 0) return { tone: "ok", text: "运行自检通过" };
  return { tone: "warn", text: `自检 · ${failing} 项待处理` };
}

/* ---------------- 内联图标(1.5px 描边 · currentColor) ---------------- */

type IconName =
  | "hub" | "skill" | "reimbursement" | "hiker" | "agents" | "plus"
  | "inbox" | "board" | "team" | "sop" | "agentBot"
  | "segHome" | "segCowork" | "segCrew";

function Icon({ name, size = 16, sw = 1.5 }: { name: IconName; size?: number; sw?: number }) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const paths: Record<IconName, React.ReactNode> = {
    hub: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" {...p} />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" {...p} />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" {...p} />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" {...p} />
      </>
    ),
    skill: (
      <>
        <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z" {...p} />
        <path d="M4 7.6 12 12l8-4.4M12 12v8.8" {...p} />
      </>
    ),
    reimbursement: (
      <>
        <path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z" {...p} />
        <path d="M9 8h6M9 12h6" {...p} />
      </>
    ),
    hiker: (
      <>
        <circle cx="12" cy="12" r="8.5" {...p} />
        <path d="M3.5 12h17M12 3.5c2.4 2.4 2.4 14.6 0 17M12 3.5c-2.4 2.4-2.4 14.6 0 17" {...p} />
      </>
    ),
    agents: (
      <>
        <rect x="5" y="6" width="14" height="11" rx="2.5" {...p} />
        <path d="M12 3v3M9 21v-1.5M15 21v-1.5" {...p} />
        <circle cx="9.4" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
        <circle cx="14.6" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" {...p} />,
    /* Crew 导航图标(设计稿 2b · 收件箱=托盘/项目=看板/团队=人/模板=网格+) */
    inbox: (
      <>
        <path d="M4 13.5V17a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3.5" {...p} />
        <path d="M4 13.5h4.2l1.6 2.5h4.4l1.6-2.5H20" {...p} />
        <path d="M5.6 13.5 7 6.8A2 2 0 0 1 9 5.2h6a2 2 0 0 1 2 1.6l1.4 6.7" {...p} />
      </>
    ),
    board: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2.5" {...p} />
        <path d="M4 9.5h16M9 5V3.6M15 5V3.6" {...p} />
      </>
    ),
    team: (
      <>
        <circle cx="9" cy="8.5" r="3.2" {...p} />
        <path d="M3.8 19.4c.8-3 2.8-4.6 5.2-4.6s4.4 1.6 5.2 4.6" {...p} />
        <path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.6 14.9c1.4.7 2.4 2.2 2.9 4.5" {...p} />
      </>
    ),
    sop: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="1.8" {...p} />
        <rect x="13" y="4" width="7" height="7" rx="1.8" {...p} />
        <rect x="4" y="13" width="7" height="7" rx="1.8" {...p} />
        <path d="M16.5 13.5v7M13 17h7" {...p} />
      </>
    ),
    agentBot: (
      <>
        <rect x="5" y="7" width="14" height="12" rx="3" {...p} />
        <path d="M12 7V4M9.5 12.5h.01M14.5 12.5h.01M9 16h6" {...p} />
      </>
    ),
    /* 折叠导轨 segmented 三段隐喻:房 / 双泡 / 节点图 */
    segHome: (
      <>
        <path d="M4.5 11 12 4.8 19.5 11" {...p} />
        <path d="M6.5 9.5V19h11V9.5" {...p} />
      </>
    ),
    segCowork: (
      <>
        <path d="M4 6.3C4 5 5 4 6.3 4h6.4C14 4 15 5 15 6.3v3.4c0 1.3-1 2.3-2.3 2.3H9.2L6 14.6V12h.3C5 12 4 11 4 9.7V6.3Z" {...p} />
        <path d="M17 8.5h1.7c1.3 0 2.3 1 2.3 2.3v2.9c0 1.3-1 2.3-2.3 2.3H18v2.6l-3-2.6" {...p} />
      </>
    ),
    segCrew: (
      <>
        <circle cx="6" cy="6.5" r="2.2" {...p} />
        <circle cx="18" cy="6.5" r="2.2" {...p} />
        <circle cx="12" cy="17.5" r="2.2" {...p} />
        <path d="M8.2 6.5h7.6M7.4 8.4l3.4 7.1M16.6 8.4l-3.4 7.1" {...p} />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ transform: dir === "left" ? "rotate(180deg)" : undefined }}
    >
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SEGMENTS: { segment: SidebarSegment; label: string; icon: IconName }[] = [
  { segment: "home", label: "Home", icon: "segHome" },
  { segment: "cowork", label: "Cowork", icon: "segCowork" },
  { segment: "crew", label: "Crew", icon: "segCrew" },
];

/** 折叠导轨的一枚导航项模型 */
interface RailNavItem {
  key: string;
  icon: IconName;
  label: string;
  active?: boolean;
  onClick: () => void;
  badge?: string | null;
  flyout?: boolean;
}

export function Sidebar({
  section,
  coworkItem,
  crewItem,
  crewProjectId,
  segment,
  homeMode,
  collapsed,
  onNavigate,
  onToggleCollapsed,
  identity,
  onLogout,
}: SidebarProps) {
  const bus = useShellBus();
  /* 未读徽标:复用外壳通知铃的共享轮询源(单一 5s 拉取,避免双拉) */
  const { unreadCount } = useCrewNotifications();
  const [chatRuns, setChatRuns] = useState<RunEntry[] | null>(null);
  const [drafts, setDrafts] = useState<RunEntry[] | null>(null);
  const [check, setCheck] = useState<SelfCheck>({ tone: "dim", text: "自检 · 装载中" });
  const [activeChatRun, setActiveChatRun] = useState<string>("");
  const [activeCreateRun, setActiveCreateRun] = useState<string>("");
  /* Crew 段真数据:项目列表(子列表 + 飞出层) */
  const [projects, setProjects] = useState<CrewProject[] | null>(null);

  /* 历史组标题:模式联动瞬间 iris 点亮 600ms 后回灰(H-13 ②;首帧不亮) */
  const [labelLit, setLabelLit] = useState(false);
  const firstModeRef = useRef(true);
  useEffect(() => {
    if (firstModeRef.current) {
      firstModeRef.current = false;
      return;
    }
    setLabelLit(true);
    const t = window.setTimeout(() => setLabelLit(false), 600);
    return () => window.clearTimeout(t);
  }, [homeMode]);

  /* 列表:进段即取 + sidebarSeq 信号刷新(真数据;失败留空) */
  const loadLists = useCallback(() => {
    listChatRuns()
      .then((runs) => setChatRuns((runs as Rec[]).map(chatEntry).filter((r) => r.id)))
      .catch(() => setChatRuns([]));
    listDrafts()
      .then((runs) => setDrafts((runs as Rec[]).map(draftEntry).filter((r) => r.id)))
      .catch(() => setDrafts([]));
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists, segment, homeMode, bus.sidebarSeq]);

  /* Crew 段:项目列表(失败静默空,不造数;未读徽标走共享通知源) */
  useEffect(() => {
    if (segment !== "crew") return;
    let alive = true;
    listProjects()
      .then((p) => alive && setProjects(p))
      .catch(() => alive && setProjects([]));
    return () => {
      alive = false;
    };
  }, [segment, bus.sidebarSeq]);

  /* 自检 chip:挂载取一次 + sidebarSeq 跟刷(runtime status 真值) */
  useEffect(() => {
    getRuntimeStatus()
      .then((s) => setCheck(deriveSelfCheck(s as Rec)))
      .catch(() => setCheck({ tone: "dim", text: "自检 · 不可用" }));
  }, [bus.sidebarSeq]);

  const openRun = (id: string) => {
    setActiveChatRun(id);
    bus.openChatRun(id);
  };
  const openDraft = (id: string) => {
    setActiveCreateRun(id);
    bus.openCreateRun(id);
  };

  const badge = deriveUnreadBadge(unreadCount);
  const displayName = identity?.displayName ?? "";

  const group = (label: string, children: React.ReactNode, lit?: boolean) => (
    <div className="ir-side__group">
      <div className={`ir-side__group-label${lit ? " ir-side__group-label--lit" : ""}`}>{label}</div>
      {children}
    </div>
  );

  const item = (opts: {
    key?: string;
    icon?: IconName;
    label: string;
    on?: boolean;
    dot?: boolean;
    badge?: string | null;
    onClick?: () => void;
    stub?: boolean;
  }) => {
    if (opts.stub) {
      return (
        <div key={opts.key ?? opts.label} className="ir-side__row ir-side__row--stub" aria-disabled="true">
          {opts.icon && (
            <span className="ir-side__row-icon">
              <Icon name={opts.icon} />
            </span>
          )}
          <span className="ir-side__row-label">{opts.label}</span>
          <span className="ir-side__stub-tag">即将上线</span>
        </div>
      );
    }
    return (
      <button
        key={opts.key ?? opts.label}
        type="button"
        className={`ir-side__row${opts.on ? " ir-side__row--on" : ""}`}
        aria-current={opts.on ? "page" : undefined}
        onClick={opts.onClick}
        title={opts.label}
      >
        {opts.dot && <span className="ir-side__row-dot" aria-hidden="true" />}
        {opts.icon && (
          <span className="ir-side__row-icon">
            <Icon name={opts.icon} />
          </span>
        )}
        <span className="ir-side__row-label">{opts.label}</span>
        {opts.badge && <span className="ir-side__badge">{opts.badge}</span>}
      </button>
    );
  };

  const hubOn = section === "hub";
  const resources = group(
    "资源",
    <>
      {item({ icon: "skill", label: "技能", stub: true })}
      {item({ icon: "hub", label: "产物中心", on: hubOn, onClick: () => onNavigate("hub") })}
      {item({ icon: "hub", label: "Review Inspector", on: section === "review", onClick: () => onNavigate("review") })}
    </>,
  );

  /* Home 段历史组:随模式换标题与数据源,条目文法不变(H-13 ②) */
  const homeHistory =
    homeMode === "chat"
      ? group(
          "历史对话",
          chatRuns === null ? (
            <div className="ir-side__note">装载中……</div>
          ) : chatRuns.length === 0 ? (
            <div className="ir-side__note">还没有对话记录</div>
          ) : (
            chatRuns.slice(0, 8).map((r) =>
              item({
                key: r.id,
                label: r.title,
                on: section === "home" && activeChatRun === r.id,
                dot: r.status === "generating",
                onClick: () => openRun(r.id),
              }),
            )
          ),
          labelLit,
        )
      : group(
          "构建记录",
          drafts === null ? (
            <div className="ir-side__note">装载中……</div>
          ) : drafts.length === 0 ? (
            <div className="ir-side__note">还没有构建记录</div>
          ) : (
            drafts.slice(0, 8).map((r) =>
              item({
                key: r.id,
                label: r.title,
                on: section === "home" && activeCreateRun === r.id,
                dot: r.status === "generating",
                onClick: () => openDraft(r.id),
              }),
            )
          ),
          labelLit,
        );

  /* Crew 段:项目子列表(真数据;dot=选中态,mono x/y 进度) */
  const projectSubList =
    projects === null ? (
      <div className="ir-side__note">装载中……</div>
    ) : projects.length === 0 ? (
      <div className="ir-side__note">还没有项目</div>
    ) : (
      projects.map((p) => {
        const on = crewProjectId === p.id && (crewItem === "project" || crewItem === "projects");
        return (
          <button
            key={p.id}
            type="button"
            className={`ir-side__subrow${on ? " ir-side__subrow--on" : ""}`}
            aria-current={on ? "page" : undefined}
            onClick={() => bus.openCrewProject(p.id)}
            title={p.goal_text}
          >
            <span className={`ir-side__proj-dot${on ? " ir-side__proj-dot--on" : ""}`} aria-hidden="true" />
            <span className="ir-side__subrow-label">{projectName(p)}</span>
            <span className="ir-side__proj-prog">{projectProgress(p.tasks).label}</span>
          </button>
        );
      })
    );

  /* ---------------- 折叠导轨(2b) ---------------- */

  const railNav: RailNavItem[] =
    segment === "crew"
      ? [
          { key: "inbox", icon: "inbox", label: "收件箱", active: crewItem === "inbox", badge, onClick: () => onNavigate("crew", undefined, "inbox") },
          { key: "projects", icon: "board", label: "项目", active: crewItem === "projects" || crewItem === "project", flyout: true, onClick: () => onNavigate("crew", undefined, "projects") },
          { key: "team", icon: "team", label: "团队", active: crewItem === "team", onClick: () => onNavigate("crew", undefined, "team") },
          { key: "templates", icon: "sop", label: "SOP 模板", active: crewItem === "templates", onClick: () => onNavigate("crew", undefined, "templates") },
        ]
      : segment === "cowork"
        ? [
            { key: "reimbursement", icon: "reimbursement", label: "报销助理", active: section === "cowork" && coworkItem === "reimbursement", onClick: () => onNavigate("cowork", "reimbursement") },
            { key: "hiker", icon: "hiker", label: "Hiker 看板", active: section === "cowork" && coworkItem === "hiker", onClick: () => onNavigate("cowork", "hiker") },
          ]
        : [
            { key: "new", icon: "plus", label: "新建任务", onClick: () => bus.newChat() },
            { key: "hub", icon: "hub", label: "产物中心", active: section === "hub", onClick: () => onNavigate("hub") },
            { key: "review", icon: "hub", label: "Review Inspector", active: section === "review", onClick: () => onNavigate("review") },
          ];

  if (collapsed) {
    return (
      <aside className="ir-side ir-side--collapsed">
        <div className="ir-rail">
          <button
            type="button"
            className="ir-rail__brand"
            onClick={onToggleCollapsed}
            aria-label="展开侧栏"
            title="展开侧栏 · ["
          >
            <IrisPetal size={18} />
          </button>

          <div className="ir-rail__seg" role="tablist" aria-label="区域">
            {SEGMENTS.map((s) => (
              <span key={s.segment} className="ir-rail__item">
                <button
                  type="button"
                  role="tab"
                  aria-selected={segment === s.segment}
                  className={`ir-rail__seg-btn${segment === s.segment ? " ir-rail__seg-btn--on" : ""}`}
                  onClick={() => onNavigate(s.segment)}
                >
                  <Icon name={s.icon} sw={1.6} />
                </button>
                <span className="ir-rail__tip" role="tooltip">{s.label}</span>
              </span>
            ))}
          </div>

          <div className="ir-rail__div" />

          <div className="ir-rail__nav">
            {railNav.map((n) => (
              <span key={n.key} className={`ir-rail__item${n.flyout ? " ir-rail__item--flyout" : ""}`}>
                <button
                  type="button"
                  className={`ir-rail__btn${n.active ? " ir-rail__btn--on" : ""}`}
                  aria-current={n.active ? "page" : undefined}
                  onClick={n.onClick}
                >
                  {n.active && <span className="ir-rail__edge" aria-hidden="true" />}
                  <Icon name={n.icon} />
                  {n.badge && <span className="ir-rail__badge">{n.badge}</span>}
                </button>
                <span className="ir-rail__tip" role="tooltip">
                  {n.label}
                  {n.key === "inbox" && badge && <em className="ir-rail__tip-sub"> 未读 {badge}</em>}
                </span>
                {n.flyout && (
                  <div className="ir-rail__flyout" role="menu">
                    <div className="ir-rail__flyout-head">项目 · hover 飞出层</div>
                    {projects === null ? (
                      <div className="ir-rail__flyout-note">装载中……</div>
                    ) : projects.length === 0 ? (
                      <div className="ir-rail__flyout-note">还没有项目</div>
                    ) : (
                      projects.map((p) => {
                        const on = crewProjectId === p.id;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="menuitem"
                            className={`ir-rail__flyout-row${on ? " ir-rail__flyout-row--on" : ""}`}
                            onClick={() => bus.openCrewProject(p.id)}
                          >
                            <span className={`ir-side__proj-dot${on ? " ir-side__proj-dot--on" : ""}`} aria-hidden="true" />
                            <span className="ir-rail__flyout-name">{projectName(p)}</span>
                            <span className="ir-rail__flyout-prog">{projectProgress(p.tasks).label}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </span>
            ))}
          </div>

          <div className="ir-rail__spacer" />

          <span className="ir-rail__item">
            <button
              type="button"
              className={`ir-rail__btn ir-rail__btn--agent${section === "agents" ? " ir-rail__btn--on" : ""}`}
              onClick={() => onNavigate("agents")}
            >
              <Icon name="agentBot" />
            </button>
            <span className="ir-rail__tip" role="tooltip">Agent 中心</span>
          </span>

          <span className="ir-rail__item">
            <button
              type="button"
              className={`ir-rail__check ir-rail__check--${check.tone}`}
              onClick={() => onNavigate("settings")}
              aria-label={check.text}
            >
              <span className="ir-rail__check-dot" aria-hidden="true" />
            </button>
            <span className="ir-rail__tip" role="tooltip">{check.text}</span>
          </span>

          <span className="ir-rail__item">
            <button
              type="button"
              className="ir-rail__avatar"
              onClick={() => onNavigate("settings")}
              aria-label={displayName || "身份"}
            >
              {initialOf(displayName)}
            </button>
            <span className="ir-rail__tip" role="tooltip">{displayName || "身份"}</span>
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="ir-side">
      {/* 品牌行:衬线 Anna + 鸢尾瓣 13(白名单点缀 1/本屏) */}
      <div className="ir-side__brand">
        <span className="ir-side__logo">
          <IrisPetal size={13} />
        </span>
        <span className="ir-side__wordmark">Anna</span>
        <span className="ir-side__brand-spacer" />
        <button
          type="button"
          className="ir-side__collapse"
          onClick={onToggleCollapsed}
          aria-label="收起侧栏"
          title="收起侧栏 · ["
        >
          <Chevron dir="left" />
        </button>
      </div>

      {/* 三段 pill(H-13 ① + Crew 增补:track/激活面/12px 字几何一致,容三枚) */}
      <div className="ir-side__modes" role="tablist" aria-label="区域">
        {SEGMENTS.map((s) => (
          <button
            key={s.segment}
            type="button"
            role="tab"
            aria-selected={segment === s.segment}
            className={`ir-side__mode${segment === s.segment ? " ir-side__mode--on" : ""}`}
            onClick={() => onNavigate(s.segment)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="ir-side__body">
        {segment === "home" && (
          <>
            <button type="button" className="ir-side__new" onClick={() => bus.newChat()}>
              <Icon name="plus" size={15} />
              <span>新建任务</span>
            </button>
            {resources}
            {homeHistory}
          </>
        )}

        {segment === "cowork" && (
          <>
            {group(
              "Hiker",
              <>
                {item({
                  icon: "hiker",
                  label: "客户与合同",
                  on: section === "cowork" && coworkItem === "hiker",
                  onClick: () => onNavigate("cowork", "hiker"),
                })}
                {item({
                  icon: "reimbursement",
                  label: "报销助理",
                  on: section === "cowork" && coworkItem === "reimbursement",
                  onClick: () => onNavigate("cowork", "reimbursement"),
                })}
              </>,
            )}
            {resources}
          </>
        )}

        {segment === "crew" && (
          <>
            {group(
              "组织",
              <>
                {item({
                  icon: "inbox",
                  label: "收件箱",
                  on: crewItem === "inbox",
                  badge,
                  onClick: () => onNavigate("crew", undefined, "inbox"),
                })}
                {item({
                  icon: "board",
                  label: "项目",
                  on: crewItem === "projects" || crewItem === "project",
                  onClick: () => onNavigate("crew", undefined, "projects"),
                })}
                <div className="ir-side__sublist">{projectSubList}</div>
                {item({
                  icon: "team",
                  label: "团队",
                  on: crewItem === "team",
                  onClick: () => onNavigate("crew", undefined, "team"),
                })}
                {item({
                  icon: "sop",
                  label: "SOP 模板",
                  on: crewItem === "templates",
                  onClick: () => onNavigate("crew", undefined, "templates"),
                })}
              </>,
            )}
            {resources}
          </>
        )}
      </div>

      <div className="ir-side__foot">
        {item({
          icon: "agents",
          label: "Agent 中心",
          on: section === "agents",
          onClick: () => onNavigate("agents"),
        })}
        <button
          type="button"
          className={`ir-side__check ir-side__check--${check.tone}`}
          onClick={() => onNavigate("settings")}
          title="打开设置查看详情"
        >
          <span className="ir-side__check-dot" aria-hidden="true" />
          <span className="ir-side__row-label">{check.text}</span>
        </button>
        <UserChip
          identity={identity}
          collapsed={collapsed}
          onLogout={onLogout}
          onOpenSettings={() => onNavigate("settings")}
        />
      </div>
    </aside>
  );
}

export default Sidebar;
