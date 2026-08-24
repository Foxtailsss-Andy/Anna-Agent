# W1 — Loop 可观测性权威化 + 计划面板 + 消耗 chip(前后端)

> 对照物:WorkBuddy 截图 3/4 的运行现场——每步一行权威意图(「运行校验、定位代码」「修改、运行校验: <路径>」)、右栏「任务进程」checklist 实时打勾划线、每条消息「共消耗 ◇ 193.25」「已完成 3m12s」、「深度思考」折叠。
> 解决 HANDOFF-2026-07-07 问题 1(liveNote 是前端猜的,不严谨)与问题 5(ChatPage 600 行拆分)。

**目标效果(验收可见)**:Chat 发「帮我分析上月费用并做成网页报告」——① 气泡上方状态行来自**后端权威帧**逐步更新;② 右栏计划面板出现模型维护的任务清单,完成项打勾划线;③ 回答完成后气泡底部出现「消耗 ~N tokens · 用时 M s」chip;④ 思考轮/工具轮/交付轮在 trace 中边界清晰可折叠。

## 现状锚点

| 事实 | 位置 |
|---|---|
| SSE 帧契约:text_delta/tool_start/tool_done/event/done/error | 发射:`services/chat/app/orchestrator.py` stream_run;消费:`apps/desktop/src/features/agentic/agentStream.ts` `consumeAgentStream` |
| 引擎循环工具分派点(step 帧发射点) | `services/runtime/app/engine/agent_loop.py` ~210-213(for tool_call in tool_calls 串行 dispatch) |
| liveNote 前端启发式(要替换的东西) | `apps/desktop/src/features/chat/ChatPage.tsx`(按帧型硬映射文案) |
| trace 折叠模型 | `apps/desktop/src/features/agentic/agentTraceModel.ts`(foldTrace/buildTrace)、`StageStepTrace.tsx` |
| 上下文占用审计(消耗 chip 的数据源之一) | `services/runtime/app/harness_runtime.py:91-93` 往 `model.call.started` 写 context_token_count/context_window/context_percent_left |
| 工具人话标签 | `apps/desktop/src/features/chat/chatTrace.ts` CHAT_TRACE_CONFIG |
| Chat run 模型 | `services/chat/app/schemas.py`(ChatRun:artifacts/audit_events/model_profile_id/skill_id) |

## 契约(前后端对齐,先定死再动手)

**新帧 `step`**(引擎权威发射,前端只渲染不猜):

```json
{ "type": "step", "phase": "analyze" | "tool" | "deliver" | "compact",
  "intent": "正在查询 ERP 财务数据", "tool": "erp.finance.query", "turn": 2 }
```

**新原生工具 `plan.update`**(模型可见 schema;引擎层实现,任何 surface 注册后可用):

```json
{ "name": "plan.update", "description": "维护当前任务的执行计划清单。多步任务开始时先建计划;每完成一步立即更新状态。",
  "input_schema": { "type":"object", "properties": { "items": { "type":"array", "items": {
    "type":"object", "properties": { "id":{"type":"string"}, "title":{"type":"string"},
      "status":{"enum":["pending","in_progress","done"]} }, "required":["id","title","status"] } } },
    "required":["items"] } }
```

代码门(ADR-002):items ≤ 20 条、title ≤ 60 字、id 去重、status 枚举校验;非法输入返回工具错误观察,不入 run 状态。run 状态新增 `plan: list[PlanItem]`(整表替换语义,幂等)。审计事件 `plan.updated {count, done_count}`。

**消耗 chip 数据**:`model.call.completed` 审计事件新增(在 harness_runtime/streaming_model 收到 provider usage 时发射):`{ input_tokens, output_tokens }`;provider 不回报 usage 时**不发射**(诚实性:估算值不冒充真值,chip 显示「~」前缀的 estimate 或不显示)。耗时由前端 done 帧时间差计算。

## 任务分解

### Task 1: ChatPage 拆分(前端地基,先行)

**Files:**
- Create: `apps/desktop/src/features/chat/useChatStream.ts`(发送+流式消费+liveNote/step 状态)
- Create: `apps/desktop/src/features/chat/ChatComposer.tsx`、`ChatThread.tsx`、`FollowUpBar.tsx`
- Modify: `apps/desktop/src/features/chat/ChatPage.tsx`(收敛为布局壳 ≤200 行)
- Test: 既有 vitest 全绿即可(拆分是等价重构,不加新逻辑)

**Interfaces(Produces):** `useChatStream(): { transcript, liveStep: StepFrame|null, plan: PlanItem[], usage: RunUsage|null, send(input, opts), stop() }` —— Task 4/5 与 W8 都消费此 hook。

- [ ] Step 1:抽 `useChatStream` hook——把 ChatPage 中 send/流式/liveNote 状态原样搬入,ChatPage 改为消费 hook;`npx tsc --noEmit` 0 error。
- [ ] Step 2:抽 ChatComposer/ChatThread/FollowUpBar 三个纯展示组件(props 从 hook 来);`npx vitest run` 全绿、`npm run build` 成功、Playwright 冒烟(发一条消息收到回答)。
- [ ] Step 3:commit `refactor(fe): W1.T1 — split ChatPage into hook + components`。

### Task 2: 引擎发射 step 帧(TDD)

**Files:**
- Modify: `services/runtime/app/engine/agent_loop.py`(模型调用前发 analyze、每个 tool dispatch 前发 tool、final 前发 deliver)
- Modify: `services/runtime/app/engine/capability.py`(协议新增可选 `humanize_step(phase, tool_call|None) -> str`,缺省实现返回工具 label 或固定文案)
- Modify: `services/chat/app/orchestrator.py` stream_run(把引擎 step 事件转成 SSE `step` 帧)
- Modify: `services/chat/app/capability.py`(实现 humanize_step:用 chatTrace 同源的中文标签,如 erp.finance.query→「正在查询 ERP 财务数据」)
- Test: `tests/runtime/test_step_frames.py`

**Interfaces(Produces):** 引擎事件流新增 `("step", StepEvent)`;`StepEvent = dataclass(phase:str, intent:str, tool:str|None, turn:int)`。

- [ ] Step 1:写失败测试——fake handler 跑两轮(1 工具轮+1 交付轮),断言事件序列含 `analyze(turn1)→tool(turn1, tool=x)→analyze(turn2)→deliver(turn2)`,intent 为 humanize_step 返回值。Run: `pytest tests/runtime/test_step_frames.py -v` → FAIL。
- [ ] Step 2:实现引擎发射 + 协议缺省实现 → 测试 PASS。
- [ ] Step 3:chat orchestrator 转发为 SSE 帧(测试:stream_run 输出含 `"type":"step"`);全量 pytest 全绿。
- [ ] Step 4:commit `feat(harness): W1.T2 — authoritative step frames from engine`。

### Task 3: plan.update 原生工具(TDD)

**Files:**
- Create: `services/runtime/app/engine/plan_tool.py`(schema 常量 + `apply_plan_update(current, items) -> list[PlanItem]` 纯函数校验门)
- Modify: `services/runtime/app/chat_tool_registry.py`(CHAT_ALLOWED_TOOLS += "plan.update",schema 暴露)
- Modify: `services/chat/app/capability.py`(dispatch_tool 分支:校验→写 run.plan→审计 `plan.updated`→返回观察「计划已更新(N 项,M 完成)」;system prompt 追加一句:多步任务先调用 plan.update 建计划、每完成一步更新)
- Modify: `services/chat/app/schemas.py`(ChatRun += `plan: list[dict] = []`)
- Test: `tests/runtime/test_plan_tool.py`、`tests/chat/test_plan_wiring.py`

- [ ] Step 1:失败测试——apply_plan_update 校验(超 20 条拒/枚举拒/id 去重/整表替换幂等)→ FAIL → 实现 → PASS。
- [ ] Step 2:失败测试——chat dispatch plan.update 后 run.plan 更新且审计事件出现 → 实现接线 → PASS;全量 pytest。
- [ ] Step 3:commit `feat(harness): W1.T3 — plan.update native tool + run.plan state`。

### Task 4: 前端计划面板 + 权威步骤行

**Files:**
- Modify: `apps/desktop/src/features/agentic/agentStream.ts`(消费 `step` 帧,回调 onStep;未知帧兼容不变)
- Create: `apps/desktop/src/features/agentic/PlanRail.tsx`(任务进程 checklist:pending 圆圈/in_progress 高亮/done 打勾划线——对照 WorkBuddy 截图 3 右栏)
- Modify: `apps/desktop/src/features/chat/useChatStream.ts`(liveNote 改为直接渲染最近 step.intent;plan 状态来自 `event` 帧的 plan.updated 载荷或 done 后 run.plan)
- Modify: `apps/desktop/src/features/agentic/agentTraceModel.ts`(step 帧作为轮边界信号,思考/工具/交付分组更准;每轮记录耗时)
- Test: `apps/desktop/src/features/agentic/__tests__/`(vitest:step 帧解析、plan 折叠状态机、trace 分组含 step 边界)

- [ ] Step 1:vitest 失败测试(agentStream 解析 step 帧 / PlanRail 状态映射纯函数)→ 实现 → 全绿。
- [ ] Step 2:PlanRail 挂进 Chat 右栏(画布未开时与产物列表同栏;画布打开时置于画布上方,复用 `.lg-canvas-*` 布局段,styles.css 文件尾追加 `lg-plan-*`)。
- [ ] Step 3:Playwright 走查:发多步任务,录屏确认计划打勾与步骤行随帧更新;截图归档 docs/progress/。
- [ ] Step 4:commit `feat(fe): W1.T4 — plan rail + authoritative live step line`。

### Task 5: 消耗/耗时 chip

**Files:**
- Modify: `services/runtime/app/harness_runtime.py` + `services/runtime/app/engine/streaming_model.py`(provider usage → 审计 `model.call.completed {input_tokens, output_tokens}`;拿不到 usage 不发)
- Modify: `apps/desktop/src/features/chat/ChatThread.tsx`(气泡底部 chip:Σ tokens + 耗时;audit 无 usage 时仅显示耗时)
- Test: `tests/runtime/test_usage_audit.py`(fake provider 带 usage → 事件出现;不带 → 不出现)

- [ ] Step 1:失败测试 → 实现 → PASS(全量 pytest)。
- [ ] Step 2:FE chip 渲染(数据从 run.audit_events 求和);vitest 纯函数 `sumRunUsage(auditEvents)`。
- [ ] Step 3:commit `feat: W1.T5 — per-run token usage audit + bubble chip`。

## 调用方式汇总

- 前端拿步骤:`consumeAgentStream(..., { onStep })`;拿计划:`event` 帧 `plan.updated` 或 `GET /api/chat/runs/{id}` 的 `run.plan`。
- 模型侧:chat system prompt 已引导;工具名 `plan.update`,fail-closed 注册在 chat registry。
- 其他 surface 复用:registry 加 `"plan.update"` + capability dispatch 分支即可(W7 的 Crew、W9 的 Code 模式都会用)。

## 验收门

四门全绿 + Playwright:一次多步任务中 ①step 行 ≥3 次变化且文案来自后端;②计划面板从 pending 到 done 全过程;③chip 出现且数值与审计一致;④断流(杀后端)时 UI 走 error 帧不悬挂。

## 风险与回退

- 模型不调用 plan.update → 计划面板空:属可接受(面板仅在有 plan 时出现);可在 skill 正文强化引导,**不许**前端伪造计划。
- step 帧频率过高 → UI 抖动:useChatStream 内 150ms 节流渲染(数据不丢,渲染合并)。
- 旧前端(未升级)遇到 step 帧:consumeAgentStream 未知帧已忽略,兼容。
