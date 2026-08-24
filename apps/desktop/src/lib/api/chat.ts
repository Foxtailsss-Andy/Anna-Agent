import { apiFetch, apiJson } from "./client";
import { getIdentity } from "./identity";
import { readSse } from "./sse";

/** 档位选择器数据源(脱敏)= GET /api/chat/model-profiles 的 profiles 项。 */
export interface ModelProfileOption {
  id: string;
  label: string;
  provider: string;
  model_name: string;
}

/** 主对话请求体(submit 与旧 stream 同形;schemas.CreateChatRunRequest)。 */
export interface ChatRunBody {
  message: string;
  /** L1b 会话连续性:上一轮 thread_id → 后端拼同 thread 既往轮(缺省=新线程)。 */
  threadId?: string;
  templateId?: string;
  modelProfileId?: string;
  skillId?: string;
  /** M2 per-run 专家选择:该 Agent 附加指令注入本次 run(缺省=域默认 chat)。 */
  agentId?: string;
  /** B2 per-run 工作空间(workdir 注册表 id):文件树上下文 + 只读工具。 */
  workdirId?: string;
}

/** L3a submit 响应:run 与请求解耦,立得 run_id/thread_id。 */
export interface SubmittedChatRun {
  run_id: string;
  thread_id: string | null;
  status: string;
}

/**
 * L3b 后台 run:POST /submit 即返(不等生成),后端在后台驱动到完成并逐帧落账。
 * 立得 run_id(供订阅/停止)与 thread_id(续聊回传,优先此源)。请求体同旧 stream。
 */
export async function submitChatRun(body: ChatRunBody): Promise<SubmittedChatRun> {
  const id = await getIdentity();
  return apiJson<SubmittedChatRun>("/api/chat/runs/submit", {
    method: "POST",
    json: {
      workspace_id: id.workspaceId,
      actor_user_id: id.userId,
      message: body.message,
      thread_id: body.threadId,
      template_id: body.templateId,
      model_profile_id: body.modelProfileId,
      skill_id: body.skillId,
      agent_id: body.agentId,
      workdir_id: body.workdirId,
    },
  });
}

/**
 * L3b 可续订阅:GET /{run_id}/stream?from_seq=N —— 先 replay > N 的帧再跟随实时,终帧后关闭
 * (已完成的 run 亦可纯 replay)。复用 readSse 逐帧解析(与旧路径同一解析器,不另造)。
 * 正常收束 → Promise resolve;传输中断 → reject(重连由 useRunStream.startBackground 编排)。
 * signal 透进底层 fetch:新一次订阅/停止会 abort 上一条,保证同时只有一条订阅。
 */
export async function subscribeChatRun(
  runId: string,
  fromSeq: number,
  handlers: { onFrame: (raw: Record<string, unknown>) => void; signal?: AbortSignal },
): Promise<void> {
  const res = await apiFetch(`/api/chat/runs/${runId}/stream?from_seq=${fromSeq}`, {
    method: "GET",
    signal: handlers.signal,
  });
  await readSse(res, handlers.onFrame);
}

/** L3b 显式停止后台 run(终态幂等)。断开订阅只是不看了 —— 停止才真正结束后端 run。 */
export function stopChatRun(runId: string): Promise<{ run_id: string; status: string }> {
  return apiJson<{ run_id: string; status: string }>(`/api/chat/runs/${runId}/stop`, {
    method: "POST",
  });
}

/**
 * L4b 续办:POST /{run_id}/continue —— 恢复顶到 max_turns 挂起(awaiting_continue)的 run。
 * 身份头同 stop;幂等:run 非 awaiting_continue 时后端原样返回当前 status(非 409,防双击竞态)。
 * 续跑在同一 run_id / journal seq 空间 —— 之后继续用 GET /{run_id}/stream?from_seq= 跟随续帧。
 */
export function continueChatRun(runId: string): Promise<{ run_id: string; status: string }> {
  return apiJson<{ run_id: string; status: string }>(`/api/chat/runs/${runId}/continue`, {
    method: "POST",
  });
}

/** Local-only SSE attach/replay counters; contains no frame content or provider data. */
export function getChatRunTelemetry(runId: string): Promise<{
  run_id: string;
  subscription_count: number;
  resume_subscription_count: number;
  frames_emitted: number;
  gap_recovery_count: number;
  last_seq: number;
  terminal: boolean;
}> {
  return apiJson(`/api/chat/runs/${runId}/telemetry`);
}

/**
 * J3 插话:POST /{run_id}/interject —— 给**正在跑**的 run 补一句话(不是新 run)。
 * 后端把它排进队列,引擎在下一轮开头作为一条独立 user 消息喂给模型;已办完的 run
 * 返回 accepted:false + 当前 status(幂等,不报错 —— 说的话和答案同时落地是竞态不是错误)。
 * 补充指示的回执以 run.interjected 事件帧进流,时间线上可见。
 */
export function interjectChatRun(
  runId: string,
  text: string,
): Promise<{ run_id: string; status: string; accepted: boolean }> {
  return apiJson<{ run_id: string; status: string; accepted: boolean }>(
    `/api/chat/runs/${runId}/interject`,
    { method: "POST", json: { text } },
  );
}

export const getModelProfiles = () =>
  apiJson<{ profiles: ModelProfileOption[]; default_profile_id: string }>(
    "/api/chat/model-profiles",
  );
export const getPromptTemplates = () =>
  apiJson<Record<string, unknown>[]>("/api/chat/prompt-templates");
export const listChatRuns = () => apiJson<Record<string, unknown>[]>("/api/chat/runs");
export const getChatRun = (runId: string) =>
  apiJson<Record<string, unknown>>(`/api/chat/runs/${runId}`);

/** 保存结果为产物;saved_by 须等于 header user(chat.py:132)。 */
export async function saveChatRun(runId: string): Promise<Record<string, unknown>> {
  const id = await getIdentity();
  return apiJson(`/api/chat/runs/${runId}/save`, {
    method: "POST",
    json: { saved_by: id.userId },
  });
}
