import { apiFetch, apiJson } from "./client";
import { getIdentity } from "./identity";

export type CreateDraftKind = "skill" | "prompt" | "python_tool";

/** B1 — Create 流式 SSE(chat 同形帧:step/event/done/error);signal 供 stop 断流。
 *  B2/B3:workdirId = 工作空间上下文注入;permissionMode = Ask/Bypass 审批档
 *  (缺省 ask,本轮真存真审计,拦截随写工具/Code 模式点亮)。 */
export async function streamCreateRun(
  prompt: string,
  kind: CreateDraftKind,
  opts?: {
    agentId?: string;
    workdirId?: string;
    permissionMode?: "ask" | "bypass";
    signal?: AbortSignal;
  },
): Promise<Response> {
  const id = await getIdentity();
  return apiFetch("/api/create/runs/stream", {
    method: "POST",
    signal: opts?.signal,
    json: {
      workspace_id: id.workspaceId,
      actor_user_id: id.userId,
      prompt,
      kind,
      agent_id: opts?.agentId,
      workdir_id: opts?.workdirId,
      permission_mode: opts?.permissionMode,
    },
  });
}

/** 生成产物草稿(kind 默认 "skill")= CreateDraftRequest。 */
export async function createDraft(
  prompt: string,
  kind: CreateDraftKind = "skill",
): Promise<Record<string, unknown>> {
  const id = await getIdentity();
  return apiJson("/api/create/drafts", {
    method: "POST",
    json: { workspace_id: id.workspaceId, actor_user_id: id.userId, prompt, kind },
  });
}

/** 草稿 run 列表(产物中心数据源;产物内容内嵌 CreateRun)。 */
export const listDrafts = () => apiJson<Record<string, unknown>[]>("/api/create/drafts");

/** 激活;confirmed_by 须匹配 header user(create.py:72)。 */
export async function activateDraft(runId: string): Promise<Record<string, unknown>> {
  const id = await getIdentity();
  return apiJson(`/api/create/drafts/${runId}/activate`, {
    method: "POST",
    json: { confirmed_by: id.userId },
  });
}
