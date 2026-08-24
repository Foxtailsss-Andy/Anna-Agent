/**
 * NodeInspectPopover · 轻检视双卡(2a:单击节点即白盒)
 *   372 宽 r18,锚节点上方 caret,近缘自动翻转;单击开、双击/全档案转抽屉、Esc/点空白关。
 *   双卡:执行中 = Agent 执行白盒(目标/进度·耗时/正在 live/输入·产出);
 *         其余 = 待就绪档案白盒(为什么没开始·还差 n 道门 / 执行者 / 解锁即通知 / 届时注入)。
 *   零捏造:回合·步骤·耗时从 frames 真算;估算「按同类均值」无历史 → 不渲染(只显已耗时)。
 *   呼吸暂歇 + 选中环接管由画布侧(TaskNode selected class)配合,浮层只负责内容。
 */

import { useEffect, useMemo, useRef } from "react";

import type { ChannelMessage } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { gateVisual, statusWord, taskVisual, type TaskVisual } from "../graph/graphMapping";
import { auditRefFor, latestArtifactVersion, taskRunRef } from "./helpers";
import { fmtElapsed } from "./format";
import { framesToTrace } from "./crewTrace";
import { MemberAvatar, MemberName } from "./MemberBits";
import { MemberPicker } from "./MemberPicker";
import { StateSeal, GateSeal, StatusPill } from "./StateSeal";
import {
  canRunAgent,
  dependencyChain,
  estimateRemaining,
  gateOps,
  inHandCount,
  popoverOps,
  resolveConsensusHits,
  selectPopoverCard,
  traceProgress,
  withAgentRun,
  type PopoverPosition,
} from "./inspectModel";
import type { InspectActions } from "./types";
import { useRunFrames } from "./useRunFrames";
import { useTaskOps } from "./useTaskOps";

/* ---------------- icons ---------------- */

function CloseX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
function Crosshair() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5V6M12 18v3.5M2.5 12H6M18 12h3.5" />
    </svg>
  );
}
function Clock() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
function MiniCheck() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#3E9C82" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/* ---------------- props ---------------- */

export interface NodeInspectPopoverProps {
  task: CrewTask;
  visual: TaskVisual;
  tasks: CrewTask[];
  channel: ChannelMessage[];
  sopName: string;
  position: PopoverPosition;
  actions: InspectActions;
}

export function NodeInspectPopover(props: NodeInspectPopoverProps) {
  const { task, visual, tasks, channel, sopName, position, actions } = props;
  const ref = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const card = selectPopoverCard(visual);
  const ops = useTaskOps(task, tasks, byId, actions);

  // Esc + 点空白关闭(mousedown 在浮层外即关;点另一节点会先关再由 onNodeClick 重开)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") actions.close();
    };
    const onDown = (e: MouseEvent) => {
      if (ops.pickerOpen) return; // 选人浮层自理
      if (ref.current && !ref.current.contains(e.target as Node)) actions.close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [actions, ops.pickerOpen]);

  const assignee = task.assignee_member_id
    ? actions.members.find((m) => m.id === task.assignee_member_id) ?? null
    : null;
  const audit = auditRefFor(task, channel);
  // 门 → gateOps(只剩去评审;不给认领/开始/提交);live 卡保持全档案/去频道;
  // dossier 卡(assigned|rework 的 agent 任务)「执行」为主按钮。
  const opButtons = task.is_gate
    ? gateOps(gateVisual(task))
    : withAgentRun(popoverOps(card, visual), canRunAgent(task, actions.members));

  const executorRow = assignee && (
    <div className="ir-insp-exec">
      <MemberAvatar member={assignee} isOwner={assignee.id === actions.ownerUserId} size={18} />
      <MemberName member={assignee} />
      {card === "dossier" && (
        <span className="ir-insp-exec__load">在手 {inHandCount(assignee.id, tasks)}</span>
      )}
      <button type="button" className="ir-insp-chip ir-insp-exec__reassign" onClick={ops.openPicker}>
        改派
      </button>
      {ops.pickerOpen && (
        <MemberPicker
          members={actions.members}
          ownerUserId={actions.ownerUserId}
          currentId={task.assignee_member_id}
          onPick={ops.confirmReassign}
          onClose={ops.closePicker}
        />
      )}
    </div>
  );

  const actionRow = (
    <div className="ir-insp-actions">
      {opButtons.map((b) => (
        <button
          key={b.id}
          type="button"
          className={`ir-insp-btn ir-insp-btn--${b.variant}`}
          disabled={ops.busy}
          onClick={() => ops.run(b.id)}
        >
          {b.label}
        </button>
      ))}
      <span className="ir-insp-actions__hint">Esc 或点击空白处关闭</span>
    </div>
  );

  return (
    <div
      ref={ref}
      className={`ir-insp-pop ir-insp-pop--${position.placement} ir-insp-pop--${card}`}
      style={{ left: position.left, top: position.top }}
      role="dialog"
      aria-label={`${task.title} · 轻检视`}
    >
      <span className="ir-insp-pop__caret" style={{ left: position.caretLeft }} aria-hidden="true" />

      {/* 头:serif 标题 + 状态 pill + audit号 + ✕ */}
      <div className="ir-insp-pop__head">
        <span className="ir-insp-pop__title">{task.title}</span>
        <StatusPill visual={visual} />
        <span className="ir-insp-pop__headright">
          {audit && <span className="ir-insp-audit">{audit}</span>}
          <button type="button" className="ir-insp-x" aria-label="关闭" onClick={actions.close}>
            <CloseX />
          </button>
        </span>
      </div>

      {card === "live" ? (
        <LiveBody task={task} channel={channel} sopName={sopName} actions={actions} executor={executorRow} />
      ) : (
        <DossierBody task={task} visual={visual} byId={byId} actions={actions} executor={executorRow} />
      )}

      {ops.error && <div className="ir-insp-err">{ops.error}</div>}
      {actionRow}
    </div>
  );
}

/* ---------------- 执行白盒(live) ---------------- */

function LiveBody({
  task,
  channel,
  sopName,
  actions,
  executor,
}: {
  task: CrewTask;
  channel: ChannelMessage[];
  sopName: string;
  actions: InspectActions;
  executor: React.ReactNode;
}) {
  const runRef = taskRunRef(task, channel);
  const { frames } = useRunFrames(runRef, true);
  const trace = useMemo(() => framesToTrace(frames ?? []), [frames]);
  const prog = traceProgress(trace.turns);
  const hits = resolveConsensusHits(trace.memoryHits, actions.memory);
  const elapsedMs = trace.startedAtMs != null ? Date.now() - trace.startedAtMs : null;
  // 估算:无历史同类 run → null(只显已耗时,零捏造)
  const estimate = estimateRemaining([], elapsedMs ?? 0);
  const desc = (task.description ?? "").trim() || task.title;
  const version = latestArtifactVersion(task);

  return (
    <div className="ir-insp-body">
      {/* 目标 */}
      <div className="ir-insp-goal">
        <div className="ir-insp-goal__k">目标</div>
        <div className="ir-insp-goal__v">{desc}</div>
        {task.acceptance_criteria && sopName && (
          <span className="ir-insp-goal__src">来源 · {sopName}</span>
        )}
      </div>

      {executor}

      {/* 进度 · 真值(回合/步骤/已耗时);估算行仅在有历史时渲染 */}
      <div className="ir-insp-prog">
        <span className="ir-insp-prog__k">进度</span>
        <span className="ir-insp-prog__mono">
          回合 {prog.turnCount} · 步骤 {prog.stepCount}
        </span>
        {elapsedMs != null && <span className="ir-insp-prog__elapsed">已 {fmtElapsed(elapsedMs)}</span>}
      </div>
      {estimate && <div className="ir-insp-estimate">{estimate.text}</div>}

      {/* 正在:… live */}
      {trace.nowIntent && (
        <div className="ir-insp-now">
          <span className="ir-insp-now__dot" aria-hidden="true" />
          <span className="ir-insp-now__t">正在：{trace.nowIntent}</span>
          {prog.stepCount > 0 && <span className="ir-insp-now__step">step-{prog.stepCount}</span>}
        </div>
      )}

      {/* 输入(共识命中 chips)· 产出 */}
      <div className="ir-insp-io">
        <div className="ir-insp-io__col">
          <div className="ir-insp-io__k">输入</div>
          <div className="ir-insp-chips">
            {hits.length === 0 ? (
              <span className="ir-insp-chip ir-insp-chip--muted">暂无命中共识</span>
            ) : (
              hits.map((h) => (
                <span key={h.id} className="ir-insp-chip ir-insp-chip--hit" title={h.text}>
                  <MiniCheck />[{h.kind}] {h.text}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="ir-insp-io__col">
          <div className="ir-insp-io__k">产出</div>
          <div className="ir-insp-chips">
            <span className="ir-insp-chip ir-insp-chip--out">
              {version != null ? `产物 v${version}` : "待产"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 待就绪档案白盒(dossier) ---------------- */

function reasonHeading(visual: TaskVisual, gateCount: number, task: CrewTask): string {
  switch (visual) {
    case "pending":
      return `为什么还没开始 · 还差 ${gateCount} 道门`;
    case "ready":
      return "就绪 · 依赖已满足，待认领或开始";
    case "review":
      return "已提交待审 · 等评审";
    case "blocked":
      return task.blocker ? `阻塞：${task.blocker}` : "阻塞 · 待协调";
    case "rework":
      return task.review_comment ? `返工 · ${task.review_comment}` : "返工 · 批注注入重跑";
    case "done":
      return "已完成";
    default:
      return "";
  }
}

function DossierBody({
  task,
  visual,
  byId,
  actions,
  executor,
}: {
  task: CrewTask;
  visual: TaskVisual;
  byId: Map<string, CrewTask>;
  actions: InspectActions;
  executor: React.ReactNode;
}) {
  const { chain, gateCount } = dependencyChain(task, byId);
  const showChain = (visual === "pending" || visual === "ready") && chain.length > 1;
  // 阻塞本任务的上游门(直接依赖里的未通过门;否则依赖链中最近的门)
  const chainGateId = [...chain].reverse().find((c) => !c.self && c.isGate)?.id;
  const blockingGate =
    (task.depends_on ?? [])
      .map((id) => byId.get(id))
      .find((t): t is CrewTask => !!t && !!t.is_gate && t.status !== "done") ??
    (chainGateId ? byId.get(chainGateId) ?? null : null);
  const waitingOnGate = visual === "pending" && gateCount > 0;

  // 届时注入:项目共识(名) + 上游已完成产出(标题)
  const upstreamDone = (task.depends_on ?? [])
    .map((id) => byId.get(id))
    .filter((t): t is CrewTask => !!t && t.status === "done");
  const injectNames = [
    ...upstreamDone.map((t) => t.title),
    ...actions.memory.slice(0, 3).map((m) => `共识 · ${m.text}`),
  ];

  return (
    <div className="ir-insp-body">
      {/* 为什么没开始 · 依赖链 */}
      <div className="ir-insp-reason">
        <div className="ir-insp-reason__k">{reasonHeading(visual, gateCount, task)}</div>
        {showChain && (
          <div className="ir-insp-chain">
            {chain.map((c, i) => {
              const t = byId.get(c.id);
              const label = t?.title ?? c.id;
              return (
                <span key={c.id} className="ir-insp-chain__seg">
                  {i > 0 && (
                    <span className="ir-insp-chain__arrow" aria-hidden="true">
                      <Chevron />
                    </span>
                  )}
                  {c.self ? (
                    <span className="ir-insp-chain__chip ir-insp-chain__chip--self">{label}（本任务）</span>
                  ) : c.isGate ? (
                    <span className="ir-insp-chain__chip ir-insp-chain__chip--gate">
                      <GateSeal tone={t ? gateVisual(t) : "active"} />
                      {label}
                    </span>
                  ) : (
                    <span className="ir-insp-chain__chip">
                      {t && <StateSeal visual={taskVisual(t, byId)} />}
                      {label} · {t ? statusWord(taskVisual(t, byId)) || "完成" : ""}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {executor}

      {/* 解锁即通知(预派即真:B3 预派 + unlocked) */}
      {waitingOnGate && (
        <div className="ir-insp-unlock">
          <Clock />
          <span className="ir-insp-unlock__t">
            “{blockingGate?.title ?? "上游评审"}”通过后自动解锁并通知你
          </span>
          <span className="ir-insp-unlock__pill">解锁时提醒我</span>
        </div>
      )}

      {/* 届时自动注入 */}
      {injectNames.length > 0 && (
        <div className="ir-insp-inject">
          <div className="ir-insp-inject__k">届时自动注入</div>
          <div className="ir-insp-chips">
            {injectNames.map((nm, i) => (
              <span key={i} className="ir-insp-chip" title={nm}>
                {nm}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default NodeInspectPopover;
