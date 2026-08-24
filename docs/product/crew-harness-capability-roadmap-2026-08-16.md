# Crew × Harness 能力路线图

> 日期：2026-08-16。状态：工程基线与下一切片决策。本文只记录当前代码可证明的能力；ShowcaseSession 隔离尚未完成。

## 1. 当前结论

Crew 的正确方向不是继续在页面、CrewService、QueryEngine 外围叠加调度逻辑，而是让 `AgentExecution` 成为唯一运行事实源：Crew 只拥有 Project、Task、Channel、Mention、Approval，并把执行结果投影为任务、频道、通知和 Artifact。`AgentExecution` 的外部 interface 保持 `dispatch / get / read_events`，复杂度收进 implementation（`services/runtime/app/execution/kernel.py:11-40`）。

当前 Showcase 已收敛为**用户显式点击后物化的 deterministic 本地案例**，不再自动写入。`POST /api/crew/showcase/ensure` 才触发创建（`services/api/app/routes/crew.py:546-575`），桌面端把入口描述为“点击后写入本地工作区，并始终标记为示例数据”（`apps/desktop/src/pages/crew/CrewProjectsPage.tsx:181-188`）。案例仍写入主 `SQLiteCrewStore` 的 Project 与 Channel，但 Project 带 `source="showcase"` 和结构化 scenario metadata（`services/crew/app/showcase.py:149-167`）；seeded Channel 全部由 Anna 发出，`run_ref / worker_profile_ref / caused_by_execution_id` 均为空且 payload 带 `source="showcase"`（`services/crew/app/showcase.py:237-264`; `tests/crew/test_showcase.py:71-85`）。它不写 Notification，也不伪装真实 Worker 或 Execution；Inbox 与 Approvals 的 actionable 聚合已按 `source` 排除 Showcase（`services/api/app/routes/crew.py:859-924`; `tests/api/test_crew_api.py:1697-1720`），Team 页面计算成员负载和 owner 待处理数时也只消费 operational projects（`apps/desktop/src/pages/crew/teamModel.ts:35-50`; `apps/desktop/src/pages/crew/CrewTeamPage.tsx:105-106,139-142`; `apps/desktop/src/pages/crew/__tests__/teamModel.test.ts:62-90`）。

这版实现是诚实、可识别的 seeded preview，但还不是隔离的 `ShowcaseSession`，也没有经过真实 `AgentExecution -> outbox -> Crew projection`。下一切片仍应把案例移到独立存储，并通过真实耐久执行路径展示交互；只有 Loop 使用 deterministic `ScriptedLoopAdapter + ManualClock`。它证明的是产品流程、耐久性和投影契约，不是 live provider 的模型质量、Token、成本或延迟证据。当前 `run_ref` 与 execution provenance 为空，下一切片应由本 Session 内真实 seeded execution 补齐，而不是伪造。

## 2. 已具备且可复用的能力

- **耐久执行内核**：状态、Signal、Snapshot、Checkpoint、Attempt、Lease、`not_before` 已进入执行模型（`services/runtime/app/execution/models.py:7-130`）；Driver 通过小型 `LoopAdapter.run(snapshot, signals)` seam 执行（`services/runtime/app/execution/driver.py:77-113`）。
- **单机恢复纪律**：SQLite Store 已有 claim/lease/fencing、事务提交、delayed retry、DLQ、startup reconcile、outbox HOL 和 tool-effect ledger（`services/runtime/app/execution/store.py:261-389,428-700,727-909`）。故障测试覆盖 retry 回滚、DLQ 单终局、延迟取消、重启保留、unknown effect 和 outbox reclaim（`tests/runtime/test_agent_execution_retry.py:144-199,275-357,489-708`）。
- **Crew 耐久 Worker 路径**：`QueryEngineLoopAdapter` 已从 Crew 状态组装 Context，经 QueryEngine 执行，并把变更留给 execution outbox projector（`services/crew/app/agent_worker.py:593-631`）。
- **HITL 基础路径**：`crew.ask_human` 可进入 durable checkpoint，`answer` Signal 可恢复原模型会话；`steer` 可随执行消费（`services/crew/app/agent_worker.py:602-605,627-689`）。
- **上下文基础**：Worker Context 已包含目标、任务、验收标准、触发指令、返工要求、上游 Artifact、项目共识和运行中补充（`services/crew/app/agent_worker.py:163-251`）；模型调用前已有压缩与 context usage audit（`services/runtime/app/engine/streaming_model.py:135-195`）。
- **Crew 投影**：执行 outbox 可幂等投影为任务状态、频道消息、通知和 Artifact；投影事务失败不 ack（`services/crew/app/execution_projection.py:54-131`; `tests/crew/test_execution_projection.py:187-218,725-775`）。
- **可替换 Loop seam**：已有 production Python Adapter 与 deterministic Scripted Adapter，符合“两种 Adapter 才形成真实 seam”的条件；Pi 可在同一 seam 做 canary，而无需替换 `AgentExecution`。

以上是“代码中存在并有局部测试覆盖”，不等于 live provider 长任务已经通过。任何模型质量、成本或长时恢复结论仍需真实任务 Trace 与 kill/restart 验收。

## 3. 目标 deep modules

```python
class AgentExecution:
    async def dispatch(command: ExecutionCommand) -> ExecutionSnapshot: ...
    async def get(execution_id: str) -> ExecutionSnapshot: ...
    async def read_events(execution_id: str, after_seq: int = 0) -> list[AgentEvent]: ...

class RunProfileRouter:
    def resolve(run_profile_ref: str, worker_profile_ref: str) -> ResolvedRunProfile: ...

class WorkerProfileCatalog:
    def get(worker_profile_ref: str) -> WorkerProfile: ...

class ToolGateway:
    async def invoke(call: ToolCall, context: ExecutionContext) -> ToolResult: ...

class LoopAdapter:
    async def run(snapshot: ExecutionSnapshot, signals: list[PendingSignal]) -> LoopResult: ...
```

职责必须集中：

- `AgentExecution`：命令幂等、队列、lease/fencing、Signal、Checkpoint、累计预算、retry/DLQ、effect ledger、typed event、outbox。
- `RunProfileRouter`：把 `run_profile_ref` 解析为 Loop Adapter、模型策略、Context 策略、预算策略和 Eval 策略；调用者不能自行拼装。
- `WorkerProfileCatalog`：把 Worker Profile 解析为角色指令、允许工具、Permission Mode、Artifact 契约和默认模型档位。
- `ToolGateway`：统一 schema 校验、策略判断、审批、Sandbox、resource-key 串行、idempotency/effect ledger、结果审计；Loop 不直接调用真实工具。
- `LoopAdapter`：只负责 Agent Loop 语义。Python 是默认 Adapter；Pi 仅作为固定版本的 JSONL/RPC Adapter canary，先跑同一 conformance suite，不承担权限、预算、恢复或事实存储。

## 4. P0 / P1 / P2 能力矩阵

“已实现”只表示对应范围有实现；“基础设施未接生产”表示底层结构存在，但主用户路径没有完整穿过；“缺失”表示尚无可验收闭环。

| 能力 | 优先级 / 现状 | 当前代码证据 | 目标 interface | 最小验收测试 |
|---|---|---|---|---|
| Loop | **P0 · 已实现（局部）** | `AgentLoop.run` 支持模型流、Tool round、steer 与 suspend，但 recovery ladder/token budget 明确不在其范围（`services/runtime/app/engine/agent_loop.py:24,119-398`）；Crew 已接 `QueryEngineLoopAdapter`（`services/crew/app/agent_worker.py:593-631`）。 | 所有 decomposition、协调提案、Worker 执行统一经 `AgentExecution`；Adapter 只返回 `LoopResult` 和 typed events。 | 同一 conformance suite 跑 Scripted/Python Adapter；截断 Tool 参数不执行；模型中断后只从 safe checkpoint 恢复；无旁路模型调用。 |
| Context | **P1 · 已实现（局部）** | `CrewWorkerContextAssembler` 已组装目标、AC、返工、上游 Artifact、共识与 steer（`services/crew/app/agent_worker.py:163-251`）；压缩审计存在（`services/runtime/app/engine/streaming_model.py:135-195`）。 | `RunProfile` 声明 context transform 链；输入输出形成 `context.*` AgentEvent，并保留 source/thread provenance。 | 给定同一 Snapshot 得到稳定 Context；Answer/Steer 不丢；压缩后仍保留目标、约束和待回复 Tool call；Trace 可还原变换。 |
| Tool | **P0 · 基础设施未接生产** | Crew Worker 当前只有 `crew.ask_human`（`services/crew/app/agent_worker.py:40-73,303-405`）；Store 有 effect ledger，但普通工具调用尚未统一经过它（`services/runtime/app/execution/store.py:850-909`）。 | `ToolGateway.invoke(call, context)` 隐藏 schema、policy、approval、sandbox、effect ledger 和审计。 | 读工具自动执行；写工具生成 approval；相同 effect key 至多一次；unknown outcome 可见且不自动重放；Tool error 作为结果返回 Loop。 |
| Permission | **P0 · 缺失（仅有词表）** | Execution Signal 包含 `approval`（`services/runtime/app/execution/models.py:15,37-43`），但 Crew Adapter 明确不支持并保持 pending（`services/crew/app/agent_worker.py:602-606,638-645`）。 | `WorkerProfile.permission_mode + ToolPolicyDecision` 由 ToolGateway 解析，审批通过 durable `SignalExecution(kind="approval")` 恢复。 | deny 永不触发副作用；ask 在批准前零副作用；重复批准幂等；拒绝/超时形成可解释终局；审批后重启可续跑。 |
| Sandbox | **P2 · 缺失** | 当前 Crew handler 是只读生成器，并非 OS 级隔离（`services/crew/app/agent_worker.py:303-405`）；目标计划仍把“取消后回收 Windows 进程树”列为待验收（`docs/superpowers/plans/2026-08-16-crew-buzz-rebuild-plan.md:63-68`）。 | `SandboxAdapter.execute(spec)` 作为 ToolGateway 内部 seam；Windows Job Object/受限工作目录为 production Adapter，fake 为测试 Adapter。 | 越界路径、未授权网络和环境变量读取被拒绝；cancel/timeout 后子进程树归零；工作区改动可枚举并可审查。 |
| Memory | **P1 · 已实现（局部）** | Context 可读取 project-scope 共识并记录 memory hit ID（`services/crew/app/agent_worker.py:195-207`），但无跨 Execution 的统一写入、检索门与遗忘策略。 | `RunProfile` 选择 Memory Policy；Context 只消费带 provenance 的 hits，写入通过显式 Tool/Artifact 事件。 | 项目隔离；检索命中可审计；失败/Showcase 不污染真实记忆；重启后命中稳定；删除/过期可验证。 |
| Planning | **P1 · 基础设施未接生产** | `@Anna` 可触发协调提案，但路由仍用裸 `asyncio.create_task`，重启可丢（`services/api/app/routes/crew.py:752-772`）。 | Planning 是一个 `run_profile_ref`，产出 typed `CoordinationProposal` Artifact；确认后再以 commands 启动子 Execution。 | 重复 Mention 只生成一份提案；进程在 draft 中途退出后可恢复；未确认不改图；确认产生可追溯且幂等的任务命令。 |
| Eval | **P1 · 基础设施未接生产** | 有全局 `evaluation_enabled/max_continuations` 配置（`services/runtime/app/config.py:59-64`），但未成为每个 RunProfile 的 durable gate，也未跨 retry 累计。 | `RunProfile.eval_policy` 返回 `pass/revise/escalate` typed event；Eval 使用同一预算账本，不直接改变 Crew。 | 固定 Artifact/rubric 得到确定 gate 结果；最多 N 次 revise；评估失败可见；禁用 Eval 不产生隐藏模型调用。 |
| Observability | **P0 · 基础设施未接生产** | Execution 有严格 seq event/outbox，Frames route 读取事件（`services/api/app/routes/crew.py:735-741`）；Worker 收集 frames/audit_events，但未完整进入 durable `LoopResult.events`（`services/crew/app/agent_worker.py:817-829,1178-1194`）。 | 单一 typed `AgentEvent` 词表映射 Trace/Frames/Crew 投影；未知事件仍可见，不降级为空。 | 每次 model/tool/context/retry/approval 有 execution_id、seq、attempt、trace/span；缺 Token 显示 unknown；API 游标重放无缺失/重复。 |
| Recovery | **P0 · 已实现（内核），工具接线未完成** | retry/DLQ/startup reconcile/effect blocker 已在 Store（`services/runtime/app/execution/store.py:592-777,1348-1526`）；故障测试覆盖事务回滚、单终局、重启和 unknown effect（`tests/runtime/test_agent_execution_retry.py:144-357,675-708`）。 | `AgentExecution` 保持唯一恢复决策者；ToolGateway 在调用前/后记录 effect 状态；Adapter 只能声明 `safe_to_retry`。 | claim 后 kill、checkpoint 后 kill、投影失败、late Signal、unknown effect 全部得到可恢复状态或可见终局；无 zombie、半写和重复副作用。 |
| Coordination | **P0 · 基础设施未接生产** | Crew Start/Steer/Answer 已 dispatch 到 Execution（`services/api/app/routes/crew.py:395-495`），但 `@Anna` draft 仍有进程内旁路（`services/api/app/routes/crew.py:761-772`）。 | Mention 先持久化；Anna coordination 与 Worker run 都是 AgentExecution；Crew 只投影 commands/events。 | 两个并行 Worker 结果都保留；运行中补充不丢；重复 POST/Mention 幂等；重启后 proposal/question/review 仍可继续。 |
| Artifacts | **P1 · 已实现（文本单产物）** | Crew schema 已有 Artifact 版本字段，projection 可投影提交与返工（`services/crew/app/schemas.py:13-23,39-42`; `services/crew/app/execution_projection.py:134-389`）。 | `ArtifactManifest` 统一 kind、uri/blob ref、media type、hash、version、producer execution、review state；内容与事件分离。 | v1 驳回后 v2 不覆盖历史；hash/producer 可验证；大文件不塞 event payload；并行提交无 last-write-wins。 |
| Model routing | **P1 · 基础设施未接生产** | Runtime 有 model profile 解析（`services/runtime/app/config.py:89-132`），Crew 有 role→handler resolver（`services/crew/app/agent_worker.py:411-437`），二者尚未收敛为按 Run/Worker/预算解析的单一路由。 | `RunProfileRouter.resolve()` 合并 RunProfile、WorkerProfile、workspace policy，产出固定 `ResolvedRunProfile`；执行中不热迁移 Adapter。 | 相同输入解析稳定；禁用模型不可选；fallback 产生事件；Worker 不得越过允许模型/工具；配置快照随 Execution 保留。 |
| Budget | **P0 · 缺失（仅单次配置/usage audit）** | provider usage 只在收到 usage frame 时写 audit（`services/runtime/app/engine/streaming_model.py:315-320`）；`StartExecution` 没有 turn/token/cost/wall-time policy 字段（`services/runtime/app/execution/models.py:24-34`）。 | `BudgetPolicy + BudgetLedger` 归 `AgentExecution`，累计 turn/input/output token/cost/wall time/tool calls，跨 retry/resume/continue 不重置。 | 达限前拒绝下一次昂贵动作；缺 usage 不伪造 0；retry/Answer 后累计值不回退；触顶进入可解释 waiting/terminal，Trace 与 UI 一致。 |

## 5. 下一切片：隔离 ShowcaseSession

### 5.1 Interface 与不变量

```python
class CrewShowcaseModule:
    async def open(command: OpenShowcase) -> ShowcaseView: ...
    async def dispatch(command: ShowcaseCommand) -> ShowcaseView: ...
    async def read_events(session_id: str, after_seq: int = 0) -> list[ShowcaseEvent]: ...
```

`ShowcaseCommand` 是封闭 union：`PostMention | ConfirmCoordinationProposal | AnswerWorker | ReviewArtifact | InjectRecoveryFault | ResetShowcase`。Reset 作为 command，不增加第四个方法。

必须满足：

1. 每次体验创建独立 `.anna/showcase/<session_id>/` 数据库；不进入真实 Project、Inbox、Notification、Memory、Usage 查询。
2. 使用真实 AgentExecution、outbox 和 Crew projection；仅把 Loop Adapter 换成 deterministic Scripted Adapter，并注入 ManualClock，测试不得真实 sleep。
3. UI 始终显示 `scripted_runtime` 标签；只有 live provider canary 才可显示 `live_provider`。Seeded 事件不得伪造 Token、成本、模型名或 Trace 质量。
4. 所有 Worker 消息、Question、Artifact、Retry、DLQ 都引用本 session 内真实 execution_id，不使用拼接伪 ID。
5. “创建真实项目”必须是结尾显式确认动作，只复制模板/目标，不复制演示通知、记忆、用量或执行历史。
6. `ResetShowcase` 只删除已解析且位于 showcase 根目录内的 session；不可触碰主 Crew DB。

### 5.2 验收

- 空 Crew 自动展示 launcher，但 `GET /api/crew/projects` 仍为空；打开、重置 Showcase 后真实项目/收件箱/通知/记忆/用量均不变。
- 同一 scenario version + command sequence 产生相同业务事件序列；execution_id 可不同，但引用闭合。
- 关闭应用并重启后可从同一 ShowcaseSession 恢复；delayed retry 只在 ManualClock 前进后 claim。
- 在 retry 前、checkpoint 后、projection commit 前注入故障，均无半状态；最终只出现一个 terminal event。
- “创建真实项目”前必须确认；确认后真实空间只多一个干净的新项目。

## 6. 3–5 分钟 Demo storyboard

| 时间 | 用户动作 | 可见反馈 | 所证明的能力 |
|---|---|---|---|
| 0:00–0:30 | 空 Crew 点击“体验周会行动项闭环” | 进入确定性内置案例；真实团队负载和 Inbox 不被污染 | 无污染首次体验、证据边界诚实 |
| 0:30–1:10 | 查看 `@Anna` 如何把零散周会记录推进成可评审流程 | Anna 生成行动项、协作看板、数据核对、纪要评审和下游同步的依赖图 | 结构化 Mention、Planning Artifact、可确认协调 |
| 1:10–1:40 | 打开周会原始纪要 | Anna 把“查激活率、补培训材料、统一账单权限”拆成可追踪行动项 | 信息归档、任务抽取、事实边界 |
| 1:40–2:20 | 查看行动项 v1 并驳回，填写“补 DRI、截止时间、验收标准和依赖” | 返工要求进入 Context，生成 v2，v1 保留 | Artifact 版本、Review Gate、可追溯返工 |
| 2:20–3:10 | 查看行动项评审通过后的并行段 | 协作看板草图与数据口径核对同时解锁，下游同步仍等待纪要发布评审 | 并行协调、Gate、依赖解锁 |
| 3:10–3:45 | 批准纪要发布评审 | 下游同步与闭环验收解锁，频道出现 worker provenance 与完成摘要 | Gate、依赖推进、单一事实投影 |
| 3:45–4:25 | 点击“模拟一次可恢复故障” | 首次 attempt 失败，显示 retry/backoff；ManualClock 前进后恢复并成功，无重复 Artifact | Retry、fencing、outbox HOL、可见恢复 |
| 4:25–5:00 | 查看 Anna 总结并选择“重置”或“创建真实项目” | 重置仅清理 Session；创建真实项目需再次确认 | 生命周期隔离、显式 promotion |

## 7. replace-don't-layer 实施顺序

1. **先冻结 interface 和契约测试**：冻结 `AgentExecution` 三方法、typed command/event vocabulary、LoopAdapter conformance；新增查询守卫测试，证明 Showcase 不出现在真实 Project/Inbox/Notification/Memory/Usage。
2. **替换现有 Showcase 写主库路径**：实现独立 ShowcaseSession Store + ScriptedLoopAdapter + ManualClock，经真实 execution/outbox/projection seed 场景；把桌面 launcher 改读 ShowcaseView。新接口验收通过后，删除 `CrewShowcaseService` 的主库 materialization、对应路由透传和锁定“普通 Crew facts”行为的旧测试，不能保留双写兼容层。
3. **替换 `@Anna` 进程内 draft**：把裸 `asyncio.create_task` 改为 planning RunProfile 的 durable Execution；投影 CoordinationProposal。通过 restart/idempotency 测试后删除后台旁路。
4. **统一事件与预算**：让 Python Loop 的 model/context/tool/audit 全部进入 `LoopResult.events`；在 AgentExecution 增加跨 attempt 的 BudgetLedger。删除 legacy frame 猜测映射和每个调用者自行计数。
5. **接入 ToolGateway 与 Permission**：先迁移 `crew.ask_human`，再迁移安全读工具，最后迁移有副作用写工具；effect ledger、approval、resource key 和 sandbox 只能在 Gateway 中实现。每迁完一类即删除旧 handler 直连。
6. **收敛 Profile 路由**：建立 WorkerProfileCatalog 与 RunProfileRouter，迁移 role resolver、model profile、context/eval/budget policy；调用者只传两个 ref，不再注入零散 settings/handler。
7. **补齐 Artifact、Memory、Eval**：按 manifest/provenance、检索门、durable gate 顺序接入，并让 Showcase 与 production 跑相同 module-interface tests。
8. **最后做 Pi canary**：固定 Pi 版本，实现第二个 LoopAdapter；与 Python Adapter 跑同一 conformance suite 和真实 Crew eval。仅当完成率、追问恢复率、重复副作用率、预算、延迟、成本、Trace 完整性在冻结指标上显著更优才扩大流量；活动 Execution 不跨 Adapter 热迁移。
9. **删除旧层而非长期兼容**：每个替换切片完成后，删除浅 pass-through、旁路状态与针对 implementation 的旧单测，只保留通过 deep module interface 验证可观察行为的测试。

完成顺序的第一门不是“页面看起来完整”，而是 Showcase 隔离、durable coordination、事件诚实、累计预算和副作用安全；这些 P0 未通过前，不用 seeded demo 宣称 live provider 或长任务高可用。
