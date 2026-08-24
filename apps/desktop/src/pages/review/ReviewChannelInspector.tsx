import { useState } from "react";

import { getChannelEvents, getRunTraceCursor, type ChannelEventsResponse, type TraceCursorResponse } from "./reviewApi";
import "./ReviewChannelInspector.css";

interface ReviewChannelInspectorProps {
  workspaceId: string;
}

export function ReviewChannelInspector({ workspaceId }: ReviewChannelInspectorProps) {
  const [channelId, setChannelId] = useState("");
  const [streamId, setStreamId] = useState("");
  const [runId, setRunId] = useState("");
  const [events, setEvents] = useState<ChannelEventsResponse | null>(null);
  const [trace, setTrace] = useState<TraceCursorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"events" | "trace" | null>(null);

  async function loadEvents(): Promise<void> {
    if (!workspaceId || !channelId || !streamId) return;
    setBusy("events");
    setError(null);
    try {
      setEvents(await getChannelEvents(workspaceId, channelId, streamId));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function loadTrace(): Promise<void> {
    if (!workspaceId || !channelId || !runId) return;
    setBusy("trace");
    setError(null);
    try {
      setTrace(await getRunTraceCursor(runId, workspaceId, channelId));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="review-inspector" aria-labelledby="review-inspector-title">
      <header className="review-inspector__header">
        <div>
          <p className="review-inspector__eyebrow">V2 REVIEW</p>
          <h1 id="review-inspector-title">Review Channel Inspector</h1>
          <p className="review-inspector__lede">只读查看 Channel 事件游标与 Run Trace。</p>
        </div>
        <span className="review-inspector__badge">LOOPBACK</span>
      </header>

      <div className="review-inspector__workspace">
        <label>
          Workspace
          <input value={workspaceId} readOnly aria-label="Workspace ID" />
        </label>
        <label>
          Channel
          <input value={channelId} onChange={(event) => setChannelId(event.target.value)} />
        </label>
        <label>
          Stream
          <input value={streamId} onChange={(event) => setStreamId(event.target.value)} />
        </label>
        <label>
          Run
          <input value={runId} onChange={(event) => setRunId(event.target.value)} />
        </label>
      </div>

      <div className="review-inspector__actions">
        <button type="button" onClick={() => void loadEvents()} disabled={busy !== null || !channelId || !streamId}>
          {busy === "events" ? "读取中……" : "读取 Channel 事件"}
        </button>
        <button type="button" onClick={() => void loadTrace()} disabled={busy !== null || !channelId || !runId}>
          {busy === "trace" ? "读取中……" : "读取 Run Trace"}
        </button>
      </div>

      {error && <p className="review-inspector__error" role="alert">{error}</p>}

      <div className="review-inspector__results">
        <section aria-labelledby="review-events-title">
          <div className="review-inspector__result-head">
            <h2 id="review-events-title">Channel events</h2>
            {events && <span>{events.events.length} events · seq {events.nextCursor.seq}</span>}
          </div>
          <pre>{events ? JSON.stringify(events.events, null, 2) : "尚未读取事件"}</pre>
        </section>
        <section aria-labelledby="review-trace-title">
          <div className="review-inspector__result-head">
            <h2 id="review-trace-title">Trace cursor</h2>
            {trace && <span>{trace.cursors.length} cursors</span>}
          </div>
          <pre>{trace ? JSON.stringify({ document: trace.document, harnessState: trace.harnessState }, null, 2) : "尚未读取 Trace"}</pre>
        </section>
      </div>
    </section>
  );
}

export default ReviewChannelInspector;
