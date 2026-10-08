import type { WorkbenchEvent, WorkbenchSession } from "../../lib/api/workbench";
import { CrewMarkdown } from "../crew/CrewMarkdown";
import "./WorkbenchChatPanel.css";

interface WorkbenchChatPanelProps {
  session: WorkbenchSession | null;
  prompt: string;
  status: string;
  runId: string | null;
  error: string | null;
  capabilities: string[];
  events: WorkbenchEvent[];
  onStop: () => void;
  composer: React.ReactNode;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "已排队",
  running: "正在办理",
  completed: "已办妥",
  cancelled: "已停止",
  failed: "这一步没有办成",
  not_started: "准备中",
};

export function WorkbenchChatPanel({
  session,
  prompt,
  status,
  runId,
  error,
  capabilities,
  events,
  onStop,
  composer,
}: WorkbenchChatPanelProps) {
  const messages = session?.messages ?? [];
  const isRunning = status === "queued" || status === "running" || status === "not_started";
  const effectivePrompt = prompt || messages.find((message) => message.role === "user")?.content || "";

  return (
    <div className="ir-home ir-home--session ir-workbench-chat">
      <div className="ir-home__main">
        <div className="ir-home__runhead">
          <span className="ir-home__runhead-title">{effectivePrompt.slice(0, 16) || "对话"}</span>
          {runId && <span className="ir-home__runhead-id">run {runId}</span>}
          {session && <span className="ir-home__runhead-thread">Session {session.session_id.slice(0, 8)}</span>}
        </div>
        <div className="ir-home__scroll">
          <div className="ir-home__col ir-workbench-chat__col">
            {effectivePrompt && (
              <div className="ir-home__user-row">
                <div className="ir-home__user-bubble">{effectivePrompt}</div>
              </div>
            )}
            <div className="ir-workbench-chat__status" role="status">
              <span className={`ir-workbench-chat__dot${isRunning ? " ir-workbench-chat__dot--running" : ""}`} />
              <span>{STATUS_LABELS[status] ?? status}</span>
              {runId && <span className="ir-workbench-chat__run-id">{runId}</span>}
            </div>
            {(capabilities.length > 0 || events.some((event) => event.type === "capability.loaded")) && (
              <div className="ir-workbench-chat__capabilities" aria-label="已发现能力">
                <span className="ir-workbench-chat__capabilities-label">能力</span>
                {capabilities.map((capability) => <span key={capability} className="ir-workbench-chat__capability">{capability}</span>)}
              </div>
            )}
            {messages.length > 0 && (
              <div className="ir-workbench-chat__history" aria-label="会话历史">
                {messages.map((message, index) => (
                  <div key={`${message.event_id ?? message.run_id ?? "message"}-${index}`} className={`ir-workbench-chat__message ir-workbench-chat__message--${message.role}${message.run_id === runId ? " ir-workbench-chat__message--current" : ""}`}>
                    {message.role === "assistant" ? <CrewMarkdown source={message.content} /> : <div>{message.content}</div>}
                  </div>
                ))}
              </div>
            )}
            {error && <div className="ir-workbench-chat__error"><strong>未能完成：</strong>{error}</div>}
            {isRunning && (
              <button type="button" className="ir-home__suspend-stop ir-workbench-chat__stop" onClick={onStop} disabled={runId === null}>
                停止此 Run
              </button>
            )}
          </div>
        </div>
        <div className="ir-home__dock">
          <div className="ir-home__col">{composer}</div>
        </div>
      </div>
    </div>
  );
}

export default WorkbenchChatPanel;
