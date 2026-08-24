/**
 * SlideOverCopilot · Hiker 滑出副驾(容器 B)— R5 Task 3
 *
 * 右侧滑出 420px,全站唯一玻璃(backdrop-filter blur 24),压在被挤压的看板上。
 * 内部 = AgentSessionHeader(小)+ 问题回声 + LoopCard(窄容器 <560 自动降级,
 * container query 由 .loop-host 承担,勿 JS 测宽)+ 答案正文 + AgentComposer。
 *
 * 数据流:open 时把注入的 question 直接发起 assistant 流(用户免重打);后续追问走 composer。
 * 独立 useRunStream 实例(与看板刷新互不干扰);关闭 = 运行中则 stop + 收起(过程保留,重开可见)。
 *
 * 诚实纪律:B0 后 Hiker assistant 有真 step 帧;失败/未连接由归一化收敛为 error 帧,
 * 帧驱动如实呈现;副驾无 resume/audit 通道 → 失败动作条仅「复制错误」(其余以 CSS 隐藏,不改包源码)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { AgentComposer } from "../../components/agent/AgentComposer";
import { AgentSessionHeader } from "../../components/agent/AgentSessionHeader";
import { LoopCard, type LoopState } from "../../components/agent/LoopCard";
import { streamHikerAssistant } from "../../lib/api/hiker";
import { usePersona } from "../../lib/persona";
import { planProgress } from "../../lib/plan";
import { DEFAULT_TOOL_LABELS } from "../../lib/turns";
import { useRunStream } from "../chat/useRunStream";
import "./SlideOverCopilot.css";

export type CopilotTarget = "hiker";

export interface SlideOverCopilotProps {
  open: boolean;
  /** 注入的追问文本(open 时自动发起) */
  question: string;
  target: CopilotTarget;
  onClose: () => void;
}

const consumedText = (tokens: number | null | undefined): string | undefined =>
  tokens != null ? `已消耗 ~${tokens.toLocaleString()} tokens` : undefined;

export function SlideOverCopilot({ open, question, target, onClose }: SlideOverCopilotProps) {
  const stream = useRunStream(DEFAULT_TOOL_LABELS);
  const { persona } = usePersona();
  const [activeQuestion, setActiveQuestion] = useState("");
  const [draft, setDraft] = useState("");
  const firedKeyRef = useRef("");

  const fire = useCallback(
    (q: string) => {
      setActiveQuestion(q);
      void stream.start((signal) => streamHikerAssistant(q, signal));
    },
    [stream],
  );

  // open + 注入问题 → 自动发起(同问题不重发;换问题重发)
  useEffect(() => {
    if (!open || !question.trim()) return;
    const key = `${target}|${question}`;
    if (firedKeyRef.current === key) return;
    firedKeyRef.current = key;
    fire(question);
  }, [open, question, target, fire]);

  const onSend = useCallback(() => {
    const q = draft.trim();
    if (!q || stream.running) return;
    setDraft("");
    firedKeyRef.current = `${target}|${q}`;
    fire(q);
  }, [draft, stream.running, target, fire]);

  const handleClose = useCallback(() => {
    if (stream.running) stream.stop(); // 运行中才断流;已完成保留终态
    onClose();
  }, [stream, onClose]);

  const copyError = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  const { tree } = stream;
  const started = !!activeQuestion;
  const cardState: LoopState = tree.state === "idle" ? "running" : (tree.state as LoopState);
  const isError = tree.state === "error";
  const isDone = tree.state === "done";
  const plan = planProgress(tree.plan);

  const statusText = stream.stopped
    ? "已停止"
    : cardState === "running"
      ? `正在为您办理 · ${stream.elapsedText}`
      : isDone
        ? "已办妥"
        : "这一步没有办成";

  const nowIntent = isError
    ? tree.nowIntent
      ? `${tree.nowIntent}，未能完成`
      : "未能完成"
    : tree.nowIntent;

  const ceremony = isDone
    ? {
        momentCount: tree.turns.reduce((n, t) => n + t.steps.length, 0),
        planText: plan ? `计划 ${plan.done}/${plan.total}` : undefined,
        usageText: [stream.usageText, stream.elapsedText].filter(Boolean).join(" · ") || undefined,
      }
    : undefined;

  const failure = isError
    ? {
        consumedText: consumedText(tree.error?.consumedTokens),
        onCopyError: () => copyError(tree.error?.message ?? ""),
        // 无 resume/audit 通道 → 以 .ir-copilot__run CSS 隐藏包内多余按钮
      }
    : undefined;

  return (
    <aside
      className={`ir-copilot${open ? " ir-copilot--open" : ""}`}
      aria-hidden={open ? undefined : true}
      inert={!open}
      aria-label="向 Anna 追问"
    >
      <div className="ir-copilot__glass">
        <div className="ir-copilot__head">
          <AgentSessionHeader statusText={statusText} tone={isError ? "error" : "default"} />
          <button type="button" className="ir-copilot__close" aria-label="关闭" onClick={handleClose}>
            ✕
          </button>
        </div>

        <div className="ir-copilot__scroll">
          {activeQuestion && (
            <div className="ir-copilot__query">
              <span className="ir-copilot__query-label">问</span>
              <span className="ir-copilot__query-text">{activeQuestion}</span>
            </div>
          )}

          {started && (
            <div className={`ir-copilot__run${isError ? " ir-copilot__run--fail" : ""}`}>
              <LoopCard
                state={cardState}
                nowIntent={nowIntent}
                elapsedText={stream.elapsedText}
                turns={tree.turns}
                plan={plan}
                usageText={stream.usageText}
                persona={persona}
                onLoadFull={undefined}
                ceremony={ceremony}
                failure={failure}
              />
            </div>
          )}

          {stream.stopped && <p className="ir-copilot__stopped">已停止 · 已产生的过程保留</p>}

          {isDone && tree.answerText.trim() && (
            <div className="ir-copilot__answer">
              <ReactMarkdown>{tree.answerText}</ReactMarkdown>
            </div>
          )}
        </div>

        <div className="ir-copilot__composer">
          <AgentComposer
            value={draft}
            onChange={setDraft}
            onSend={onSend}
            running={stream.running}
            onStop={stream.stop}
            ctxPercent={stream.ctxPercent}
            placeholder="继续追问这份看板……"
            footnote=""
          />
        </div>
      </div>
    </aside>
  );
}

export default SlideOverCopilot;
