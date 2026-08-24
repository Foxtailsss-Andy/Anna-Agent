# live-chat-frames.json — 采集说明与现实校准(R2 · Task 3 Step 2)

> JSON 不能带注释,采集观察记录于此(与 fixture 同目录)。

## 采集环境

- 2026-07-09,后端 `uvicorn services.api.app.main:app --host 127.0.0.1 --port 8000`
  (brief 写的 `python -m services.api.app.main` 无 `__main__` runner,导入即退出 exit 0;
  正确入口 = uvicorn,见 `apps/desktop/electron/runtime-service.mjs:78-86`。偏差已记于 commit + 报告。)
- 身份走本地回落(桌面免登录):`workspace_id=local-workspace` / `user_id=local-user` / `role=boss` / `source=local-runtime`。
- 端点 `POST /api/chat/runs/stream`,message = "请用 plan.update 规划并生成一个简单页面"。

## 本条 fixture = 失败流(合法 fixture,brief 认可)

**本机未配置模型 key → run 立即 `model_not_configured` 失败**,故这条真流**没有 tool 调用、没有 plan.updated、没有 model.call.***。
帧序(线上真实):

1. `event{event.type=chat.run.created}`
2. `event{event.type=skill.loaded}`(payload: skill_id/skill_name/skill_version/content_hash)
3. `event{event.type=chat.run.failed}`(payload: `{error_code:"model_not_configured"}`)
4. `error{run:<ChatRun>}` — **chat 失败信道 = `error{run}`,不另发 `done`**;`run.status="failed"`、
   `run.error_code="model_not_configured"`、`run.error_message="model endpoint and API key are required before running Anna Chat"`。

→ 归一化端到端:3 个 event → 3 个 `EventFrame`;`error{run}` → 1 个 `ErrorFrame`(message 取 `run.error_message`)。
终止帧恰 1(error),`out.length=4>0`。**证实 A2 §2:chat 失败走 error{run} 而非 done{status:failed}。**

因模型 key 未配,成功流(含 tool_call)本机不可采;第二份成功 fixture 需配置模型后补采。
tool 调用相关的三项观察改由**代码静态分析**给出(brief Task 3 Step 2 的 fallback 分支):

## ① mcp.tool.called 审计帧 vs tool_done 引擎帧的先后 —— 代码证据

- `services/runtime/app/engine/agent_loop.py:242-244`:
  ```
  yield {"type":"tool_start","name":...}          # 引擎帧
  observations.append(handler.dispatch_tool(...)) # dispatch 内 append mcp.tool.called 到 audit_events
  yield {"type":"tool_done","name":...}           # 引擎帧
  ```
  `mcp.tool.called` 在 dispatch 中落审计(`mcp_dispatcher.py:126-142 record_tool_called`),
  时点在 tool_start 之后、tool_done 之前。
- `services/chat/app/orchestrator.py:194-208`:每个引擎帧**产出前先 flush 水位新增的审计帧**
  (`for frame in watermark.new_frames(): yield frame` 在 `yield event` 之前)。
- 结论:**wire 顺序 = `tool_start` → `event{mcp.tool.called}` → `tool_done`**。
  审计帧在 tool_done **之前**到达。→ A2 §4 的 `ok` 查表方向成立:
  处理 tool_done 时,对应 tool 的 `mcp.tool.called.status` 已在上下文中,可查;查无则默认 `ok:true`。
  **A2 §4 无需修订**;风险节假设(审计在 tool_done 之后到)未发生。

## ② plan.updated payload 形状 —— 代码证据

- `services/chat/app/capability.py:194-199`:`audit.append(..., "plan.updated", ..., {"count":len, "done_count":n, "items":plan})`,
  `items` = `[{id,title,status}]`(PlanItem)。→ 归一化取 `event.payload.items`,与 A2 §2/§4 一致。

## ③ model.call.* payload 字段 —— 代码证据

- `model.call.started`(`streaming_model.py:160-176`):`model_name`、`context_token_count`、`context_percent_left`(+tool_names/hash/window)。
  → 归一化取 `model_name`(usage.model)、`context_percent_left`(CTX 环原始剩余值,`getCtxPercentLeft()`;
  useRunStream 换算为已用百分比供 W5 CTX 环显示,契约细节见 R4 复审修复)。
- `model.call.completed`(`streaming_model.py:281-292`):`input_tokens`/`output_tokens` **仅 provider 真报时才有键**
  (无 usage 帧 → 无键,诚实纪律不伪造 0)。→ 归一化仅在这两键存在时累加并置 `reported=true`;否则 tokens=null。
  与 A2 §2/§4 一致。
