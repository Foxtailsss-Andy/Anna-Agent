# Anna · CONTEXT.md — 域词表与运行链路（全仓术语契约）

> **本表是全仓术语契约：改词先改这里，再改代码与文档。**
> 定案于 Trace 轮（2026-08-06，ADR-003）。词汇基准 = OpenTelemetry Trace 模型 +
> OTel GenAI semantic conventions（repo: `open-telemetry/semantic-conventions-genai`）+
> Cloudflare ADLC 六性质。自造词一律弃用（弃用清单见 ADR-003）。

## 1. 术语定案表

| Anna 里的东西 | 规范术语 | 规范命名 / 值 |
|---|---|---|
| 一次 run | **Trace** | `trace_id` = run_id |
| run 里的一轮 | **turn span** | 父子：agent → turn → 调用 |
| 一次模型调用 | **inference span** | `gen_ai.operation.name="chat"`、`gen_ai.request.model`、`gen_ai.usage.input_tokens` / `output_tokens` |
| 一次工具调用 | **execute_tool span** | `gen_ai.operation.name="execute_tool"`、`gen_ai.tool.name` |
| 整个 run 的根 | **agent span** | `gen_ai.operation.name="invoke_agent"`、`gen_ai.agent.name="anna.<surface>"` |
| 会话（一个 thread 多个 run） | conversation | `gen_ai.conversation.id` = thread_id，无 thread 回落 run_id（Q6） |
| 压缩/排队/判断层瞬时事件 | **span event** | audit 事件原名（`context.compaction.applied` 等）；**attributes 只收标量字段**（非标量按 OTel 属性合法性丢弃，见 ADR-003 附注②） |
| token/耗时/模型名等元数据 | **attribute** | `gen_ai.*` 优先；Anna 私有用 `anna.*` 前缀（如 `anna.turns`、`anna.step.intent`、`anna.orphaned`、`anna.context.percent_left`） |
| 失败分类 | attribute | `error.type` = error_code（OTel 标准名） |
| 埋点 | **instrumentation** | 只埋 3 个 chokepoint：`stream_model` / loop 工具派发 / delegate——五个 surface 全覆盖 |
| 权限 | **permission mode**（readonly / ask / contained-write / full）；审批 = **human-in-the-loop** | ADLC 原文 "Permissioned: graduated access escalation" |
| 给 agent 看的运行时仪表 | **agent-facing telemetry** | ADLC 原文 "giving agents the same observability they have in production" |

## 2. Harness-first 产品边界（2026-08-31）

本分支以 [HF-PARITY-1.0](docs/product/anna-harness-product-parity-goal-2026-08-31.md) 为当前交付范围。Home、Cowork、Crew 的既定功能与界面保留，Agent 执行权迁移到 Harness。接入实现及验收证据见 Goal，以下定义所有权。

| 概念 | 所有权 |
|---|---|
| Home | 个人对话、任务和创建产物的统一工作面，保留共享 LoopCard、历史、文件、执行控制和 Trace |
| Cowork | 确定性业务看板、业务助手和审批流程；真实业务事实来自连接器 |
| Crew | 项目 Graph、Channel、Memory，以及已有指派、产物、评审和协作规则 |
| Harness Host | 唯一 Agent 执行 authority，拥有 Run/Profile、上下文、Memory 装载、权限、持久化事件与终态 |
| Oh-my-Pi | Harness 中的模型/工具循环执行器，根据实际上下文判断下一步，通过受控工具执行 |
| Business Adapter | 复用身份、业务 CRUD、状态机和连接器；无模型凭据、无旧 Agent Loop，不独立完成 Agent 任务 |
| Product Projection | 将规范事件映射为已有界面的结果、过程、历史与产物视图；不产生第二个 Agent 事实源 |

原有 Home/Cowork/Crew 的功能保真属于当前 Goal；穷尽恢复组合、多平台和 Benchmark 等后续工作见 [社区 Backlog](docs/product/anna-harness-first-community-backlog-2026-08-31.md)。下节只保留旧实现的历史术语和证据映射。

### 2.1 Legacy Python 九跳链路（历史执行实现）

| # | 跳 | 模块 · 位置 |
|---|---|---|
| 1 | 提交 | HomePage composer → `POST /api/chat/runs[/stream]`（routes/chat.py），身份头校验 |
| 2 | 建 run | ChatOrchestrator：建 run → audit `chat.run.created` → 先持久化再跑（L2 写穿） |
| 3 | 后台驱动 | BackgroundRunManager：run 与 SSE 解耦，断线不死（P3），帧全走 journal |
| 4 | 并发闸 | concurrency.py：per-workspace 信号量（排队即 `run.queued` 入帧）+ 进程级速率桶 |
| 5 | 预检 | 模型/连接器 preflight、`skill.loaded` audit——在引擎之前 |
| 6 | 能力层 | CapabilityHandler：system prompt + 历史 + 工具面 |
| 7 | 引擎 | QueryEngine → AgentLoop：ReAct 循环（插话 J3 / step 帧 / 批钩子 / 逐个派发），终局 done / exhausted(可续) / error / awaiting_approval |
| 8 | 模型调用 | stream_model：双层压缩 → audit `model.call.*`（带 token 与 context 用量）→ 速率桶 → SSE 流式 + 首 token 前重试 |
| 9 | 判断层 | PlanGate（J1）/ Evaluator（J2）/ 插话（J3）/ 出境披露（J4），挂 6/7 的钩子 |

观测双通道贯穿 3-9：过程帧 + audit 事件 → `FrameJournal.append` 盖 `seq`+毫秒 `ts` → 内存环 + SQLite `run_frames` 写穿；audit 另经 `AuditFrameWatermark` 以 `{"type":"event"}` 帧混入同一 journal。帧词表事实源 = [A2](docs/superpowers/plans/2026-07-09-iris-rebuild/A2-frame-contract.md)。

## 3. Legacy TraceDoc 契约（`GET /api/chat/runs/{run_id}/trace`）

装配器 = `services/runtime/app/trace_assembler.py`（纯读、确定性、无墙钟），契约 gate = `tests/gates/test_gate_trace.py`（9 条）。

```json
{
  "trace_id": "<run_id>",
  "surface": "chat",
  "spans": [
    {
      "span_id": "s1", "parent_span_id": null,
      "name": "invoke_agent chat", "kind": "agent",
      "start_time": "…", "end_time": "…", "duration_ms": 19000,
      "status": "ok|error|unset",
      "attributes": { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "anna.chat",
                       "gen_ai.conversation.id": "<thread_id|run_id>", "anna.turns": 2 },
      "events": [ { "name": "frame.done", "time": "…", "attributes": { } } ]
    }
  ]
}
```

规则（全部有 gate 断言）：
- `kind ∈ agent|turn|inference|tool`，**前端类型刻意开成 `string`**——为 `invoke_agent` 子代理等未来 kind 留位；
- `duration_ms ≥ 0`；`end_time ≥ start_time`（序列化时归一）；
- **诚实规则**：token 属性只在 provider 真报时出现，缺失不补 0（前端行 chip 与摘要条同规则）；孤儿 span（started 无 completed、tool_start 无 done、审批挂起时仍开着的调用）标 `anna.orphaned=true` + status error；
- **零丢失**：未知帧类型 → `frame.<type>` span event（标量字段入 attributes），前向兼容；
- `anna.turns` 由 turn span 计数派生（生产终局帧不带 turns 字段）；
- 脱敏边界：TraceDoc 只重排已 journal 的数据，不开新敏感面；工具 args/结果原文不在帧里，未来若露必须走三级下钻既有脱敏通道。

前端：`lib/api/trace.ts`（client）→ `lib/traceSpans.ts`（纯归约 `toWaterfall`，含 Q7 判断层事件 chip：已核实名走中文映射、未知名原样直显）→ `pages/trace/TraceWaterfall.tsx` + `TraceDrawer.tsx`（HomePage 运行头「执行过程」入口）。

## 4. 方向锚（2026-08-17 Harness v2 重定位）

Anna 是频道级 Agent：每个 Channel 恰有一个 Anna，统一负责该频道的身份、判断与记忆。并行 Pipeline 是同一 Anna 管控的 Run/Lane，不是多个 Anna；Context 与 Memory 默认按 Channel 隔离，跨频道读取必须经过显式授权。业务域溶解为 connector + run profile；ERP/Hiker 为边缘连接器非核心。智能化路径 = 轮内（上下文×行动带宽×判断门）/ Run 间（记忆）/ 版本间（评测在环）三时间尺度。

## 5. Crew 协作语言（2026-08-16 定案）

**Actor**：
Crew 中可以加入频道、发表消息、被授权和被 Mention 的身份；Actor 类型只有 Human、Anna 与 Worker Profile。
_Avoid_: 用户/机器人混用、Bot

**Anna**：
一个 Channel 中唯一拥有统一身份、判断与记忆的协调 Agent；她理解频道意图并协调 Actor，但不能绕过权限与确认规则。不同 Channel 的 Anna 共享产品身份与治理规则，不共享未授权的 Context 或 Memory。
_Avoid_: 全局全知 Anna、同频道多个 Anna、Crew Manager Agent

**Channel Session**：
一个 Channel 内 Anna 的长期状态边界，包含该频道的 Context、Memory、Run 引用和授权；不同 Channel Session 默认彼此隔离。
_Avoid_: 全局共享会话、无授权跨频道上下文

**Run**：
Anna 为频道内一个明确目标启动的有界执行，具有来源、预算、停止条件和终态；同一 Channel 可以同时存在多个 Run。
_Avoid_: 无界后台任务、把模型调用等同于 Run

**Lane**：
Channel Session 中承载一个 Run 的有序执行分支；多个 Lane 可以并行，但只能通过 Proposal、Artifact 或 Gate 合并频道事实。
_Avoid_: 子 Anna、并行任务直接改写共享事实

**Memory Candidate**：
Anna 从频道工作中提议沉淀的、带来源的长期记忆候选；确认前不是 Channel Memory。
_Avoid_: 静默学习、把所有聊天记录当长期记忆

**Artifact**：
Run 产出的可评审交付物，具有类型、版本、来源 Run 和验证状态；聊天文本本身不是 Artifact。
_Avoid_: 无来源结果、覆盖历史版本

**Worker Profile**：
频道中具名、可被 Mention 的执行角色，持有明确的职责、能力和权限配置；它由该频道 Anna 的 Harness 调度，不是另一个拥有频道判断与记忆的 Anna。
_Avoid_: 子 Anna、Bot、永久自治 Agent

**Channel**：
一个成员集合明确、消息有序且可恢复的协作现场；对话、问题、回答、协调提案与执行结果都在这里形成共同事实。
_Avoid_: 临时聊天框、只读活动流

**Mention**：
频道消息中指向一个或多个 Actor ID 的结构化路由意图；显示文本不是路由事实源。
_Avoid_: 正则识别 @ 名字、仅靠消息正文重派

**Assignment**：
Anna 或 Human 交给 Worker Profile 的一项有来源、有目标、有权限约束的工作承诺，可关联任务节点但不等同于任务节点。
_Avoid_: 把频道消息直接当任务、无来源的后台作业

**Coordination Proposal**：
Anna 根据频道上下文提出的结构化协作变更；涉及改派、改图或外部副作用时，确认前不成为事实。
_Avoid_: 静默改图、用自然语言冒充已执行
