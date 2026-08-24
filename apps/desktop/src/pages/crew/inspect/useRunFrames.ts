/**
 * useRunFrames · 拉 crew run 逐帧(B2 GET /api/crew/runs/{run_ref}/frames),轮询 3s。
 *   popover 执行白盒 / 抽屉 trace 共用。404/无 token → 空(不造数)。
 */

import { useEffect, useState } from "react";

import { getRunFrames, type RunFrame } from "../../../lib/api/crew";

const POLL_MS = 3000;

export function useRunFrames(
  runRef: string | null | undefined,
  active: boolean,
): { frames: RunFrame[] | null; loading: boolean } {
  const [frames, setFrames] = useState<RunFrame[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runRef || !active) {
      setFrames(null);
      setLoading(false);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const f = await getRunFrames(runRef);
        if (alive) setFrames(f);
      } catch {
        if (alive) setFrames((p) => p ?? []); // 未上线/404 → 空,保留已有真值
      } finally {
        if (alive) setLoading(false);
      }
    };
    setLoading(true);
    void tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [runRef, active]);

  return { frames, loading };
}
