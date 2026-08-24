# Anna 架构与定义 (Architecture & Definition)

> **版本**：v2.0 ｜ **日期**：2026-06-28 ｜ **状态**:已对齐基准 (canonical baseline)
> **性质**:开发过程中的**曲解校正 + 功能优化对齐**,**不是推翻**以前的设计。
> **取代关系**:本文档取代以下旧文档的「**定位与底座模型**」部分(其业务场景/治理/安全/数据模型/集成仍有效,保留作历史与场景参考):
> - `docs/product/Anna_Product_Planning_MVP_Architecture.md` (v0.1, 2026-05-27)
> - `docs/product/Anna_PRD_V1_0.md` (v1.0)
> - `docs/product/Anna 架构图、蓝图、时序图文字版.md`
> **延续关系**:`docs/design/2026-06-11-anna-architecture-review-and-hermes-adr.md`(自有 model-agnostic loop)、`docs/design/2026-06-12-adr-002-agent-vs-code-path.md`(模型负责想/代码负责管)继续有效,本文档在其上构建。

---

## 0. 与旧设计的关系:对齐校正,非推翻

旧文档(Product Planning v0.1、PRD v1.0)把 Anna 定位为「轻量企业 AI 助手」,并**明确说明这是 MVP 阶段的有意收敛**——PRD v1.0 原文:「Anna 第一版**不追求**做完整企业 AI 操作系统」;Product Planning 原文:「**基于企业级 AI OS 的思路**做一个更轻的助手」。也就是说,**企业级 AI OS 一直是被承认的北极星,只是被推迟**。

在开发了财务看板、报销、Hiker 三个 vertical 之后,我们发现两件事:① 我们建出来的 Harness(治理/审批/审计/Skill/工具调用/模型无关 loop)其实已经强到**足以成为平台本身**;② 我们想让**平台成为产品**。因此本文档把定位从「MVP 框架的轻量助手」**升级**为「企业级 AI Agent Runtime / 平台优先」——这是**沿着旧文档已承认的轨迹前进 + 校正几处开发中的曲解**,不是另起炉灶。

| 旧设计 | 处理 | 说明 |
|---|---|---|
| 定位=轻量企业 AI 助手 | **升级** | → 企业级 AI Agent Runtime(Harness 即产品、平台优先);旧定位是 MVP 有意收敛,北极星不变 |
| Cowork-first、Agent/Skill/Memory/MCP、治理/审批/审计、写操作受控、安全(凭证后端)| **保留** | 仍是核心,且代码已落地、被验证 |
| PRD §14.5 Agent 对象模型(type/skill_ids/allowed_tools/memory_scope)| **形式化** | → Capability=Agent,把已有模型讲清楚,非新增 |
| Hermes Harness + Pi Create 底座 | **校正** | 已决定自有 model-agnostic loop(见 Hermes ADR),不依赖 Hermes/Pi |
| Associate(目标拆解模块)| **校正** | 已下线;其「复杂目标编排」诉求由未来 Crew 承接 |
| Cowork = 财务看板+财务助手+Associate | **校正** | 现为 财务看板(+copilot 抽屉)+报销+Hiker;财务助手并入看板成 copilot |
| 每个能力写死在代码里(领域 schema 在 orchestrator)| **优化** | → 领域知识住 Skill、Connector 配置化、Harness 透传 |
| Tool Registry per-domain、并发未定 | **优化** | → 系统无关 Connector 抽象、异步无状态并发模型 |
| Memory(只读/只写)| **优化** | → Loop Engineering(全局可开关的学习闭环) |

---

## 1. 一句话定义

> **Anna 是一个模型无关(model-agnostic)的企业级 AI Agent Runtime(即 Harness):对上,用一套统一的 Agent 能力支撑多个产品入口(Chat / Create / Cowork / Crew);对下,用一套统一的 Connector 层连接企业系统(ERP / SCM / MES…),并内建治理(审批 / 审计 / 权限)。每一个入口、每一个业务场景,都是「同一个 Runtime 被不同的 Skill / Prompt / Memory / Tool 配置」出来的结果,而不是一堆各自独立的应用。**

「不和任何产品/品牌/系统强绑定」这个底层构想,在架构上 = **L1 模型无关 + L3 Connector 统一**两个技术约束。

---

## 2. 七层架构

| 层 | 是什么 | 代码现状 (2026-06-28 审计) | 目标 |
|---|---|---|---|
| **L1 模型层** | LLM 推理引擎,模型无关、可换厂商 | ✅ OpenAI-compatible 可换(`services/runtime/app/model_provider.py`),实测 mimo-v2.5-pro | 保持可换;每 Agent 可配不同 endpoint |
| **L2 Harness**(核心产品) | Orchestration、Agent Loop、Tool Calling、Skill、Memory、Hook(治理)、Sandbox、Audit、Evaluation | 🟢 8 件中 6 件 PRODUCTION(`services/runtime/`);Memory 弱、Eval 无 | 异步无状态化;补 Memory 学习闭环 |
| **L3 Connector 层** | 统一接入企业系统(MCP),read/write/validate/verify,治理统一 | 🔴 3 套 bespoke adapter(`services/mcp_gateway/`)、冻结 tool registry、硬编码 schema | **R1**:通用连接器 + 工具发现 + 配置化 |
| **L4 业务能力 Capability** | 一个 Capability = Skill + 工具集 + Memory 作用域(声明式包);各业务是 Runtime 的**配置**,非独立 app | 🟡 Skill 机制 PRODUCTION(`services/runtime/app/skill_loader.py`),但领域 schema 仍硬编码在 orchestrator | 领域知识下沉到 Skill;Capability 作为可加载单元 |
| **L5 产品入口 Surface** | Chat / Create / Cowork / Crew;每个 = Runtime + 一组 Capability + 入口级 Skill/Prompt/Memory | 🟡 四入口都在(`apps/desktop/`),但前端各写各的、未共享内核 | **R2**:前端统一引擎 |
| **L6 治理与多租户**(横切) | 组织 / 角色 / 权限 / 数据共享 | 🔴 建模了但未强制、不安全(Python 层过滤) | **R3**:DB 级隔离 + RBAC enforcement(按需) |
| **L7 Loop Engineering**(横切) | 从治理过的操作里抽取价值,改进下一次任务 | 🔴 基本无;原料(audit/approval)已在手 | **R4**:全局可开关学习闭环 |

**点6 Graph Knowledge**:不单列层,作为贯穿 L2/L4/L7 的**建模方法**(每个对象有核心、分层勾连、相互建立关系),最该落在 L7 的记忆图上。

---

## 3. 核心模型:Capability = Agent(一套体系,两视角)

「作为单独 Agent 调用」和「封装成单独 Business Capability」是**同一个东西的设计期与运行期两面**,不是二选一:

- **Capability = 名词,声明式打包单元(设计期)**:Skill + 工具白名单 + 依赖 Connector + Memory 作用域 + 治理 policy + I/O 契约(含 test_cases)。
- **Agent = 动词,运行实例(运行期)**:Harness 加载一个 Capability、按 Agent Loop 跑起来,就是一个运行中的 Agent。

> **形式化说明**:这是把 PRD v1.0 §14.5 已有的 Agent 对象模型(`type / prompt_id / skill_ids / allowed_tool_ids / memory_scope`)讲清楚,**不是新增概念**。

### 铁律(三者不互持可变状态 → "互不影响"的根因)

```
loop  住在 Harness          —— 运行逻辑永远在 L2,Capability 不拥有运行时
config 住在 Capability       —— 声明式配置,领域 schema 从代码挪进 Skill
run 状态 住在 per-run context —— 每次运行一个独立上下文对象,不挂在单例上
```

### Capability 包(声明式,Admin 可管理)

```yaml
Capability / AgentConfig:
  id: hiker-global
  version: 1.2.0
  connector:  { type: mcp, server: <env/db>, auth: <后端秘钥> }   # 外部参数,配置化
  model:      { endpoint: <default>, api_key: <后端秘钥> }         # 每 Agent 可不同 LLM(接缝)
  skill:      skills/hiker/SKILL.md                                # 领域知识在此,不在代码
  tools:      [hiker.master_data.search, ...]                      # 工具白名单(隔离点)
  memory:     { scope: agent:hiker }                               # 记忆作用域(隔离点)
  policy:     { write: requires_approval, risk_default: low }      # 治理(隔离点)
  io_contract:{ input: ..., output: ..., test_cases: [...] }       # 可组装 / 可单独调试
  isolation_mode: in-process    # 逻辑隔离=现在 / sandboxed-process|container=将来
```

四个工程诉求由此满足:**可组装**(io_contract)、**单独加载**(id+version)、**单独调试**(test_cases + 独立 trace)、**互不影响**(tools 白名单 + memory_scope + policy + per-run context)。

**复杂度保持线性**:内核(Harness)一套、做厚做稳;新增业务 = 加一个声明式 Capability 包,**Harness 一行不动**。复杂度长在「包」的数量上(每个小、隔离、可测),不长在内核里。

---

## 4. 配置 / 管理层(决议 C1)

把 MCP 等外部接入**做成 Admin 后台可管理、可单独更换的配置项**,分 tag/Agent 管理:

- **配置内容**:每个 Agent 的 Connector(MCP Server)、Model(LLM endpoint/key)、Skill、Memory 作用域。即「抽象的 Capability」落成一条 **Admin 管理的配置记录**。
- **数据归一化 = Approach A**:领域 schema 住 Skill、Harness 透传,**不建统一语义层**(YAGNI;facet 归一作为将来可选接缝)。
- **安全红线**:LLM Key 与 MCP 凭证**只在后端**、UI 脱敏,**绝不进 Electron 渲染层**(延续旧设计的凭证后端原则)。
- **演进非重建**:建在**现有 Admin runtime-config 之上**(`services/api/app/routes/admin_runtime.py` + `runtime_config.py`,今天已管 Hiker MCP 字段),从「全局 per-system env 字段」演进为「per-Agent 配置记录」,配置入 DB、预留 tenant scope。
- **每 Agent 不同 LLM**:配置层**保留接缝**,但**现阶段所有 Agent 默认同一模型**,不跑 (Agent×模型) 矩阵(见 §10 风险 R4)。

---

## 5. 并发与隔离模型

**参照 Claude Code 的并发原则**:session 完全独立、loop 是 I/O-bound 等待、真瓶颈是模型 API 配额而非本地;Harness 无状态、可重入。

```
Harness     = 无状态、可重入、全异步 的编排代码(不持有 per-run 可变状态,不是会被独占的资源)
tab         = 一个长期存在的 Agent 会话(绑定一个 Capability + 自己的 context)
问Anna/刷Kanban = 一个 run(异步任务)
所有 run    = 共享同一个 event loop,各自 await 模型/MCP,因此并发推进(像 CC 的多 session)
速率闸      = rate-limit-aware semaphore,按 endpoint 计(防 N tab 打爆 provider)
隔离        = per-run context + Capability 作用域(逻辑隔离),非进程隔离
```

- 跨 tab **并发**;单个会话内**顺序**(单条推理链不可并行);单回合内多 tool 可 `asyncio.gather`。
- **isolation_mode**:`in-process`(逻辑隔离,现在)/ `sandboxed-process` | `container`(物理隔离,将来给 Crew/多租户/大规模 codegen)。物理隔离是 Capability 的**架构属性**,不改 Harness。

### 代码现状与改造(诚实)

- ✅ streaming 传输层已并发(`services/runtime/app/event_stream.py`,每请求独立 worker 线程)。
- 🔴 底层**部分串行 + 竞态**:同步 orchestrator + `asyncio.run()` 每次新 event loop + 阻塞 `httpx.Client` 的 MCP + 单例 orchestrator 持共享可变状态(`_runs_by_id`/`_run_counter`)+ SQLite 无 WAL。
- **改造**:async 到底(await 模型、MCP 换 `AsyncClient`)+ run 状态进 per-run context + SQLite WAL+timeout。**注意**:这次重写的理由是 Capability 模型要求的「无状态化」,async 是副产品(见 §10 风险 R2),**不是为今天并不存在的并发需求**。多进程水平扩展属将来多租户服务端,先不做。

---

## 6. Connector 抽象(R1,系统无关)

**目标**:把「加一个企业系统」从写代码变成改配置。

- 现状:3 套 bespoke adapter + 冻结 tool registry + orchestrator/prompt 硬编码 schema;加第 4 系统 ≈ 10 改动点、1000–2000 行新代码。
- 目标:**一个通用 MCP 连接器**(参数化 server/auth/tenant)+ **工具发现**(而非冻结集)+ 命名空间走配置 + 治理统一经 Harness。
- **首个参考实现**:迁 Hiker(只读、最小);但抽象**必须对着 3 个 vertical 一起设计**,并在纸面用报销(写入+审批+多轮)压测过再宣布成立(见 §10 风险 R1)。
- **可证伪验收**:新加一个玩具 MES connector,**只改配置、不写新 orchestrator 代码**,端到端跑通。

---

## 7. Loop Engineering(L7,决议 C3)

- **全局机制 + 可开关**:全局默认开 + 按 Agent 覆盖。
- **机制开放、可改、可优化**:抽取策略、注入策略做成**可配置的 skill/policy**,不硬编码。
- **记忆分级**:MemoryItem 带 scope(`agent` / `workspace` / `global`);Loop 按配置写入对应层 —— 兼容 C1 的 per-Agent Memory 与全局学习。
- **与 A5 一致**:机制在 Harness 里**统一**,差异只靠**配置**,不在 Harness 内分支。
- **落地纪律(见 §10 风险 R3)**:**先写死一版有主见的 抽取→注入,测量它是否真改善下一次**(减少错误/缺字段/审批被拒),**有用了再做可配置**。其测量信号与 Eval(C5)耦合——Loop 必须配一个最小评测信号才闭得了环。

---

## 8. 区分原则(A5,用户明确)

> Agent/tab 之间的区分**从架构层做**(各自是独立可加载的 Capability 单元),**不靠 Rule、也不在 Harness 内部做分支区分**。Harness 保持**统一、稳定**——加一个 Agent = 加一个 Capability 包,Harness 一行不动。这是「更稳定」的根因。

「异步 + 无状态 + per-run context」是 Harness 自身的**架构不变量**(底座就是这么建的),不是用来区分 Agent 的 Rule。

---

## 9. 战略与路线

**平台优先(Harness 即产品)**:Harness 才是可开源、有差异化的产物,vertical 是它的证明。vision 与代码的差距 ≈ 全部是「横向化债」(Connector 抽象 + 前端统一引擎 + 多租户 + 记忆闭环)。平台从 **3 个已存在的 vertical 里抽取**,不是空中楼阁。

| 阶段 | 内容 | 可证伪验收 |
|---|---|---|
| **① 配置层 + R1 Connector 抽象** | MCP/LLM/Skill/Memory 变 per-Agent 配置;通用连接器;迁 Hiker 参考 | 加玩具 MES,只改配置即跑通 |
| **② R4 Memory + L7 Loop** | per-Agent Memory 已在配置里,顺势做学习闭环 | 注入过去经验,可测出错误/缺字段下降 |
| **③ R2 前端统一引擎** | 收掉 5 份重复(共享原语可提前抽,见风险 R5) | 新 Surface 复用共享 stream/client,无新拷贝 |
| **④ R3 多租户 enforcement** | Crew/多人需要时再做(接缝已留) | 跨 workspace 越权读写被拦 |

---

## 10. 设计原则与风险(批判性结论固化)

| # | 原则 / 风险 | 对策 |
|---|---|---|
| **R1** | 只拿 Hiker(只读)验证抽象 = 虚假信心,碰报销写入会塌 | 抽象对着 3 个 vertical 一起设计;纸面先用报销压测再宣布 R1 成立 |
| **R2** | 别为「并发」重写,要为「无状态」重写 | async 折进 R1 的无状态化重构,白拿;不为不存在的并发需求单立阶段;靠 252 测试 + 新增 per-run 隔离测试兜底 |
| **R3** | Loop Engineering 先做成可配置 = 过度设计;难点是「经验是否真有用」 | 先写死一版 + 测量 + 再可配置;C3 与 C5(Eval)比计划更耦合,需最小评测信号 |
| **R4** | per-Agent 异构模型 = 2 人团队的维护乘数 | 留「可换模型」接缝,现阶段全用同一模型,不跑 (Agent×模型) 矩阵 |
| **R5** | 前端全压到第③阶段 = 再积几个月债 | 共享原语(annaClient/useAnnaStream/统一 run-event 类型)现在就抽止血;全量统一等后端契约稳 |
| **R6** | 大量架构但无验证手段 | 每阶段挂可证伪硬指标(见 §9);无证伪测试则「平台优先」会漂走 |
| **R7** | 「OS」一词招致镀金/过度通用化 | 始终留一个 vertical(建议报销)做到真正出色当样板;人们为 app 来、为 platform 留 |

---

## 11. 未决(后续优化,本轮不动)

- **C4**:多租户深度 / Crew 多 Agent 编排 —— 用户明确先不碰。
- **C5**:Evaluation(L2)—— 暂缺、未排期;但注意与 L7 Loop Engineering 的耦合(R3)。

---

## 12. 术语表

| 术语 | 定义 |
|---|---|
| **Harness** | L2 核心:模型无关、无状态、可重入、异步的 Agent 编排运行时。Anna 的「产品」本体 |
| **Capability** | 声明式打包单元(名词):Skill+工具+Connector+Memory 作用域+policy+io_contract。一条 Admin 管理的配置记录 |
| **Agent** | Capability 的运行实例(动词):Harness 加载并运行一个 Capability |
| **Connector** | L3:一个外部系统的统一接入(现 MCP),read/write/validate/verify |
| **Surface** | L5 产品入口:Chat/Create/Cowork/Crew = Harness + 一组 Capability |
| **Skill** | 领域知识 + prompt 约束 + 允许工具,的打包(领域 schema 的家) |
| **Memory / MemoryItem** | 记忆;MemoryItem 带 scope(agent/workspace/global) |
| **run** | 一次 Agent 执行(一次「问 Anna」/一次刷看板),持有 per-run context |
| **isolation_mode** | Capability 的隔离级别:in-process(现)/ sandboxed-process / container(将来) |

---

*本文档为 Anna 后续开发的唯一架构基准。修订请走 ADR/PR,并同步 `MEMORY.md` 的 [Anna AIOS 架构对齐] 条目。*
