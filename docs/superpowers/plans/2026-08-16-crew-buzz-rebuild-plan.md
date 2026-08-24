# Crew × Buzz 高可用重建计划

> 2026-08-16。目标不是给旧 Crew 加一层皮，而是让 Anna 成为真正的频道协调者：人和 Worker Profile 能在同一频道协作，Mention 不丢、执行可恢复、副作用可解释、Loop 可替换。

## 冻结决策

- Anna 是唯一协调 Agent；Scribe、Design、Engineer、Check 等是具名 Worker Profile Actor。
- Worker Profile 可加入频道、发言、被结构化 Mention；权限、模型、工具和预算由 Profile 在 Harness 内解析。
- Crew 拥有 Project、Task、Channel、Mention、Approval；它不认识 QueryEngine 或 Pi 类型。
- `AgentExecution` 是运行事实源；CrewTask、频道消息、通知、Trace 都是投影。
- External interface 只有 `dispatch(command)`、`get(execution_id)`、`read_events(execution_id, cursor)`。
- Start、Steer、Answer、Cancel、Redrive 都先持久化再确认；终态不可复活，追问创建 linked execution。
- 单机高可用目标先用 SQLite + lease/fencing；多实例以后替换 Store Adapter。
- 吸收 Buzz 契约，不 fork Buzz 技术栈；Pi 先做 Adapter canary，不直接替换 Python Loop。

## 目标用户路径

1. Human 在频道中 `@Scribe`；Mention 以 Actor ID 落库，重复投递只创建一个 Execution。
2. Anna 根据频道、任务、项目共识和权限构建 Assignment，选择 Worker Profile 并排队。
3. Worker 可在频道提问、报告进度、交付或明确失败；每条消息都有 execution/message provenance。
4. Human 在 Worker 运行中补充信息时形成 durable Steer；等待输入时的回答形成 Answer 并安全续跑。
5. 重启后 Execution 从最后安全 checkpoint 恢复；事件 seq、累计预算和副作用账本不重置。
6. 外部写需要确认与 idempotency key；结果未知时进入人工处理，不自动重放。

## 阶段与验收

### P0 · 基线清零

- 删除 Finance 清理后测试夹具里残留的 ERP adapter 构造参数。
- Crew、Runtime concurrency、全量 Python/前端四门回绿。

验收：`tests/runtime/test_concurrency.py` 全绿；不把已知红灯带入新内核。

### P1 · Durable AgentExecution Kernel

- 定义 command、snapshot、event、error、state vocabulary。
- SQLite 表覆盖 executions、commands/inbox、events/outbox、attempt/lease、checkpoint、effect ledger。
- 实现幂等 dispatch、version/CAS、严格 seq、单终局、claim/heartbeat/fencing、startup reconciliation。
- 建 ScriptedLoopAdapter 与 interface contract/fault-injection tests。

验收：重复 Start/Signal 不重复；双 Worker 抢占只有一个 fencing token 有效；任意事务失败不产生半状态；kill/restart 后无 zombie。

### P2 · 替换 Crew 旧调度

- QueryEngineLoopAdapter 接入现有 Python Loop。
- 频道 Mention 先落库，再 dispatch Execution；指令原文和 message_id 进入 RunSpec。
- 新内核达到 run-agent parity 后删除 `CrewBackgroundRunManager` 与进程内 `_inflight_by_task`。
- CrewTask、频道、通知和 Trace 改为消费 execution outbox 的幂等投影。

验收：两个并行任务均保留结果；并发 Human 操作不被旧 Project JSON 覆盖；重复 POST 返回同一 execution；重启后继续或诚实进入等待状态。

### P3 · Buzz 式频道协作

- ChannelAuthorKind 增加 worker；Mention 只以 Actor ID 路由。
- 建 task thread、question/answer、progress、coordination proposal、review history。
- `@Human` 只通知；`@Worker` dispatch/steer；`@Anna` 产生协调提案。
- 只读动作可自动执行；改派、改图、文件/命令写入与外部副作用走确认规则。

验收：Worker 听得到触发消息与相关 thread；能提问并在回答后续跑；运行中补充不静默丢失；所有状态变更在频道可见。

### P4 · Loop 与 Harness 深化

- 统一 typed AgentEvent、context transform、before/after Tool hooks、steering/follow-up、cancel 和 safe checkpoint。
- 累计 turn/token/cost/wall-time budget 跨 retry/continue 不重置。
- Tool Policy 将安全读与有副作用写区分；写操作按 resource key 串行并记录 effect id。
- decomposition、command drafting、worker execution 全部跨同一 AgentExecution seam，删除旁路模型调用。

验收：工具错误可观察并能自愈；截断 Tool 参数不执行；预算触顶进入可解释等待；取消后完整回收 Windows 进程树。

### P5 · Pi Adapter Canary

- Pin Pi 版本，通过 JSONL/RPC 子进程 Adapter 映射到 Anna 事件词表。
- PythonLoopAdapter 与 PiLoopAdapter 跑同一 conformance suite 和真实 Crew eval。
- 比较任务完成率、追问恢复率、重复副作用率、预算、延迟、成本、Trace 完整性。

验收：只有 Pi 在预先冻结指标上显著胜出才扩大流量；活动 Execution 不跨 Adapter 热迁移。

### P6 · 故障注入与交付门

- 注入 claim 后崩溃、模型中断、checkpoint 后崩溃、Tool 结果未知、投影失败、重复 Mention、队列满、断线重放、并发更新等故障。
- 所有失败必须形成可恢复状态或可见终局，禁止静默丢消息、伪成功和无限重试。
- 完成 UI、API、Trace、Windows Electron 真机验收。

验收：核心不变量通过 deterministic tests；本地重启演练和完整用户路径通过；四门全绿。

## 明确不做

- 不移植 Buzz 的 Nostr、Rust relay、Tauri、Postgres/Redis/S3 技术栈。
- 不把 Worker Profile 伪装成拥有独立全局权限和记忆的第二个 Anna。
- 不把 asyncio dict、内存队列或 UI loading 状态称作高可用。
- 不为了兼容旧 manager 保留双重运行真相。
- 不宣称 Connector 外部写 exactly-once；未知结果必须人工确认。
