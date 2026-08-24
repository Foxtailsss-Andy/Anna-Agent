/**
 * historyFrames · 已落库 ChatRun → v1 原始帧序列(真数据重放,非编造)
 *
 * 回看 = 把 `GET /api/chat/runs/{id}`(或 list 项,shape 同 ChatRun)重放成
 * 与实时流同构的 v1 帧,再交给 `createNormalizer()` + `reduceTurns` 走同一条渲染链路。
 *
 * 现场核对(2026-07-10,live backend + services/chat/app/schemas.py::ChatRun):
 *   audit_events: list[AuditEvent{type, run_id, payload, created_at}]  ✓ 与假设一致
 *   artifacts:    list[{id, kind, title, content}]                      ✓
 *   plan:         list[{id, title, status}]                             ✓
 *   status:       "generating" | "ready" | "saved" | "failed"          — 非 "succeeded"
 *                 归一化只把 status === "failed" 收敛为 error 帧,ready/saved → done。
 *   答案正文 = assistant_message(非 "answer");且 text_delta 是流内帧、不落 audit_events,
 *   故回看树 answerText 为空 —— 页面回看的最终答案改读 run.assistant_message(见 ChatPage)。
 *
 * 合成规则:
 *   - audit_events 逐条 → {type:"event", event}(plan.updated 由归一化解包成一等计划帧;
 *     其余成系统步,无 L3、不可掀);
 *   - 末尾按 run 自身合成一个终帧 {type:"done", run};status:"failed" 由归一化收敛为 error 帧
 *     (run.error_message / error_code 即真值)。run 自身即真相,不另造消耗/产物。
 */
export function rawFramesFromRun(run: Record<string, unknown>): Record<string, unknown>[] {
  const events = (run.audit_events as Record<string, unknown>[] | undefined) ?? [];
  return [
    ...events.map((event) => ({ type: "event", event })),
    { type: "done", run },
  ];
}

export default rawFramesFromRun;
