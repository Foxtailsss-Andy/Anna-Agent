/**
 * HomeComposer · Home 四层 composer(Home 合并轮 M2 · V2 H-01…H-08)
 *
 * 工具栏默认仅 3 件:＋(28 方钮)· Anna 档案 pill(不出现模型名,V2 修订 ①)· 发送/停止;
 * 环境行 = 工作空间 chip + 权限 chip(仅 Create)+ 上下文环(仅会话态,无字,V2 修订 ②)+ 快捷键注。
 * 弹层六件(M6 纪律:同屏至多一个,Esc/点外关,＋菜单永远向上):
 *   ＋菜单(添加文件/技能/Agent/连接器只读)· 技能面板(「/」快召同型)· Anna 档案面板
 *   · 工作空间弹层(已存/新建/打开本地文件夹或路径输入回退)· 权限弹层(Ask|Bypass 琥珀)。
 * 偏差登记(M2):档案面板「档位」段后端今日无参数 —— 按 N4 零站位不画,待真参数再上;
 * 「添加文件」= 读入文本 honest 版(文本注入 prompt,附件 chip 可删)。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { HomeMode } from "../../components/shell/AnnaShell";
import type { Workdir } from "../../lib/api/workdirs";
import { canPickFolder } from "../../lib/api/workdirs";
import { handleComposerEnter } from "../../lib/composerKeys";
import { nextPlaceholder } from "./templates";
import "./HomeComposer.css";

export interface SkillOption {
  id: string;
  label: string;
  description?: string;
  version?: string;
}

export interface ProfileOption {
  id: string;
  label: string;
}

export interface AgentOption {
  id: string;
  label: string;
}

export interface ConnectorStatus {
  name: string;
  ok: boolean;
}

export interface AttachmentLite {
  name: string;
  chars: number;
}

export type PermissionMode = "ask" | "bypass";

type PanelKind =
  | null
  | "plus"
  | "agent"
  | "connectors"
  | "skill"
  | "profile"
  | "workdir"
  | "permission";

export interface HomeComposerProps {
  mode: HomeMode;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  running: boolean;
  onStop: () => void;
  /**
   * J3 插话:提供时,运行中的 composer 不再锁死 —— 输入并回车是给**当前 run**
   * 补一句指示(不是新 run)。不提供 → 运行中沿既有的「只能停止」行为。
   */
  onInterject?: (text: string) => void;
  placeholder: string;
  /** 供页面(场景层模板填空)控制光标/选区 */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;

  /** tag:Chat = 选中的 Skill(可无);Create = kind(永有值) */
  skillTag: { id: string; label: string } | null;
  onClearSkillTag: () => void;
  kindLabel?: string;
  onResetKind?: () => void;

  skills: SkillOption[];
  onPickSkill: (id: string, label: string) => void;

  profiles: ProfileOption[];
  profileId: string;
  onProfileId: (id: string) => void;

  agents: AgentOption[];
  agentId: string;
  onAgentId: (id: string) => void;

  connectors: ConnectorStatus[];
  onManageConnectors: () => void;
  onManageSkills: () => void;
  onOpenAgentCenter: () => void;

  attachments: AttachmentLite[];
  onAddFiles: (files: FileList) => void;
  onRemoveAttachment: (index: number) => void;

  workdir: Workdir | null;
  workdirs: Workdir[];
  onSelectWorkdir: (w: Workdir | null) => void;
  onOpenFolder: () => Promise<string | null>;
  onAddPath: (path: string) => Promise<string | null>;

  permission?: PermissionMode;
  onPermission?: (p: PermissionMode) => void;

  /** M9:运行中环境行锁定(60% 去 ▾ 不可点;上下文环除外) */
  envLocked?: boolean;
  /** 会话态才渲染上下文环(问候页不出现,V2 修订 ②);>80 转 warn */
  ctxPercent?: number;
  footnote?: string;
}

/* ---------------- 小件 ---------------- */

function FolderIcon({ tone }: { tone: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5C3 5.7 3.7 5 4.5 5H9l2 2.5h8.5c.8 0 1.5.7 1.5 1.5V18c0 .8-.7 1.5-1.5 1.5h-15C3.7 19.5 3 18.8 3 18V6.5Z"
        stroke={tone}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShieldIcon({ tone }: { tone: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.2l6.5 2.6v5.1c0 3.9-2.7 6.6-6.5 7.9-3.8-1.3-6.5-4-6.5-7.9V5.8L12 3.2Z"
        stroke={tone}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 上下文环:13px 无字 SVG 弧 + mono 百分比(V2 M8;>80% 转 warn;直切无补间) */
function CtxRing({ percent }: { percent: number }) {
  const warn = percent > 80;
  const r = 7.5;
  const c = 2 * Math.PI * r;
  return (
    <span className={`hcp__ctx${warn ? " hcp__ctx--warn" : ""}`} title={`上下文已用 ${Math.round(percent)}%`}>
      <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--hcp-ring-track)" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
          transform="rotate(-90 10 10)"
        />
      </svg>
      {Math.round(percent)}%
    </span>
  );
}

/* ---------------- 主件 ---------------- */

export function HomeComposer(props: HomeComposerProps) {
  const {
    mode, value, onChange, onSend, running, onStop, placeholder,
    footnote = "Enter 发送 · Shift+Enter 换行 · 内容由 AI 生成，请注意甄别",
  } = props;
  /* J3:能否边跑边说 —— 由页面提供 onInterject 决定(Chat/Create 会话态有,问候态无)。 */
  const canSteer = running && props.onInterject !== undefined;
  const submitSteer = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    props.onInterject?.(text);
  }, [props, value]);
  const rootRef = useRef<HTMLDivElement>(null);
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = props.inputRef ?? localInputRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [slashMode, setSlashMode] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const nativePick = canPickFolder();

  /* M6:Esc / 点外关闭;同屏至多一个弹层(panel 单值即保证) */
  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel]);

  const openPanel = useCallback((p: Exclude<PanelKind, null>) => {
    setPanel((prev) => (prev === p ? null : p));
  }, []);

  /* 「/」快召:输入区首字符为 / → 技能面板(同一面板同一数据,行首带 mono 词头) */
  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
      if (next.startsWith("/")) {
        setSlashMode(true);
        setSkillQuery(next.slice(1));
        setSkillIndex(0);
        setPanel("skill");
      } else if (slashMode) {
        setSlashMode(false);
        setSkillQuery("");
        if (panel === "skill") setPanel(null);
      }
    },
    [onChange, slashMode, panel],
  );

  const filteredSkills = props.skills.filter(
    (s) =>
      !skillQuery ||
      s.label.toLowerCase().includes(skillQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(skillQuery.toLowerCase()),
  );

  const pickSkill = useCallback(
    (s: SkillOption) => {
      props.onPickSkill(s.id, s.label);
      if (slashMode) {
        onChange("");
        setSlashMode(false);
        setSkillQuery("");
      }
      setPanel(null);
      inputRef.current?.focus();
    },
    [props, slashMode, onChange, inputRef],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      /* 快召键盘:↑↓ 选择 · Enter 落 tag · Esc 关(V2 H-05) */
      if (panel === "skill" && slashMode) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSkillIndex((i) => Math.min(i + 1, filteredSkills.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSkillIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const s = filteredSkills[skillIndex];
          if (s) pickSkill(s);
          return;
        }
      }
      /* M4:Tab / Shift+Tab 在【占位符】间跳转(有占位符才拦截) */
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
        const el = inputRef.current;
        if (el && value.includes("【")) {
          const from = e.shiftKey ? 0 : el.selectionEnd ?? 0;
          const range = e.shiftKey
            ? nextPlaceholder(value.slice(0, Math.max(0, (el.selectionStart ?? 0) - 1)), 0)
            : nextPlaceholder(value, from);
          if (range) {
            e.preventDefault();
            el.setSelectionRange(range.start, range.end);
            return;
          }
        }
      }
      /* 全局 Enter 发送(S-E · 设计稿 3k):纯 Enter 与 Ctrl/⌘+Enter 均发送,
         Shift+Enter 换行,IME 组词中完全放行;skill 快召面板开启时 Enter 已在上方分支消费 */
      handleComposerEnter(
        {
          key: e.key,
          shiftKey: e.shiftKey,
          isComposing: e.nativeEvent.isComposing,
          preventDefault: () => e.preventDefault(),
        },
        {
          running,
          hasText: value.trim().length > 0,
          onSend,
          /* J3:运行中的 Enter 改道为「补充指示」(仅当页面支持 steering) */
          ...(canSteer ? { onInterject: submitSteer } : {}),
        },
      );
    },
    [panel, slashMode, filteredSkills, skillIndex, pickSkill, value, running, onSend, inputRef, canSteer, submitSteer],
  );

  const autoGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputRef]);

  const addPath = useCallback(async () => {
    const p = pathDraft.trim();
    if (!p) return;
    setPathError(null);
    const err = await props.onAddPath(p);
    if (err) setPathError(err);
    else {
      setPathDraft("");
      setPanel(null);
    }
  }, [pathDraft, props]);

  const openNativeFolder = useCallback(async () => {
    const err = await props.onOpenFolder();
    if (err) setPathError(err);
    else setPanel(null);
  }, [props]);

  const hasText = value.trim().length > 0;
  const canSend = !running && hasText;
  /* J3:运行中送出的是插话;按钮同一个位置,语义随运行态切换(不新增第二个发送键) */
  const canSubmit = canSteer ? hasText : canSend;
  const permission = props.permission;
  const envLocked = props.envLocked === true;

  /* ---------------- 弹层们 ---------------- */

  const plusMenu = panel === "plus" && (
    <div className="hcp__panel hcp__panel--plus" role="menu">
      <button type="button" className="hcp__prow" role="menuitem" onClick={() => { fileRef.current?.click(); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.5 3h7L18 7.5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V4.5A1.5 1.5 0 0 1 6.5 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M13.5 3v4.5H18" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
        <span>添加文件</span>
        <span className="hcp__prow-note">读入文本</span>
      </button>
      <button type="button" className="hcp__prow" role="menuitem" onClick={() => setPanel("skill")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4.5 17.5 12 12 19.5 6.5 12 12 4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /></svg>
        <span>技能</span>
        <span className="hcp__prow-more">›</span>
      </button>
      <button type="button" className="hcp__prow" role="menuitem" onClick={() => setPanel("agent")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.5" r="3.4" stroke="currentColor" strokeWidth="1.5" /><path d="M5.2 19.6c1.2-3.5 3.7-5.3 6.8-5.3s5.6 1.8 6.8 5.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        <span>Agent</span>
        <span className="hcp__prow-note">{props.agentId ? props.agents.find((a) => a.id === props.agentId)?.label ?? props.agentId : "默认"}</span>
        <span className="hcp__prow-more">›</span>
      </button>
      <button type="button" className="hcp__prow" role="menuitem" onClick={() => setPanel("connectors")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6.8" cy="12" r="2.7" stroke="currentColor" strokeWidth="1.5" /><circle cx="17.2" cy="12" r="2.7" stroke="currentColor" strokeWidth="1.5" /><path d="M9.6 12h4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        <span>连接器</span>
        <span className="hcp__prow-more">›</span>
      </button>
    </div>
  );

  /* Agent 与连接器各自独立二级面板(V2 H-04:同 H-05 型) */
  const agentPanel = panel === "agent" && (
    <div className="hcp__panel hcp__panel--connectors">
      <div className="hcp__panel-label">AGENT · 本次 RUN 注入其附加指令</div>
      <button
        type="button"
        className={`hcp__prow${props.agentId === "" ? " hcp__prow--on" : ""}`}
        onClick={() => { props.onAgentId(""); setPanel(null); }}
      >
        <span>默认（本域 Agent）</span>
        {props.agentId === "" && <span className="hcp__check">✓</span>}
      </button>
      {props.agents.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`hcp__prow${props.agentId === a.id ? " hcp__prow--on" : ""}`}
          onClick={() => { props.onAgentId(a.id); setPanel(null); }}
        >
          <span>{a.label}</span>
          {props.agentId === a.id && <span className="hcp__check">✓</span>}
        </button>
      ))}
      {props.agents.length === 0 && (
        <div className="hcp__panel-empty">还没有配置过 Agent 附加指令</div>
      )}
      <button type="button" className="hcp__panel-foot" onClick={props.onOpenAgentCenter}>
        Agent 中心 →
      </button>
    </div>
  );

  const connectorPanel = panel === "connectors" && (
    <div className="hcp__panel hcp__panel--connectors">
      <div className="hcp__panel-label">连接器 · 只读状态</div>
      {props.connectors.map((c) => (
        <div key={c.name} className={`hcp__crow${c.ok ? "" : " hcp__crow--off"}`}>
          <span className={`hcp__dot${c.ok ? " hcp__dot--ok" : ""}`} aria-hidden="true" />
          {c.name}
          <span className="hcp__crow-state">{c.ok ? "已连接" : "未连接"}</span>
        </div>
      ))}
      <button type="button" className="hcp__panel-foot" onClick={props.onManageConnectors}>
        管理连接 →
      </button>
    </div>
  );

  const skillPanel = panel === "skill" && (
    <div className="hcp__panel hcp__panel--skill">
      {!slashMode && (
        <div className="hcp__search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.5" /><path d="M15.8 15.8 20 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input
            value={skillQuery}
            onChange={(e) => { setSkillQuery(e.target.value); setSkillIndex(0); }}
            placeholder="搜索技能……"
            aria-label="搜索技能"
          />
        </div>
      )}
      <div className="hcp__panel-list">
        {filteredSkills.length === 0 ? (
          <div className="hcp__panel-empty">没有匹配的技能</div>
        ) : (
          filteredSkills.slice(0, 5).map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`hcp__srow${slashMode && i === skillIndex ? " hcp__srow--on" : ""}`}
              onClick={() => pickSkill(s)}
            >
              {slashMode && <span className="hcp__srow-word">/skill</span>}
              <span className="hcp__srow-main">
                <span className="hcp__srow-name">{s.label}</span>
                {s.description && <span className="hcp__srow-desc">{s.description}</span>}
              </span>
              {s.version && <span className="hcp__srow-ver">{s.version}</span>}
            </button>
          ))
        )}
      </div>
      <div className="hcp__panel-footrow">
        <button type="button" className="hcp__panel-foot" onClick={props.onManageSkills}>管理技能 →</button>
        {slashMode && <span className="hcp__panel-keys">↑↓ 选择 · Enter 落 tag · Esc 关闭</span>}
      </div>
    </div>
  );

  const profilePanel = panel === "profile" && (
    <div className="hcp__panel hcp__panel--profile">
      <div className="hcp__panel-label">ANNA 档案 · PROFILES</div>
      {props.profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`hcp__prow${props.profileId === p.id ? " hcp__prow--on" : ""}`}
          onClick={() => { props.onProfileId(p.id); setPanel(null); }}
        >
          <span>{p.label}</span>
          {props.profileId === p.id && <span className="hcp__check">✓</span>}
        </button>
      ))}
      <div className="hcp__panel-note">档案 → 模型映射在底层配置（设置 · 模型档案）；此处只选档案。</div>
    </div>
  );

  const workdirPanel = panel === "workdir" && (
    <div className="hcp__panel hcp__panel--workdir">
      <div className="hcp__panel-label">已存工作空间</div>
      {props.workdirs.length === 0 ? (
        <div className="hcp__panel-empty">还没有工作空间</div>
      ) : (
        props.workdirs.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`hcp__wrow${props.workdir?.id === w.id ? " hcp__wrow--on" : ""}`}
            onClick={() => { props.onSelectWorkdir(w); setPanel(null); }}
          >
            <FolderIcon tone="currentColor" />
            <span className="hcp__wrow-main">
              <span className="hcp__wrow-name">{w.name}</span>
              <span className="hcp__wrow-path">{w.path}</span>
            </span>
            {props.workdir?.id === w.id && <span className="hcp__check">✓</span>}
          </button>
        ))
      )}
      <div className="hcp__panel-divider" />
      {nativePick ? (
        <button type="button" className="hcp__panel-foot" onClick={() => void openNativeFolder()}>
          打开本地文件夹……
        </button>
      ) : (
        <div className="hcp__pathadd">
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            placeholder="输入文件夹绝对路径……"
            aria-label="文件夹路径"
            onKeyDown={(e) => { if (e.key === "Enter") void addPath(); }}
          />
          <button type="button" onClick={() => void addPath()}>挂载</button>
        </div>
      )}
      {pathError && <div className="hcp__patherr">{pathError}</div>}
      <div className="hcp__panel-footrow">
        <span className="hcp__panel-note-inline">该文件夹将作为任务执行现场与上下文来源</span>
        {props.workdir && (
          <button type="button" className="hcp__panel-foot" onClick={() => { props.onSelectWorkdir(null); setPanel(null); }}>
            取消选择
          </button>
        )}
      </div>
    </div>
  );

  const permissionPanel = panel === "permission" && permission && props.onPermission && (
    <div className="hcp__panel hcp__panel--permission">
      <div className="hcp__panel-label">权限 · 仅对本 Create 会话生效</div>
      <button
        type="button"
        className={`hcp__perm${permission === "ask" ? " hcp__perm--on" : ""}`}
        onClick={() => { props.onPermission!("ask"); setPanel(null); }}
      >
        <ShieldIcon tone="currentColor" />
        <span className="hcp__perm-main">
          <span className="hcp__perm-name">Ask · 遇事先问 {permission === "ask" && <span className="hcp__check">✓</span>}</span>
          <span className="hcp__perm-desc">超出工作空间范围的写入、删除或外部调用，Anna 会暂停，弹窗请您确认后再继续。</span>
        </span>
      </button>
      <button
        type="button"
        className={`hcp__perm hcp__perm--bypass${permission === "bypass" ? " hcp__perm--bypass-on" : ""}`}
        onClick={() => { props.onPermission!("bypass"); setPanel(null); }}
      >
        <ShieldIcon tone="currentColor" />
        <span className="hcp__perm-main">
          <span className="hcp__perm-name">Bypass · 完全自主 {permission === "bypass" && <span className="hcp__check hcp__check--warn">✓</span>}</span>
          <span className="hcp__perm-desc">
            本次会话内不再逐项请示，Anna 直接执行全部动作。<b>仅在您信任任务来源时开启</b> —— 高风险动作将不再询问。
          </span>
        </span>
      </button>
    </div>
  );

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="hcp" ref={rootRef}>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".txt,.md,.markdown,.csv,.json,.log,.py,.ts,.tsx,.js,.html,.css,.yaml,.yml,.toml"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) props.onAddFiles(e.target.files);
          e.target.value = "";
          setPanel(null);
        }}
      />
      <div className="hcp__card">
        {(props.skillTag || mode === "create" || props.attachments.length > 0) && (
          <div className="hcp__tags">
            {mode === "create" && props.kindLabel && (
              <span className="hcp__tag">
                ◈ {props.kindLabel}
                <button type="button" className="hcp__tag-x" aria-label="重置产出类型" onClick={props.onResetKind}>×</button>
              </span>
            )}
            {props.skillTag && (
              <span className="hcp__tag">
                ◈ {props.skillTag.label}
                <button type="button" className="hcp__tag-x" aria-label="移除技能" onClick={props.onClearSkillTag}>×</button>
              </span>
            )}
            {props.attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="hcp__tag hcp__tag--file">
                {a.name}
                <span className="hcp__tag-note">{Math.max(1, Math.round(a.chars / 1000))}k 字</span>
                <button type="button" className="hcp__tag-x" aria-label={`移除附件 ${a.name}`} onClick={() => props.onRemoveAttachment(i)}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="hcp__input"
          rows={2}
          value={value}
          /* J3:运行中 composer 不锁 —— 提示语直说此刻这里说的话会进正在跑的这次任务 */
          placeholder={canSteer ? "补充指示，边跑边说……" : placeholder}
          onChange={(e) => { handleChange(e.target.value); autoGrow(); }}
          onKeyDown={handleKeyDown}
        />
        <div className="hcp__bar">
          <div className="hcp__anchor">
            <button
              type="button"
              className={`hcp__plus${panel === "plus" || panel === "agent" || panel === "connectors" ? " hcp__plus--on" : ""}`}
              aria-label="更多"
              aria-expanded={panel === "plus"}
              onClick={() => openPanel("plus")}
            >
              ＋
            </button>
            {plusMenu}
            {agentPanel}
            {connectorPanel}
            {skillPanel}
          </div>
          <span className="hcp__spacer" />
          <div className="hcp__anchor hcp__anchor--right">
            <button
              type="button"
              className={`hcp__profile${panel === "profile" ? " hcp__profile--on" : ""}`}
              onClick={() => openPanel("profile")}
              aria-expanded={panel === "profile"}
            >
              <b>Anna</b> · {props.profiles.find((p) => p.id === props.profileId)?.label ?? props.profileId}
              <span className="hcp__caret">{panel === "profile" ? "▴" : "▾"}</span>
            </button>
            {profilePanel}
          </div>
          {running && (
            <button type="button" className="hcp__stop" onClick={onStop}>
              <span className="hcp__stop-square" aria-hidden="true" />
              停止
            </button>
          )}
          <button
            type="button"
            className={`hcp__send${canSubmit ? "" : " hcp__send--off"}`}
            aria-label={canSteer ? "补充指示" : "发送"}
            title={canSteer ? "补充指示 · 交给正在跑的这次任务" : undefined}
            disabled={!canSubmit}
            onClick={canSteer ? submitSteer : onSend}
          >
            ↑
          </button>
        </div>
      </div>

      {/* 环境行:「在哪跑、怎么管」+ 会话态上下文环(右端) */}
      <div className={`hcp__env${envLocked ? " hcp__env--locked" : ""}`}>
        <div className="hcp__anchor">
          <button
            type="button"
            className={`hcp__envchip${props.workdir ? " hcp__envchip--set" : ""}${panel === "workdir" ? " hcp__envchip--on" : ""}`}
            onClick={() => !envLocked && openPanel("workdir")}
            disabled={envLocked}
          >
            <FolderIcon tone="currentColor" />
            工作空间 · {props.workdir ? props.workdir.name : "未选择"}
            {!envLocked && <span className="hcp__caret">{panel === "workdir" ? "▴" : "▾"}</span>}
          </button>
          {workdirPanel}
        </div>
        {permission && props.onPermission && (
          <div className="hcp__anchor">
            <button
              type="button"
              className={`hcp__envchip hcp__envchip--perm${permission === "bypass" ? " hcp__envchip--bypass" : ""}${panel === "permission" ? " hcp__envchip--on" : ""}`}
              onClick={() => !envLocked && openPanel("permission")}
              disabled={envLocked}
            >
              <ShieldIcon tone="currentColor" />
              权限 · {permission === "ask" ? "Ask" : "Bypass"}
              {!envLocked && <span className="hcp__caret">{panel === "permission" ? "▴" : "▾"}</span>}
            </button>
            {permissionPanel}
          </div>
        )}
        <span className="hcp__spacer" />
        {props.ctxPercent !== undefined && <CtxRing percent={props.ctxPercent} />}
        <span className="hcp__footnote">
          {canSteer
            ? "Enter 补充指示 · 交给正在跑的这次任务，不会另起一次 · Shift+Enter 换行"
            : footnote}
        </span>
      </div>
    </div>
  );
}

export default HomeComposer;
