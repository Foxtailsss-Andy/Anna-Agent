# Anna Crew PRD v1.0 — 组织协同:一张人机同构的活 Work Graph

> **Date** 2026-07-17 ｜ **Status** **v1.0 已拍板**(决议见 §17;DESIGN-BRIEF 已出)｜ **Owner** Boss
> **取代**:`docs/superpowers/specs/2026-06-21-crew-design.md`(其决策 D1-D11 的沿用/改判见 §3;其后端实现是本 PRD 的地基)
> **承接**:PRD v1.1 修订二(Associate 退役、Crew 为继任者、定位 post-MVP)——本文即 Crew 的正式 PRD。
> **触发**:业务方对「组织中的人员协同」高度关注;Boss 给出六点场景 + Asana Work Graph 参考 + 分层 Memory + Crew 账户沟通方式四组新输入(2026-07-17)。

---

## 0. 一句话

> **Crew 把「组织里谁在做什么、做到哪了」建成一张人机同构的活 Work Graph:Anna 既是这张图的调度员(拆解、派人、催办、评审),也是图上的第一批员工(Agent 真干活);每一次协作沉淀为团队共享的 Memory。**

三段式 IA 的分工由此完整:**Home = 我让 Anna 干活;Cowork = 业务系统值守;Crew = 组织协同**。

---

## 1. 背景

### 1.1 需求原点(Boss 六点场景,2026-07-17 重申)

1. **任务拆解**:Boss 定目标,Agent 按预制 SOP/最佳实践拆解出任务路径与关键节点(Workflow/DAG);
2. **人员分配**:结合团队成员的角色/技能/属性分配(PM、前端、后端、UIUE、设计、外包……);
3. **任务分发**:通知相关人员;人员可反馈「没空/需协调」,MVP 由 Boss 人为调整;
4. **执行监督**:可视化看进度;任务触发下一节点即下推(PRD 完成→评审→驳回返工→通过→推 UIUE);
5. **人机替换**:部分员工将由 Agent 接管,Anna 直接调用 Agent 执行——不一定都是人类;
6. **协作面**:除了 Graph/横向动态流程图,右侧要有成员与 Anna 的互动:Anna 让 subagent 做完任务要在聊天框 **@那个员工**;Anna 分配、审核任务也 @人;进度公开,并反馈到左侧画布。

新增关键输入(本轮问答拍定):

- **通知不出站**:本版本通过 **Anna 的 Crew 账户**通知——登录后右上角弹出协作通知,引导进入 Crew,不跳出到 IM 工具;
- **叙事连通**:不只产品研发/营销流程,**Cowork 的报销与其他审批流也集成进 Crew**,让「组织的事」在一处汇合;
- **图会生长**:右侧频道的协作会反过来改变左侧的图——节点长出新分支、小分支;画布选型要以效果为导向、给足论据(§6)。

### 1.2 现状资产盘点(2026-07-17 实测,main 分支)

| 资产 | 状态 | 位置 |
|---|---|---|
| Crew 后端全套 | **活着且接线中**:SOP 模板、AI 拆解、智能派人、任务状态机(含评审门/驳回返工/下推解锁)、SQLite store、8+ API 端点 | `services/crew/`、`services/api/app/routes/crew.py`(main.py 已装配) |
| Agent 执行 | **空壳**:`agent_worker._produce` 单次 `call_model`、`tools=[]`、无 ReAct 循环 | `services/crew/app/agent_worker.py` |
| 身份/租户 | 活着:登录、boss/member 两档、workspace 隔离、Team 花名册 | `services/identity/` |
| Crew 前端 | **Iris 重建中被整体移除**,仅剩 Cowork 侧栏「Crew·组织 即将上线」占位;分段 pill 注释明确「可容三枚(F1)」——第三段接缝已预留 | `apps/desktop/src/components/shell/Sidebar.tsx` |
| Memory | 仅 workspace 级 BusinessMemory(chat/finance 在用);无 project/member 分层 | `services/memory/` |
| 通知/邮件/webhook | **零**(无任何 mailer/notification/webhook 代码) | — |
| 实时通道 | SSE 帧流(无 WebSocket);main 上帧无 seq | `services/api/app/routes/_sse.py` 等 |
| 子代理机制 | **未实施**(W7 计划在案:`run_subagent` + `agent.delegate` + Crew 接真引擎) | `docs/superpowers/plans/2026-07-07-workbuddy-absorption/07-subagent-crew-engine.md` |
| 长跑运行时 | `feat/harness-longrun` 20 commit **READY TO MERGE 待验收**:L1 多轮 / L2 run 持久化 / L3 后台运行+断线恢复(seq 帧日志) / L4 autocompact+续办 / L5 并发闸 | 分支,未合 main |

**结论**:域模型与治理是现成的(拆解/派人/状态机/评审门全真),缺的是①执行接真引擎(W7)②协作层(频道/通知)③可视化(图)④Memory 分层。这轮是「把骨架接上神经和皮肤」,不是从零造。

### 1.3 对标:Asana Agentic Work Management(2026-06-04 发布)

Asana 在 2026-06 发布 Agentic Work Management,自称「human-agent teams 的操作系统」:**Enterprise Work Graph**(任务/项目/目标一对多关系的数据底座)+ **AI Teammates**(30+ 预置 Agent)+ **AI Studio**(无代码工作流)+ **Dash**(AI Chief of Staff)+ MCP/AI Connectors。这验证了 Crew 的方向就是行业主赛道。

Anna 的差异化(旧设计三条依然成立,新增一条):

1. **执行内生**:Asana 的 Agent 经连接器"接出去";Anna 的 Agent 就跑在同一 Harness 里,与人共享同一状态机、同一评审门、同一审计。人↔Agent 替换 = 改 assignee,不是接集成。
2. **治理 native**:approval/hash/audit/评审门从第一天就在(ADR-002:模型负责想、代码负责管)。
3. **本地优先/模型无关**:数据在用户手里,模型可换。
4. **Memory 显性**(新):Asana 的上下文藏在 Work Graph 里;Anna 把「团队共识」做成可见、可编辑、可溯源的一等对象,人和 Agent 同读同一份认知。

---

## 2. Real Feature:三面一体

### 2.1 需求聚类:表面 vs 本质

六点场景的表面读法是「项目管理工具」(拆解/分配/跟踪)——那是 Asana 克隆,做不过也不必做。往下挖一层,三类真需求:

| 聚类 | 对应场景点 | 本质 |
|---|---|---|
| **结构**(看得见) | ①拆解 ④执行监督 ⑥左画布 | 组织的工作是一张图:节点=任务,边=依赖,状态实时点亮,**图随协作生长** |
| **沟通**(组织得起来) | ③分发 ⑥右频道 + 通知拍板 | 进度不靠人填报,由 runtime 事件自动长在频道里;Anna 主持,@人即组织 |
| **认知**(越用越懂) | ⑤人机替换的前提 + Memory 输入 | 人和 Agent 要共享同一份项目共识;个人/团队/项目分层沉淀 |

三者骑在既有 **Harness(执行)** 上:Agent 真干活、治理真兜底。

### 2.2 产品取向对比(宏观三选一)

| 取向 | 描述 | 判定 |
|---|---|---|
| A 项目工具优先 | Asana-lite:把看板/列表/甘特做全 | ❌ 红海,且丢掉 Anna 的执行内生优势 |
| B 沟通枢纽优先 | channel-first:先做团队 IM,任务是消息的附属 | ❌ IM 是巨坑,且「协作全在 Anna 内」的既定决策不支持做通用 IM |
| **C 三面一体(选定)** | **Graph(结构)× Channel(沟通)× Memory(认知),执行骑 Harness** | ✅ 三面互相成就:图给频道锚点,频道给图生长,Memory 给两者认知 |

### 2.3 五个签名特性

1. **一张活的图**:组织协作长在图上;评审驳回、频道决定、阻塞上报都会让图变形、长分支——图不是报表,是现场。
2. **Anna 主持的频道**:派活、交活、请审、驳回全部由 runtime 事件自动落成频道里的结构化卡片并 @到人;进度公开,零日报。
3. **人机同构**:Agent 是花名册里的正式成员,有角色、有技能、有负载;派给人还是派给 Agent 是同一个动作;Agent 产物过同一道评审门。
4. **组织收件箱**:项目的事(任务/评审/@我)与业务系统的事(报销审批、催收派办)汇到同一个铃、同一个 Inbox——Anna 把大家组织在一起。
5. **团队共享 Memory**:项目共识一处沉淀,人与 Agent 同读;Agent 的回答与产物可溯源到引用的共识条目。

---

## 3. 决策记录

### 3.1 旧决策(2026-06-21 D1-D11)沿用/改判

| 旧决策 | 判定 |
|---|---|
| D1 改名 Crew | **沿用** |
| D2 升一级 sidebar | **沿用并落地**:第三段 pill(本轮拍板 N1) |
| D3 Cowork 保留、与 Crew 正交 | **沿用**,并新增集成关系(N4) |
| D4 可信 Demo 尽量做全 | **沿用**(本轮成功标准=业务方可信演示) |
| D5 通知先发邮件 | **改判 → N3**:站内 Crew 账户通知;邮件/webhook 全退 P2 |
| D6 协作全程在 Anna 内、不接外部 IM | **沿用并强化**(通知也不出站了) |
| D7 真 Auth + 租户 + Team | **沿用**(已建成) |
| D8 旁开 services/crew | **沿用**(已建成) |
| D9 权限 Boss/成员两档 | **沿用** |
| D10 像素小办公室 | **改判 → N5**:退役,Work Graph 画布取代(Boss:「不需要房子这种形式」) |
| D11 SOP 首发产品设计+营销物料 | **沿用 + 扩展**(N4:审批流场景加入叙事) |

### 3.2 本轮新决策(N 系列)

| # | 决策 | 依据 |
|---|---|---|
| N1 | **Crew = 一级第三段**,侧栏 Home ｜ Cowork ｜ Crew | Boss 拍板 2026-07-17;Sidebar 三枚 pill 接缝(F1)已预留 |
| N2 | 主视图 = **结构化动态 DAG 画布(G1)**,自由无限画布不做 | 评估见 §6;**Boss 已确认(07-17 拍板①)** |
| N3 | 通知 = **站内 Crew 账户通知铃**(Anna 外壳级,登录即弹、深链进 Crew);外部通道(webhook/邮件)全退 P2,通知层留 channel 抽象接缝 | Boss 拍板:不跳出 IM |
| N4 | **Cowork 流程集成进 Crew = 「流程投影」**:集成对象是**整个报销流程**(审批只是一环)——P0 四步流程状态卡(提交→校验建单→审批→回读核验,审批步深链)+ Inbox 审批卡;P1 投影小图 + 就地批 + 催收派办 | Boss 拍板 07-17(纠偏:非单一审批卡) |
| N5 | 像素小办公室退役;`OfficeView` 不复活 | Boss:更贴近实际的动态流程图 |
| N6 | Memory 分层:`scope = workspace(已有) / project(新) / member(新)`,与 AIOS C3 的 MemoryItem scope 设计合流 | §8 |
| N7 | 频道事件源 = **任务状态机 transition**(零捏造:每张事件卡可溯 audit);频道→图的生长走「显式命令 + AI 填参 + 确认门」 | ADR-002 |
| N8 | 旧 Crew 后端域模型沿用为基;前端全新(Iris 设计语言),不搬旧 CrewPage | Iris 校对基准为最高设计权威 |
| N9 | Team 花名册的 Agent 成员 = **Agent 中心配置的引用**(同一 agent registry,不重复建) | 架构对齐:Capability=Agent |
| N10 | 实时性:P0 轮询(3-5s)点亮图与频道;P1 升级为项目级 SSE 事件流(复用长跑轮 seq 帧日志模式) | 演示够用、零新基建先行 |
| N11 | 旗舰演示场景 = **SOP「功能迭代与设计」**(示例项目:登录页重设计——用真实在途迭代做叙事);报销降为流程投影客串 | Boss 拍板 07-17:要真实团队协作场景,报销流较简单 |
| N12 | 演示账号 = **2 人 + 3 Agent**:Boss(产品/评审)、Andy(工程)、Agent·Scribe(PRD/文案)、Agent·Design(设计稿)、Agent·Check(验收预检) | Anna 代决策(拍板⑤授权) |
| N13 | 「+任务」= **Asana 式人机协同拆解**:显式触发 → Anna 起草 1..N 子任务(≤3,角色/依赖/验收自动带上)→ 勾选确认批量下推 | Boss 拍板 07-17:提效、快速下推执行与检查、协同进度可视化 |

---

## 4. 用户与权限

- **Boss(老板/项目发起人)**:建项目、AI 拆解确认、派人/改派、评审、处理审批、编辑项目共识、管理花名册与模板。
- **成员(员工)**:收件箱、接活/没空反馈、执行、提交产物、频道发言、@人、查看全图(进度公开)。
- **Agent 成员**:无登录;由 Harness 代表执行;产物过评审门;在花名册/频道/图上与人同等呈现(带 Agent 标识,persona 不骗人)。
- 权限沿用两档(D9);全部数据按 workspace 隔离(已建成)。

---

## 5. 信息架构与页面设计

### 5.1 一级 IA

侧栏分段 pill:`Home ｜ Cowork ｜ Crew`(F1 接缝落地)。Crew 段侧栏二级:

```
[Crew 段]
  收件箱 Inbox        ← 成员默认落点;徽标=未读数
  项目 Projects       ← 项目列表(状态/进度/阻塞摘要)
  团队 Team           ← 人 + Agent 花名册
  模板 Templates      ← SOP 模板库
  资源(沿用现有组)
```

全局(跨段):**通知铃**挂 Anna 外壳右上,任何段可见(§5.5)。

### 5.2 收件箱 Inbox

三组,行动直达:

- **待我做**:assigned/rework 的任务卡(含驳回理由);
- **待我审**:评审门卡 + **报销审批卡**(N4,含金额/事由/申请人,点击深链报销页);
- **@我**:频道提及,点击深链到频道锚点。

### 5.3 项目详情页(核心屏,三区)

```
┌──────────────────────────────────────────────────────────────┐
│ 项目健康条:阶段进度 x/y · 阻塞 n · 等我处理 n · 活跃 Agent n │
├────────────────────────────────────┬─────────────────────────┤
│                                    │  项目频道(Anna 主持)   │
│   Work Graph 画布(主视图)        │  · 事件卡:派活/交活/    │
│   横向 DAG · 状态点亮 · 可平移缩放 │    请审/驳回,@到人     │
│   节点=任务卡(assignee 头像/状态)│  · 人类发言 · 评审卡     │
│   执行中呼吸 · 阻塞红 · 新分支高亮 │  · 「+任务」命令        │
│                                    │  (可折叠;宽度可调)     │
├────────────────────────────────────┴─────────────────────────┤
│ 视图切换:图 ｜ 列表(P0 轻量) ｜ 看板(P1)                 │
└──────────────────────────────────────────────────────────────┘
```

- **点节点 → 任务抽屉**(右滑出,压频道之上):详情/验收标准/产物(版本)/执行 trace(Agent 任务复用 StageStepTrace,可看真 run)/操作(认领·开始·提交·评审·改派·没空)。
- 频道事件卡与图节点互为锚点:点卡片跳节点,节点抽屉里可跳频道上下文。

### 5.4 团队 Team

花名册卡片:头像/姓名/`kind: human|agent`/职能角色(PM/前端/UIUE/文案…)/技能 chips/当前负载(进行中任务数,真数据)/状态。Agent 卡片点开 → 跳 Agent 中心该 Agent 的配置(模型档案/附加指令)——**同一 registry,两个视角**(N9)。Boss 可编辑技能与角色。

### 5.5 通知铃(Anna 外壳级)

- 位置:外壳右上,三段全程可见;未读徽标。
- **登录后**:有未读 → 弹出堆叠通知卡(最多 3 张)+ 铃点亮,点击深链直达 Crew 对应任务/频道锚点/审批卡——这就是「Crew 账户作为沟通方式」的具象。
- 事件类型:派活给我 / @我 / 待我审(含报销)/ 我的任务被驳回 / 我项目的阻塞。
- 已读态落库;通知与频道事件同源(同一状态机 transition,不双写两套事实)。

### 5.6 模板 Templates

SOP 模板列表 + DAG 骨架预览(小图)。首发(N11):**「功能迭代与设计」**(旗舰,新——需求简报→PRD 起草→PRD 评审◇→设计稿→设计评审◇→实施→代码评审◇→验收合并)+ **「营销物料」**(沿用);原「产品设计」模板并入前者。报销走真实流投影(§10),不造演示模板。P1 模板编辑;P2 AI 生成模板(对标 AI Studio)。

---

## 6. Work Graph 画布:方案评估与选型(Boss 点名)

### 6.1 事实:Asana 怎么做的

**Asana 没有自由无限画布。**「Work Graph」是数据模型(任务/项目/目标/人的一对多关系底座),呈现层全部是结构化视图:List / Board / Timeline / Gantt / Calendar / Dashboard,依赖以 Timeline/Gantt 上的连线呈现;Workflow Builder 是「从左到右的阶段式流程编辑器」,不是白板。自由画布是 Miro/FigJam 的赛道——**协同白板 ≠ 协同执行**。

对 Anna 的启示:「图会生长」的正确实现是**数据驱动 + 自动布局重算**,而不是手摆节点。AI 拆解生成图、协作让图长分支——这些都要求布局器随数据变化重新排版并动画过渡;手摆布局反而会在每次生长时被打乱。

### 6.2 三方案对比(工作量以本项目 subagent-driven 节奏估)

| 方案 | 描述 | 工作量 | 判定 |
|---|---|---|---|
| **G1 结构化动态 DAG(推荐)** | React Flow(@xyflow,MIT)+ elkjs/dagre 自动布局:横向 DAG、平移缩放、状态点亮(执行中呼吸/阻塞红/完成灰)、**图变异时布局重算 + 动画过渡 + 新分支高亮**、点节点开抽屉 | 基础视图 ≈1 个执行片;生长动画 +0.5-1 片;合计 **≈2 片** | ✅ 与「AI 生成 + 协作生长」相性最好 |
| G2 自由无限画布 | Miro 式:节点任意摆、自由连线、便签 | 在 G1 之上 **+1-2 周级**:手摆布局持久化、与自动生长的布局合并策略(难点,无成熟方案)、信息密度管理 | ❌ 成本高且与自动拆解相冲 |
| G3 看板为主 + 只读小图 | 旧 Crew 已验证的看板 + 缩略 DAG | ≈1 片 | ❌ 最便宜但丢掉签名视觉,对业务方冲击力弱 |

**推荐 G1,三条论据**:①「图会生长」在 G1 是自然能力(数据变→重排→动画),在 G2 是灾难(生长打乱手摆);②行业验证:Asana 自己也走结构化呈现,自由画布无先例;③成本曲线:G1 两片可交付签名视觉,G2 的增量花在与核心叙事无关的自由度上。**G1 兼容后续升级**:P1 可加「pin 节点」局部微调,P2 若真需要白板另立视图,不推翻。

### 6.3 图的生长机制(三个真来源)

| 来源 | 机制 | 深度 |
|---|---|---|
| a. 评审驳回 | 状态机已有:rejected → rework,节点变色、返工边呈现 | P0(现成) |
| b. 频道长任务 | 频道「**+任务**」命令(或消息 hover「转为任务」,Asana 式 message→task):Anna 按这句话+项目上下文起草 **1..N 个子任务**(≤3;标题/角色建议/依赖/验收标准自动带上)→ **勾选确认批量下推**(确认即指派+通知+图生长,N13) | P0(显式触发+确认门);P1 升级为 Anna 主动建议芯片 |
| c. 阻塞上报 | 成员/Agent 报 blocker → 节点标红 + Boss 收通知;可派生「协调任务」 | P0 标红+通知;派生任务 P1 |

纪律:**模型只起草,推进靠确认**(ADR-002);图上每次变化都有 audit 事件对应,零捏造。

---

## 7. 项目频道(Anna 主持)

### 7.1 消息模型

| kind | 产生方式 | 呈现 |
|---|---|---|
| `event` | 状态机 transition 自动生成(派活/开始/交活/请审/通过/驳回/阻塞/新节点) | 结构化事件卡,@相关人,可点跳节点 |
| `artifact` | 任务提交产物(人或 Agent) | 产物卡(标题/版本/摘要),点开抽屉 |
| `review` | 评审请求 | **评审卡带按钮**:通过 / 驳回+批注——评审在频道里就地完成,直接驱动状态机(沟通即协作的落点) |
| `say` | 人类自由发言(支持 @) | 普通消息 |
| `command` | 「+任务」等显式命令 | 草案卡 → 确认后落图 |

### 7.2 频道 ↔ 图 双向驱动

- **图→频道**:每个状态机 transition 自动落一张事件卡(Anna 口吻、@到人)。Agent 任务完成 → 频道出产物卡并 @评审人;下游任务解锁 → @下游 assignee。
- **频道→图**:评审卡按钮直接驱动状态机(图即时变);「+任务」长出新分支(§6.3-b);驳回批注作为 rework 输入注入 Agent 重跑上下文(老后端已有 rework 原因字段,接进 agent prompt)。

### 7.3 MVP 边界

不做:自由 NL 全解析(命令显式化)、频道内私聊/子线程、表情回应、已读回执、外部成员。频道是**项目时间线**,不是通用 IM(取向 B 之否决)。

---

## 8. Memory 分层

| scope | 内容 | 读者 | 写入 | 状态 |
|---|---|---|---|---|
| `workspace`(已有) | 业务口径/规则/SOP 片段 | 各域 Agent | 人工+建议 | BusinessMemory 不动 |
| `project`(新) | **项目共识**:目标、受众、关键决策、术语口径、约束 | 该项目所有 Agent run(system 注入)+ 成员可见 | P0 人工编辑(项目内「共识」面板);P1 频道沉淀建议(Anna 提议「要不要记入共识?」) | 新建 |
| `member`(新) | 人:技能/角色/偏好/负载画像(花名册字段);**Agent:即该 Agent 的专属 memory** | 派人引擎、该 Agent 自身 | 花名册编辑 + P1 运行沉淀 | 新建 |

- 与 AIOS C3 合流:MemoryItem 带 scope,机制在 Harness 统一、差异只在配置;Boss 提的「Hiker/Chat/Create 各有独立 Memory」= member(agent) scope 的同一机制,Crew 不另造轮子。
- **溯源验收**(呼应 PRD v1.1 修订四):Agent 产物 trace 中可见注入的共识条目;审计含 memory 命中记录。
- 不做向量 RAG(维持既有裁决,结构化检索)。

---

## 9. 运行时与治理(与 Harness 的关系)

### 9.1 执行

- **Agent 任务执行 = W7.T3 落地**:`agent_worker` 弃单发空壳,改走 `run_subagent`(独立 QueryEngine、按职能角色映射工具集与 skill、max_turns 治理),产物 + `run_ref` 挂任务卡,trace 可回看。
- **后台运行**:Agent 任务是长活,跑在 L3 后台 run 上(断线恢复、帧日志);多 Agent 并行受 L5 并发闸约束;长项目上下文由 L4 autocompact 兜底;跨天项目靠 L2 持久化。
- **前置依赖**:`feat/harness-longrun` 合并 main(当前 READY TO MERGE 待 Boss 验收)。

### 9.2 治理

- Agent 产物必须过同一评审门(人审;ADR-002);
- 写操作(如报销)沿用 CapabilitySuspend 审批;
- 频道事件、通知、图变化三者同源于状态机 transition + audit,**不允许任何 UI 侧捏造状态**(拒绝假数据红线);
- Agent 在频道/花名册带明确 Agent 标识(persona 不骗人,沿用三级下钻四护栏)。

---

## 10. Cowork 集成:组织收件箱(叙事连通)

- **P0 报销全流程进 Crew(流程投影)**:集成对象是**整个报销流程**而非单一审批环节——Crew 侧生成「流程卡」,四步状态条(提交→校验建单→审批→回读核验)由报销后端既有事件驱动、当前步高亮;审批步弹通知 + 入 Inbox,点击深链 Cowork 报销页既有 UI;批完投影同步(同源审计)。薄投影,不动报销逻辑。
- **P1 就地审批**:复用报销远程审批四件套 API,在 Crew 审批卡上直接批;催收派办(值守轮设计)产生的任务进 Crew Inbox。
- **与值守轮的边界**:值守页 = 业务系统维度(巡检发现的事);Crew Inbox = 组织协作维度(人派给你的事+待你审的事)。同一审批两处可入口,状态同源。两轮改动错开排期,避免碰撞同一批文件。

这一条把叙事连成一句话:**业务系统的事(Cowork)和项目的事(Crew)最终都汇到「人」——Anna 负责把人组织起来。**

---

## 11. 数据模型(增量,基于旧 Crew 域模型)

```
Task(既有) + source: crew|reimbursement|dispatch   # 组织收件箱
           + origin: sop|channel|rework|blocker     # 生长来源
           + created_from_message_id?               # 频道锚点
ChannelMessage { id, project_id, author(member_id|anna), kind: event|artifact|review|say|command,
                 body, refs{task_id?, run_ref?, artifact_id?}, mentions[member_id], created_at }
Notification   { id, workspace_id, to_member_id, kind, title, deep_link,
                 read_at?, idempotency_key, created_at }
MemoryItem(既有) + scope: workspace|project|member + project_id? + member_id?
Member(既有)   + agent_ref?(→ Agent 中心 agent_id)  # N9:引用不复制
Project(既有)  (频道与项目 1:1,不建独立 channel 实体)
```

API 增量(草图):`GET/POST /projects/{id}/channel`、`POST /projects/{id}/channel/command`(草案→确认两段)、`GET /notifications` + `PATCH read`、`GET/PUT /projects/{id}/memory`;既有 8 端点沿用;`run-agent` 改异步返回 `run_ref`(L3);`suggest-assignments` 沿用。

---

## 12. MVP 范围(P0 / P1 / P2)

| 优先级 | 内容 |
|---|---|
| **P0(Crew alpha)** | 第三段 IA + 收件箱(三组)+ 项目列表 + 团队 + 模板;项目三区(健康条 + G1 画布 + 频道);任务全生命周期 + 评审卡就地批;AI 拆解 + 智能派人(后端现成,新 UI);**Agent 真执行**(W7.T3 + L3 后台 + trace);通知铃(外壳级,登录即弹);项目共识 Memory(手动 + 注入 + 溯源);报销全流程状态卡(四步投影,审批深链);图生长 a/b/c(b=显式命令+确认);列表辅视图;轮询实时(N10) |
| **P1** | 就地审批;催收派办进 Crew;频道沉淀共识建议;Anna 主动「立为任务?」建议;成员负载视图;看板视图;pin 节点微调;项目级 SSE 事件流;member memory 运行沉淀;模板编辑器 |
| **P2** | webhook/邮件门铃(通知 channel 抽象);外部 IM;跨项目 portfolio;自动化规则(对标 Asana Rules);容量/排期引擎;WebSocket 在场;AI 生成模板;多机部署 |

**非目标(本期不做)**:通用 IM(子线程/私聊/表情)、自由白板、入站邮件/IM 解析、多租户计费、高级分析报表。

---

## 13. 演示剧本(15 分钟 money-shot,全真数据)

场景 = **Anna 自身的一次功能迭代**(N11 旗舰 SOP「功能迭代与设计」;示例项目「登录页重设计」——用真实在途的迭代做叙事,零捏造)。

1. **建项目**:Boss 新建「登录页重设计」,选 SOP「功能迭代与设计」→ AI 拆解出 需求简报→PRD 起草→PRD 评审◇→设计稿→设计评审◇→实施→代码评审◇→验收合并 的 DAG,**图当场长出来**;
2. **派人**:智能派人建议(PRD 起草=Agent·Scribe、设计稿=Agent·Design、实施=Andy、评审=Boss,N12)→ Boss 确认 → 频道里 Anna 逐个 @人,**成员端通知铃弹卡**;
3. **Agent 干活**:Agent·Scribe 后台真跑 PRD 初稿(节点呼吸、可点开看 trace)→ 完成 → 频道产物卡 @Boss 请审;
4. **人协作**:Andy(第二账号)从通知进来,频道里提「验收标准补一条:画布 50 节点不掉帧」→ 「+任务」:Anna 起草『性能验收』子任务(角色/依赖/验收自动带上,N13)→ Boss 勾选确认 → **图上长出新分支**(高亮动画);
5. **评审门**:频道评审卡驳回+批注 → 节点转红返工 → Agent 带批注重跑 → 通过 → **下游『设计稿』解锁点亮**,@下一棒;
6. **叙事连通**:中途 Andy 提交差旅报销 → Boss 通知铃弹「审批」→ Inbox 报销流程卡(四步状态条,当前步=审批)→ 深链报销页批掉 → 回 Crew 流程卡走到「回读核验」;
7. **共识 Memory**:打开项目共识(「登录页只在远程 4xx 形态出现」「已发布版=暖 terracotta 非蓝白」)→ 指给业务方看 Agent trace 里引用的共识条目——「人和 Agent 读同一份认知」。

**达标线**:剧本连演 3 次无阻断性失败(沿用 PRD v1.1 §18.2 口径)。

---

## 14. 验收标准

1. 剧本 3 连(§13);
2. Agent 任务产物 100% 过评审门才可下推(审计可证);
3. 频道每张事件卡可溯源到 audit 事件(零捏造抽查);
4. 通知:派活/请审/@我三类事件通知达到率 100%(站内);
5. Memory:Agent 产物 trace 含共识条目命中记录(修订四口径);
6. 四门全绿(tsc/vitest/pytest/build)+ 新增 crew gate(拆解→派人→执行→评审→下推 冒烟)。

---

## 15. 工作量与切片建议(粗估,拍板后由 writing-plans 细化)

| 切片 | 内容 | 估量 |
|---|---|---|
| S1 后端 | 通知中心(store+API+未读) | 1 片 |
| S2 后端 | 项目频道(消息模型+状态机事件桥+命令两段式) | 1 片 |
| S3 后端 | Memory scope 扩展(project/member+注入+命中审计) | 1 片 |
| S4 后端 | W7.T3:Crew worker 接真引擎 + L3 后台 run + run_ref | 1-1.5 片 |
| S5 后端 | 报销审批→Crew 审批卡薄桥 | 0.5 片 |
| S6 前端 | 第三段 IA + 收件箱 + 团队 + 模板(壳与列表) | 1 片 |
| S7 前端 | Work Graph 画布(React Flow+elk,状态点亮+生长动画) | 1.5-2 片 |
| S8 前端 | 项目频道 UI + 任务抽屉(trace 复用) | 1-1.5 片 |
| S9 前端 | 通知铃(外壳级)+ 登录弹卡 | 0.5 片 |
| S10 | 联调 + 剧本三连 + gate | 1 片 |

合计 ≈10 片,建议拆两轮:**Crew-α**(S4/S6/S7 + S1 最小通知:图 + 真执行主线)→ **Crew-β**(S2/S3/S5/S8/S9/S10:频道 + Memory + 集成 + 剧本)。前置:长跑轮合 main;新依赖:@xyflow/react + elkjs(均 MIT)。

---

## 16. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 分支排队:harness-longrun、cowork-anna-polish 未合 | 先验收合并再开工;Crew 改动避开值守轮文件 |
| R2 | React Flow 在 Electron 的性能/体积 | 节点 <50 无压力;按需引入 |
| R3 | 「+任务」草案质量 | 显式命令+确认门,模型只起草(ADR-002) |
| R4 | 多账号演示体验(桌面单实例) | 演示用双浏览器窗口(uvicorn 同源模式);通知铃跨账号各自轮询 |
| R5 | 范围蔓延(Crew 天然是大产品) | P0 表为唯一事实源;新想法一律记 P1/P2 |
| R6 | 与值守轮 Cowork 改动冲突 | 排期错开;报销桥只读接审批事件,不动报销代码 |

---

## 17. 拍板决议(2026-07-17,Boss;④⑤⑥授权 Anna 代决策)

| # | 问题 | 决议 |
|---|---|---|
| ① | 画布选型 | **G1 确认**(结构化动态 DAG) |
| ② | Cowork 流程集成 | **纠偏:集成对象是整个报销流程**(审批只是一环),但报销流较简单 → 落成「流程投影」(§10);**旗舰演示场景改为「Anna 功能迭代与设计」**(真实团队协作,N11) |
| ③ | 频道长任务 | **借鉴 Asana 人机协同模式**(N13):显式触发 → Anna 起草 1..N 子任务 → 勾选确认批量下推;第一性原理=提效、快速下推执行与检查、协同进度可视化 |
| ④ | SOP 模板 | 首发「功能迭代与设计」+「营销物料」;报销走真实流投影,不造假模板(Anna 代决策) |
| ⑤ | 演示账号 | **2 人 + 3 Agent**:Boss(产品/评审)、Andy(工程)、Agent·Scribe、Agent·Design、Agent·Check(N12,Anna 代决策) |
| ⑥ | 排期 | **Crew-α 先行**;值守轮拍板可并行、实施错后(Anna 代决策) |

---

## 18. 下一步

1. ~~Boss 拍板~~ **已完成(2026-07-17,决议见 §17)**;
2. ~~出 DESIGN-BRIEF~~ **已完成**:`docs/superpowers/DESIGN-BRIEF-2026-07-17-anna-crew.md`(桌面副本同名)交 Claude Design;
3. 返稿校对 → `writing-plans` 出实施计划(切片按 §15,subagent-driven);
4. 长跑轮验收合 main(前置)。

---

### 附:对标来源

- [Asana AI & Agentic Work Management](https://asana.com/product/ai)
- [Asana Unveils Operating System for Human-Agent Teams(BusinessWire, 2026-06-04)](https://www.businesswire.com/news/home/20260604472500/en/Asana-Unveils-Operating-System-for-Human-Agent-Teams)
- [SiliconANGLE:Asana launches AI-powered products to help organizations manage human and agent work](https://siliconangle.com/2026/06/04/asana-launches-ai-powered-products-help-organizations-manage-human-agent-work/)
- [Asana Project Views(List/Board/Timeline/Gantt/Calendar)](https://asana.com/features/project-management/project-views)
- [Asana AI Teammates](https://asana.com/product/ai/ai-teammates)
