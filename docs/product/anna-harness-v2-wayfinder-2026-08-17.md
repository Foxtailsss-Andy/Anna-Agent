# Anna Harness v2 · Wayfinder 决策地图

> 日期：2026-08-17  
> 状态：Shaping / decision tickets open  
> 目标：用 Pi 作为 Loop Kernel，在不继续堆叠旧 Python Harness 的前提下，重建可上线的 Anna Harness。

## 0. Session 边界

本 Session 是 Harness v2 的产品决策主 Session，只负责：事实审计、领域词汇、ADR、Wayfinder 决策地图、架构 Spec、实施票据与最终 Handoff。它不启动重构开发。

下一个 Session 根据 Handoff 开始实施：GPT-5.5 high 负责开发；GPT-5.6 Sol xhigh 负责独立双轴评审。每张票在独立 smart zone 内完成 TDD、验证、评审和交接。

## 1. 工作协议

本次重构超过单个 Agent context smart zone，采用指定原文的方法：

1. Grill with docs：先统一领域词汇、边界与 ADR；
2. Wayfinder：先关闭决策票据，再生成实施票据；
3. Spec：每个实施票据有输入、输出、非目标和验收；
4. Implement：每票由独立上下文执行，使用 TDD 的 red → green → refactor；
5. Review：按 repo standards 与原始 spec 双轴评审；
6. Handoff：每票结束写入可供下一 Agent 直接接管的结果与证据。

开发模型固定为 GPT-5.5 high；独立评审固定为 GPT-5.6 Sol xhigh。

## 2. 已确认的问题

### 2.1 LoopAdapter 是终局批处理接口

当前 `LoopAdapter.run(snapshot, signals) -> LoopResult` 只允许 Adapter 在结束时返回事件。确定性诊断连续两次证明：Adapter 已运行时 Durable Store 只有 `execution.started / execution.claimed`，没有任何进度 frame。复杂任务因此无法在执行中定位第一处偏离。

### 2.2 多个运行事实源叠在一起

当前并存：

- QueryEngine / AgentLoop：模型与 Tool loop；
- AgentExecution：queue、lease、retry、outbox；
- RunStore / RunRegistry：run 与持久化；
- FrameJournal：流式过程；
- surface orchestrator：Chat、Crew、Create、Hiker、Reimbursement、Associate 各自状态；
- TraceAssembler：事后从 frame 推断 span。

它们分别拥有一部分事实，没有一个可在运行中重放的 canonical event stream。

### 2.3 Tool 平台碎片化

至少存在 Chat、Create、Hiker、Reimbursement、Associate 五套 Tool Registry，加上 MCP dispatcher。effect ledger 虽已存在，但普通 Tool 没有统一经过 schema、permission、approval、sandbox、idempotency、audit 和 resource-key 控制。

### 2.4 长任务没有全程预算

Execution 命令没有 wall-time、turn、token、cost、tool-call 预算；provider usage 与 Eval 消耗没有跨 retry/resume 累计。Heartbeat 只能证明 Worker 活着，不能决定何时停止。

### 2.5 Session、Memory、Eval 与 Trace 没有统一契约

- Session 分散在 thread/run/execution/crew project 等对象；
- Memory 主要是显式 CRUD，没有统一写入、检索、遗忘和跨频道授权策略；
- Eval 是局部 judge，不是版本化 RunProfile gate；
- Trace 主要由完成后的 frame 反推，运行中证据不完整。

### 2.6 Python / TypeScript 边界不适合继续扩张

Pi 是 TypeScript。若把 Pi 只包成另一个 subprocess，再保留旧 Python QueryEngine、AgentExecution、Tool Registry 与 TraceAssembler，会形成第三层运行时。重构必须给出明确替换边界，不能长期双写。

## 3. Pi 0.84.2 源码裁定

核验版本：npm latest `@earendil-works/pi-coding-agent@0.84.2`；源码提交 `58302d34e703e0453ea13bdd10c7e423589ce177`。

### 可直接采用

- 多 Provider / Model API 与流式事件；
- 稳定 Agent Loop、Tool call/result 顺序、abort；
- AgentSession SDK、JSON/RPC 模式；
- steering / follow-up queue；
- session JSONL tree、branch/fork；
- context compaction；
- Agent Skills 与 Extensions；
- usage/cost/context telemetry；
- 自定义 Tool 和禁用 built-in Tool 的入口。

### 不能交给 Pi

- 频道、组织、成员、租户与权限事实；
- 长期 Scheduler / Wake Condition；
- 业务 Memory distillation 与 ACL；
- Eval Case / Dataset / Release Gate；
- 企业 Tool approval、effect ledger 与补偿；
- production Sandbox；
- 跨进程 durable queue、lease/fencing 与 outbox；
- Anna 的 OTel Trace / Harness Trace 产品模型。

### 暂不能采用

Pi main 中新导出的 `AgentHarness v2` 目前仍是 scaffold：restore、prompt、resume、steer、watch、manual drive、lane 等核心方法明确返回 `HarnessNotImplemented`。不能以它为近期上线依赖，也不应复制其未完成实现。可以吸收其 lane、operation、replay policy、typed event 与 telemetry 词汇。

### 安全边界

Pi 默认文件/Bash Tool 运行在当前用户权限内；官方明确不内置 Sandbox 或 permission popup。Anna 必须禁用 Pi built-ins，只向 Pi 注册经过 Anna ToolGateway 的 Tool。

## 4. 推荐目标架构

```text
Electron / Channel UI
        |
        v
Anna Control Plane (TypeScript, new)
  Identity + Channel Session + Scheduler + RunProfile
  Budget + Permission + Approval + Memory Policy + Eval Gate
  Canonical Event Store + Trace Projection
        |
        v
Pi Loop Kernel (pinned 0.84.2)
  Model + Agent Loop + Tool protocol + steering + compaction
        |
        v
Anna ToolGateway
  schema -> policy -> approval -> sandbox -> effect ledger -> audit
        |
        v
Connectors / Files / CLI / MCP / Business systems
```

核心规则：Pi 负责“一轮如何思考和调用 Tool”；Anna 负责“谁可以做、何时做、做多久、如何恢复、如何记忆、如何评测、如何发布”。

## 5. 迁移策略：新脊柱，旧系统冻结

### 保留为事实与验收

- `CONTEXT.md` 中确认后的产品词汇；
- ADR-003 Trace 诚实规则；
- Crew 多人/评审/返工/通知场景；
- 当前真实最小任务与复杂任务 badcase；
- 测试中的幂等、重启、late signal、unknown effect 约束；
- Electron 前端视觉资产，可在新 API 稳定后复用。

### 重新实现

- Agent Session / Run / Event / Trace 主链；
- ToolGateway、Permission、Approval、Sandbox；
- Skill catalog 与 RunProfile；
- Memory Policy；
- Eval 与发布门；
- Scheduler / Wake Condition；
- Channel Session 与 Worker execution 映射。

### 完成替代后删除

- Python QueryEngine / AgentLoop / model provider；
- surface-specific Tool Registry；
- FrameJournal + TraceAssembler 的事后猜测链；
- Crew 内直接 `asyncio.create_task` 规划旁路；
- 新旧 Runtime 双写和兼容分支。

## 6. 决策票据

### D01 · Anna 身份与频道实例 — CLOSED

每个 Channel 恰有一个 Anna；并行 Pipeline 是该 Anna 管控的 Run/Lane。Channel Session 是 Context、Memory、Run 引用和授权的长期边界；跨频道读取必须显式授权。

### D02 · 重写边界 — CLOSED

在同仓新建 TypeScript Harness v2 包和独立服务，旧 Python Harness 冻结；通过 HTTP/event contract 做短期 strangler。不在 Python 内嵌 Pi subprocess，也不 Fork Pi。

### D03 · Pi 接入层 — CLOSED

在以下选项中选择：

1. 稳定 `coding-agent AgentSession SDK`；
2. 更低层 `pi-agent-core Agent`；
3. 等待/参与 Pi `AgentHarness v2` 完成。

最终裁定：production spine 使用固定版本的 `pi-agent-core Agent + pi-ai`，通过 `PiLoopKernel` adapter 隔离；`coding-agent AgentSession SDK` 只用于参考、兼容性 canary 和行为对照，不成为 canonical persistence。严格禁用 Pi built-in tools。拒绝 3 作为近期上线前提。

### D04 · Durable Store — CLOSED

Anna Event Store 是唯一运行事实源。本地以 Node SQLite 实现，所有实体强制携带 `channel_id` 并通过 scope-bound repository 访问；Pi transcript 只是运行投影。未来云端 Store 必须通过同一 conformance suite。

### D05 · Tool / Sandbox — CLOSED

Pi 不获得 built-in Bash/Write/Edit。ToolGateway 是唯一执行入口：ACL 内只读 typed Tool 可自动执行；写操作必须审批；不可逆操作要求二次确认或补偿。第一批只做 `read_workspace` 和 fake approval-gated write；Sandbox 是独立 Adapter，不能用路径检查冒充 OS 隔离。

### D06 · Trace / Eval — CLOSED

Canonical Event 投影为 ADR-003/OTel Trace，保留 provider 原始 usage。Eval 分为确定性 Contract Eval 与经人工校准的 Quality Eval；固定 4 个 Smoke + 16 个 Dev Set，每个 failed Trace 转为 Regression Case。

### D07 · 上线形态 — CLOSED

近期先发布 macOS 本地开发者预览，后台服务随桌面运行；“应用关闭后仍跨天运行”作为云端 Runtime 里程碑，不在首版假装成立。

### D08 · 并行 Pipeline — CLOSED

一个 Channel Anna 可以启动多个并行 Run/Lane。频道输入日志保持有序；并行 Lane 不直接修改 Channel Memory 或共享项目事实，只提交 Proposal、Artifact 或 Memory Candidate，由串行 Projector 或人工 Gate 合并。

### D09 · Memory 学习边界 — CLOSED

Memory 分为 Run Context、Channel Memory 与显式授权的 Workspace Memory。Anna 可以自动提出带 provenance 的 Memory Candidate；本地预览必须经 Channel Owner 确认后才能成为长期 Memory。

### D10 · 主动性 — CLOSED

本地预览只允许显式 Schedule、未解决线程 SLA、已登记 Connector Event、等待节点到期和用户建立的 Monitor。每个主动 Run 必须有 trigger、预算、权限、停止条件和通知对象；不做无边界 ambient scan。

### D11 · 第一真实场景 — CLOSED

首个场景是“产品评审会后迭代闭环 / Review-to-Validated-Patch”：真实评审纪要进入频道后，Anna 协调 PRD 增量、UI 方案与截图、开发 Patch、自动化 Test、Eval 与人工 Gate。写操作只发生在隔离 Git worktree；首版不自动 push 或 merge。CI 使用确定性 fixture，发布验收对 Anna 仓库执行 live canary。

## 7. 第一实施票候选

在 D04–D06 与下一轮产品决策关闭后，第一票建议为：

**T01 · Pi Loop Canary**

- 新建隔离 TypeScript package；
- 固定 `pi-agent-core` / `pi-ai` 0.84.2；
- 关闭 built-in tools；
- 注入一个 fake read Tool；
- 将 Pi JSON/SDK event 映射为 Anna canonical event；
- 支持 steer、abort、明确终态；
- 使用 fake provider 完成 TDD，再用现有 DeepSeek 配置做一次 live canary；
- 不改 Crew、不接真实业务写系统、不删除旧 Runtime。

T01 通过后再生成 T02 Durable Store、T03 ToolGateway、T04 Memory、T05 Eval、T06 Sandbox、T07 Channel Session 等实施票据。
