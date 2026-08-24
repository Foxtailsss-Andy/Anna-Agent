import { apiFetch, apiJson } from "./client";
import { getIdentity } from "./identity";

/** 看板快照(无 period)= HikerDashboardSnapshot(A1 §2)。 */
export async function createHikerDashboardRun(): Promise<Record<string, unknown>> {
  const id = await getIdentity();
  return apiJson("/api/cowork/hiker/dashboard/runs", {
    method: "POST",
    json: { workspace_id: id.workspaceId, actor_user_id: id.userId },
  });
}

/** 助手 SSE(无非流式版);返回 Response 交给 readSse。
 *  signal(R5 追加,镜像 chat.ts):透进底层 fetch,供副驾 stop() 主动断流。 */
export async function streamHikerAssistant(
  question: string,
  signal?: AbortSignal,
): Promise<Response> {
  const id = await getIdentity();
  return apiFetch("/api/cowork/hiker/assistant/runs/stream", {
    method: "POST",
    signal,
    json: { workspace_id: id.workspaceId, actor_user_id: id.userId, question },
  });
}
