/**
 * friendlyError · C5 错误人话(精修二轮)
 *
 * 后端 C2 契约:状态冲突返 409 JSON `{detail, code, task_status}`,
 * codes = task_not_startable | task_not_runnable。本模块把 ApiError 翻成
 * 一句中文人话;解析失败时诚实回落到原始 detail(不编造原因)。
 */

import { ApiError } from "../../../lib/api/client";

/** 后端 TaskStatus → 中文状态词(与 graphMapping 视觉词分层:这里是叙述用) */
const STATUS_WORDS: Record<string, string> = {
  todo: "待认领",
  assigned: "已指派",
  running: "执行中",
  submitted: "待审",
  in_review: "待审",
  rework: "返工",
  done: "已完成",
  blocked: "阻塞",
};

/** 后端原始 TaskStatus → 中文状态词(叙述用;precheckOp 陈旧提示复用,单一事实源)。 */
export function statusWordCn(status: unknown): string {
  return typeof status === "string" ? (STATUS_WORDS[status] ?? status) : "";
}

interface ErrorBody {
  detail?: unknown;
  code?: unknown;
  task_status?: unknown;
}

function parseBody(body: string): ErrorBody | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const outer = parsed as ErrorBody;
      // FastAPI 把 HTTPException(detail=dict) 渲染成 {"detail": {...}} —— 解开一层
      if (outer.detail && typeof outer.detail === "object") {
        return outer.detail as ErrorBody;
      }
      return outer;
    }
  } catch {
    /* 非 JSON 体,走回落 */
  }
  return null;
}

/**
 * ApiError → 人话。已知 code 给场景化解释;未知则回落 detail 原文;
 * 非 ApiError 回落 String(e)。绝不吞错、绝不编造。
 */
export function friendlyTaskError(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  const body = parseBody(e.body ?? "");
  const word = statusWordCn(body?.task_status);
  switch (body?.code) {
    case "task_not_startable":
      return `该任务已被推进，当前${word ? `“${word}”` : "状态已变化"}——无需手动开始，列表刷新后按钮会归位。`;
    case "task_not_runnable":
      return `该任务当前不可执行${word ? `（已“${word}”）` : ""}——多半 Anna 已自动跑完，看看产物或评审卡。`;
    case "task_is_gate":
      return "这是评审门——不用开始、也不提交，直接评审：通过或驳回。";
    case "task_not_assignable":
      return "该任务已在推进中，不能直接改派——让当前执行者提交，或先在频道协调。";
    default: {
      const detail = typeof body?.detail === "string" ? body.detail : e.body;
      return detail || `请求失败（HTTP ${e.status}）`;
    }
  }
}
