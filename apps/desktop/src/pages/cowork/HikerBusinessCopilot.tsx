import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { AgentComposer } from "../../components/agent/AgentComposer";
import { AgentSessionHeader } from "../../components/agent/AgentSessionHeader";
import { LoopCard } from "../../components/agent/LoopCard";
import { streamHikerAssistant } from "../../lib/api/hiker";
import { DEFAULT_TOOL_LABELS } from "../../lib/turns";
import { planProgress } from "../../lib/plan";
import { usePersona } from "../../lib/persona";
import { useRunStream } from "../chat/useRunStream";

export function HikerBusinessCopilot({
  open,
  question,
  onClose,
  onOrdinary,
}: {
  open: boolean;
  question: string;
  onClose: () => void;
  onOrdinary: () => void;
}) {
  const stream = useRunStream(DEFAULT_TOOL_LABELS);
  const { persona } = usePersona();
  const [activeQuestion, setActiveQuestion] = useState("");
  const [draft, setDraft] = useState("");
  const firedKeyRef = useRef("");

  const fire = useCallback((text: string) => {
    setActiveQuestion(text);
    void stream.start((signal) => streamHikerAssistant(text, signal));
  }, [stream]);

  useEffect(() => {
    if (!open || !question.trim()) return;
    const key = `business|${question}`;
    if (firedKeyRef.current === key) return;
    firedKeyRef.current = key;
    fire(question);
  }, [fire, open, question]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || stream.running) return;
    setDraft("");
    firedKeyRef.current = `business|${text}`;
    fire(text);
  }, [draft, fire, stream.running]);

  const tree = stream.tree;
  const done = tree.state === "done";
  const error = tree.state === "error";
  const state = error ? "error" : done ? "done" : "running";
  const status = stream.stopped ? "已停止" : stream.running ? "正在为您办理" : error ? "这一步没有办成" : done ? "已办妥" : "等待输入";

  return (
    <aside className={`ir-copilot${open ? " ir-copilot--open" : ""}`} aria-hidden={open ? undefined : true} inert={!open} aria-label="Hiker 业务副驾">
      <div className="ir-copilot__glass">
        <div className="ir-copilot__head">
          <AgentSessionHeader statusText={status} tone={error ? "error" : "default"} />
          <button type="button" className="ir-copilot__close" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="ir-copilot__scroll">
          {activeQuestion && <div className="ir-copilot__query"><span className="ir-copilot__query-label">问</span><span className="ir-copilot__query-text">{activeQuestion}</span></div>}
          {activeQuestion && <div className="ir-copilot__run"><LoopCard state={state} nowIntent={tree.nowIntent} elapsedText={stream.elapsedText} turns={tree.turns} plan={planProgress(tree.plan)} usageText={stream.usageText} persona={persona} /></div>}
          {done && tree.answerText.trim() && <div className="ir-copilot__answer"><ReactMarkdown>{tree.answerText}</ReactMarkdown></div>}
          {stream.stopped && <p className="ir-copilot__stopped">已停止 · 已产生的过程保留</p>}
        </div>
        <div className="ir-copilot__composer">
          <button type="button" className="ir-copilot__ordinary" onClick={onOrdinary}>普通对话 →</button>
          <AgentComposer value={draft} onChange={setDraft} onSend={send} running={stream.running} onStop={stream.stop} placeholder="继续追问 Hiker 业务事实……" footnote="" />
        </div>
      </div>
    </aside>
  );
}
