# Anna 架构审查与 Hermes 基座决策(ADR-001)

> 日期:2026-06-11
> 状态:已决策(可被后续 ADR 推翻)
> 输入:三份并行审查——原始设计文档审查、hermes-agent 源码盘点(vendor/hermes-agent,MIT License)、Anna 现有运行时代码盘点

## 0. 一句话结论

**Anna 保留自有的"治理层"(工具白名单、业务审批、审计证据链、MCP client),把 Hermes 当"发动机仓库"按件取用(模型传输层、Provider 体系、上下文压缩),整机不上船。** 这同时满足"以 Hermes 为基座的综合能力"和"轻量好用"两个目标——因为 Hermes 最强的恰好是 Anna 最弱的(模型引擎),而 Anna 最核心的恰好是 Hermes 没有的(企业业务治理)。

## 1. 设计文档硬伤清单(审查结论)

按严重程度排序,完整论证见审查记录:

| # | 硬伤 | 出处 | 本 ADR 的处置 |
|---|---|---|---|
| 1 | **Hermes 角色三种说法打架**:PRD 说"Anna Harness 自有"、Planning 说"Hermes-style 底座"、Spec 说"仅参考不引入" | 三份文档对照 | 本文档第 3 节冻结定位,以后只引用 ADR-001 |
| 2 | **整个演示闭环押注外部 ERP MCP 按时交付**,无 B 方案 | PRD 开放问题 Q1 | 保留 tests/mcp_gateway 本地契约服务器作为"演示连接器"常备方案;真实租户验证仍是最终验收门,两套演示脚本并行维护 |
| 3 | **范围蠕变**:Workcell 办事大厅、多业务看板(采购/生产)、Create 泛低代码、16 维权限矩阵,都混进了"轻量 MVP" | Planning 多处 | 全部移出 MVP(见第 5 节"不做清单") |
| 4 | **ERP 写入无回滚/补偿设计**,只有幂等键 | PRD 写入原则章节 | MVP 接受"幂等 + 审批前确认 + 读回校验"为边界;补偿事务列入 P1 设计债 |
| 5 | **Agent Loop 深度未定义**:完整 Harness(Memory/Hook/Eval)vs 狭义 model-call 循环 | Planning vs Spec | 冻结为狭义循环 + 治理钩子;Memory 仅保留现有 Business Memory 最小实现;Eval 不做 |
| 6 | 多租户/权限"说不做又给了企业级设计" | PRD/Planning 矛盾 | MVP 单 Workspace;数据表保留 workspace_id 字段(已有),权限矩阵只读展示,不实现细粒度检查 |

**总体判断:架构分层(用户→应用→Harness→Runtime→MCP→ERP)没有硬伤,方向正确;问题集中在文档间不一致和范围自律。** 现有代码(230 个后端测试、真实模型已验证)实际上已经把 Spec 的"务实派"路线走通了。

## 2. 现有代码债(盘点结论)

| 事实 | 数字 |
|---|---|
| services/api/app/main.py 单文件 | **3,142 行**(路由+readiness 投影+schema 校验+辅助函数全塞在一起) |
| 五个域 orchestrator 合计 | 3,464 行,其中**约 26%(~900 行)是复制粘贴的样板**(Skill 加载、_hash_payload、_fail_run、模型循环、MCP 预检、工具分发) |
| AnnaHarnessRuntime | 仅 102 行,只包了模型调用+审计 |
| model_provider.py | 254 行,仅 OpenAI 兼容、**无流式、无重试、无降级** |

## 3. Hermes 基座决策(核心)

### 3.1 Hermes 源码盘点关键事实

- MIT License;Python **3.11–3.13**(不支持 3.14);原生支持 Windows
- 核心可嵌入:`AIAgent`(run_agent.py)+ `agent/conversation_loop.py`(~3,900 行成熟主循环)+ `agent/transports/chat_completions.py`(流式/重试/错误分类/上下文压缩)+ 30+ Provider 插件(**含小米 MiMo**)
- 但要看清三点:
  1. **Hermes 不是通用 MCP client**(它是 MCP *server*,把自己暴露给 Claude Desktop 等);而"调用外部 ERP/报销 MCP"恰是 Anna 的命脉,这部分 Anna 自己的 JSON-RPC Gateway 已经实现且被测试覆盖
  2. **Hermes 的审批是"危险命令模式匹配"**(rm -rf 等),不是企业业务审批(金额/审批人/证据哈希);Anna 的审批-快照-哈希-读回链路是自研且更适配
  3. **Hermes 的审计是调试日志**(RotatingFileHandler + 脱敏),不是合规证据链;Anna 的 audit events + SQLite 持久化更适配
- 整机引入的代价:核心 ~42,000 行 + 150-200MB 依赖(prompt_toolkit/rich/PIL/...),还要逐个关掉 terminal/browser/file 等对财务场景危险的通用工具——**这与"轻量"直接冲突**

### 3.1b 2026-06-13 集成现状诚实补记(产品经理验收)

审查发现并如实记录:截至 2026-06-13,**Anna 与 Hermes 是零代码集成**——`grep -r "import hermes" services/` 无结果,vendor/hermes-agent 仅作参考库。准确定位是:**"受 Hermes 启发的自建轻量 Harness",而非"以 Hermes 为基座的封装"**。这是诚实结论,不是失败:

- 引擎层(`services/runtime/app/engine/`)已于 2026-06-13 真实落地,这是"按件取用"的首个兑现:`engine/streaming.py`(流式 SSE 传输)+ `model_provider.py`(重试/错误分类)都是**参照 Hermes transport 模式重新实现**,绑定 Anna 自己的 ModelRequest/ModelResponse 契约,不在运行时依赖 Hermes。
- H1(重试/错误分类)✅ 完成;**流式 ✅ 已完成**(2026-06-13,Chat P0);H2(Provider Profile 多模型)、H3(上下文压缩)未做,按轻量原则暂缓。
- 为什么不整库引入:Hermes 内核 ~42,000 行 + 200MB 依赖,且它不是通用 MCP client、审批是危险命令匹配、审计是调试日志——这三样恰是 Anna 必须自有的。整库引入与"轻量"冲突。**自建 Harness(内核 103 行 + 共享基类)已被 252 测试覆盖、六大模块真实跑通,是正确选择。**

如需进一步靠拢 Hermes,正确做法仍是"按件取用"(下一件可选 H2 Provider Profile),而非替换已验证的治理层。

### 3.2 决策:三层架构,按件取用

```text
┌─────────────────────────────────────────────────┐
│ Anna 应用层(Electron + React)                    │
├─────────────────────────────────────────────────┤
│ Anna 治理层(自有,Anna 的核心资产,保持小)            │
│   工具白名单注册表 · 业务审批(快照/哈希/幂等/读回)     │
│   审计证据链 · MCP JSON-RPC client · Skill 治理     │
├─────────────────────────────────────────────────┤
│ 引擎层(从 Hermes 改造引入,vendored,带许可声明)      │
│   H1: chat_completions 传输(流式/重试/错误分类)     │
│   H2: Provider Profile 体系(含 MiMo 插件模式)      │
│   H3: 上下文压缩(对话变长后引入)                     │
└─────────────────────────────────────────────────┘
```

**不引入**:gateway(78 万字节消息平台)、CLI/TUI、terminal/browser/file/cron 通用工具、hermes_state、approval.py、web dashboard。

**引入方式**:不做 pip 依赖、不做整库 import(避免依赖爆炸)。从 `vendor/hermes-agent` 把目标模块**改造复制**到 `services/runtime/app/engine/`(文件头保留 MIT 版权声明),改掉其内部 logging/状态耦合。vendor/ 目录本身不进 git,只作参考与升级对照。

### 3.3 配套决策

- **D-py**: Python 钉到 **3.12**(与桌面 sidecar 一致,且在 Hermes 支持区间内;当前 venv 是 3.14,需重建)。pyproject `requires-python = ">=3.12,<3.14"`。
- **D-model**: 单一全局 Model Provider(mimo-v2.5-pro);多模型路由不做。
- **D-skill**: Anna 的 SKILL.md 格式保持现状(frontmatter + 工具白名单),不迁移到 Hermes skill 格式;它已被 SkillLoader/测试/审计契约绑定。

## 4. 减重重构计划(按 ROI 排序)

| 切片 | 内容 | 预期 | 验证 |
|---|---|---|---|
| A1 | **拆 main.py**:routes/(按域)+ readiness/ + validators/ + projections/,main.py 只留装配 | 3,142 → ≤300 行 | 全量 pytest 不动断言 |
| A2 | **BaseOrchestrator**:_hash_payload/_fail_run/_next_run_id/Skill 加载+审计/模型循环骨架下沉 | 五域 -400 行 | 全量 pytest |
| A3 | **MCPToolDispatcher**:预检链 + assert_allowed + call_tool + 审计的统一分发 | 三域 -300 行 | 全量 pytest |
| H1 | **引擎层第一件**:用 Hermes transport 模式重写 model_provider(流式 + 重试 + 错误分类),保持 ModelRequest/ModelResponse 契约不变 | 体验+稳定性 | test_model_provider + live:chat 实跑 |
| H2 | Provider Profile(为后续切换模型留口) | 可选 | 同上 |

顺序:A1 → A2/A3(可并行)→ H1。A 系列不改行为,纯结构;H1 改 provider 内部但保契约。

## 5. 不做清单(轻量护栏,引用即生效)

1. 不做 Workcell/办事大厅拟物可视化(Associate 维持 DAG 节点卡)
2. 不做采购/生产等多业务看板(只做财务)
3. Create 只做 Skill/Prompt/Python 工具草稿三件套,不做页面/连接器生成
4. 不做多模型路由、不做 Eval 体系、不做细粒度权限执行(矩阵只读)
5. 不引入 Hermes gateway/TUI/通用工具面
6. 不做自动 SOP 重排;Associate 计划生成后由用户确认推进

## 6. 风险与跟踪

| 风险 | 处置 |
|---|---|
| Python 3.14 → 3.12 重建后出现兼容差异 | 全量测试是门;3.12 是 sidecar 既定目标,长期一致性更好 |
| ERP MCP 真实连接器无时间表 | 本地契约服务器常备演示;Admin readiness 诚实显示 blocked |
| Hermes 上游演进,vendored 代码漂移 | vendor/ 保留浅克隆,升级时 diff 对照;引擎层模块保持小而少 |
