/**
 * TaskDrawer · 任务抽屉(480 右滑 240ms,画布压暗 6%)
 *   头(serif 标题 + 状态章 pill + 回频道 + ✕)/ 署名行(+改派)。
 *   主体产出先行(R3 §3j;可用性收束二批 §6 调整):
 *   ① 产物 —— 可交付时(非门 · running|rework)内置「交付区」交付面板:正文框=产物本身,
 *      上传文档纯前端读入(任意扩展名 → 内容判定为文本才收),提交即 vN+1(废除底部提交内联;
 *      节点/向导条「提交」→ 开抽屉聚焦此)
 *   → ② 验收标准(来源标 origin=channel/sop + 依据提示 + 可勾本机备忘)
 *   → ③ 执行过程(仅 Agent 任务 / 有历史 run;人任务与门整区隐藏,段号动态续)
 *   → ④ 元信息(沉底)。段号 sectionNumbers 动态编排(②③ 缺席顺次前移,元信息不跳号)。
 *   操作组随状态(drawerOps + withAgentRun 双按钮收敛);动作走 useTaskOps(DEV-1 前置校验
 *   + C5 友好错误)。零捏造:字段皆来自状态机 / run frames。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChannelMessage } from "../../../lib/api/crew";
import { sniffArtifactKind } from "../channel/artifactChip";
import { CrewMarkdown } from "../CrewMarkdown";
import type { CrewTask } from "../crewModel";
import { downstreamReviewGate, useTaskOps } from "./useTaskOps";
import { framesToTrace } from "./crewTrace";
import { fmtElapsed, hhmm } from "./format";
import { auditRefFor, latestArtifactVersion, taskRunRef } from "./helpers";
import { MemberAvatar, MemberName } from "./MemberBits";
import { MemberPicker } from "./MemberPicker";
import { StatusPill } from "./StateSeal";
import {
  ARTIFACT_BINARY_REJECT,
  criteriaSourceLabel,
  decodeTextFile,
  opsForTask,
  processSectionVisible,
  resolveConsensusHits,
  sectionNumbers,
  traceProgress,
  validateArtifactFile,
  type OpButton,
  type SectionNumbers,
} from "./inspectModel";
import { TraceLevels } from "./TraceLevels";
import type { InspectActions } from "./types";
import { taskVisual } from "../graph/graphMapping";
import { useRunFrames } from "./useRunFrames";

/** 序号徽(①产物=iris「1」· ②③④=灰) */
function NumBadge({ n, tone }: { n: number; tone: "iris" | "gray" }) {
  return <span className={`ir-insp-num ir-insp-num--${tone}`} aria-hidden="true">{n}</span>;
}

/** 下载 icon(产物卡 · 阅读器共用语汇) */
function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4.5 19.5h15" />
    </svg>
  );
}
/** 全幅阅读 icon(扩展) */
function ExpandIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" />
    </svg>
  );
}
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** 产物 chip 上抛(C4;缺省 no-op 保 W1 独立编译) */
export interface ReaderHooks {
  onOpenReader?: (ref: { taskId: string; version?: number }) => void;
  onDownload?: (ref: { taskId: string; version?: number }) => void;
}

/* ---------------- icons ---------------- */

function CloseX() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
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
function FileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3.5h7L19 8.5v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
      <path d="M13.5 3.5v5.5H19" />
    </svg>
  );
}

/** 验收标准拆行(单串 → 多勾选行;换行 / 分号 / 斜杠分隔;皆空 → []) */
function splitCriteria(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|;|；/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* 验收标准勾选 · 本机评审备忘(不上报服务端,零捏造:勾是"我核过",不是状态) */
const AC_KEY = (taskId: string) => `crew-ac-check:${taskId}`;

function loadAcChecks(taskId: string, count: number): boolean[] {
  try {
    const raw = localStorage.getItem(AC_KEY(taskId));
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(arr)) return Array.from({ length: count }, (_, i) => arr[i] === true);
  } catch {
    /* 本机备忘,坏了就当没勾 */
  }
  return Array.from({ length: count }, () => false);
}

function saveAcChecks(taskId: string, checks: boolean[]): void {
  try {
    localStorage.setItem(AC_KEY(taskId), JSON.stringify(checks));
  } catch {
    /* 存不了也不打扰 */
  }
}

export interface TaskDrawerProps extends ReaderHooks {
  task: CrewTask;
  tasks: CrewTask[];
  channel: ChannelMessage[];
  actions: InspectActions;
}

export function TaskDrawer({ task, tasks, channel, actions, onOpenReader, onDownload }: TaskDrawerProps) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const visual = taskVisual(task, byId);
  const ops = useTaskOps(task, tasks, byId, actions);

  // ① 交付区(内联于产物区):产物正文草稿 + 上传读入态(纯前端 FileReader)
  const deliverRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);

  // Esc:抽屉内 textarea(交付区)聚焦时先失焦(不误关抽屉);改派浮层自理;否则关抽屉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ops.pickerOpen) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) {
        active.blur();
        return;
      }
      actions.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actions, ops.pickerOpen]);

  const assignee = task.assignee_member_id
    ? actions.members.find((m) => m.id === task.assignee_member_id) ?? null
    : null;
  const audit = auditRefFor(task, channel);

  // meta 行:依赖(上游 done)✓ · 下游门 ◇ · 提交时刻
  const upstreamDone = (task.depends_on ?? [])
    .map((id) => byId.get(id))
    .filter((t): t is CrewTask => !!t && t.status === "done");
  const gate = downstreamReviewGate(task, tasks);
  const versions = [...(task.artifact_versions ?? [])].sort((a, b) => b.version - a.version);
  const submittedAt = versions.length ? hhmm(versions[0].submitted_at) : null;

  const criteria = splitCriteria(task.acceptance_criteria);
  // 门 → gateOps(只剩去评审;真机事故:门曾被 ready 分支误导认领/开始/提交);
  // 任务 → drawerOps + agent 双按钮收敛。
  const opButtons = opsForTask(task, visual, actions.members);

  // 交付区可见 = 与「底部曾出现『提交』」同条件(非门 · running|rework · 未被 agent「执行」替换)。
  const submittable = opButtons.some((b) => b.id === "submit");
  const nextVersion = versions.length + 1; // 提交即产物 v{N+1}(N=当前版本数)
  // ③ 执行过程只属 Agent 任务(有历史 run 也留);段号随 ②③ 缺席动态前移(元信息不跳号)。
  const hasProcess = processSectionVisible(task, actions.members, !!taskRunRef(task, channel));
  const nums: SectionNumbers = sectionNumbers({ hasCriteria: criteria.length > 0, hasProcess });

  // 门的「①产物」= 被评审 producer 的产物(评审视角:先读要审的东西)
  const producer = task.is_gate && task.reviews_task_id ? byId.get(task.reviews_task_id) ?? null : null;
  const artifactOwnerId = producer ? producer.id : task.id;
  const artifactVersions = producer
    ? [...(producer.artifact_versions ?? [])].sort((a, b) => b.version - a.version)
    : versions;

  // 验收标准勾选(本机评审备忘)
  const [acChecks, setAcChecks] = useState<boolean[]>(() => loadAcChecks(task.id, criteria.length));
  useEffect(() => {
    setAcChecks(loadAcChecks(task.id, criteria.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换任务/条数变才重载
  }, [task.id, criteria.length]);
  const toggleAc = (i: number) => {
    setAcChecks((prev) => {
      const next = prev.map((v, idx) => (idx === i ? !v : v));
      saveAcChecks(task.id, next);
      return next;
    });
  };

  // 换任务:清交付草稿/读入态;新任务可交付 → 下一帧聚焦交付区(让位抽屉入场动画)。
  useEffect(() => {
    setDraft("");
    setFileError(null);
    setLoadedName(null);
    if (!submittable) return;
    const id = requestAnimationFrame(() => deliverRef.current?.focus());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅换任务时重置 + 聚焦
  }, [task.id]);

  // 上传文档读入(纯前端 FileReader,内容判定):扩展名/体积前置过关 → 读 ArrayBuffer
  // → decodeTextFile(UTF-8 严格 + NUL 拒)能干净解码才 REPLACE 草稿 + 记文件名;
  // 二进制(解码失败)= 人话拒绝(二进制悄悄断 Agent grounding,诚实不收)。
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重选同一文件
    if (!file) return;
    const check = validateArtifactFile(file.name, file.size);
    if (!check.ok) {
      setFileError(check.message);
      setLoadedName(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result;
      const text = buf instanceof ArrayBuffer ? decodeTextFile(buf) : null;
      if (text == null) {
        setFileError(ARTIFACT_BINARY_REJECT);
        setLoadedName(null);
        return;
      }
      setDraft(text);
      setLoadedName(file.name);
      setFileError(null);
    };
    reader.onerror = () => {
      setFileError("读取失败，请重试");
      setLoadedName(null);
    };
    reader.readAsArrayBuffer(file);
  };

  // 底部「提交」= 滚动聚焦①区交付面板(交付区即产物区,不再往返开抽屉);其余 op 照走。
  const onFooterOp = (op: OpButton["id"]) => {
    if (op === "submit") {
      deliverRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      deliverRef.current?.focus();
      return;
    }
    ops.run(op);
  };

  return (
    <div className="ir-insp-drawer-layer" role="dialog" aria-label={`${task.title} · 任务抽屉`}>
      {/* 画布压暗 6% 背幕(点击关闭) */}
      <div className="ir-insp-scrim" onClick={actions.close} aria-hidden="true" />

      <aside className="ir-insp-drawer">
        {/* 头部 */}
        <div className="ir-insp-drawer__head">
          <div className="ir-insp-drawer__titlerow">
            <span className="ir-insp-drawer__title">{task.title}</span>
            <StatusPill visual={visual} />
            <span className="ir-insp-drawer__headright">
              <button type="button" className="ir-insp-chip" onClick={() => { actions.ring(task.id); actions.close(); }}>
                <Crosshair />回频道
              </button>
              <button type="button" className="ir-insp-x" aria-label="关闭" onClick={actions.close}>
                <CloseX />
              </button>
            </span>
          </div>

          {/* 署名行(门=评审人,不给改派——门是裁定席不是工位) */}
          {task.is_gate ? (
            <div className="ir-insp-drawer__sign">
              {(() => {
                const reviewer = actions.members.find((m) => m.id === actions.ownerUserId) ?? null;
                return reviewer ? (
                  <>
                    <MemberAvatar member={reviewer} isOwner size={22} />
                    <MemberName member={reviewer} />
                    <span className="ir-insp-sign__role">· 评审人</span>
                  </>
                ) : (
                  <span className="ir-insp-sign__unassigned">评审人 · 项目负责人</span>
                );
              })()}
            </div>
          ) : assignee ? (
            <div className="ir-insp-drawer__sign">
              <MemberAvatar member={assignee} isOwner={assignee.id === actions.ownerUserId} size={22} />
              <MemberName member={assignee} roleSuffix />
              <span className="ir-insp-sign__spacer" />
              <button type="button" className="ir-insp-chip" onClick={ops.openPicker}>改派</button>
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
          ) : (
            <div className="ir-insp-drawer__sign ir-insp-drawer__sign--none">
              <span className="ir-insp-sign__unassigned">未指派</span>
              <span className="ir-insp-sign__spacer" />
              <button type="button" className="ir-insp-chip" onClick={ops.openPicker}>指派</button>
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
          )}
        </div>

        {/* 主体(滚动)· 产出先行:①产物 → ②验收标准 → ③执行过程 → ④元信息 */}
        <div className="ir-insp-drawer__body">
          {/* ① 产物(默认展开,最新版;门=被评审 producer 的产物) */}
          <section className="ir-insp-sec">
            <div className="ir-insp-sec__hnum">
              <NumBadge n={nums.artifact} tone="iris" />
              <span className="ir-insp-sec__htitle">{task.is_gate ? "待评审产物" : "产物"}</span>
              {task.is_gate && producer ? (
                <span className="ir-insp-sec__tag">来自“{producer.title}”</span>
              ) : submittable ? (
                <span className="ir-insp-sec__tag ir-insp-sec__tag--iris">交付区</span>
              ) : (
                <span className="ir-insp-sec__tag ir-insp-sec__tag--iris">默认展开</span>
              )}
            </div>

            {/* 交付区(产物区即交付区):正文框=产物本身;上传文档读入(文本类);提交即 vN+1 */}
            {submittable && (
              <DeliveryPanel
                deliverRef={deliverRef}
                fileInputRef={fileInputRef}
                draft={draft}
                onDraft={setDraft}
                onPickFile={onPickFile}
                fileError={fileError}
                loadedName={loadedName}
                busy={ops.busy}
                nextVersion={nextVersion}
                onSubmit={() => ops.confirmSubmit(draft)}
              />
            )}

            {artifactVersions.length === 0 ? (
              <div className="ir-insp-empty-inline">
                {task.is_gate
                  ? `被评审任务尚未交付${producer ? `——等“${producer.title}”提交后再审` : ""}。`
                  : "尚无产物 —— 提交后在此列出版本。"}
              </div>
            ) : (
              <div className="ir-insp-arts">
                {artifactVersions.map((v, i) => (
                  <ArtifactVersionCard
                    key={v.version}
                    taskId={artifactOwnerId}
                    version={v.version}
                    content={v.content}
                    at={hhmm(v.submitted_at)}
                    defaultOpen={i === 0}
                    onOpenReader={onOpenReader}
                    onDownload={onDownload}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ② 验收标准(来源标 + 依据提示 + 可勾选本机评审备忘) */}
          {criteria.length > 0 && (
            <section className="ir-insp-sec">
              <div className="ir-insp-sec__hnum">
                <NumBadge n={nums.criteria ?? 2} tone="gray" />
                <span className="ir-insp-sec__htitle">验收标准</span>
                <span className="ir-insp-sec__tag">{criteriaSourceLabel(task.origin)}</span>
              </div>
              <div className="ir-insp-crit-basis">对照上方产物逐条核对 · 勾选仅本机备忘</div>
              <div className="ir-insp-crit">
                {criteria.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`ir-insp-crit__row${acChecks[i] ? " is-checked" : ""}`}
                    aria-pressed={acChecks[i] ?? false}
                    onClick={() => toggleAc(i)}
                  >
                    <span className="ir-insp-crit__box" aria-hidden="true">
                      {acChecks[i] && (
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      )}
                    </span>
                    {c}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ③ 执行过程(仅 Agent 任务 / 有历史 run;默认折叠 → 三级下钻) */}
          {hasProcess && (
            <section className="ir-insp-sec">
              <TraceSection task={task} channel={channel} actions={actions} num={nums.process ?? 3} />
            </section>
          )}

          {/* ④ 元信息(沉底) */}
          <section className="ir-insp-sec ir-insp-sec--meta">
            <div className="ir-insp-sec__hnum">
              <NumBadge n={nums.meta} tone="gray" />
              <span className="ir-insp-sec__htitle">元信息</span>
            </div>
            <div className="ir-insp-metagrid">
              {upstreamDone.length > 0 && (
                <span>依赖 · {upstreamDone.map((t) => t.title).join("、")} ✓</span>
              )}
              {gate && <span>下游 · {gate.title} ◇</span>}
              {submittedAt && <span>提交 {submittedAt}</span>}
              {!task.is_gate && <span>改派 · 可</span>}
              {task.is_gate && <span>评审 · 通过或驳回</span>}
            </div>
          </section>
        </div>

        {/* 操作组(随状态)· 提交 → 滚动聚焦①区交付面板(不再有底部提交内联) */}
        <div className="ir-insp-drawer__foot">
          <DrawerActions buttons={opButtons} busy={ops.busy} onOp={onFooterOp} />
          <span className="ir-insp-drawer__foothint">操作随状态变化</span>
        </div>
        {ops.error && <div className="ir-insp-err ir-insp-err--drawer">{ops.error}</div>}
      </aside>
    </div>
  );
}

/* ---------------- 产物版本卡(展开 / 全幅阅读 / 下载) ---------------- */

/** 字数(去空白字符数;来自真实产物内容,零捏造)。 */
function contentChars(s: string): number {
  return (s ?? "").replace(/\s+/g, "").length;
}

function ArtifactVersionCard({
  taskId,
  version,
  content,
  at,
  defaultOpen = false,
  onOpenReader,
  onDownload,
}: {
  taskId: string;
  version: number;
  content: string;
  at: string | null;
  defaultOpen?: boolean;
} & ReaderHooks) {
  const [open, setOpen] = useState(defaultOpen);
  const chars = contentChars(content);
  // 全幅阅读:有 onOpenReader → 上抛阅读器(C4);缺省退化为内嵌展开(保 W1 独立编译)
  const openReader = () => (onOpenReader ? onOpenReader({ taskId, version }) : setOpen(true));
  return (
    <div className="ir-insp-art">
      <div className="ir-insp-art__row">
        <span className="ir-insp-art__icon" aria-hidden="true"><FileIcon /></span>
        <span className="ir-insp-art__title">产物</span>
        <span className="ir-insp-art__ver">v{version}</span>
        <span className="ir-insp-art__meta">
          {chars.toLocaleString()} 字{at ? ` · ${at}` : ""}
        </span>
        <span className="ir-insp-art__spacer" />
        <button type="button" className="ir-insp-chip ir-insp-art__preview" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开"}
        </button>
        <button type="button" className="ir-insp-art__read" onClick={openReader}>
          <ExpandIcon />全幅阅读
        </button>
        {onDownload && (
          <button type="button" className="ir-insp-art__dl" aria-label="下载" title="下载 .md" onClick={() => onDownload({ taskId, version })}>
            <DownloadIcon />
          </button>
        )}
      </div>
      {open && (
        <div className="ir-insp-art__body">
          {sniffArtifactKind(content) === "html" ? (
            // HTML 产物内联展开 = 转义源码(CrewMarkdown 会吞标签);沉浸预览走「全幅阅读」沙箱。
            <div className="ir-insp-art__html">
              <div className="ir-insp-art__htmlhead">HTML 源码</div>
              <pre className="ir-insp-art__htmlsrc">{content}</pre>
            </div>
          ) : (
            <CrewMarkdown source={content} />
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- ③ 执行过程(默认折叠 → 三级 Trace / 留位) ---------------- */

function TraceSection({ task, channel, actions, num }: { task: CrewTask; channel: ChannelMessage[]; actions: InspectActions; num: number }) {
  const [open, setOpen] = useState(false);
  const runRef = taskRunRef(task, channel);
  const { frames } = useRunFrames(runRef, !!runRef);
  const trace = useMemo(() => framesToTrace(frames ?? []), [frames]);

  // 零帧留位:Agent 尚未执行(无 run_ref 或帧未到)→ 白话留位(黑话「现件留位」清除),不硬造过程。
  if (!runRef || trace.frameCount === 0) {
    return (
      <>
        <div className="ir-insp-sec__hnum">
          <NumBadge n={num} tone="gray" />
          <span className="ir-insp-sec__htitle">执行过程</span>
        </div>
        <div className="ir-insp-trace-empty">
          <span className="ir-insp-trace-empty__pill">待执行</span>
          <span className="ir-insp-trace-empty__note">Agent 开始执行后，这里会逐帧回放它的过程。</span>
        </div>
      </>
    );
  }

  const prog = traceProgress(trace.turns);
  const dur =
    trace.startedAtMs != null
      ? fmtElapsed(
          (trace.terminalStatus != null ? trace.endedAtMs ?? Date.now() : Date.now()) - trace.startedAtMs,
        )
      : null;
  const meta = `${prog.turnCount} 回合 · ${trace.frameCount} 步${dur ? ` · ${dur}` : ""}`;
  const hits = resolveConsensusHits(trace.memoryHits, actions.memory);

  return (
    <div className="ir-insp-proc">
      {/* ③ 折叠头行(整行可点;即点即开) */}
      <button
        type="button"
        className={`ir-insp-proc__row${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <NumBadge n={num} tone="gray" />
        <span className="ir-insp-sec__htitle">执行过程</span>
        <span className="ir-insp-proc__meta">{meta}</span>
        <span className="ir-insp-proc__chev"><Chevron open={open} /></span>
      </button>
      {!open ? (
        <div className="ir-insp-proc__caption">默认折叠 · 点开进三级下钻</div>
      ) : (
        <>
          <TraceLevels
            trace={trace}
            latestVersion={latestArtifactVersion(task)}
            onCollapse={() => setOpen(false)}
          />
          {hits.length > 0 && (
            <div className="ir-insp-hits">
              <div className="ir-insp-hits__k">注入共识 {hits.length} 条（命中入审计=溯源验收）：</div>
              <div className="ir-insp-chips">
                {hits.map((h) => (
                  <span key={h.id} className="ir-insp-chip ir-insp-chip--hit" title={h.text}>
                    [{h.kind}] {h.text}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- 操作组 + 提交内联 ---------------- */

function DrawerActions({ buttons, busy, onOp }: { buttons: OpButton[]; busy: boolean; onOp: (op: OpButton["id"]) => void }) {
  if (buttons.length === 0) return <span className="ir-insp-drawer__foothint">已完成 · 墨迹已干</span>;
  return (
    <>
      {buttons.map((b) => (
        <button
          key={b.id}
          type="button"
          className={`ir-insp-btn ir-insp-btn--${b.variant} ir-insp-btn--lg`}
          disabled={busy}
          onClick={() => onOp(b.id)}
        >
          {b.label}
        </button>
      ))}
    </>
  );
}

/* ---------------- ① 交付面板(产物区即交付区) ---------------- */

/** 上传 icon(读入文本类文档) */
function UploadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16.5v-11m0 0-4 4m4-4 4 4M4.5 19.5h15" />
    </svg>
  );
}

/**
 * 交付面板(用户二检「我在哪提交/输入框是干什么的/为什么不能上传/下游能不能读」;
 *   三检「为什么限制 md/txt」放开为文本类通吃):正文框=产物本身(markdown);
 *   上传文档纯前端读入(任意扩展名 → 内容判定,能干净解码为文本才收);提交即 vN+1。
 *   二进制(Word/PDF/图片)会悄悄断 Agent grounding → 诚实拒绝,直传记 P1(见 §6 全局裁决)。
 */
function DeliveryPanel({
  deliverRef,
  fileInputRef,
  draft,
  onDraft,
  onPickFile,
  fileError,
  loadedName,
  busy,
  nextVersion,
  onSubmit,
}: {
  deliverRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  draft: string;
  onDraft: (v: string) => void;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileError: string | null;
  loadedName: string | null;
  busy: boolean;
  nextVersion: number;
  onSubmit: () => void;
}) {
  return (
    <div className="ir-insp-deliver">
      <div className="ir-insp-deliver__label">交付区 · 下面写的就是产物本身（markdown）</div>
      <textarea
        ref={deliverRef}
        className="ir-insp-deliver__ta"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        placeholder="在此撰写或粘贴产物正文……"
        rows={5}
      />
      {fileError && <div className="ir-insp-deliver__err">{fileError}</div>}
      {loadedName && <div className="ir-insp-deliver__note">已读入 {loadedName}</div>}
      <div className="ir-insp-deliver__act">
        <button
          type="button"
          className="ir-insp-deliver__upload"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          title="读入文本类文档：markdown、html、纯文本等（Word、PDF、图片等二进制暂不支持）"
        >
          <UploadIcon />上传文档读入（文本类）
        </button>
        <input ref={fileInputRef} type="file" hidden onChange={onPickFile} />
        <span className="ir-insp-deliver__spacer" />
        <button
          type="button"
          className="ir-insp-btn ir-insp-btn--primary ir-insp-btn--lg"
          disabled={busy || draft.trim() === ""}
          onClick={onSubmit}
        >
          提交产物
        </button>
      </div>
      <div className="ir-insp-deliver__help">
        提交即产物 v{nextVersion}：评审人可全幅阅读，下游 Agent 起草时会自动读取
      </div>
    </div>
  );
}

export default TaskDrawer;
