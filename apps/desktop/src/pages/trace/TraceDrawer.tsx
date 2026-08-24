/**
 * TraceDrawer · 执行过程抽屉(取数 + 轮询,纪律照抄 crew/inspect/useRunFrames.ts:19-44)。
 * 外壳照抄 crew/inspect/TaskDrawer 的 .ir-insp-drawer 结构(head 吸顶 + body 单独滚动),
 * 类名保持 trace-* 前缀(Task 6 侦察结论,见 TraceWaterfall.tsx 顶注)。
 * 关闭或切换 run 时清空 doc,避免闪现上一个 run 的旧 trace(对照 useRunFrames 的 setFrames(null))。
 */
import { useEffect, useState } from 'react';
import { getRunTrace, type TraceDto } from '../../lib/api/trace';
import { TraceWaterfall } from './TraceWaterfall';

const POLL_MS = 3000;

export function TraceDrawer({ runId, open, onClose }: { runId: string; open: boolean; onClose: () => void }) {
  const [doc, setDoc] = useState<TraceDto | null>(null);
  useEffect(() => {
    if (!open || !runId) {
      setDoc(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const d = await getRunTrace(runId);
        if (alive) setDoc(d);
      } catch {
        if (alive) setDoc((p) => p ?? null); // 404/未上线 → 空态,不造数
      }
    };
    void tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [runId, open]);
  if (!open) return null;
  return (
    <aside className="trace-drawer" role="dialog" aria-label="执行过程">
      <header className="trace-drawer__head">
        <span>执行过程</span>
        <button type="button" className="trace-drawer__close" onClick={onClose}>关闭</button>
      </header>
      <div className="trace-drawer__body">
        {doc ? <TraceWaterfall doc={doc} /> : <div className="trace-empty">加载中……</div>}
      </div>
    </aside>
  );
}
