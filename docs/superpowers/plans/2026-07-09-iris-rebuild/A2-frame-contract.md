# 附录 A2 · 帧契约:现状(v1)→ Iris(v2)映射

> **v2 = `lib/frames.ts`(Iris 交接包)= 唯一目标契约**。本附录记录 2026-07-09 后端现状(v1)与 v2 的逐帧差距,
> 以及前端归一化层(normalizer,R2 切片)的映射规则。B 系列(后端梳理轮)逐步把 v2 原生化,归一化层随之收缩直至删除。
>
> **Trace 轮增补(2026-08-06)**:journal 落库帧新增两个 ADDITIVE 字段——`seq`(L3a)与毫秒 `ts`(T1b,frame_journal.py);
> 由帧流+audit 事后装配的 **TraceDoc 契约**(OTel span 树,`GET /api/chat/runs/{run_id}/trace`)登记在根
> [CONTEXT.md](../../../../CONTEXT.md) §3,装配规则 gate = tests/gates/test_gate_trace.py。

## 1. v1 现状:引擎 → SSE 管线

```
AgentLoop.run (agent_loop.py:96-293, yield 进程帧)
  → QueryEngine.run (query_engine.py:119-162, 透传)
  → orchestrator.stream_*_advance (插审计帧 watermark + 吞引擎终止帧 + 发 domain done{run})
  → routes/_sse.py:21 sse_frame() / chat.py:107-117 内联序列化 → "data: <json>\n\n"
```

流式端点(6 条):chat runs/stream(chat.py:85)、finance assistant(finance.py:55)、hiker assistant(hiker.py:26)、
报销 runs/stream(reimbursement.py:214)、报销 answers/stream(:246)、报销 approve/stream(:278,遗留路径仅审计帧)。
看板(dashboard runs)、create、associate、crew 均为同步非流式。

## 2. v1 帧词表(线上真实结构)

| type | 字段 | 备注 | 出处 |
|---|---|---|---|
| `text_delta`(chat 遗留 `delta`) | `{text}` | 单 token | agent_loop.py:169 |
| `step` | `{phase,intent,tool,turn}` | phase ∈ analyze/tool/deliver/compact;intent = 代码生成中文(ADR-002);**仅 Chat 发**(handler 需定义 humanize_step,现只有 chat/app/capability.py:240-254) | agent_loop.py:141-147 |
| `tool_start` / `tool_done` | `{name}` | **无 turn、无 ok、无 args/result** | agent_loop.py:242/244 |
| `event` | `{event:{type,run_id,payload,created_at}}` | 审计事件;所有 surface 都有 | event_stream.py:73-81 |
| `awaiting_approval` | `{reason,detail}` | 报销 detail={approval_id} | agent_loop.py:255-259 |
| `done` | `{run:<domain run model_dump>}` | 失败 run 也走 done(status:"failed") | 各 orchestrator |
| `error` | chat:`{run}`;其余仅意外异常:`{message}` | 错误信道分裂 | chat/orchestrator.py:213-216 等 |

**藏在审计事件里的真数据**(归一化层要挖):

- `plan.updated`:payload `{count,done_count,items:[{id,title,status}]}`(chat/app/capability.py:194-199,仅 Chat)
- `model.call.started`:payload 含 `model_name`、`context_token_count`、`context_percent_left`(streaming_model.py:160-176)→ **W5 CTX 环真数据源**
- `model.call.completed`:payload 含 `input_tokens`/`output_tokens`(provider 真报才有,streaming_model.py:289-292)→ usage 真数据源
- `mcp.tool.called`:payload `{tool_name,input_hash,status,error?}`(mcp_dispatcher.py:135-142)→ tool_done 的 `ok` 判定源(**只有 hash,无原文**)

## 3. 逐帧差距判定

| Iris v2 帧 | 后端现状 | 判定 |
|---|---|---|
| `step{phase,intent,turn}` | 名义匹配(多 `tool` 字段);覆盖面仅 Chat | 部分有 |
| `thinking{delta,turn}` | 完全缺。provider payload 已开 thinking,但 `_parse_sse_line` 只取 `delta.content`,`reasoning_content` 被丢弃(streaming_model.py:240) | 完全缺(B1) |
| `plan.updated{plan[]}` | 埋在 event 帧 payload 里,仅 Chat | 部分有(归一化可解) |
| `text_delta{delta}` | 有,字段名 `text`(chat 另有遗留 type `delta`) | 字段名差异 |
| `tool_start{tool,turn}` | `{name}`,无 turn | 部分有 |
| `tool_done{tool,ok,turn,drilldown}` | `{name}`;ok 可从审计 mcp.tool.called 推;**drilldown 整块缺**(原文不上 wire、审计只有 hash) | 大部分缺(B2) |
| `event{name}` | 有(超集,`event.type` 即 name) | 有 |
| `awaiting_approval{reason,detail}` | 有,字段一致 | 有 |
| `done{run{runId,artifacts,plan,usage,durationMs}}` | `run.id`≠`runId`;artifacts/plan 仅 ChatRun 有;usage 只在审计;无 durationMs | 部分有 |
| `error{message,provider,retryable,consumedTokens}` | 分裂:chat error{run} / 其余 done{run.status=failed} 或 error{message};三字段缺 | 部分有 |

## 4. 归一化层映射规则(R2 切片实现,`lib/api/normalize.ts`)

**纪律:只做真数据的形态映射与解包,禁止编造**(ADR-002/诚实红线)。归一化器是有状态的
(`createNormalizer()` 返回 `(raw) => Frame[]`),内部跟踪:当前 turn(最近 step.turn,缺省 1)、
最近一次 `mcp.tool.called` 状态(按 tool_name)、usage 累计(来自 model.call.* 审计)、首帧时间。

| v1 输入 | v2 输出 | 规则 |
|---|---|---|
| `{type:"step",...}` | `StepFrame` 原样 | 更新 ctx.turn = frame.turn |
| `{type:"delta"\|"text_delta",text}` | `TextDeltaFrame{delta:text,turn:ctx.turn}` | 改名 |
| `{type:"tool_start",name}` | `ToolStartFrame{tool:name,turn:ctx.turn}` | 注入 turn |
| `{type:"tool_done",name}` | `ToolDoneFrame{tool:name,ok,turn:ctx.turn}` | `ok` = 最近 `mcp.tool.called{tool_name=name}.status !== "error"`,查无审计则 true;**drilldown 不填**(无 L3 → LoopCard 不出箭头,正确降级) |
| `{type:"event",event}` 且 `event.type==="plan.updated"` | `PlanUpdatedFrame{plan:event.payload.items}` | 解包真计划;不再另发 EventFrame |
| `{type:"event",event}` 其他 | `EventFrame{name:event.type,at:Date.parse(event.created_at)}` | model.call.* / mcp.tool.called 同时喂 ctx(usage/ok),仍原样发 EventFrame(系统步,审计可见) |
| `{type:"awaiting_approval",...}` | `AwaitingApprovalFrame` 原样 + turn=ctx.turn | — |
| `{type:"done",run}` 且 run.status!=="failed" | `DoneFrame{run:{runId:run.id, artifacts:run.artifacts??[], plan:run.plan??[], usage:ctx.usage, durationMs:ctx.elapsed}}` | usage.tokens = Σ审计 in+out(无审计→null,不显示);durationMs 前端计时 |
| `{type:"done",run}` 且 run.status==="failed" | `ErrorFrame{message:run.error_message??run.error_code, consumedTokens:ctx.usage.tokens}` | 失败 run 收敛为 error 帧(只发 error,不发 done) |
| `{type:"error",run\|message}` | `ErrorFrame{message:run?.error_message??message??"unknown_error", consumedTokens:ctx.usage.tokens}` | — |
| 未知 type | 丢弃 + console.warn | 前向兼容 |

**实现前必验**(R2 切片第一步):用真实后端捕一段 chat 流存 fixture,确认 `mcp.tool.called` 审计帧与
`tool_done` 引擎帧的先后顺序(watermark 插帧时机),据此定 `ok` 判定的查表方向;fixture 进 vitest。

## 5. B 系列后端原生化路线(下轮「后端梳理」执行,详见 10-backend-roadmap.md)

- **B0(可并入本轮,小)**:给 finance/hiker/reimbursement 三个 handler 补 `humanize_step`(照抄 chat/app/capability.py:240-254 模式)→ step 帧全 surface 覆盖;LoopCard 副驾/报销才有「当下行」。
- **B1**:引擎原生发 v2 帧(text→delta 改名、tool 帧带 turn/ok、thinking 帧解析 reasoning_content、plan.updated 升一等帧、done.run 带 usage/durationMs、error 统一 {message,provider,retryable,consumedTokens})。加 `?frames=v2` 或 Accept 头协商,归一化层按帧形状自动直通。
- **B2**:L3 下钻通道(稳定 stepId + 每步 raw args/result 落库 + 脱敏门 + `GET /api/<domain>/runs/{runId}/steps/{stepId}/full` + truncated/restricted 元数据)——`onLoadFull` 接这里。
- **B3**:ChatRun 持久化(现为进程内存,重启即失,chat/orchestrator.py:116)+ 跨域产物索引(产物中心真正的一等数据源)+ SSE 断线 resume。
