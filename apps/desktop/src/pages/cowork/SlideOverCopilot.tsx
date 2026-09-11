/** Hiker 滑出副驾：Workbench Hiker Session 的产品投影。看板读取与副驾执行彼此独立。 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { AgentComposer } from "../../components/agent/AgentComposer";
import { AgentSessionHeader } from "../../components/agent/AgentSessionHeader";
import { IrisPetal } from "../../components/anna/IrisPetal";
import { useWorkbenchSession } from "../workbench/useWorkbenchSession";
import { HikerBusinessCopilot } from "./HikerBusinessCopilot";
import "./SlideOverCopilot.css";

export type CopilotTarget = "hiker";

export interface SlideOverCopilotProps {
  open: boolean;
  question: string;
  mode?: "business" | "ordinary";
  target: CopilotTarget;
  onClose: () => void;
}

export function SlideOverCopilot({ open, question, mode: initialMode = "business", target, onClose }: SlideOverCopilotProps) {
  const workbench = useWorkbenchSession("hiker");
  const [mode, setMode] = useState<"business" | "ordinary">(initialMode);
  const skipOrdinaryQuestionRef = useRef(false);
  const [activeQuestion, setActiveQuestion] = useState("");
  const [draft, setDraft] = useState("");
  const firedKeyRef = useRef("");

  const fire = useCallback((q: string) => {
    setActiveQuestion(q);
    void workbench.start(q);
  }, [workbench.start]);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, question]);

  useEffect(() => {
    if (mode !== "ordinary") return;
    if (skipOrdinaryQuestionRef.current) {
      skipOrdinaryQuestionRef.current = false;
      return;
    }
    if (!open || !question.trim()) return;
    const key = `${target}|${question}`;
    if (firedKeyRef.current === key) return;
    firedKeyRef.current = key;
    fire(question);
  }, [mode, open, question, target, fire]);

  const onSend = useCallback(() => {
    const q = draft.trim();
    if (!q || workbench.starting || workbench.running) return;
    setDraft("");
    firedKeyRef.current = `${target}|${q}`;
    fire(q);
  }, [draft, fire, target, workbench.running, workbench.starting]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const currentMessages = (workbench.session?.messages ?? []).filter((message) => message.run_id === workbench.runId);
  const answer = [...currentMessages].reverse().find((message) => message.role === "assistant")?.content;
  const running = workbench.starting || workbench.running;
  const statusText = workbench.error
    ? "这一步没有办成"
    : running
      ? "正在为您办理"
      : workbench.run?.status === "cancelled"
        ? "已停止"
        : answer
          ? "已办妥"
          : "等待输入";

  if (mode === "business") {
    return <HikerBusinessCopilot open={open} question={question} onClose={onClose} onOrdinary={() => { skipOrdinaryQuestionRef.current = true; setMode("ordinary"); }} />;
  }

  return (
    <aside
      className={`ir-copilot${open ? " ir-copilot--open" : ""}`}
      aria-hidden={open ? undefined : true}
      inert={!open}
      aria-label="向 Anna 追问"
    >
      <div className="ir-copilot__glass">
        <div className="ir-copilot__head">
          <AgentSessionHeader statusText={statusText} tone={workbench.error ? "error" : "default"}>
            <IrisPetal size={12} />
          </AgentSessionHeader>
          <button type="button" className="ir-copilot__close" aria-label="关闭" onClick={handleClose}>✕</button>
        </div>
        <div className="ir-copilot__scroll">
          {activeQuestion && (
            <div className="ir-copilot__query">
              <span className="ir-copilot__query-label">问</span>
              <span className="ir-copilot__query-text">{activeQuestion}</span>
            </div>
          )}
          {workbench.runId && <div className="ir-copilot__run-id">Run {workbench.runId}</div>}
          {workbench.capabilities.length > 0 && (
            <div className="ir-copilot__capabilities" aria-label="已发现能力">
              {workbench.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
            </div>
          )}
          {answer && <div className="ir-copilot__answer"><ReactMarkdown>{answer}</ReactMarkdown></div>}
          {workbench.error && <div className="ir-copilot__error">{workbench.error}</div>}
          {workbench.run?.status === "cancelled" && <p className="ir-copilot__stopped">已停止 · 已产生的过程保留</p>}
        </div>
        <div className="ir-copilot__composer">
          <AgentComposer
            value={draft}
            onChange={setDraft}
            onSend={onSend}
            running={running}
            onStop={() => void workbench.stop("Stopped by user")}
            stopDisabled={workbench.starting || !workbench.runId}
            placeholder="继续追问这份看板……"
            footnote=""
          />
        </div>
      </div>
    </aside>
  );
}

export default SlideOverCopilot;
