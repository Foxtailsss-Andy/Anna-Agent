/**
 * crewSession · 进入项目频道时恢复哪一个 Crew Anna 会话(review RS/C6)。
 *
 * Host 保留 Workbench Session;ChannelColumn 每次按 projectId 挂载时据此恢复卡片与历史。
 * 只认本项目的 crew surface 会话,取最近更新(缺 updated_at 回落 created_at)的一个;无 → null。
 */

interface SessionLike {
  session_id: string;
  surface: string;
  project_id?: string;
  created_at?: string;
  updated_at?: string;
}

function stamp(session: SessionLike): number {
  const t = Date.parse(session.updated_at ?? session.created_at ?? "");
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

export function latestCrewSession(sessions: readonly SessionLike[], projectId: string): string | null {
  let best: SessionLike | null = null;
  for (const session of sessions) {
    if (session.surface !== "crew" || session.project_id !== projectId) continue;
    if (best === null || stamp(session) > stamp(best)) best = session;
  }
  return best?.session_id ?? null;
}
