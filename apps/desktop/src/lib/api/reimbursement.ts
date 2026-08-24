import { apiFetch, apiJson } from "./client";
import { getIdentity } from "./identity";

/** Anna 导入的附件引用({name, uri:"anna://attachment/..."})。 */
export interface AttachmentRef {
  name: string;
  uri: string;
}

/** 启动 SSE(含 awaiting_approval 帧);req = CreateReimbursementRunRequest。
 *  signal(R6 追加,镜像 chat.ts):透进底层 fetch,供 useRunStream.stop() 主动断流。 */
export async function streamReimbursementRun(
  inputText: string,
  attachments: AttachmentRef[] = [],
  signal?: AbortSignal,
): Promise<Response> {
  const id = await getIdentity();
  return apiFetch("/api/cowork/reimbursements/runs/stream", {
    method: "POST",
    signal,
    json: {
      workspace_id: id.workspaceId,
      actor_user_id: id.userId,
      input_text: inputText,
      attachments,
    },
  });
}

/** 补齐字段后推进 SSE(supplement 恢复段);身份走头。signal(R6)供主动断流。 */
export async function streamAnswers(
  runId: string,
  answers: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return apiFetch(`/api/cowork/reimbursements/runs/${runId}/answers/stream`, {
    method: "POST",
    signal,
    json: { answers },
  });
}

/** 批准 SSE(RESUME 路径);approved_by 须等于 header user(reimbursement.py:294)。signal(R6)供主动断流。 */
export async function streamApprove(approvalId: string, signal?: AbortSignal): Promise<Response> {
  const id = await getIdentity();
  return apiFetch(`/api/cowork/reimbursements/approvals/${approvalId}/approve/stream`, {
    method: "POST",
    signal,
    json: { approved_by: id.userId },
  });
}

/** 驳回(非流式);rejected_by 须等于 header user。 */
export async function rejectApproval(approvalId: string): Promise<Record<string, unknown>> {
  const id = await getIdentity();
  return apiJson(`/api/cowork/reimbursements/approvals/${approvalId}/reject`, {
    method: "POST",
    json: { rejected_by: id.userId },
  });
}

/** run 列表(倒序,最新在前)。端点真形 = `{runs:[...完整 run...]}`(reimbursement.py:59;
 *  R2 客户端旧类型误标为裸数组)→ 此处解包 `.runs`,调用方直接拿数组。 */
export const listRuns = async (): Promise<Record<string, unknown>[]> => {
  const body = await apiJson<{ runs?: Record<string, unknown>[] }>(
    "/api/cowork/reimbursements/runs",
  );
  return Array.isArray(body.runs) ? body.runs : [];
};
export const getRun = (runId: string) =>
  apiJson<Record<string, unknown>>(`/api/cowork/reimbursements/runs/${runId}`);

/** 重试回读校验(verify_pending → 再读企业报销系统状态);非流式,返回刷新后的 run。
 *  (R2 客户端漏了此函数,R6 补;端点 reimbursement.py:158) */
export const verifyReimbursement = (runId: string) =>
  apiJson<Record<string, unknown>>(`/api/cowork/reimbursements/runs/${runId}/verify`, {
    method: "POST",
  });

/** 上传附件:raw body + X-Anna-Attachment-Name(percent-encoded)→ {name, uri}。 */
export async function uploadAttachment(name: string, blob: Blob): Promise<AttachmentRef> {
  return apiJson<AttachmentRef>("/api/cowork/reimbursements/attachments", {
    method: "POST",
    body: blob,
    headers: { "X-Anna-Attachment-Name": encodeURIComponent(name) },
  });
}

/** run 审计事件流(「查看审计」按钮);run-scoped,走身份头。 */
export const getAudit = (runId: string) =>
  apiJson<Record<string, unknown>>(`/api/admin/audit/reimbursement/runs/${runId}`);
