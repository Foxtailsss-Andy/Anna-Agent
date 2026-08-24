# Claude Tag × Buzz × Anna 开发分流门

> 日期：2026-08-17  
> 状态：Crew 冻结决策已接受；Harness v2 设计中  
> 目的：在继续 Crew 功能开发前，判断瓶颈位于 Crew 产品层，还是 Anna 的 Harness / Agent Loop / Durable Runtime。

## 1. 北极星

Anna 维持“恰一个 Anna：身份 + 判断 + 记忆”。Crew 中的 Worker Profile 是 Anna Harness 调度的具名执行角色，不扩张为多个拥有全局身份与记忆的独立 Anna。

Claude Tag 提供四项对标要求：

1. 多人共享同一个 AI 协作者；
2. 可审计、可授权、可删除的长期记忆与持续学习；
3. 在明确边界内主动发现、跟进和提醒；
4. 异步执行、自我安排后续动作，并跨小时、跨天恢复。

Buzz 只作为可验证的架构参考：频道事实源、Agent/Human 身份、事件日志、Activity Feed、Workflow/Schedule、ACP/MCP 和多 Agent E2E。默认不引入 Nostr、keypair、relay 或“多个自治 Bot”的产品模型。

## 2. 当前证据

### 已通过

- 模型最小调用：`deepseek-v4-pro` 1.63 秒返回，Provider 报告真实 Token usage。
- 最小 Crew Worker：5 秒完成，产出 282 字 Artifact、1 个版本、163 个 frame；frame 含 `event / step / text_delta / done`；项目 memory ID 进入执行证据。
- 多人链路：Boss 与 Andy 使用独立身份；频道消息共享；Andy 收到通知。
- 自动触发：Boss 通过评审后，没有调用 `run-agent`，预指派 Agent 自动进入 Execution。
- 重启恢复：Project、Memory 与 Execution event 在 backend 重启后仍可读取。
- Durable Runtime 已有 queue、lease、heartbeat、fencing、checkpoint、retry、DLQ、startup reconcile、outbox 和 effect ledger。

### 未通过

- 多角色复杂项目的设计 Worker 在 90 秒内一直是 `running`，没有 Artifact。
- Worker Adapter 在 `engine.run()` 内把 frame 累积在进程内列表，Loop 返回后才一次性写入 `LoopResult.events`；长任务执行中只看得到 started/claimed，无法持久观察第一处偏离。
- 进程重启会取消当前 Adapter 并重新排队，但中间 frame 未成为 durable event；长任务可能重复付费、重复推理，且无法证明从安全 checkpoint 继续。
- `StartExecution` 没有 wall-time、turn、token、cost、tool-call 累计预算。
- `@Anna` 协调草案仍走裸 `asyncio.create_task`，重启可能丢失。
- ToolGateway、Permission、approval resume、Sandbox 尚未进入主执行路径。
- 没有 Self-schedule、Wake Condition、跨频道 Memory Policy 或 ambient scan。

## 3. 初步架构裁定

### 不是当前首要瓶颈

- **模型连接**：最小调用和最小 Crew Worker 均已成功。
- **基本 Agent Loop**：短任务可完成、可产出 Artifact、可记录 Memory hit。
- **Crew UI / 项目状态机**：多人、评审、通知、自动解锁和投影已经足以承载下一轮底层验证。

### 当前首要瓶颈

首要瓶颈位于 **Harness 的长程执行接线**，具体是：

1. 执行中 frame 没有增量进入 durable event；
2. 缺少累计预算与 wall-time deadline；
3. restart 只能重排，不能证明从可验证 checkpoint 继续；
4. Planning、Schedule、Tool/Permission 仍有旁路或缺口。

因此建议冻结新的 Crew 页面与交互功能，先进入 Harness H0。不是推翻现有 AgentExecution，而是补齐其 production Loop 接线。

## 4. 推荐开发切片

### H0：Long-run observability and termination

只解决已观察到的因果链，不同时扩张 Scheduler、ToolGateway 和跨频道 Memory：

1. QueryEngine 执行 frame 增量持久化为 typed `AgentEvent`，API cursor 可在运行中读取；
2. 为 Execution 增加可快照的 wall-time / turn budget，达到上限必须进入明确终态或可续状态；
3. restart 前后保留 attempt、checkpoint、已持久 frame 和终态唯一性；
4. 增加 blocking/slow Adapter、kill/restart 和超时测试；
5. 用固定模型、固定任务、固定预算复跑“最小任务 + 复杂任务”，从第一处分歧归因。

H0 通过后再进入：

- H1：Durable Planning + Self-schedule / Wake Condition；
- H2：ToolGateway + Permission + approval Signal + Sandbox；
- H3：Channel / Workspace Memory distillation、授权、删除与 provenance；
- C1：Claude Tag 式 Crew 场景与 Activity Feed。

## 5. H0 发布门

必须同时满足：

1. 执行开始后 2 秒内能通过 cursor 看到增量 event，不等待 Loop 终结；
2. 固定最小任务在预算内产出唯一 Artifact；
3. 固定复杂任务在 120 秒内 `succeeded / awaiting_signal / failed / timed_out` 四者之一，禁止无界 `running`；
4. model call 中 kill backend，重启后不丢已持久事件，不出现两个 terminal event；
5. 重试、重启、late Signal 不产生重复 Artifact；
6. 缺失 provider usage 时保持 unknown，不补零；
7. 现有 TypeScript、Vitest、Pytest、build 四门继续通过。

## 6. Grill Round 1 决策

等待用户确认：

- D1：是否现在冻结 Crew 新功能并转入 Harness H0；
- D2：H0 是否保持最小范围，不同时实现 Scheduler / ToolGateway；
- D3：是否采用本文的 120 秒终态门与运行中可见性门；
- D4：Buzz 是否只吸收模式与测试，不引入其协议/身份底座；
- D5：Subagent 开发前，如何保护 Computer-3 的大批未提交修改。

确认后执行顺序：GPT-5.5 high 开发；GPT-5.6 Sol xhigh 独立评审；根据评审结论修复和复验。

## 7. 2026-08-17 用户裁定

1. Anna 继续对标 Claude Tag 的频道协作模型：一个 Anna 管控频道，成员共享其工作过程并可补充、纠偏。
2. Crew 阶段开发立即冻结。本文与现有 Crew 场景、测试、路线图保留为未来验收依据，不继续向 Crew 页面或状态机叠加新能力。
3. 全面转向 Harness 优化；优先判断并替换底层 Agent Loop、Tool、Skill、Memory、Eval、Sandbox 与 Trace 链路。
4. Pi 是候选 Loop Kernel。具体采用 `pi-agent-core`、稳定 `coding-agent AgentSession`，还是尚在建设的 `AgentHarness v2`，必须经源码与原型门裁定，不从产品名直接推导。
5. Harness 完成后，Crew 只有在以下条件同时满足时恢复：长任务增量可观测、终态有界、重启可续、Tool/Permission/Sandbox 成立、Memory/Eval/Trace 可验收。

“一个 Anna 管控频道”与当前 `CONTEXT.md` 的“全产品恰一个 Anna”存在术语歧义。暂记录为待裁定：推荐保留一个 Anna 身份与治理策略，每个频道创建一个隔离的 Channel Session，而不是创建多个拥有全局身份与记忆的 Anna。
