/**
 * ReimbursementPage · Cowork 报销(审批卡 confirm/supplement + 附件 + 审计)— R6
 *
 * W4「审批卡通用化」的第一个真实落位。全链路真跑:
 *   输入(+真附件上传)→ SSE 流 → LoopCard;
 *   awaiting_approval → done{waiting_confirmation} → 取全 run → ApprovalCard(confirm 对账)→ approve/stream 续办(append);
 *   done{collecting} → ApprovalCard(supplement 补录)→ answers/stream 续办(append);
 *   reject(D-R6-1:回填 input_text)、verify 重试、查看审计、历史回看,全接真端点。
 *
 * 状态单一来源裁决(风险 §63):awaiting/collecting 并存以「最新 run.status」为准,别双卡同屏。
 *   tree.state(帧)在 awaiting 后被 done 覆写为 done,故卡态改由 run.status 决定;
 *   run 全量(approval/missing_fields)不在归一化 RunSummary 里 → 流关后按 runId 取 run(R4 完成再取模式)。
 *   awaiting 帧到 done 帧之间(running 中,run 未到手)→ 只渲染骨架标题,禁放假字段(风险 §62)。
 *
 * 诚实纪律:审批卡字段 = draft_snapshot 真值;risk chip = risk_level 直通;payload 原文一字不改;
 *   零假数据;失败卡传 onAudit(报销有真审计端点)+ onCopyError,不传 onResume(无断点续跑通道)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { AgentComposer } from "../../components/agent/AgentComposer";
import { AgentSessionHeader } from "../../components/agent/AgentSessionHeader";
import { ApprovalCard } from "../../components/agent/ApprovalCard";
import { LoopCard, type LoopState } from "../../components/agent/LoopCard";
import { StateNote } from "../../components/anna/StateNote";
import { createNormalizer } from "../../lib/api/normalize";
import { usePersona } from "../../lib/persona";
import {
  getAudit,
  getRun,
  listRuns,
  rejectApproval,
  streamAnswers,
  streamApprove,
  streamReimbursementRun,
  verifyReimbursement,
  type AttachmentRef,
} from "../../lib/api/reimbursement";
import { planProgress } from "../../lib/plan";
import { DEFAULT_TOOL_LABELS, reduceTurns, type RunTree, type ToolLabels } from "../../lib/turns";
import { useRunStream } from "../chat/useRunStream";
import { confirmProps, supplementProps } from "./approvalView";
import { AttachmentPicker } from "./AttachmentPicker";
import { dashboardFailKind } from "./snapshotView";
import "./ReimbursementPage.css";

type Run = Record<string, unknown>;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const rec = (v: unknown): Run => (v !== null && typeof v === "object" ? (v as Run) : {});

/** 报销 10 工具 → L2 步骤中文标签(step.intent 已由 B0 humanize;此为工具步兜底)。 */
const REIMB_TOOL_LABELS: ToolLabels = {
  ...DEFAULT_TOOL_LABELS,
  "reimbursement.get_capabilities": "确认报销能力",
  "reimbursement.get_policy": "核对报销政策",
  "reimbursement.validate_draft": "校验报销单据",
  "reimbursement.create_draft": "创建报销单据",
  "reimbursement.submit_intent": "提交报销审批",
  "reimbursement.submit": "提交报销",
  "reimbursement.get_status": "查询报销状态",
};

/* 历史回看:run.audit_events → raw 帧(+ awaiting/done 终帧)→ 归一化(与 R4 historyFrames 同路)。 */
function rawFramesFromRun(run: Run): Run[] {
  const evs = Array.isArray(run.audit_events) ? (run.audit_events as Run[]) : [];
  const raws: Run[] = evs.map((e) => ({ type: "event", event: e }));
  if (str(run.status) === "waiting_confirmation" && run.approval) {
    raws.push({ type: "awaiting_approval", reason: "awaiting_approval", detail: { approval_id: str(rec(run.approval).id) } });
  }
  raws.push({ type: "done", run });
  return raws;
}

/** run.status → 卡态阶段(单一来源裁决)。neutral = 草稿已就绪但未提交(含驳回后 draft_created):中性回看,不庆祝。 */
type Phase = "running" | "loading-run" | "awaiting-skeleton" | "confirm" | "supplement" | "verify" | "done" | "neutral" | "error";

const STATUS_DOT: Record<string, string> = {
  completed: "ok",
  waiting_confirmation: "await",
  collecting: "await",
  verify_pending: "await",
  draft_created: "run",
  failed: "fail",
};

const consumedText = (tokens: number | null | undefined): string | undefined =>
  tokens != null ? `已消耗 ~${tokens.toLocaleString()} tokens` : undefined;

interface AuditView {
  runId: string;
  events: { type: string; created_at: string; payload: Run }[];
}

export function ReimbursementPage() {
  const runStream = useRunStream(REIMB_TOOL_LABELS);
  const { persona } = usePersona();

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string>("");
  const [latestRun, setLatestRun] = useState<Run | null>(null);
  const [viewingRun, setViewingRun] = useState<Run | null>(null);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectedNote, setRejectedNote] = useState(false);
  const [dismissedSupplement, setDismissedSupplement] = useState<Set<string>>(new Set());
  const fetchedRef = useRef<string>("");

  /* 历史 + 未连接裁决数据源:listRuns(倒序,含完整 run) */
  const refreshRuns = useCallback(async (): Promise<Run[]> => {
    try {
      const list = await listRuns();
      setRuns(list);
      setRunsError(null);
      return list;
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : String(e));
      setRuns([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  /* 流关(running→false 且到达终态)后取全 run:approval/missing_fields 不在 RunSummary 里。
   * I-2(a):用户主动 stop() 不是终态,是断流 —— 不追取/不用刚取到的 run 覆写现场,
   * 否则会把一次「已停止」误判为某个陈旧/在办 run 的终态,进而在 phase 链落到未知分支。 */
  useEffect(() => {
    const st = runStream.tree.state;
    if (runStream.running || runStream.stopped || st === "idle") return;
    if (viewingRun) return; // 回看态不追取
    const key = `${st}:${runStream.tree.run?.runId ?? ""}:${runStream.frames.length}`;
    if (fetchedRef.current === key) return;
    fetchedRef.current = key;
    void (async () => {
      const list = await refreshRuns();
      const hinted = runStream.tree.run?.runId;
      const run = (hinted && list.find((r) => str(r.id) === hinted)) || list[0] || null;
      if (run) {
        setActiveRunId(str(run.id));
        setLatestRun(run);
      }
    })();
  }, [
    runStream.running,
    runStream.stopped,
    runStream.tree.state,
    runStream.tree.run?.runId,
    runStream.frames.length,
    viewingRun,
    refreshRuns,
  ]);

  /* ---------------- 通路 ---------------- */

  const startCreate = useCallback(() => {
    const text = draft.trim();
    if (!text || runStream.running) return;
    const atts = attachments;
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    setViewingRun(null);
    setRejectedNote(false);
    setAudit(null);
    setLatestRun(null);
    setActiveRunId("");
    fetchedRef.current = "";
    void runStream.start((signal) => streamReimbursementRun(text, atts, signal));
  }, [draft, attachments, runStream]);

  /** confirm 提交 / supplement 提交:approve|answers/stream RESUME,append 拼到同一时间线。 */
  const resume = useCallback(
    (runId: string, open: (signal: AbortSignal) => Promise<Response>) => {
      const append = !viewingRun && activeRunId === runId;
      setViewingRun(null);
      setRejectedNote(false);
      setAudit(null);
      setActiveRunId(runId);
      fetchedRef.current = "";
      void runStream.start(open, { append });
    },
    [viewingRun, activeRunId, runStream],
  );

  const onConfirm = useCallback(
    (runId: string, approvalId: string) => resume(runId, (s) => streamApprove(approvalId, s)),
    [resume],
  );

  const onSupplement = useCallback(
    (runId: string, values: Record<string, string>) => {
      // 只提交填写了的字段(空值不入,避免覆盖已有草稿)
      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v.trim() !== "") answers[k] = v.trim();
      resume(runId, (s) => streamAnswers(runId, answers, s));
    },
    [resume],
  );

  /** D-R6-1 返回修改:reject(真动作)+ 回填原 input_text + 明示「已驳回」。 */
  const onReject = useCallback(
    async (runId: string, approvalId: string, inputText: string) => {
      setBusy(true);
      try {
        await rejectApproval(approvalId);
        const list = await refreshRuns();
        setLatestRun(list.find((r) => str(r.id) === runId) ?? null);
        setActiveRunId(runId);
        setViewingRun(null);
        setDraft(inputText);
        setRejectedNote(true);
      } catch (e) {
        setAttachError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refreshRuns],
  );

  const onVerify = useCallback(
    async (runId: string) => {
      setBusy(true);
      try {
        const updated = await verifyReimbursement(runId);
        const list = await refreshRuns();
        setLatestRun(list.find((r) => str(r.id) === runId) ?? updated);
        setActiveRunId(runId);
        setViewingRun(null);
      } catch (e) {
        setAttachError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refreshRuns],
  );

  const onAudit = useCallback(async (runId: string) => {
    try {
      const res = await getAudit(runId);
      const events = Array.isArray(res.audit_events) ? (res.audit_events as Run[]) : [];
      setAudit({
        runId,
        events: events.map((e) => ({ type: str(e.type), created_at: str(e.created_at), payload: rec(e.payload) })),
      });
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const viewHistory = useCallback(async (run: Run) => {
    // 取全 run(list 已含全量,但审计/最新态以详情为准)
    setAudit(null);
    setRejectedNote(false);
    try {
      const full = await getRun(str(run.id));
      setViewingRun(full);
    } catch {
      setViewingRun(run);
    }
  }, []);

  const exitHistory = useCallback(() => {
    setViewingRun(null);
    setAudit(null);
  }, []);

  const copyError = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  /* ---------------- 视图模型 ---------------- */

  const isLive = !viewingRun;
  const focusRun = viewingRun ?? latestRun;

  const historyTree = useMemo<RunTree | null>(() => {
    if (!viewingRun) return null;
    const norm = createNormalizer();
    const frames = rawFramesFromRun(viewingRun).flatMap((r) => norm(r as Parameters<typeof norm>[0]));
    return reduceTurns(frames, REIMB_TOOL_LABELS);
  }, [viewingRun]);

  const tree = viewingRun ? (historyTree as RunTree) : runStream.tree;
  const running = isLive && runStream.running;
  const status = str(focusRun?.status);

  const phase: Phase = running
    ? "running"
    : tree.state === "error" || status === "failed"
      ? "error"
      : status === "waiting_confirmation"
        ? "confirm"
        : status === "collecting"
          ? "supplement"
          : status === "verify_pending"
            ? "verify"
            : status === "completed"
              ? "done"
              : status === "draft_created"
                ? "neutral" // 驳回后 / 未提交:草稿在,但从未提交 —— 不能庆祝(诚实纪律)
                : status === "validating" || status === "submitting" || status === "verifying"
                  ? "running" // I-2(c):后端处理中间态(可能见于历史回看)—— 冻结「运行中」呈现,不臆造终态
                  : isLive && !focusRun && (tree.state === "done" || tree.state === "awaiting")
                    ? "loading-run"
                    : tree.state === "done"
                      ? "neutral" // 未知终态:中性回看,不臆造「办妥」
                      : tree.state === "awaiting"
                        ? "awaiting-skeleton"
                        : "running";

  // I-2(b):started = 已有可示内容(帧或历史 run),与 phase 落到哪个分支无关。
  // 旧式 `running || phase !== "running" ? … : false` 会在「stop() 后 phase 落回兜底
  // running」这一支把已产生的轨迹连同「已停止」提示一并误判为「从未开始」而卸载。
  const started = tree.state !== "idle" || !!focusRun;

  const cardState: LoopState =
    phase === "running"
      ? "running"
      : phase === "error"
        ? "error"
        : phase === "done" || phase === "verify" || phase === "neutral"
          ? "done" // done=礼成(有 ceremony);verify/neutral=素回看(无 ceremony)
          : "awaiting"; // confirm / supplement / awaiting-skeleton / loading-run

  const plan = planProgress(tree.plan);
  const runId = str(focusRun?.id) || tree.run?.runId || "";
  const approval = rec(focusRun?.approval);
  const draftObj = rec(focusRun?.draft);
  const agentMessage = str(focusRun?.agent_message);

  // I-2(b):stopped 优先于 running/phase 判断,呈现与 ChatPage 一致的「已停止」头状态(诚实纪律 ——
  // 断流后不再谎称「正在为您办理」)。
  const statusText =
    runStream.stopped && isLive
      ? "已停止"
      : running
        ? `正在为您办理 · ${runStream.elapsedText}`
        : phase === "confirm"
          ? "等您示下"
          : phase === "supplement"
            ? "请您补充"
            : phase === "verify"
              ? "已提交，待回读校验"
              : phase === "done"
                ? "都办妥了"
                : phase === "neutral"
                  ? "草稿已就绪"
                  : phase === "error"
                    ? "这一步没有办成"
                    : "正在为您办理";

  const nowIntent =
    phase === "confirm"
      ? "提交前需要您确认"
      : phase === "supplement"
        ? "请您补充"
        : phase === "error"
          ? tree.nowIntent
            ? `${tree.nowIntent}，未能完成`
            : "未能完成"
          : tree.nowIntent;

  const ceremony =
    phase === "done" // 礼成仅当真办妥(completed);verify/neutral 不庆祝
      ? {
          momentCount: tree.turns.reduce((n, t) => n + t.steps.length, 0),
          planText: plan ? `计划 ${plan.done}/${plan.total}` : undefined,
          usageText:
            [runStream.usageText, isLive ? runStream.elapsedText : undefined].filter(Boolean).join(" · ") || undefined,
        }
      : undefined;

  const failure =
    phase === "error"
      ? {
          consumedText: consumedText(tree.error?.consumedTokens),
          onAudit: () => void onAudit(runId),
          onCopyError: () => copyError(tree.error?.message ?? ""),
          // onResume 不传:报销无断点续跑通道(补录/审批各有真通路);↻ 以 CSS 隐藏
        }
      : undefined;

  const confirm = phase === "confirm" ? confirmProps(focusRun) : null;
  const supplementDismissedForRun = dismissedSupplement.has(runId);
  const supplement = phase === "supplement" && !supplementDismissedForRun ? supplementProps(focusRun) : null;
  const doneExternalId = str(draftObj.external_reimbursement_id);
  const doneExternalStatus = str(draftObj.external_status);

  /* ---------------- 渲染 ---------------- */

  const composerZone = (
    <div className="ir-r6__composer-zone">
      {attachError && <StateNote kind="error" text={attachError} />}
      <AttachmentPicker
        attachments={attachments}
        onAdd={(ref) => {
          setAttachError(null);
          setAttachments((a) => (a.some((x) => x.uri === ref.uri) ? a : [...a, ref]));
        }}
        onRemove={(uri) => setAttachments((a) => a.filter((x) => x.uri !== uri))}
        onError={setAttachError}
        disabled={runStream.running}
      />
      <AgentComposer
        value={draft}
        onChange={setDraft}
        onSend={startCreate}
        running={runStream.running}
        onStop={runStream.stop}
        placeholder="把报销事项告诉 Anna，可附发票"
        footnote="Enter 发送 · Shift+Enter 换行 · 报销单据将提交至企业报销系统，提交前请您过目"
      />
      {rejectedNote && (
        <p className="ir-r6__reject-note">已驳回，可修改后重新提交。原始事由已回填，请您过目。</p>
      )}
    </div>
  );

  return (
    <div className="ir-r6">
      <div className="ir-r6__scroll">
        <div className="ir-r6__col">
          <header className="ir-r6__head">
            <div className="ir-r6__eyebrow">COWORK · HIKER · 报销</div>
            <div className="ir-r6__head-row">
              <span className="ir-r6__title">报销 · 审批直办</span>
              {viewingRun && (
                <button type="button" className="ir-r6__back" onClick={exitHistory}>
                  ← 返回当前
                </button>
              )}
            </div>
          </header>

          {!viewingRun && composerZone}

          {/* 运行现场 / 卡态 */}
          {started && focusRunOrLive(phase, focusRun, tree) && (
            <>
              <AgentSessionHeader statusText={statusText} tone={phase === "error" ? "error" : "default"} />

              {agentMessage.trim() && (phase === "confirm" || phase === "supplement" || phase === "done" || phase === "verify") && (
                <div className="ir-r6__agent-msg">
                  <span className="ir-r6__agent-msg-label">Anna</span>
                  <div className="ir-r6__agent-msg-body">
                    <ReactMarkdown>{agentMessage}</ReactMarkdown>
                  </div>
                </div>
              )}

              <div
                className={[
                  "ir-r6__run",
                  phase === "error" ? "ir-r6__run--fail" : "",
                  runStream.stopped && isLive ? "ir-r6__run--stopped" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <LoopCard
                  state={cardState}
                  nowIntent={nowIntent}
                  elapsedText={isLive ? runStream.elapsedText : undefined}
                  turns={tree.turns}
                  plan={plan}
                  usageText={isLive ? runStream.usageText : undefined}
                  persona={persona}
                  onLoadFull={undefined}
                  ceremony={ceremony}
                  failure={failure}
                  approvalSlot={
                    confirm ? (
                      <div className="ir-r6__approval-slot">
                        <ApprovalCard
                          {...confirm}
                          onConfirm={() => onConfirm(runId, str(approval.id))}
                          onRevise={() => void onReject(runId, str(approval.id), str(focusRun?.input_text))}
                          reviseLabel="返回修改"
                        />
                      </div>
                    ) : phase === "awaiting-skeleton" ? (
                      <div className="ir-r6__approval-slot">
                        <div className="ir-r6__skeleton">正在载入审批详情……</div>
                      </div>
                    ) : undefined
                  }
                />
              </div>

              {runStream.stopped && isLive && <p className="ir-r6__stopped">已停止 · 已产生的过程保留</p>}

              {phase === "loading-run" && <StateNote kind="loading" text="正在载入运行结果" />}

              {/* 补录(卡外) */}
              {supplement && (
                <div className="ir-r6__supplement">
                  <ApprovalCard
                    {...supplement}
                    onConfirm={(values) => onSupplement(runId, values ?? {})}
                    onRevise={() =>
                      setDismissedSupplement((s) => new Set(s).add(runId))
                    }
                    reviseLabel="稍后再说"
                    confirmLabel="提交补充"
                  />
                </div>
              )}

              {/* 成功正文 + verify 重试 */}
              {(phase === "done" || phase === "verify") && (doneExternalId || phase === "verify") && (
                <div className="ir-r6__done-detail">
                  {phase === "done" && (
                    <p className="ir-r6__done-line">
                      都办妥了。单据{" "}
                      {doneExternalId && <span className="ir-r6__mono">{doneExternalId}</span>} 已提交
                      {doneExternalStatus && <> · 状态 <span className="ir-r6__mono">{doneExternalStatus}</span></>}
                      ，回读校验通过。
                    </p>
                  )}
                  {phase === "verify" && (
                    <div className="ir-r6__verify-row">
                      <p className="ir-r6__done-line">
                        单据{" "}
                        {doneExternalId && <span className="ir-r6__mono">{doneExternalId}</span>} 已提交，回读校验尚未通过。
                      </p>
                      <button type="button" className="ir-r6__verify-btn" disabled={busy} onClick={() => void onVerify(runId)}>
                        重试回读校验
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 中性态(草稿已就绪 / 驳回后 draft_created):不庆祝,如实说明 */}
              {phase === "neutral" && (
                <p className="ir-r6__done-line">
                  报销草稿已就绪
                  {doneExternalId && <> · 单据 <span className="ir-r6__mono">{doneExternalId}</span></>}
                  ，尚未提交审批。
                </p>
              )}

              {/* verify 类失败(已提交)另给重试 */}
              {phase === "error" && focusRun?.write_action != null && (
                <div className="ir-r6__verify-row">
                  <button type="button" className="ir-r6__verify-btn" disabled={busy} onClick={() => void onVerify(runId)}>
                    重试回读校验
                  </button>
                </div>
              )}
            </>
          )}

          {/* 审计面板 */}
          {audit && (
            <div className="ir-r6-audit">
              <div className="ir-r6-audit__head">
                <span className="ir-r6-audit__title">审计 · {audit.runId}</span>
                <button type="button" className="ir-r6-audit__close" aria-label="关闭审计" onClick={() => setAudit(null)}>
                  ✕
                </button>
              </div>
              {audit.events.length === 0 ? (
                <StateNote kind="empty" text="该运行暂无审计事件" />
              ) : (
                <ol className="ir-r6-audit__list">
                  {audit.events.map((e, i) => (
                    <li key={i} className="ir-r6-audit__row">
                      <span className="ir-r6-audit__type">{e.type}</span>
                      <span className="ir-r6-audit__time">{e.created_at}</span>
                      {Object.keys(e.payload).length > 0 && (
                        <pre className="ir-r6-audit__payload">{JSON.stringify(e.payload, null, 2)}</pre>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {/* 历史 run 列表 */}
          <section className="ir-r6-hist">
            <div className="ir-r6-hist__label">历史报销</div>
            {runsError ? (
              dashboardFailKind(undefined, runsError) === "offline" ? (
                <StateNote kind="offline" text="报销服务未连接 · 接通后这里显示真实单据，不做演示数据" />
              ) : (
                <StateNote kind="error" text={runsError} />
              )
            ) : runs === null ? (
              <StateNote kind="loading" text="正在装载报销记录" />
            ) : runs.length === 0 ? (
              <StateNote kind="empty" text="还没有报销记录；从上方发起第一笔" />
            ) : (
              <div className="ir-r6-hist__list">
                {runs.map((r) => (
                  <button
                    key={str(r.id)}
                    type="button"
                    className={`ir-r6-hist__row${str(r.id) === runId && !isLive ? " ir-r6-hist__row--on" : ""}`}
                    onClick={() => void viewHistory(r)}
                  >
                    <span className={`ir-r6-hist__dot ir-r6-hist__dot--${STATUS_DOT[str(r.status)] ?? "run"}`} />
                    <span className="ir-r6-hist__msg">{str(r.input_text) || "（空）"}</span>
                    <span className="ir-r6-hist__status">{str(r.status)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** started 且有可渲染内容(实时树非空 或 有 run 对象)。 */
function focusRunOrLive(phase: Phase, focusRun: Run | null, tree: RunTree): boolean {
  return phase === "running" || phase === "loading-run" || phase === "awaiting-skeleton" || !!focusRun || tree.turns.length > 0;
}

export default ReimbursementPage;
