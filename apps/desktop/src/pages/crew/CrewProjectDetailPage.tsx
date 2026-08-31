/**
 * CrewProjectDetailPage · 项目详情三区(F1 骨架 + F2 画布 + F4 检视/列表/共识)
 *
 * 面包屑条 52px(项目›名 + SOP pill + 视图切换条〔图/列表 真实现 · 看板 P1〕+ 共识·N pill)
 *   + 健康条 60px(真数据推导)
 *   + 内容区:图(F2 Work Graph)或 列表(F4)+ 频道列 328px(F3)。
 * F4 覆盖层:轻检视 popover(单击节点)/ 任务抽屉(双击 · 全档案 · crew:open-task)/
 *   共识面板(共识 pill)。全真:一切来自后端;失败降级空态,绝不造数。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { getIdentity } from "../../lib/api/identity";
import {
  assignTask,
  getProject,
  getProjectMemory,
  listChannel,
  listTeam,
  listTemplates,
  postChannel,
  reviewTask,
  runAgentTask,
  startTask,
  submitTask,
  type ChannelMessage,
  type CrewProject,
  type MemoryItem,
  type SopTemplate,
  type TeamMember,
} from "../../lib/api/crew";
import { ChannelColumn } from "./channel/ChannelColumn";
import type { ReaderTarget } from "./channel/AttachmentChip";
import { awaitingCount, projectProgress, runningCount } from "./crewModel";
import { CrewGraphCanvas } from "./graph/CrewGraphCanvas";
import { agentActiveCount, blockedCount, gateVisual, taskVisual, type NodeActionOp } from "./graph/graphMapping";
import { dispatchRingCall, planLocate } from "./graph/graphMotion";
import { ConsensusPanel } from "./inspect/ConsensusPanel";
import { CrewListView } from "./inspect/CrewListView";
import { friendlyTaskError } from "./inspect/friendlyError";
import { computePopoverPosition, type Rect } from "./inspect/inspectModel";
import { NodeInspectPopover } from "./inspect/NodeInspectPopover";
import { TaskDrawer } from "./inspect/TaskDrawer";
import type { InspectActions } from "./inspect/types";
import { deriveNextUp } from "./nextUp";
import { NextUpStrip } from "./NextUpStrip";
import { ArtifactReader, type ReaderReview } from "./reader/ArtifactReader";
import { downloadArtifactMd } from "./reader/download";
import { INITIAL_CANVAS_VIEW, canvasViewReducer, resolveArtifact, reviewReadiness } from "./reader/readerModel";
import "./crew.css";
import "./inspect/inspect.css";

const OPEN_TASK_EVENT = "crew:open-task";
const POLL_MS = 3000;
const POP_W = 372;
const POP_H = 340; // 翻转判定用估算高度

function initialOf(name: string): string {
  const t = (name ?? "").trim();
  return t ? t[0].toUpperCase() : "·";
}

const VIEWS = [
  { id: "graph", label: "图" },
  { id: "list", label: "列表" },
  { id: "board", label: "看板", stub: true },
] as const;

type ViewId = "graph" | "list";

export function CrewProjectDetailPage({ projectId }: { projectId: string | null }) {
  const [project, setProject] = useState<CrewProject | null>(null);
  const [channel, setChannel] = useState<ChannelMessage[] | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [templates, setTemplates] = useState<SopTemplate[]>([]);
  const [memory, setMemory] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  // F4 覆盖层状态
  const [view, setView] = useState<ViewId>("graph");
  const [inspect, setInspect] = useState<{ taskId: string; anchor: Rect } | null>(null);
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [consensusOpen, setConsensusOpen] = useState(false);

  // R1:画布区视图态(图 ↔ 产物阅读器);频道列恒在右
  const [canvasView, dispatchCanvas] = useReducer(canvasViewReducer, INITIAL_CANVAS_VIEW);

  // DEV-2:节点动作失败的画布底栏瞬时提示(mono,~4s 自淡;seq 令同文案也重播动画)
  const [notice, setNotice] = useState<{ msg: string; seq: number } | null>(null);
  const noticeSeq = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    noticeSeq.current += 1;
    setNotice({ msg, seq: noticeSeq.current });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  // 当前会话身份(判定 Boss = 项目负责人;失败静默,非 Boss 口径)
  useEffect(() => {
    getIdentity()
      .then((id) => setSessionUserId(id.userId))
      .catch(() => setSessionUserId(null));
  }, []);

  const load = useCallback(() => {
    if (!projectId) {
      setProject(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getProject(projectId)
      .then((p) => setProject(p))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    listChannel(projectId)
      .then((m) => setChannel(m))
      .catch(() => setChannel([]));
    listTeam()
      .then((m) => setMembers(m))
      .catch(() => setMembers([]));
    listTemplates()
      .then((t) => setTemplates(t))
      .catch(() => setTemplates([]));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // 项目共识(共识·N pill + 命中溯源 + 届时注入 chips);失败/未上线 → 空
  const reloadMemory = useCallback(() => {
    if (!projectId) return;
    getProjectMemory(projectId)
      .then((m) => setMemory(m))
      .catch(() => setMemory([]));
  }, [projectId]);
  useEffect(() => {
    reloadMemory();
  }, [reloadMemory]);

  // F2:画布轮询快照流回(单一事实源 —— 健康条/频道列与图同步)
  const onSnapshot = useCallback((p: CrewProject, ch: ChannelMessage[] | null) => {
    setProject(p);
    if (ch) setChannel(ch);
  }, []);

  // F2:项目详情生命周期内轮询快照,图/列表/阅读器切换时保持刷新
  useEffect(() => {
    setLastSync(null);
    if (!projectId) return;
    let alive = true;
    const tick = async () => {
      try {
        const [p, ch] = await Promise.all([
          getProject(projectId),
          listChannel(projectId).catch(() => null),
        ]);
        if (!alive) return;
        setLastSync(new Date());
        onSnapshot(p, ch);
      } catch {
        /* 网络抖动:保留上一个真快照,不造数 */
      }
    };
    const iv = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [projectId, onSnapshot]);

  // F3:频道动作后立即重取,不等画布下一拍
  const refresh = useCallback(
    (p?: CrewProject) => {
      if (p) setProject(p);
      if (!projectId) return;
      getProject(projectId).then(setProject).catch(() => {});
      listChannel(projectId).then(setChannel).catch(() => {});
    },
    [projectId],
  );

  // F3 → F4:artifact/评审卡「打开抽屉」派 crew:open-task
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId) {
        setInspect(null);
        setDrawerTaskId(detail.taskId);
      }
    };
    window.addEventListener(OPEN_TASK_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TASK_EVENT, onOpen);
  }, []);

  // C4:频道 chip / 评审卡「全幅阅读」→ 阅读器接管画布区(频道留右)
  const handleOpenReader = useCallback((target: ReaderTarget) => {
    dispatchCanvas({ type: "openReader", taskId: target.taskId, version: target.version });
  }, []);

  // C4:下载 → 解析该任务/版本的真产物,另存 `产物名-vN.md`(无产物静默)
  const handleDownload = useCallback(
    (target: ReaderTarget) => {
      const t = (project?.tasks ?? []).find((x) => x.id === target.taskId);
      const resolved = resolveArtifact(t ?? null, members, target.version);
      if (!resolved || !resolved.content) return;
      downloadArtifactMd(resolved.artifactName, resolved.version, resolved.content);
    },
    [project?.tasks, members],
  );

  // O-C:频道「定位」→ 图节点点名(§6 双向打通:频道管读与定位,图管推进)。
  // 阅读器/列表先归位到图,再点名环(P6 pan+ring)。画布若由卸载→挂载
  // (reader/list→graph),RING_EVENT 监听须待挂载后注册,故双 rAF 延迟派发;
  // 已在图则即时(canvas 已挂载,监听在位)。
  const handleLocate = useCallback(
    (taskId: string) => {
      const plan = planLocate(canvasView.kind, view);
      if (plan.backToGraph) dispatchCanvas({ type: "backToGraph" });
      if (plan.switchToGraph) setView("graph");
      if (plan.backToGraph || plan.switchToGraph) {
        requestAnimationFrame(() => requestAnimationFrame(() => dispatchRingCall(taskId)));
      } else {
        dispatchRingCall(taskId);
      }
    },
    [canvasView.kind, view],
  );

  // DEV-2/C5:节点动作失败 → 人话提示 + 立即拉最新快照(状态归位)
  const notifyActionError = useCallback(
    (e: unknown) => {
      showNotice(friendlyTaskError(e));
      refresh();
    },
    [showNotice, refresh],
  );

  // 可用性收束 · 一屏两键评审:打开阅读器对照评审态(左读被评审产物,底钉通过/驳回)
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const handleOpenReview = useCallback(
    (gateId: string) => {
      const gate = (project?.tasks ?? []).find((t) => t.id === gateId);
      const producerId = gate?.reviews_task_id ?? null;
      if (!gate || !producerId) {
        showNotice("该评审门没有可读的被评审产物。");
        return;
      }
      setReviewError(null);
      setInspect(null);
      setDrawerTaskId(null);
      dispatchCanvas({ type: "openReader", taskId: producerId, gateId });
    },
    [project?.tasks, showNotice],
  );
  const handleReviewDecide = useCallback(
    async (gateId: string, approved: boolean, comment: string | null) => {
      setReviewBusy(true);
      setReviewError(null);
      try {
        const p = await reviewTask(projectId!, gateId, approved, comment);
        refresh(p);
        dispatchCanvas({ type: "backToGraph" });
        // 判后回图,点名环落在门上——通过=落章、驳回=返工回路,下一步一目了然。
        // 从阅读器回图 = 画布刚重挂,RING_EVENT 监听待注册 → 与 handleLocate 同款双 rAF 延迟。
        requestAnimationFrame(() => requestAnimationFrame(() => dispatchRingCall(gateId)));
      } catch (e) {
        setReviewError(friendlyTaskError(e));
      } finally {
        setReviewBusy(false);
      }
    },
    [projectId, refresh],
  );

  // R1:阅读器 ESC 回图。仅在阅读器视图且无更上层浮层(抽屉/轻检视/共识各自有 Esc)时接管,避免双响应
  useEffect(() => {
    if (canvasView.kind !== "reader") return;
    if (drawerTaskId || inspect || consensusOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dispatchCanvas({ type: "backToGraph" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasView.kind, drawerTaskId, inspect, consensusOpen]);

  const isOwner = !!sessionUserId && !!project && sessionUserId === project.owner_user_id;

  // F4 动作契约(真 API + refresh)
  const inspectActions: InspectActions = useMemo(
    () => ({
      sessionUserId,
      ownerUserId: project?.owner_user_id ?? "",
      isOwner,
      members,
      memory,
      assign: (taskId, memberId) => assignTask(projectId!, taskId, memberId).then(refresh),
      start: (taskId) => startTask(projectId!, taskId).then(refresh),
      submit: (taskId, artifact) => submitTask(projectId!, taskId, artifact).then(refresh),
      // run-agent 返回 {run_ref};立即 refresh 让 run_ref 落任务后抽屉 trace 可见。
      runAgent: (taskId) => runAgentTask(projectId!, taskId).then(() => refresh()),
      say: (body, mentions) => postChannel(projectId!, body, mentions).then(() => refresh()),
      // DEV-1:预检发现陈旧/动作失败时立即刷新(不等 3s 轮询)
      refresh: () => refresh(),
      // 可用性收束:去评审 → 阅读器对照评审(一屏两键)
      openReview: (gateId) => handleOpenReview(gateId),
      ring: (taskId) => dispatchRingCall(taskId),
      openDrawer: (taskId) => {
        setInspect(null);
        setDrawerTaskId(taskId);
      },
      close: () => {
        setInspect(null);
        setDrawerTaskId(null);
      },
    }),
    [sessionUserId, project?.owner_user_id, isOwner, members, memory, projectId, refresh, handleOpenReview],
  );

  const onInspect = useCallback((taskId: string, anchor: Rect) => {
    setDrawerTaskId(null);
    setInspect({ taskId, anchor });
  }, []);
  const onOpenDrawer = useCallback((taskId: string) => {
    setInspect(null);
    setDrawerTaskId(taskId);
  }, []);

  // #2 节点/列表就地主动作 → 真 API(复用 inspectActions,不新建封装)或开抽屉/轻检视
  const onNodePrimary = useCallback(
    (taskId: string, op: NodeActionOp, anchor?: Rect) => {
      switch (op) {
        case "claim":
          // 认领 = 派给自己(需会话身份;免登录已在映射侧不给「认领」)
          if (sessionUserId)
            void inspectActions.assign(taskId, sessionUserId).catch(notifyActionError);
          break;
        case "start":
          void inspectActions.start(taskId).catch(notifyActionError);
          break;
        case "execute":
          void inspectActions.runAgent(taskId).catch(notifyActionError);
          break;
        case "submit": // 人执行中/返工 → 开抽屉提交区
        case "review": // 活跃门 → 开评审面(承接于抽屉/频道评审卡)
          setInspect(null);
          setDrawerTaskId(taskId);
          break;
        case "seeReason":
          // 阻塞看原因:画布带锚点 → 轻检视 popover;列表无锚点 → 抽屉
          if (anchor) {
            setDrawerTaskId(null);
            setInspect({ taskId, anchor });
          } else {
            setInspect(null);
            setDrawerTaskId(taskId);
          }
          break;
      }
    },
    [sessionUserId, inspectActions, notifyActionError],
  );

  if (!projectId) {
    return (
      <div className="ir-crew-detail ir-crew-detail--empty">
        <StateNote kind="empty" petal text="从左侧“项目”选择一个项目查看工作图" />
      </div>
    );
  }
  if (loading && !project) {
    return (
      <div className="ir-crew-detail ir-crew-detail--empty">
        <StateNote kind="loading" text="正在装载项目" />
      </div>
    );
  }
  if (error && !project) {
    return (
      <div className="ir-crew-detail ir-crew-detail--empty">
        <StateNote kind="error" text={error} />
      </div>
    );
  }
  if (!project) return null;

  const tasks = project.tasks ?? [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const prog = projectProgress(tasks);
  const running = runningCount(tasks);
  const awaiting = awaitingCount(tasks);
  // C1:健康条「活跃 Agent」并数在飞(status running 或 run_inflight),与图流光/频道活动行三处同源
  const agentActive = agentActiveCount(tasks, members);
  const stuck = blockedCount(tasks);
  const name = (project.goal_text ?? "").trim() || project.id;
  const template = templates.find((t) => t.id === project.sop_template_id);
  const templateName = template?.name ?? project.sop_template_id;

  const memberMap = new Map(members.map((m) => [m.id, m]));
  const assigneeIds = [...new Set(tasks.map((t) => t.assignee_member_id).filter((x): x is string => !!x))];

  // F4 覆盖层的当前任务(从最新 project.tasks 派生 → 动作后自动反映新态)
  const inspectTask = inspect ? tasks.find((t) => t.id === inspect.taskId) ?? null : null;
  const drawerTask = drawerTaskId ? tasks.find((t) => t.id === drawerTaskId) ?? null : null;
  // R1:阅读器目标任务(从最新快照派生;任务消失则回退图,不留空阅读器)
  const readerTask =
    canvasView.kind === "reader" ? tasks.find((t) => t.id === canvasView.taskId) ?? null : null;
  const readerVersion = canvasView.kind === "reader" ? canvasView.version : undefined;
  // 对照评审态:携 gateId → 底钉评审条。门活跃 → 「通过/驳回」按钮变体;
  // 门休眠(双亲未齐,#1)→ 「还差 X 交付后开评」等待变体(缺父交付后轮询原地翻活);
  // 门已通过 → 条隐藏(已裁定,edge 取最简诚实:不显残条)。
  const readerGate =
    canvasView.kind === "reader" && canvasView.gateId
      ? tasks.find((t) => t.id === canvasView.gateId && t.is_gate) ?? null
      : null;
  const readerGateVisual = readerGate ? gateVisual(readerGate) : null;
  const readerReview: ReaderReview | undefined =
    !readerGate || readerGateVisual === "passed"
      ? undefined
      : readerGateVisual === "active"
        ? {
            state: "active",
            gateTitle: readerGate.title,
            busy: reviewBusy,
            error: reviewError,
            onApprove: () => void handleReviewDecide(readerGate.id, true, null),
            onReject: (comment: string) => void handleReviewDecide(readerGate.id, false, comment),
          }
        : {
            state: "waiting",
            gateTitle: readerGate.title,
            missing: reviewReadiness(readerGate, byId).missing,
          };

  // 「该你了」向导条(第一性:一件事 + 一个按钮;零即隐)
  const nextUp = deriveNextUp(tasks, sessionUserId, isOwner);
  const popPosition =
    inspect && inspectTask
      ? computePopoverPosition(
          inspect.anchor,
          { width: POP_W, height: POP_H },
          { width: typeof window !== "undefined" ? window.innerWidth : 1440, height: typeof window !== "undefined" ? window.innerHeight : 900 },
        )
      : null;

  return (
    <div className="ir-crew-detail">
      {/* 面包屑条 52px */}
      <div className="ir-crew-bar">
        <div className="ir-crew-bar__crumb">
          <span className="ir-crew-bar__crumb-root">项目</span>
          <span className="ir-crew-bar__crumb-sep">›</span>
          <span className="ir-crew-bar__crumb-name" title={name}>{name}</span>
        </div>
        <span className="ir-crew-pill ir-crew-pill--sop">
          <span className="ir-crew-pill__k">SOP</span>
          {templateName}
        </span>
        <div className="ir-crew-viewsw" role="tablist" aria-label="视图">
          {VIEWS.map((v) =>
            "stub" in v && v.stub ? (
              <span key={v.id} className="ir-crew-viewsw__opt ir-crew-viewsw__opt--stub" aria-disabled="true">
                {v.label}
                <span className="ir-crew-viewsw__p1">P1</span>
              </span>
            ) : (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === view}
                className={`ir-crew-viewsw__opt${v.id === view ? " ir-crew-viewsw__opt--on" : ""}`}
                onClick={() => setView(v.id as ViewId)}
              >
                {v.label}
              </button>
            ),
          )}
        </div>
        <span className="ir-crew-bar__spacer" />
        {/* 共识·N pill(F4:点开右滑面板;N=真条数,0 时不带数) */}
        <button
          type="button"
          className={`ir-crew-pill ir-crew-pill--consensus${consensusOpen ? " is-open" : ""}`}
          onClick={() => setConsensusOpen((v) => !v)}
        >
          共识{memory.length > 0 ? ` · ${memory.length}` : ""}
        </button>
      </div>

      {project.source === "showcase" && (
        <div className="ir-crew-showcase-banner">
          内置案例 · 确定性示例数据，不代表现场模型运行
        </div>
      )}

      {/* 健康条 60px */}
      <div className="ir-crew-health">
        <div className="ir-crew-health__title">{name}</div>
        <div className="ir-crew-health__prog" aria-label={`进度 ${prog.label}`}>
          <div className="ir-crew-health__bars">
            {tasks.map((t, i) => (
              <span
                key={t.id ?? i}
                className={`ir-crew-bar-seg ir-crew-bar-seg--${
                  t.status === "done" ? "done" : t.status === "running" ? "now" : "idle"
                }`}
              />
            ))}
          </div>
          <span className="ir-crew-health__mono">
            进度 {prog.label}
            {running > 0 ? ` · 执行 ${running}` : awaiting > 0 ? ` · 待审 ${awaiting}` : ""}
          </span>
        </div>
        {agentActive > 0 && (
          <span className="ir-crew-chip ir-crew-chip--agent">
            <span className="ir-crew-chip__dot" aria-hidden="true" />
            Agent 执行中 · {agentActive}
          </span>
        )}
        {awaiting > 0 && (
          <span className="ir-crew-chip ir-crew-chip--warn">等我处理 · {awaiting}</span>
        )}
        {stuck > 0 && (
          <span className="ir-crew-chip ir-crew-chip--danger">阻塞 · {stuck}</span>
        )}
        {assigneeIds.length > 0 && (
          <div className="ir-crew-health__avatars">
            {assigneeIds.slice(0, 6).map((id) => {
              const mem = memberMap.get(id);
              const agent = mem?.kind === "agent";
              return (
                <span
                  key={id}
                  className={`ir-crew-ava${agent ? " ir-crew-ava--agent" : ""}`}
                  title={mem?.display_name ?? id}
                >
                  {initialOf(mem?.display_name ?? id)}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* 「该你了」向导条:一件事 + 一个按钮(评审→一屏两键;做事→抽屉;零即隐) */}
      <NextUpStrip
        next={nextUp}
        onAction={(taskId, kind) => {
          if (kind === "review") {
            handleOpenReview(taskId);
          } else if (kind === "start") {
            void inspectActions.start(taskId).catch(notifyActionError);
          } else {
            // submit / rework → 开抽屉(提交区就在脚下)
            setInspect(null);
            setDrawerTaskId(taskId);
          }
        }}
      />

      {/* 内容行:图 / 列表 / 阅读器 + 频道 */}
      <div className="ir-crew-body">
        {readerTask ? (
          // R1:产物阅读器接管画布区(频道列留右 —— 对照评审 posture)
          <ArtifactReader
            task={readerTask}
            members={members}
            projectName={name}
            version={readerVersion}
            onBack={() => dispatchCanvas({ type: "backToGraph" })}
            onSwitchVersion={(v) => dispatchCanvas({ type: "switchVersion", version: v })}
            review={readerReview}
          />
        ) : view === "list" ? (
          <div className="ir-insp-listwrap">
            <CrewListView
              tasks={tasks}
              members={members}
              ownerUserId={project.owner_user_id}
              sessionUserId={sessionUserId}
              onOpenTask={onOpenDrawer}
              onPrimary={onNodePrimary}
            />
          </div>
        ) : (
          <div className="ir-crew-canvas">
            <CrewGraphCanvas
              project={project}
              channel={channel ?? []}
              members={members}
              lastSync={lastSync}
              onInspect={onInspect}
              onOpenDrawer={onOpenDrawer}
              selectedTaskId={inspect?.taskId ?? null}
              sessionUserId={sessionUserId}
              onNodePrimary={onNodePrimary}
            />
          </div>
        )}

        {/* 频道列 328px(F3);C4 全幅阅读/下载上抛到阅读器/下载器 */}
        <ChannelColumn
          projectId={projectId}
          project={project}
          channel={channel}
          members={members}
          isOwner={isOwner}
          onRefresh={refresh}
          onOpenReader={handleOpenReader}
          onDownload={handleDownload}
          onOpenReview={handleOpenReview}
          onLocate={handleLocate}
        />

        {/* DEV-2:节点动作失败瞬时提示(seq key 令重复文案也重播淡入淡出) */}
        {notice && (
          <div key={notice.seq} className="ir-crew-notice" role="status">
            {notice.msg}
          </div>
        )}
      </div>

      {/* F4 覆盖层 */}
      {inspect && inspectTask && popPosition && (
        <NodeInspectPopover
          task={inspectTask}
          visual={taskVisual(inspectTask, byId)}
          tasks={tasks}
          channel={channel ?? []}
          sopName={templateName}
          position={popPosition}
          actions={inspectActions}
        />
      )}
      {drawerTask && (
        // TODO(S-D2 props): wire onOpenReader={handleOpenReader} / onDownload={handleDownload} once TaskDrawer accepts them (props absent in this checkout)
        <TaskDrawer task={drawerTask} tasks={tasks} channel={channel ?? []} actions={inspectActions} />
      )}
      {consensusOpen && (
        <ConsensusPanel
          projectId={projectId}
          items={memory}
          isOwner={isOwner}
          onClose={() => setConsensusOpen(false)}
          onChanged={reloadMemory}
        />
      )}
    </div>
  );
}

export default CrewProjectDetailPage;
