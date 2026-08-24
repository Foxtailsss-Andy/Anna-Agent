/**
 * HomePage · Home 一页双模(Home 合并轮 M2 · V2 H-01/H-02/H-03 + 运行通路吸收)
 *
 * 问候态:问候(稳定不换)→ 模式 pill → 场景 chips(二级模板面板,点选填【占位符】文本;
 *   Create 场景同步落 kind tag)→ 四层 composer → 环境行。副文案层已删除(V2 ③)。
 * 会话态(M2 粗版,M3 精修到 H-09/H-10):严格单列 —— 气泡 → 身份行 → LoopCard → 正文/产物;
 *   Chat = 真流(useRunStream);Create = 同步 createDraft 过渡版(真等待,B1 流式化后同构)。
 * 诚实纪律:发送空文禁用;附件 = 读入文本(chip 可删);工作空间选择真注册(内容注入 B2)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { AgentSessionHeader } from "../../components/agent/AgentSessionHeader";
import { LoopCard } from "../../components/agent/LoopCard";
import { BloomIris, IrisPetal } from "../../components/anna/IrisPetal";
import { StateNote } from "../../components/anna/StateNote";
import { useShellBus } from "../../components/shell/AnnaShell";
import type { HomeMode } from "../../components/shell/AnnaShell";
import { getRuntimeConfig, getRuntimeStatus, getSkills } from "../../lib/api/admin";
import { continueChatRun, getChatRun, getModelProfiles, interjectChatRun, stopChatRun, submitChatRun, subscribeChatRun } from "../../lib/api/chat";
import { activateDraft, listDrafts, streamCreateRun, type CreateDraftKind } from "../../lib/api/create";
import {
  activateHarnessV2CreateRun,
  getHarnessV2Capabilities,
  readHarnessV2CreateRun,
  listHarnessV2CreateRuns,
  startHarnessV2Run,
  subscribeHarnessV2CreateRun,
  type HarnessV2CreateRunRecord,
  type HarnessV2CreateRunProjection,
} from "../../lib/api/harnessV2";
import { createNormalizer } from "../../lib/api/normalize";
import { getIdentity } from "../../lib/api/identity";
import { addWorkdir, listWorkdirs, pickFolder, touchWorkdir, type Workdir } from "../../lib/api/workdirs";
import { usePersona } from "../../lib/persona";
import { v2ApiBase } from "../../lib/runtime";
import { detectSuspension, type SuspensionInfo } from "../../lib/streamResume";
import { evaluationNotice } from "../../lib/evaluation";
import { planProgress } from "../../lib/plan";
import { threadTurnLabel } from "../../lib/thread";
import { DEFAULT_TOOL_LABELS, reduceTurns } from "../../lib/turns";
import { errorApology } from "../chat/errorApology";
import { rawFramesFromRun } from "../chat/historyFrames";
import { formatUsageText, useRunStream } from "../chat/useRunStream";
import { verificationRows } from "../create/draftView";
import { TraceDrawer } from "../trace/TraceDrawer";
import { HomeComposer, type AgentOption, type ConnectorStatus, type PermissionMode, type ProfileOption, type SkillOption } from "./HomeComposer";
import {
  CHANNEL_PENDING_NOTE,
  UNDELIVERED_NOTE,
  interjectRejectedNote,
  restoredDraft,
} from "./interjectNotes";
import { resolveCreateRuntimeBoundary } from "./createRuntimeBoundary";
import { RightPanel, type PanelArtifact, type PanelFile } from "./RightPanel";
import { nextPlaceholder, scenesOf, type Scene } from "./templates";
import "./HomePage.css";

type Rec = Record<string, unknown>;
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);

/** 前端时段映射(非模型文本)。 */
export function timeGreeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "上午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

const MODES: { mode: HomeMode; label: string }[] = [
  { mode: "chat", label: "Chat" },
  { mode: "create", label: "Create" },
];

const KIND_LABEL: Record<CreateDraftKind, string> = {
  skill: "技能",
  prompt: "提示词",
  python_tool: "工具",
};

const AGENT_LABELS: Record<string, string> = {
  chat: "通用对话",
  hiker: "Hiker",
  reimbursement: "报销",
  create: "构建",
};

const PLACEHOLDERS: Record<HomeMode, string> = {
  chat: "随便聊、布置任务 —— 输入或调用技能，@ 引用产物……",
  create: "描述你要构建的能力 —— 输入或调用技能，@ 引用产物或空间文件……",
};

interface ArtifactLite {
  id: string;
  title: string;
  kind: string;
  content: string;
}

function artifactsOf(run: Rec | null): ArtifactLite[] {
  const arr = Array.isArray(run?.artifacts) ? (run!.artifacts as Rec[]) : [];
  return arr.map((a) => ({
    id: str(a.id),
    title: str(a.title, "产物"),
    kind: str(a.kind, "document"),
    content: str(a.content),
  }));
}

const isPageKind = (kind: string) => kind === "page";

/**
 * L4b 回看挂起识别:run.status === "awaiting_continue" 即挂起(权威真凭证);再从 audit_events
 * 里的 run.suspended 事件补 turns_used(无则省略,不猜)。非挂起 → null。诚实红线:只据真状态,
 * 不据任何旁证臆断。
 */
function suspensionFromRun(run: Rec | null): SuspensionInfo | null {
  if (!run || str(run.status) !== "awaiting_continue") return null;
  const events = Array.isArray(run.audit_events) ? (run.audit_events as Rec[]) : [];
  for (const e of events) {
    const hit = detectSuspension(e);
    if (hit) return hit;
  }
  return {}; // 状态即权威凭证;无事件则省略回合数
}

/** Create 产出真文件名(artifact.path 末段)。 */
function fileNameOf(art: Rec | null): string {
  if (!art) return "";
  const path = str(art.path);
  return path.split(/[\\/]/).pop() || path || "draft";
}

function createProjectionRecord(
  projection: HarnessV2CreateRunProjection,
  prompt: string,
): Rec {
  return {
    id: projection.runId,
    prompt,
    kind: str(projection.artifact?.kind, "skill"),
    status: projection.status,
    ...(projection.artifact === undefined ? {} : { artifact: projection.artifact }),
    ...(projection.validation === undefined ? {} : { validation: projection.validation }),
    ...(projection.error === undefined
      ? {}
      : {
          error_code: projection.error.code,
          error_message: projection.error.message,
        }),
  };
}

function createListRecord(run: HarnessV2CreateRunRecord): Rec {
  return createProjectionRecord(run, run.prompt);
}

interface AttachmentFull {
  name: string;
  chars: number;
  text: string;
}

export function HomePage({ displayName }: { displayName: string }) {
  const bus = useShellBus();
  const { persona } = usePersona();
  const mode = bus.homeMode;
  const runStream = useRunStream(DEFAULT_TOOL_LABELS);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /* ---- composer 状态 ---- */
  const [draft, setDraft] = useState("");
  /* J3:插话没被接住时的诚实回执(接住了则不出声 —— 时间线上有真事件帧) */
  const [steerNote, setSteerNote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentFull[]>([]);
  const [skillTag, setSkillTag] = useState<{ id: string; label: string } | null>(null);
  const [kind, setKind] = useState<CreateDraftKind>("skill");
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState("default");
  const [profileId, setProfileId] = useState("default");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [workdirs, setWorkdirs] = useState<Workdir[]>([]);
  const [workdir, setWorkdir] = useState<Workdir | null>(null);
  const [permission, setPermission] = useState<PermissionMode>("ask");

  /* ---- 场景层 ---- */
  const [openScene, setOpenScene] = useState<string | null>(null);
  const scenesRef = useRef<HTMLDivElement>(null);

  /* ---- 会话状态 ---- */
  const [sessionMode, setSessionMode] = useState<HomeMode | null>(null);
  /* L1b 会话连续性:本 chat 会话的 thread_id(首轮成功后从 run 捕获,续聊回传)。
     仅 chat;新建/回看/切 create 会话时清空,避免跨线程串接。 */
  const threadIdRef = useRef<string | null>(null);
  /* L3b 后台 run:当前 chat 后台 run 的 id(submit 即得,供停止按钮显式停后端 run;
     续看跑动中任务时置为其 id;新建/回看终态/切 create 会话时清空)。 */
  const bgRunIdRef = useRef<string | null>(null);
  const [lastMessage, setLastMessage] = useState("");
  const [completedRun, setCompletedRun] = useState<Rec | null>(null);
  const [viewingRun, setViewingRun] = useState<Rec | null>(null);
  const [traceRunId, setTraceRunId] = useState<string | null>(null); // Trace T2:「执行过程」抽屉当前查看的 run
  const fetchedRef = useRef<string | null>(null);
  const v2CreateRunRef = useRef<string | null>(null);
  const v2CreateChannelRef = useRef<string | null>(null);
  /* Create run 全量(校验/注册收尾段数据源;v2 走 durable projection,Legacy 走 listDrafts) */
  const [createRun, setCreateRun] = useState<Rec | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  /* 发送瞬间快照的 kind(会话内回显,不随 composer 后续改动) */
  const [sentKind, setSentKind] = useState<CreateDraftKind>("skill");

  /* ---- 右侧滑出面板(M4 · H-11/H-12):默认不存在,绝不自动弹开(N5) ---- */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelArtifactId, setPanelArtifactId] = useState("");
  const [panelFile, setPanelFile] = useState("");
  const [unreadArtifacts, setUnreadArtifacts] = useState(false);
  const seenArtifactCountRef = useRef(0);

  /* ---- 数据装载(真后端;失败静默空) ---- */
  useEffect(() => {
    getModelProfiles()
      .then((r) => {
        /* V2 修订 ①:模型名全站不出现 —— 档案 label 若配置成了模型名,呈现回落档案名
           (default → 「默认」);档案 → 模型映射属底层配置,不属界面。 */
        setProfiles(
          (r.profiles ?? []).map((p) => {
            const raw = (p.label || "").trim();
            const label =
              raw && raw !== p.model_name ? raw : p.id === "default" ? "默认" : p.id;
            return { id: p.id, label };
          }),
        );
        const dflt = r.default_profile_id ?? "default";
        setDefaultProfileId(dflt);
        setProfileId((cur) => (cur === "default" ? dflt : cur));
      })
      .catch(() => {});
    getSkills()
      .then((r) => {
        const list = Array.isArray((r as Rec).skills) ? ((r as Rec).skills as Rec[]) : [];
        setSkills(
          list.map((s) => ({
            id: str(s.id),
            label: str(s.name) || str(s.id),
            description: str(s.description) || undefined,
            version: str(s.version) || undefined,
          })).filter((s) => s.id),
        );
      })
      .catch(() => {});
    getRuntimeConfig()
      .then((r) => {
        const values = ((r as Rec).values ?? {}) as Rec;
        const directives = (values.agent_directives ?? {}) as Rec;
        setAgents(Object.keys(directives).map((id) => ({ id, label: AGENT_LABELS[id] ?? id })));
      })
      .catch(() => {});
    getRuntimeStatus()
      .then((s) => {
        const st = s as Rec;
        const ok = (k: string) => ((st[k] ?? {}) as Rec).status === "connected";
        setConnectors([
          { name: "ERP", ok: ok("erp_mcp") },
          { name: "Hiker", ok: ok("hiker_mcp") },
          { name: "报销网关", ok: ok("reimbursement_mcp") },
        ]);
      })
      .catch(() => {});
    void refreshWorkdirs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshWorkdirs = useCallback(async () => {
    try {
      const r = await listWorkdirs();
      setWorkdirs(r.workdirs ?? []);
    } catch {
      setWorkdirs([]);
    }
  }, []);

  /* ---- ShellBus 信号 ---- */
  useEffect(() => {
    const text = bus.consumePrefill();
    if (!text) return;
    setDraft((prev) => (prev.trim() ? `${prev}\n${text}` : text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.prefillSeq]);

  useEffect(() => {
    const id = bus.consumeOpenChatRun();
    if (!id) return;
    getChatRun(id)
      .then((run) => {
        const r = run as Rec;
        setSessionMode("chat");
        setCreateRun(null);
        setCreateError(null);
        // L3b 续看跑动中任务:generating(非终态)→ 不落历史回看,改为从 seq 0 订阅
        // —— 追平既往帧再跟随实时到办妥;终态则一如既往走历史回看(不订阅)。
        if (str(r.status) === "generating") {
          bgRunIdRef.current = str(r.id);
          threadIdRef.current = str(r.thread_id) || null; // 续看 live → 保留其 thread 以便续聊
          fetchedRef.current = null;
          setViewingRun(null);
          setCompletedRun(null);
          setLastMessage(str(r.message));
          void runStream.startBackground(
            async () => str(r.id),
            (runId, fromSeq, onFrame, signal) => subscribeChatRun(runId, fromSeq, { onFrame, signal }),
          );
        } else {
          if (runStream.running) runStream.stop(); // 取消可能仍在跑的上一条订阅
          runStream.reset();
          bgRunIdRef.current = null;
          threadIdRef.current = null; // 回看历史轮 = 离开当前 live 线程,续聊从新线程起
          setViewingRun(r);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.openChatRunSeq]);

  useEffect(() => {
    const id = bus.consumeOpenCreateRun();
    if (!id) return;
    threadIdRef.current = null; // 切到 create 会话:thread 为 chat 专属,清空
    bgRunIdRef.current = null; // 离开 chat 后台 run 上下文
    const v2Configured = v2ApiBase() !== "";
    v2CreateRunRef.current = null;
    v2CreateChannelRef.current = null;
    const runsPromise: Promise<Rec[]> = !v2Configured
      ? listDrafts().then((runs) => runs as Rec[])
      : getIdentity()
        .then((identity) => {
          const channelId = `desktop-home:${identity.workspaceId}`;
          v2CreateChannelRef.current = channelId;
          return listHarnessV2CreateRuns({ channelId });
        })
        .then(({ runs }) => runs.map(createListRecord));
    runsPromise
      .then((runs) => {
        const run = (runs as Rec[]).find((r) => str(r.id) === id);
        if (run) {
          if (v2Configured) v2CreateRunRef.current = id;
          if (runStream.running) runStream.stop();
          runStream.reset();
          setSessionMode("create");
          setCreateRun(run);
          setCreateError(null);
          setViewingRun(null);
        } else if (v2Configured) {
          setCreateError("This Create run belongs to the Legacy Runtime and is unavailable here.");
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.openCreateRunSeq]);

  useEffect(() => {
    if (bus.newChatSeq === 0) return;
    if (runStream.running) runStream.stop();
    runStream.reset();
    threadIdRef.current = null; // 新建任务 = 全新会话线程
    bgRunIdRef.current = null;
    setSessionMode(null);
    setViewingRun(null);
    setCompletedRun(null);
    setCreateRun(null);
    setCreateError(null);
    v2CreateRunRef.current = null;
    v2CreateChannelRef.current = null;
    setLastMessage("");
    setDraft("");
    setSteerNote(null); /* J3:新建任务清空插话态(同 L1b/L4b reset 纪律) */
    setAttachments([]);
    setPanelOpen(false);
    setPanelArtifactId("");
    setPanelFile("");
    setUnreadArtifacts(false);
    seenArtifactCountRef.current = 0;
    fetchedRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.newChatSeq]);

  /* 完成:取全 run(chat=artifact.content/assistant_message;create=校验三面)+ 刷侧栏 */
  useEffect(() => {
    const rid = runStream.tree.run?.runId;
    if (runStream.tree.state !== "done" || !rid || fetchedRef.current === rid) return;
    fetchedRef.current = rid;
    if (sessionMode === "create") {
      const boundary = resolveCreateRuntimeBoundary({
        v2Configured: v2ApiBase() !== "",
        runId: rid,
        v2RunId: v2CreateRunRef.current,
        channelId: v2CreateChannelRef.current,
      });
      if (boundary.kind === "v2") {
        readHarnessV2CreateRun(rid, { channelId: boundary.channelId })
          .then((projection) => setCreateRun(createProjectionRecord(projection, lastMessage)))
          .catch((error) => setCreateError(error instanceof Error ? error.message : String(error)));
      } else if (boundary.kind === "legacy") {
        listDrafts()
          .then((runs) => {
            const run = (runs as Rec[]).find((r) => str(r.id) === rid);
            if (run) setCreateRun(run);
          })
          .catch(() => {});
      } else {
        setCreateError(boundary.message);
      }
    } else {
      getChatRun(rid)
        .then((run) => {
          setCompletedRun(run as Rec);
          // L1b:首轮成功即捕获 thread_id(同 thread 稳定,仅捕获一次),供续聊回传。
          if (!threadIdRef.current) {
            const tid = str((run as Rec).thread_id);
            if (tid) threadIdRef.current = tid;
          }
        })
        .catch(() => {});
    }
    bus.refreshSidebar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStream.tree.state, runStream.tree.run?.runId]);

  /* ---- 场景层:模板面板(M6 纪律:点外/Esc 关) ---- */
  useEffect(() => {
    if (!openScene) return;
    const onDown = (e: MouseEvent) => {
      if (scenesRef.current && !scenesRef.current.contains(e.target as Node)) setOpenScene(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenScene(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openScene]);

  /** M4 微交互:模板落入 → 光标落首个【占位符】整段选中;Tab 跳转在 composer。 */
  const insertTemplate = useCallback((scene: Scene, text: string) => {
    if (scene.kind) setKind(scene.kind);
    setOpenScene(null);
    setDraft((prev) => {
      const next = prev.trim() ? `${prev}\n${text}` : text;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const base = prev.trim() ? prev.length + 1 : 0;
        const range = nextPlaceholder(next, base);
        if (range) el.setSelectionRange(range.start, range.end);
        else el.setSelectionRange(next.length, next.length);
      });
      return next;
    });
  }, []);

  /* ---- 附件(读入文本 honest 版) ---- */
  const onAddFiles = useCallback((files: FileList) => {
    for (const f of Array.from(files)) {
      if (f.size > 256 * 1024) {
        setAttachments((prev) => [...prev, { name: `${f.name}（超 256KB 未读入）`, chars: 0, text: "" }]);
        continue;
      }
      void f.text().then((text) => {
        setAttachments((prev) => [...prev, { name: f.name, chars: text.length, text }]);
      });
    }
  }, []);

  /* ---- 工作空间 ---- */
  const selectWorkdir = useCallback((w: Workdir | null) => {
    setWorkdir(w);
    if (w) void touchWorkdir(w.id).catch(() => {});
  }, []);

  const onOpenFolder = useCallback(async (): Promise<string | null> => {
    const path = await pickFolder();
    if (!path) return null;
    try {
      const w = await addWorkdir(path);
      setWorkdir(w);
      await refreshWorkdirs();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [refreshWorkdirs]);

  const onAddPath = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        const w = await addWorkdir(path);
        setWorkdir(w);
        await refreshWorkdirs();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [refreshWorkdirs],
  );

  /* ---- 发送 ---- */
  const composeMessage = useCallback((): string => {
    const parts = attachments
      .filter((a) => a.text)
      .map((a) => `【附件 ${a.name}】\n${a.text}\n【附件结束】`);
    return [...parts, draft.trim()].filter(Boolean).join("\n\n");
  }, [attachments, draft]);

  const chatSend = useCallback(() => {
    const message = composeMessage();
    if (!message) return;
    setSessionMode("chat");
    setViewingRun(null);
    setCompletedRun(null);
    setCreateRun(null);
    fetchedRef.current = null;
    bgRunIdRef.current = null;
    setLastMessage(message);
    setDraft("");
    setSteerNote(null); /* J3:新一轮开始,上一轮的插话回执不该留在屏上 */
    setAttachments([]);
    /* L3b:submit(run 与请求解耦,断线不杀 run)→ 从 seq 0 订阅(replay+跟随);
       传输中断且未见终帧 → startBackground 按退避重连续帧;见终帧走既有完成流。 */
    void runStream.startBackground(
      async () => {
        const res = await submitChatRun({
          message,
          // L1b:本会话已捕获 thread_id → 续聊回传,后端拼同 thread 既往轮;首轮为 undefined=新线程。
          threadId: threadIdRef.current ?? undefined,
          modelProfileId: profileId !== defaultProfileId ? profileId : undefined,
          skillId: skillTag?.id,
          agentId: agentId || undefined,
          workdirId: workdir?.id,
        });
        bgRunIdRef.current = res.run_id;
        // L1b:优先从 submit 响应捕获 thread_id(办妥 getChatRun 兜底,见完成 effect)。
        if (!threadIdRef.current && res.thread_id) threadIdRef.current = res.thread_id;
        return res.run_id;
      },
      (runId, fromSeq, onFrame, signal) => subscribeChatRun(runId, fromSeq, { onFrame, signal }),
    );
    /* 侧栏立即出现 generating 条目(呼吸点,V2 H-09 活跃项) */
    window.setTimeout(() => bus.refreshSidebar(), 600);
  }, [composeMessage, runStream, profileId, defaultProfileId, skillTag, agentId, workdir, bus]);

  /* B1:Create 走流式管线(与 Chat 同一 useRunStream,LoopCard 同构,N7) */
  const createSend = useCallback(() => {
    const message = composeMessage();
    if (!message) return;
    setSessionMode("create");
    setViewingRun(null);
    setCompletedRun(null);
    setCreateRun(null);
    setCreateError(null);
    v2CreateRunRef.current = null;
    v2CreateChannelRef.current = null;
    setSentKind(kind);
    fetchedRef.current = null;
    threadIdRef.current = null; // create 会话无 chat 线程:防御性清空,免后续 chatSend 复用陈旧 thread
    setLastMessage(message);
    setDraft("");
    setSteerNote(null); /* J3:同上 */
    setAttachments([]);
    if (v2ApiBase() !== "") {
      void runStream.startBackground(
        async () => {
          if (kind !== "skill") {
            throw new Error("Harness v2 Create currently supports only Skill artifacts");
          }
          const capabilities = await getHarnessV2Capabilities();
          const surface = capabilities.surfaces?.find((candidate) => candidate.id === "create");
          if (surface?.status !== "available") {
            throw new Error("Harness v2 Create is not available in this Runtime");
          }
          const identity = await getIdentity();
          const commandId = `desktop:create:${crypto.randomUUID()}`;
          const channelId = `desktop-home:${identity.workspaceId}`;
          v2CreateRunRef.current = commandId;
          v2CreateChannelRef.current = channelId;
          const started = await startHarnessV2Run("create", {
            channelId,
            commandId,
            sourceEventId: `desktop:create:source:${commandId}`,
            goal: message,
          });
          v2CreateRunRef.current = started.run_id;
          return started.run_id;
        },
        (runId, fromSeq, onFrame, signal) => {
          const channelId = v2CreateChannelRef.current;
          if (channelId === null) throw new Error("Harness v2 Create channel is not available");
          return subscribeHarnessV2CreateRun(runId, {
            channelId,
            fromSeq,
            onFrame,
            signal,
          });
        },
      );
    } else {
      void runStream.start((signal) =>
        streamCreateRun(message, kind, {
          signal,
          agentId: agentId || undefined,
          workdirId: workdir?.id,
          permissionMode: permission,
        }),
      );
    }
    window.setTimeout(() => bus.refreshSidebar(), 600);
  }, [composeMessage, kind, agentId, workdir, permission, runStream, bus]);

  const onSend = useCallback(() => {
    if (runStream.running) return;
    if (mode === "chat") chatSend();
    else createSend();
  }, [mode, chatSend, createSend, runStream.running]);

  /* L3b 停止:chat 后台 run 断开订阅 ≠ 停后端(run 仍在跑),须显式 stopChatRun;
     然后本地 stop() 断流并显「已停止」。create/其它模式保持原语义(主动断流即停)。 */
  const handleStop = useCallback(() => {
    if (sessionMode === "chat" && bgRunIdRef.current) {
      // 停止 RPC 失败(网络断=重连场景)→ 诚实标记,不伪称已停止(后端 run 可能仍在跑)。
      // 本地 stop() 不阻塞:本地视图照常停止跟随,note 只关乎后端真相。
      void stopChatRun(bgRunIdRef.current).catch(() => runStream.noteStopUndelivered());
    }
    runStream.stop();
  }, [sessionMode, runStream]);

  /* J3 插话:运行中说的话交给**正在跑的这次 run**(不是新 run)。
     真凭证走后端 —— 时间线上的「收到补充指示」来自 run.interjected 事件帧,前端不自造。
     没被接住时(run 刚好收尾 / 网络失败)诚实回退:把话还给输入框并说明,绝不假装送到了。
     文案与还原语义在 interjectNotes.ts(纯函数,单测钉死),这里只做事件面适配。 */
  const handleInterject = useCallback(
    (text: string) => {
      const rid = bgRunIdRef.current;
      if (!rid) {
        /* 提交刚发出、后台通道还没建立的窗口:running 已翻 true 但 run_id 还是 null。
           旧实现直接 return —— 敲了回车却零反馈。这里说清楚,并**不清空草稿**。 */
        setSteerNote(CHANNEL_PENDING_NOTE);
        return;
      }
      setSteerNote(null);
      setDraft("");
      const restore = (note: string) => {
        /* 追加而非二选一:这一两秒里用户可能又打了字,那句插话不许被丢掉。 */
        setDraft((prev) => restoredDraft(prev, text));
        setSteerNote(note);
      };
      void interjectChatRun(rid, text)
        .then((res) => {
          /* 终态各说各的:res.status 可能是 ready/saved,也可能是 failed/interrupted。 */
          if (!res.accepted) restore(interjectRejectedNote(res.status));
        })
        .catch(() => {
          restore(UNDELIVERED_NOTE);
        });
    },
    [],
  );

  const onActivate = useCallback(async () => {
    const id = str(createRun?.id) || str(createRun?.runId);
    if (!id || activating) return;
    setActivating(true);
    try {
      const boundary = resolveCreateRuntimeBoundary({
        v2Configured: v2ApiBase() !== "",
        runId: id,
        v2RunId: v2CreateRunRef.current,
        channelId: v2CreateChannelRef.current,
      });
      if (boundary.kind === "v2") {
        await activateHarnessV2CreateRun(id, { channelId: boundary.channelId });
        const projection = await readHarnessV2CreateRun(id, {
          channelId: boundary.channelId,
        });
        setCreateRun(createProjectionRecord(projection, str(createRun?.prompt)));
      } else if (boundary.kind === "legacy") {
        const run = await activateDraft(id);
        setCreateRun(run as Rec);
      } else {
        throw new Error(boundary.message);
      }
      bus.refreshSidebar();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setActivating(false);
    }
  }, [createRun, activating, bus]);

  /* ---- 历史回看(chat) ---- */
  const historyReplay = useMemo(() => {
    if (!viewingRun) return null;
    const norm = createNormalizer();
    const frames = rawFramesFromRun(viewingRun).flatMap((r) => norm(r));
    return { tree: reduceTurns(frames, DEFAULT_TOOL_LABELS), usage: norm.getUsage() };
  }, [viewingRun]);

  /* ---- 面板数据与入口(真值:产物/文件计数,未读圆点;计数跳动 M2) ---- */
  const liveArtifactCount = useMemo(
    () => runStream.frames.filter((f) => f.type === "event" && f.name === "chat.artifact.emitted").length,
    [runStream.frames],
  );
  const panelArtifacts: PanelArtifact[] = useMemo(() => {
    const source = sessionMode === "chat" ? (viewingRun ?? completedRun) : null;
    return artifactsOf(source).map((a) => ({ id: a.id, title: a.title, kind: a.kind, content: a.content }));
  }, [sessionMode, viewingRun, completedRun]);
  const panelFiles: PanelFile[] = useMemo(() => {
    if (sessionMode !== "create" || !createRun) return [];
    const art = (createRun.artifact ?? null) as Rec | null;
    if (!art) return [];
    return [{ name: fileNameOf(art), preview: str(art.preview) }];
  }, [sessionMode, createRun]);
  const artifactCount =
    sessionMode === "create"
      ? panelFiles.length
      : panelArtifacts.length || liveArtifactCount;

  /* 产物流入 = 计数跳动 + 未读圆点;绝不自动弹开(N5/M2) */
  useEffect(() => {
    if (artifactCount > seenArtifactCountRef.current && !panelOpen) setUnreadArtifacts(true);
    seenArtifactCountRef.current = artifactCount;
  }, [artifactCount, panelOpen]);

  const openPanelTo = useCallback((artifactId?: string) => {
    if (artifactId) setPanelArtifactId(artifactId);
    setPanelOpen(true);
    setUnreadArtifacts(false);
  }, []);
  const togglePanel = useCallback(() => {
    setPanelOpen((v) => {
      if (!v) setUnreadArtifacts(false);
      return !v;
    });
  }, []);

  /* 页头安静 chip 组(V2 H-09:tinted 胶囊 + mono 计数 + 未读 6px 圆点;打开转激活态) */
  const headChips = sessionMode ? (
    <>
      <span className="ir-home__runhead-spacer" />
      {sessionMode === "create" && panelFiles.length > 0 && (
        <button
          type="button"
          className={`ir-home__headchip${panelOpen ? " ir-home__headchip--on" : ""}`}
          onClick={togglePanel}
        >
          文件 <b key={`f${panelFiles.length}`} className="ir-home__headchip-count">{panelFiles.length}</b>
        </button>
      )}
      {artifactCount > 0 && sessionMode === "chat" && (
        <button
          type="button"
          className={`ir-home__headchip${panelOpen ? " ir-home__headchip--on" : ""}`}
          onClick={togglePanel}
        >
          产物 <b key={`a${artifactCount}`} className="ir-home__headchip-count">{artifactCount}</b>
          {unreadArtifacts && <span className="ir-home__headchip-dot" aria-hidden="true" />}
        </button>
      )}
    </>
  ) : null;

  const rightPanel = sessionMode ? (
    <RightPanel
      open={panelOpen}
      form={sessionMode === "create" ? "files" : "canvas"}
      runId={sessionMode === "create" ? str(createRun?.id) : (runStream.tree.run?.runId ?? str(viewingRun?.id))}
      artifacts={panelArtifacts}
      activeId={panelArtifactId}
      onActivate={setPanelArtifactId}
      files={panelFiles}
      activeFile={panelFile}
      onActivateFile={setPanelFile}
      onClose={() => setPanelOpen(false)}
      pendingNote={runStream.running ? "运行中 · 产物内容将在办妥后可读" : undefined}
    />
  ) : null;

  /* ---- composer(两态共用) ---- */
  const composer = (
    <HomeComposer
      mode={mode}
      value={draft}
      onChange={setDraft}
      onSend={onSend}
      running={runStream.running}
      onStop={handleStop}
      /* J3:仅 chat 会话态且已有后台 run —— 只有这里存在「正在跑的这一次」可供补话 */
      onInterject={sessionMode === "chat" ? handleInterject : undefined}
      placeholder={sessionMode ? (mode === "create" ? "补充要求、调整草案，或吩咐下一件事……" : "追问、补充，或吩咐下一件事……") : PLACEHOLDERS[mode]}
      inputRef={inputRef}
      skillTag={skillTag}
      onClearSkillTag={() => setSkillTag(null)}
      /* V2 H-10:会话内 kind 已在用户气泡回显,composer 不重复 tag(问候态才选) */
      kindLabel={mode === "create" && !sessionMode ? KIND_LABEL[kind] : undefined}
      onResetKind={() => setKind("skill")}
      skills={skills}
      onPickSkill={(id, label) => setSkillTag({ id, label })}
      profiles={profiles.length ? profiles : [{ id: defaultProfileId, label: "日常" }]}
      profileId={profileId}
      onProfileId={setProfileId}
      agents={agents}
      agentId={agentId}
      onAgentId={setAgentId}
      connectors={connectors}
      onManageConnectors={() => bus.navigate("settings")}
      onManageSkills={() => bus.navigate("settings")}
      onOpenAgentCenter={() => bus.navigate("agents")}
      attachments={attachments.map((a) => ({ name: a.name, chars: a.chars }))}
      onAddFiles={onAddFiles}
      onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
      workdir={workdir}
      workdirs={workdirs}
      onSelectWorkdir={selectWorkdir}
      onOpenFolder={onOpenFolder}
      onAddPath={onAddPath}
      permission={mode === "create" ? permission : undefined}
      onPermission={mode === "create" ? setPermission : undefined}
      envLocked={runStream.running}
      ctxPercent={sessionMode !== null ? runStream.ctxPercent : undefined}
    />
  );

  /* ================= 问候态 ================= */
  if (!sessionMode) {
    const scenes = scenesOf(mode);
    return (
      <div className="ir-home">
        <div className="ir-home__aura" aria-hidden="true" />
        <div className="ir-home__bloom" aria-hidden="true">
          <BloomIris size={380} />
        </div>
        <div className="ir-home__inner">
          <div className="ir-home__title">
            <span className="ir-home__hi">
              {timeGreeting()}，{displayName}。
            </span>
            <IrisPetal size={26} />
          </div>

          <div className="ir-home__modes" role="tablist" aria-label="模式">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                role="tab"
                aria-selected={mode === m.mode}
                className={`ir-home__mode${mode === m.mode ? " ir-home__mode--on" : ""}`}
                onClick={() => {
                  bus.setHomeMode(m.mode);
                  setOpenScene(null);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* 场景层:一级 chip → 二级模板面板(V2 H-03) */}
          <div className="ir-home__scenes" ref={scenesRef}>
            <div className="ir-home__chips">
              {scenes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`ir-home__chip${openScene === s.id ? " ir-home__chip--on" : ""}`}
                  aria-expanded={openScene === s.id}
                  onClick={() => setOpenScene((cur) => (cur === s.id ? null : s.id))}
                >
                  {s.label}
                  <span className="ir-home__chip-caret">{openScene === s.id ? "▴" : "▾"}</span>
                </button>
              ))}
            </div>
            {openScene && (
              <div className="ir-home__tpanel">
                {(() => {
                  const scene = scenes.find((s) => s.id === openScene);
                  if (!scene) return null;
                  return (
                    <>
                      <div className="ir-home__tpanel-label">
                        {scene.label} · 模板 {scene.templates.length}
                      </div>
                      {scene.templates.map((t) => (
                        <button
                          key={t.name}
                          type="button"
                          className="ir-home__trow"
                          onClick={() => insertTemplate(scene, t.text)}
                        >
                          <span className="ir-home__trow-name">{t.name}</span>
                          <span className="ir-home__trow-text">{t.text}</span>
                        </button>
                      ))}
                      <div className="ir-home__tpanel-foot">点击模板填入输入区，填入即成纯文本 —— 可改、可删、可只用一半</div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {composer}
        </div>
      </div>
    );
  }

  /* ================= 会话态(M2 粗版单列;M3 精修 H-09/H-10) ================= */

  /* Create 收尾段(校验三面 + 注册;live 完成后与构建记录回看共用,V2 H-10) */
  const createSaved = str(createRun?.status) === "saved" || str(createRun?.status) === "activated";
  const createArt = (createRun?.artifact ?? null) as Rec | null;
  const createArtName = createArt
    ? str(createArt.skill_id) || str(createArt.prompt_id) || str(createArt.tool_id)
    : "";
  const createTail =
    sessionMode === "create" && createRun && str(createRun.status) !== "failed" ? (
      <div className="ir-home__verify">
        <div className="ir-home__verify-head">
          <span className="ir-home__verify-title">产出校验</span>
          <span className="ir-home__verify-note">SkillLoader · Fixture · 注册资格</span>
        </div>
        {verificationRows(createRun).length > 0 && (
          <div className="ir-home__verify-rows">
            {verificationRows(createRun).map((r) => (
              <span key={r.text} className={`ir-home__verify-row${r.ok ? "" : " ir-home__verify-row--bad"}`}>
                {r.ok ? "✓" : "×"} {r.text}
              </span>
            ))}
          </div>
        )}
        <div className="ir-home__verify-actions">
          {!createSaved ? (
            <>
              <button type="button" className="ir-home__btn-primary" disabled={activating} onClick={() => void onActivate()}>
                确认保存（注册）
              </button>
              <span className="ir-home__verify-hint">保存后进入产物中心</span>
            </>
          ) : (
            <span className="ir-home__verify-done">已注册{createArtName ? ` · ${createArtName}` : ""} · 已入产物中心</span>
          )}
        </div>
        {createError && <StateNote kind="error" text={createError} />}
      </div>
    ) : null;

  /* 构建记录回看(侧栏信号;B3 前 create 审计不重放,轻形态呈现) */
  if (sessionMode === "create" && runStream.tree.state === "idle" && createRun) {
    const failed = str(createRun.status) === "failed";
    const prompt = str(createRun.prompt);
    return (
      <div className={`ir-home ir-home--session${panelOpen ? " ir-home--panel" : ""}`}>
        <div className="ir-home__main">
          <div className="ir-home__runhead">
            <span className="ir-home__runhead-title">{prompt.slice(0, 16) || "构建"}</span>
            <span className="ir-home__runhead-id">run {str(createRun.id)}</span>
            {headChips}
          </div>
          <div className="ir-home__scroll">
            <div className="ir-home__col">
              {prompt && (
                <div className="ir-home__user-row">
                  <div className="ir-home__user-bubble">
                    <span className="ir-home__user-tag">◈ {KIND_LABEL[str(createRun.kind) as CreateDraftKind] ?? str(createRun.kind)}</span>
                    {prompt}
                  </div>
                </div>
              )}
              <AgentSessionHeader
                statusText={failed ? "这一步没有办成" : "已为您办好"}
                tone={failed ? "error" : "default"}
              />
              {createTail}
              {panelFiles.length > 0 && (
                <div className="ir-home__anchors">
                  <button type="button" className="ir-home__anchor" onClick={() => openPanelTo()}>
                    <span className="ir-home__anchor-badge">◈</span>
                    {KIND_LABEL[str(createRun.kind) as CreateDraftKind] ?? "产出"} · {fileNameOf((createRun.artifact ?? null) as Rec | null)}
                    <span className="ir-home__anchor-go">{panelOpen ? "已在右侧打开" : "↗ 查看文件"}</span>
                  </button>
                </div>
              )}
              {failed && str(createRun.error_message) && (
                <StateNote kind="error" text={str(createRun.error_message)} />
              )}
            </div>
          </div>
          <div className="ir-home__dock">
            <div className="ir-home__col">{composer}</div>
          </div>
        </div>
        {rightPanel}
      </div>
    );
  }

  /* 统一运行视图(Chat live/历史回看 + Create live 流,N7 同一套组件) */
  const live = !viewingRun;
  const tree = live ? runStream.tree : historyReplay!.tree;
  /* L4b 挂起(顶到 max_turns 的诚实暂停,非失败/非断线):live 读 hook 的 run.suspended 真凭证,
     回看读 run.status === "awaiting_continue"。仅在此真凭证下呈现续办卡 —— 绝不据旁证臆断。 */
  const suspendedInfo = live ? runStream.suspended : suspensionFromRun(viewingRun);
  const isSuspended = suspendedInfo != null && !runStream.running;
  const state: "running" | "done" | "error" | "suspended" = isSuspended
    ? "suspended"
    : tree.state === "error"
      ? "error"
      : tree.state === "done" || !live
        ? "done"
        : "running";
  /* LoopCard 无 suspended 态 → 映射为 awaiting(静止形态:无 spinner、无办妥礼成),真状态由续办卡承担 */
  const loopState: "running" | "done" | "error" | "awaiting" =
    state === "suspended" ? "awaiting" : state;
  const stopped = live && runStream.stopped;
  /* L3b:断线重连中(仅 live)。真话——后台 run 仍在跑,连接断了在续帧,不伪造进度。 */
  const reconnecting = live && runStream.reconnecting;
  /* L3b follow-up:停止指令未送达(stopChatRun 失败,仅 live)。诚实——本地已停跟随,但后端 run 可能仍在跑。 */
  const stopUndelivered = live && runStream.stopUndelivered;
  const answer = live
    ? str(completedRun?.assistant_message) || tree.answerText
    : str(viewingRun?.assistant_message);
  const artifacts = artifactsOf(live ? completedRun : viewingRun);
  const runId = live ? tree.run?.runId ?? "" : str(viewingRun?.id);
  const usageText = live ? runStream.usageText : formatUsageText(historyReplay!.usage);
  const usageTokens = live ? runStream.usage.tokens : historyReplay!.usage.tokens;
  const durationText = live ? runStream.elapsedText : "";
  const plan = planProgress(tree.plan);
  const isDone = state === "done";
  const isError = state === "error";
  const userMessage = live ? lastMessage : str(viewingRun?.message);
  /* L1b 会话轮次 chip:仅 chat 且 run 审计真含 chat.thread.continued 时出现(诚实:
     首轮/未续聊 → null,不显示「第 1 轮」)。live 读 completedRun(办妥后 getChatRun 全量),
     回看读 viewingRun;流式中 completedRun 未到 → 无 chip,办妥即现。 */
  /* J2:判断层诚实标注(与 threadLabel 同源同纪律——读 run 的真审计链;
     live 用办妥后全量拉回的 completedRun,回看用 viewingRun) */
  const evalNotice = evaluationNotice(
    (live ? completedRun : viewingRun)?.audit_events,
  );
  const threadLabel =
    sessionMode === "chat"
      ? threadTurnLabel((live ? completedRun : viewingRun)?.audit_events)
      : null;
  const statusText = stopUndelivered
    ? "停止指令未送达，任务可能仍在后台执行"
    : stopped
      ? "已停止"
      : isSuspended
        ? "回合预算用尽，任务已挂起"
        : reconnecting
          ? "连接中断，正在重连……"
          : state === "running"
            ? `正在为您办理 · ${durationText}`
            : isDone
              ? "已为您办好"
              : "这一步没有办成";
  /* 办妥 mono 行(V2 H-10):n 瞬间 · 计划 n/m(或 无计划)· N tok · 耗时;模型不入行 */
  const ceremony = isDone
    ? {
        momentCount: tree.turns.reduce((n, t) => n + t.steps.length, 0),
        planText: plan ? `计划 ${plan.done}/${plan.total}` : undefined,
        usageText:
          [
            usageTokens != null ? `${usageTokens.toLocaleString()} tok` : null,
            durationText || null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      }
    : undefined;
  const failure = isError
    ? {
        consumedText:
          tree.error?.consumedTokens != null
            ? `已消耗 ~${tree.error.consumedTokens.toLocaleString()} tokens`
            : undefined,
        onCopyError: () => void navigator.clipboard?.writeText(tree.error?.message ?? "").catch(() => {}),
      }
    : undefined;

  /* L4b 续办:实时挂起 → continueRun 接着既有时间线从上次 seq 续跑;回看挂起 → 切成 live,
     POST continue 后从 seq 0 fresh replay(L3b reopen flow)。两路都用同一 subscribeChatRun。 */
  const onContinueRun = () => {
    if (runStream.running) return;
    const subscribe = (runId: string, fromSeq: number, onFrame: (raw: Rec) => void, signal: AbortSignal) =>
      subscribeChatRun(runId, fromSeq, { onFrame, signal });
    if (live && bgRunIdRef.current) {
      const runId = bgRunIdRef.current;
      void runStream.continueRun(runId, () => continueChatRun(runId), subscribe);
    } else if (!live && viewingRun && str(viewingRun.status) === "awaiting_continue") {
      const runId = str(viewingRun.id);
      bgRunIdRef.current = runId;
      threadIdRef.current = str(viewingRun.thread_id) || null; // 续办后续聊仍在同一线程
      fetchedRef.current = null;
      setLastMessage(str(viewingRun.message));
      setCompletedRun(null);
      setViewingRun(null); // live=true 从此生效,交给 startBackground 从 0 重放+跟随
      void runStream.startBackground(async () => {
        await continueChatRun(runId);
        return runId;
      }, subscribe);
    }
  };

  return (
    <div className={`ir-home ir-home--session${panelOpen ? " ir-home--panel" : ""}`}>
      <div className="ir-home__main">
      <div className="ir-home__runhead">
        <span className="ir-home__runhead-title">{userMessage.slice(0, 16) || "对话"}</span>
        {runId && <span className="ir-home__runhead-id">run {runId}</span>}
        {threadLabel && <span className="ir-home__runhead-thread">{threadLabel}</span>}
        {headChips}
        {runId && (
          <button
            type="button"
            className={`ir-home__headchip${traceRunId === runId ? " ir-home__headchip--on" : ""}`}
            onClick={() => setTraceRunId(runId)}
          >
            执行过程
          </button>
        )}
      </div>
      <div className="ir-home__scroll">
        <div className="ir-home__col">
          {userMessage && (
            <div className="ir-home__user-row">
              <div className="ir-home__user-bubble">
                {sessionMode === "create" && (
                  <span className="ir-home__user-tag">◈ {KIND_LABEL[sentKind]}</span>
                )}
                {userMessage}
              </div>
            </div>
          )}
          <AgentSessionHeader statusText={statusText} tone={isError || stopUndelivered ? "error" : "default"} />
          <div className={`ir-home__run${isError ? " ir-home__run--fail" : ""}${stopped ? " ir-home__run--stopped" : ""}`}>
            <LoopCard
              state={loopState}
              nowIntent={isError ? (tree.nowIntent ? `${tree.nowIntent}，未能完成` : "未能完成") : tree.nowIntent}
              elapsedText={durationText}
              turns={tree.turns}
              plan={plan}
              usageText={usageText}
              persona={persona}
              onLoadFull={undefined}
              ceremony={ceremony}
              failure={failure}
            />
          </div>
          {isSuspended && (
            /* L4b 续办卡:诚实挂起(顶到 max_turns)— 主按钮续跑完,live 另给停止;文案只在真凭证下现 */
            <div className="ir-home__suspend">
              <div className="ir-home__suspend-head">
                回合预算用尽，任务已挂起
                {suspendedInfo?.turnsUsed != null ? ` · 已跑 ${suspendedInfo.turnsUsed} 回合` : ""}
              </div>
              <div className="ir-home__suspend-actions">
                <button type="button" className="ir-home__btn-primary" onClick={onContinueRun}>
                  继续跑完
                </button>
                {live && (
                  <button type="button" className="ir-home__suspend-stop" onClick={handleStop}>
                    停止
                  </button>
                )}
                {/* 文案只承诺已渲染的按钮:回看(非 live)不显停止键,故只提「重新发起」 */}
                <span className="ir-home__suspend-hint">{live ? "也可以停止或重新发起" : "也可以重新发起"}</span>
              </div>
            </div>
          )}
          {stopped && !stopUndelivered && <p className="ir-home__stopped-note">已停止 · 已产生的过程保留</p>}
          {isDone && answer.trim() && (
            <div className="ir-home__answer">
              <ReactMarkdown>{answer}</ReactMarkdown>
            </div>
          )}
          {/* J2 判断层诚实标注:复核发现没真办成、补办后仍不达 → 就在答案边上说清楚。
              只在真有 run.evaluation.flagged 时出现;干净/跳过/复核通过一律零噪声。 */}
          {isDone && evalNotice && (
            <div className="ir-home__flagged" role="note">
              <span className="ir-home__flagged-head">未完全达成 —— 复核发现还差这些</span>
              {evalNotice.gaps.length > 0 && (
                <ul className="ir-home__flagged-list">
                  {evalNotice.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              )}
              <span className="ir-home__flagged-foot">
                上面的回答已经交付，但它不是完整的答案。可以直接补一句让我接着办。
              </span>
            </div>
          )}
          {isDone && artifacts.length > 0 && (
            /* 流内产物锚点 chip(V2 H-10:薄纱胶囊 + ◇ 徽 + iris ↗;点击滑出面板并定位) */
            <div className="ir-home__anchors">
              {artifacts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`ir-home__anchor${panelOpen && panelArtifactId === a.id ? " ir-home__anchor--on" : ""}`}
                  onClick={() => openPanelTo(a.id)}
                >
                  <span className="ir-home__anchor-badge">◇</span>
                  {isPageKind(a.kind) ? "网页" : "文档"} · {a.title}
                  <span className="ir-home__anchor-go">↗</span>
                </button>
              ))}
            </div>
          )}
          {isDone && sessionMode === "create" && panelFiles.length > 0 && (
            <div className="ir-home__anchors">
              <button type="button" className="ir-home__anchor" onClick={() => openPanelTo()}>
                <span className="ir-home__anchor-badge">◈</span>
                {KIND_LABEL[sentKind]} · {fileNameOf((createRun?.artifact ?? null) as Rec | null)}
                <span className="ir-home__anchor-go">{panelOpen ? "已在右侧打开" : "↗ 查看文件"}</span>
              </button>
            </div>
          )}
          {isDone && createTail}
          {isError && (
            <>
              <p className="ir-home__apology">{errorApology(tree.error?.message ?? "")}</p>
              {tree.error?.message && <StateNote kind="error" text={tree.error.message} />}
            </>
          )}
        </div>
      </div>
      <div className="ir-home__dock">
        <div className="ir-home__col">
          {steerNote && (
            <p className="ir-home__steernote" role="status">
              {steerNote}
            </p>
          )}
          {composer}
        </div>
      </div>
      </div>
      {rightPanel}
      <TraceDrawer runId={traceRunId ?? ""} open={!!traceRunId} onClose={() => setTraceRunId(null)} />
    </div>
  );
}

export default HomePage;
