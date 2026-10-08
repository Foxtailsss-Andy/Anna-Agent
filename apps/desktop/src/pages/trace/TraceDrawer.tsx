/**
 * TraceDrawer · 执行过程抽屉(取数 + 轮询,纪律照抄 crew/inspect/useRunFrames.ts:19-44)。
 * 外壳照抄 crew/inspect/TaskDrawer 的 .ir-insp-drawer 结构(head 吸顶 + body 单独滚动),
 * 类名保持 trace-* 前缀(Task 6 侦察结论,见 TraceWaterfall.tsx 顶注)。
 * 关闭或切换 run 时清空 doc,避免闪现上一个 run 的旧 trace(对照 useRunFrames 的 setFrames(null))。
 *
 * source:legacy chat run 走 /api/chat/runs/:id/trace;Workbench run 走 Product Host 的
 * /api/workbench/runs/:id/trace(CONTRACTS §1.4,同一 TraceDto 形状)。
 */
import { useEffect, useState } from 'react';
import { getRunTrace, getWorkbenchRunTrace, type TraceDto } from '../../lib/api/trace';
import { TraceWaterfall } from './TraceWaterfall';

const POLL_MS = 3000;

export type TraceSource = 'chat' | 'workbench';

export function TraceDrawer({
  runId,
  open,
  onClose,
  source = 'chat',
}: {
  runId: string;
  open: boolean;
  onClose: () => void;
  source?: TraceSource;
}) {
  const [doc, setDoc] = useState<TraceDto | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setDoc(null);
    setUnavailable(false);
    if (!open || !runId) return;
    let alive = true;
    const load = source === 'workbench' ? getWorkbenchRunTrace : getRunTrace;
    const tick = async () => {
      try {
        const d = await load(runId);
        if (alive) {
          setDoc(d);
          setUnavailable(false);
        }
      } catch {
        // 404/422/未上线 → 保留已有 doc;从未取到则如实显示不可用,不造数
        if (alive) setUnavailable(true);
      }
    };
    void tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [runId, open, source]);
  if (!open) return null;
  return (
    <aside className="trace-drawer" role="dialog" aria-label="执行过程">
      <header className="trace-drawer__head">
        <span>执行过程</span>
        <button type="button" className="trace-drawer__close" onClick={onClose}>关闭</button>
      </header>
      <div className="trace-drawer__body">
        {doc ? (
          <TraceWaterfall doc={doc} />
        ) : unavailable ? (
          <div className="trace-empty">该 Run 的执行过程暂不可读取。</div>
        ) : (
          <div className="trace-empty">加载中……</div>
        )}
      </div>
    </aside>
  );
}
