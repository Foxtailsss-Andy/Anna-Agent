# Cowork 值守轮 — Finance × Hiker 重构设计稿

- **日期**:2026-07-12
- **状态**:设计稿,待用户拍板(拍板清单见 §9)
- **范围**:Cowork 段的 Finance(财务经营看板)与 Hiker(客户与合同看板)两个业务面 + 新增「值守」落点;报销助理页本轮零改动(仅被值守引用)
- **产出后流程**:用户拍板 → 出 DESIGN-BRIEF 交 Claude Design → 返稿逐屏校对 → 实施计划
- **事实基础**:本稿所有「现有能力」均经代码勘探核实(2026-07-12,分支 feat/fe-home-merge);字段出处见附录 A。规划不承诺连接器喂不出的数据(ADR-002 / 拒绝假数据)。

---

## §0 一句话与定位

> **Cowork = Anna 替你值守业务系统的地方。看板负责「看清」,值守负责「找到你」,派办负责「办妥」,证据链负责「可信」。**

与 Home 构成一对:

| | Home | Cowork |
|---|---|---|
| 方向 | **你找 Anna**(发起对话/构建) | **业务经 Anna 找你**(需要你的事送上门) |
| 单元 | 会话(Chat/Create run) | 值守卡(审批/风险/异常/到期) |
| 节奏 | 你想到才来 | 打开就有今天的值守结果 |

这是「新一代 Agentic SaaS 连上 ERP」与「传统 BI 门户 + 聊天框」的分水岭:**ERP 已经擅长存数据、出报表;Anna 做 ERP 做不到的四件事——替你盯(attention)、替你查(explanation)、跨系统合(synthesis)、替你办(follow-through)。**

---

## §1 为什么重构(现状诊断)

现状(经勘探核实)是一套很干净的「确定性 BI 五段式 + 滑出副驾」:数据 100% 真值、空态诚实、Iris token 统一。问题不在质量,在**形态天花板**:

1. **它只回答「现在什么样」,不回答「哪些事需要我」。** 焦点警示带有异常,但异常不可行动——看到「客户A 逾期 72 天」之后,用户只能自己去 ERP 办。洞察与动作断链。
2. **后端高价值零件没有被产品面用上。** Hiker 11 个工具只结构化消费了 3 个:催款提醒行(逾期/今日到期/即将到期,逐行带单号金额日期)、合同业务链时间线(合同→订单→发货→开票→应收→回款→核销)全部闲置;报销远程审批四件套、催收任务写闭环(在待退役的 Associate 里)同样闲置。
3. **Cowork 与 Home 词表割裂。** Cowork 副驾还在旧 AgentComposer,没有档案 pill / + 菜单 / Agent 注入;finance/hiker 无 step 帧,LoopCard「当下」行是空的(B0 未合入)。

上一轮 Home 合并已明文「Cowork 及其所有内页本轮零改动」——即 Cowork 被显式冻结、留给本轮。

---

## §2 三个取向与选择

| 取向 | 内容 | 判断 |
|---|---|---|
| **A 增强看板**(保守) | 保留两块看板,给洞察卡加动作按钮、副驾换新 Composer | 便宜,但产品叙事不变:仍是「你去看数据」。差异化不足以支撑「新一代」定位 |
| **B 值守台**(**推荐**) | 反转入口:Cowork 落点 = 跨系统值守简报(需要你的事),看板降为各系统的「快照区」,洞察卡长出「派办」闭环,Hiker 长出对象 360 | 用的全是已有零件(审批门/催款行/业务链/催收写),P1 不需要调度器就能立住;是 Harness AIOS 叙事的自然产品化 |
| **C 全对话化**(激进) | 取消看板,一切经对话生成 | 否决:丢掉确定性 BI 的可信度与一眼可扫性,违背已验证的「看板=监控/副驾=追问」分工;信任回退 |

**选 B。** 关键理由:B 的每一块都能指到真实数据字段和已验证的机制(见附录 A),不需要为了叙事造假数据;且 A 是 B 的子集(B 的 P1 包含 A 的全部动作)。

---

## §3 真实场景四幕(现状 vs 重构后)

### 幕一 · 周一早上:值守简报
- **现状**:打开 Finance 看板扫 6 个 KPI,再切 Hiker 看板扫 7 个 KPI,自己判断哪里要管。
- **重构后**:进 Cowork 落在「值守」页,Anna 已巡检(打开即刷新/手动「现在巡检」):
  > 需要你的 3 件事:① 1 笔报销等你审批(¥8,400 · 中风险 · 已等 1 天);② 今日到期回款 2 笔 ¥36 万,逾期 3 笔 ¥98 万(最久 72 天);③ 费用环比 +12%,主因差旅(异常卡)。
- **数据出处**:① 报销审批(本地挂起 run + 远程 `reimbursement.list_approvals`);② Hiker `get_collection_summary.reminders`(逐行 plan_number/customer/金额/planned_date/days_offset);③ ERP snapshot `anomalies[]`。**全部现有字段,巡检为确定性聚合,不经模型。**

### 幕二 · 逾期回款的两条动线(旗舰场景,两侧各自成立)

**2a · Finance:从看见到办妥(ERP 内闭环)**
- **现状**:账龄表看到「客户A ¥48 万 逾期 72 天」→ 到此为止,去 ERP 手工建催收任务。
- **重构后**:账龄行点「**派办催收**」→ 副驾发起催收 run(预填客户/金额/账龄)→ 模型起草催收任务 → **审批卡挂起**(引擎 `awaiting_approval`)→ 你确认 → 写入 ERP `erp.collection_task.create_draft` → 读回 `get_status` 核验 → 「办妥」卡带任务号。
- **机制出处**:写与读回 = demo-erp 现有工具对(今天由待退役的 Associate 持有);审批门 = 报销已验证的 `CapabilitySuspend` 原语。

**2b · Hiker:一条链看穿一个客户(只读证据)**
- **现状**:催款风险只有计数,「哪家、哪单、卡在哪一环」要自己拼。
- **重构后**:值守回款卡/催款提醒行点「**查客户**」→ **客户 360 抽屉**:合同列表 + 选中合同的**业务链时间线**——合同已签、订单已下、货已发、票已开、应收挂账、回款缺口,每节点带单号/金额/日期,**链条断在哪一眼可见**。底部「向 Anna 追问这家客户」;催款函草稿生成为 P2 产物(只读域,不写回 Hiker)。
- **数据出处**:`hiker.contract.get_business_chain`(7 类节点数组)+ `list_contracts`。

**两条动线的所有零件今天都存在,只是没接到产品面上。** 注意:ERP 与 Hiker 当前客户集不同,两条动线各管各的系统;「同一客户跨系统联查」是 P3(依赖主数据映射,见 §8)。

### 幕三 · 老板审批(需要你 ≠ 你去找)
- **现状**:员工用报销助理提交后,审批人要自己去报销页翻。
- **重构后**:值守页「待你审批」卡:金额/风险级/政策摘要/等待时长;P1 点「去审批」深链报销页审批卡;P2 就地审批(W4 通用 ApprovalCard)。

### 幕四 · 追问与解释
- **现状**:副驾能问,但「当下」行空(无 step 帧),答案质量受限于 `erp.finance.query` 的演示实现。
- **重构后**:每张值守卡/KPI/异常都带「追问」→ 跳到对应系统副驾并自动带上下文发起;B0 合入后步骤时间线点亮;真正的自由查询(发票级下钻)标注为 P3(依赖 demo-erp 真记账化,见 §8)。

---

## §4 信息架构

```
侧栏(两段不变:Home | Cowork)
Cowork 段:
  值守            ← 新增,Cowork 默认落点
  Finance
    经营看板       ← 重构(§5.2)
    报销助理       ← 本轮零改动
  Hiker
    经营看板       ← 重构(§5.3)
  (Crew·组织 stub 不动;资源组不动)
```

- `CoworkItem` 增加 `"duty"`;进入 Cowork 段默认选中值守(可拍板,§9-1)。
- Cowork 段标签现为「看板」,建议改为「**值守**」或「**业务**」(拍板项 §9-5)——重构后 Cowork 不止是看板。
- **层次语义**:值守页管「哪些事需要你」(跨系统、可行动);系统页管「这个系统现在什么样 + 就地追问/派办」;报销页管「发起并办完一笔报销」。三层各有唯一职责,不互相复制。

---

## §5 逐屏规格

### §5.1 值守页(新)

**页头**:眉题 `COWORK · 值守` / 衬线标题「今日值守」/ 右侧「现在巡检」按钮 / ProvenanceLine:`来源:报销 · Hiker · ERP(只读)· 巡检于 HH:MM · 由代码汇总,非模型生成`。

**巡检 run 语义**:`POST /api/cowork/duty/runs` → 新的**确定性聚合 orchestrator(无模型)**,并行调三源:
1. 报销待审批:本地 `ApprovalRequest(status=pending)` + 远程 `reimbursement.list_approvals`;
2. Hiker 回款:`get_collection_summary(window_days=7)` 的 `reminders.summary + rows`;
3. ERP 异常与账龄:`erp.finance.get_dashboard_snapshot().anomalies` + `get_receivables_aging()`。

每源独立降级:某源失败只灰该区块(块内 offline/error chip),不整页倒下。巡检本身是一个 run,可用 LoopCard 回看(与三级下钻规格一致:确定性步骤也留痕)。

**刷新规则**:进入值守页时,若本会话尚无巡检结果则自动发起一次;已有则显示最近结果(页头标巡检时间)+ 手动「现在巡检」。P1 不落库,结果为会话级(与 finance/hiker 看板现行为一致);P2 落库后升级为「今日值守」跨会话延续。

**区块结构**(自上而下):

1. **需要你**(核心区,按 severity 排序的值守卡列):
   - **值守卡解剖**(设计原语,交 Claude Design 的核心件):
     - 结论句(衬线,**代码从真实字段拼装**,非模型生成,如「3 笔回款已逾期,合计 ¥98 万,最久 72 天」)
     - 证据行(2-4 个关键数/迷你行表,确定性)
     - 溯源行(来源工具 + 数据截至,微字号)
     - 动作条:`去处理`(深链目标页/抽屉)· `追问 Anna`(跳系统副驾并预填发起)· `忽略`(本地,P1 会话级)·(P2 增 `盯住`)
   - **P1 卡词表**(只做这四类,零站位):
     | 卡 | 数据源 | 去处理指向 |
     |---|---|---|
     | 待你审批(报销) | 本地 pending + 远程 list_approvals | 报销页审批卡(P2 就地审) |
     | 回款到期/逾期(Hiker) | reminders rows(逐行单号/客户/金额/日期) | Hiker 页客户 360 抽屉 |
     | 经营异常(ERP) | snapshot.anomalies(ar_overdue / expense_spike) | Finance 页对应区块 + 副驾追问 |
     | 应收账龄重点(ERP) | receivables_aging rows(≥45 天) | Finance 页派办催收 |
2. **快照行**(压缩摘要,每系统一行):Finance:现金/应收/利润 3 个数 + Hiker:合同额/未收 2 个数,点击进各自看板。**不是第二个看板,只是路标。**
3. **值守记录**(P2,依赖落库):历史巡检列表 + 与上次的 delta(「新增 1 笔逾期」)。P1 不画此区(零站位红线)。

**空态**:三源全断 → 整页诚实引导(复用 CoworkStates 语法);巡检过但无事 → 「今天没有需要你的事」+ 快照行照常(正向空态);从未巡检 → 「还没有今天的值守记录 — 现在巡检」。

**内容三问**(值守卡准入标准,写进验收):**需要你吗?到期了吗?变了吗?**(P1 前两问;「变了吗」待 P2 落库后启用)——KPI 水平值本身不是新闻,不进值守。

### §5.2 Finance 页(重构)

1. **新增「需要你」条**(看板顶部、AlertBand 位置升级):账龄行动卡——`receivables_aging` 每行(客户/金额/账龄)长出动作条:`派办催收` · `追问`。AlertBand 的异常卡并入此条(异常卡动作:`追问` · `去看数据`)。
2. **快照区 = 现五段式保留**(KPI 带 + 趋势/账龄图 + 洞察 + Anna 解读):形态不动,只把「建议动作」区的 chip 从「只能追问」升级为可派办(`suggested_actions.target` 已有 `write_intent` 枚举位)。
3. **派办催收闭环(P1 旗舰交互)**:动作条「派办催收」→ 打开副驾并发起催收 run(预填客户/金额/账龄上下文)→ 模型起草任务 payload → 引擎挂起 `awaiting_approval` → **副驾内审批卡**(复用报销 ApprovalCard 形态,LoopCard approvalSlot 已有此插槽)→ 确认 → 写 `erp.collection_task.create_draft` → `get_status` 读回核验 → 办妥卡带 `demo-task-N` 任务号。拒绝则回草稿态。
   - 后端配套:finance 工具白名单增加催收对(写工具仅 orchestrator 确认后调用,镜像报销模式);**Associate 域随之正式退役**(其催收语义被 Finance 吸收,符合 PRD 修订二)。
4. **副驾升级到统一词表**(§5.5)。

### §5.3 Hiker 页(重构)

1. **新增「需要你」条**:催款提醒卡——`reminders.rows` 按 `reminder_type`(overdue/due_today/due_soon)分组,逐行:单号/合同号/客户/计划额/未收额/计划日期/偏移天数;行动作:`查客户`(360 抽屉)· `追问`。现 AlertBand 计数文案并入。
2. **快照区 = 现五段式保留**(KPI/回款进度/账龄分布/重点客户表/洞察)。
3. **客户/合同 360 抽屉(P1 新增,本轮最大的「呈现」创新)**:重点客户表行、催款提醒行、副驾提到的客户/合同 → 右侧抽屉(与副驾同容器规格,420px,同时只开一个):
   - 客户头:名称/合同数/合同额/已收/未收(customers row 字段);
   - 合同列表:`list_contracts(customer_name)`(合同号/状态/金额);
   - 选中合同 → **业务链时间线**:`get_business_chain` 的 7 类节点(合同→销售订单→发货→开票→应收→回款→核销)按时间轴纵排,每节点:单号/金额/日期/状态;缺哪环空哪环(**链条断在哪一眼可见——这就是催收证据**);
   - 底部:`向 Anna 追问这家客户`(预填客户名跳副驾)· `生成催款函草稿`(P2,产物,不写回 Hiker)。
   - 后端配套:hiker orchestrator 增加确定性 profile/chain 端点 + Anna 侧 schema(现只有副驾模型能自由调这两个工具,无结构化类型)。
4. **只读纪律不变**:Hiker 全部动作要么是「读并呈现」,要么是「生成产物」(草稿/简报),**绝不做假的写回按钮**。合同到期雷达暂不做(勘探未证实合同实体带到期日字段,待 `get_contract_detail` 字段核验后再进 P2)。

### §5.4 报销助理页

本轮**零改动**(它已是参考级 agentic 页)。与值守的关系:它的 pending 审批进值守「待你审批」卡;P2 就地审批落地后,值守卡直接完成审批动作(复用 W4 通用 ApprovalCard)。

### §5.5 词表与组件统一(「整洁 + 面向未来」的本轮兑现)

| 件 | 现状 | 本轮 |
|---|---|---|
| Composer | Cowork 用旧 AgentComposer(与 Home 割裂) | 副驾换统一 Composer(**与 HomeComposer 同源**:抽共享核 + 副驾窄容器变体,不另起炉灶):保留建议问题 chips(即场景层)、`+` 菜单(Agent 注入 / 连接器只读状态)、模型档案 pill;**不挂工作空间/权限件**(副驾不操作文件系统,挂了就是假管控,同决议 8 逻辑) |
| LoopCard | 已共享(M3「办妥」形随入) | 副驾 approvalSlot 接通(催收审批卡);B0 合入后「当下」行自动点亮 |
| ApprovalCard | 仅报销页 | 抽成通用件给催收复用(= WorkBuddy W4 的第一步) |
| ProvenanceLine | 看板页头有 | 下沉到**每张值守卡**(卡级溯源) |
| step 帧 | finance/hiker/reimb 不发 | **B0 本轮并入**(各 capability 补 humanize_step,代码生成中文标签) |

---

## §6 五个签名特性(「特色」的正面回答)

1. **业务收件箱**:不是你去翻系统,是需要你的事来找你。值守卡三问(需要你吗/到期了吗/变了吗)决定一切内容取舍。
2. **一条链看穿一件事**:对象 360。别的系统给你八张报表,Anna 给你一条业务链——合同到回款每一环真单据,断在哪一眼可见。
3. **看板会办事**:从看见到办妥。每个洞察长出动作,写动作必过审批门(挂起→确认→写入→读回核验→办妥),全程留痕可回看。
4. **每个数字可追责**:卡级 ProvenanceLine + 「由代码计算,非模型生成」分界 + 三级下钻(L3 真参数/真返回,B2 落地后)。这是对「AI 会编数」的产品级回答。
5. **问一次,例行一辈子**(P2):任何追问过的问题、任何值守卡,都可「盯住」固化为例行巡检(哨兵);到点自动跑,结果进值守记录并门铃通知。**任何你问过两次的问题,都不该问第三次。**

---

## §7 诚实性红线(ADR-002 分界)

| 内容 | 谁产生 | 呈现纪律 |
|---|---|---|
| 值守卡结论句/证据行/快照/业务链 | **代码**(确定性聚合/映射) | 可作页面权威事实;卡级溯源行必在 |
| 异常解释、Anna 解读、催收草稿、追问答案 | **模型** | 必须视觉区隔并标注(现「Anna 解读」折叠语法沿用);不得与确定性数字混排成同权威级 |
| 巡检 | 确定性(无模型) | ProvenanceLine 写明「由代码汇总,非模型生成」 |
| 空态/降级 | — | 每源独立降级;never 假数字、never 假开关、never 站位区块(P2 功能 P1 不画) |
| 写动作 | 模型起草,**人确认,代码执行与核验** | 审批卡展示权威 payload(哈希锁定),办妥必附读回核验结果 |

---

## §8 分期与后端缺口

### P1 · 本轮重构(前端为主 + 小后端,全部基于现有零件)

| 项 | 零件现状 | 新建量 |
|---|---|---|
| 值守页 + 确定性巡检聚合 | 三个数据源现成 | 新 duty orchestrator + 路由(无模型,镜像 hiker dashboard 模式) |
| Finance/Hiker「需要你」条 | 字段现成(anomalies/aging/reminders) | 前端重排 + hiker snapshot 增透出 reminders rows |
| 派办催收闭环 | 写工具对 + 审批门原语 + ApprovalCard 全现成 | finance capability 接 suspend + 审批路由(镜像报销);**Associate 退役** |
| 客户/合同 360 抽屉 | 两个 MCP 工具现成 | hiker 确定性 profile/chain 端点 + schema 映射 |
| 词表统一 | HomeComposer/LoopCard/ApprovalCard 现成 | 副驾 Composer 替换 + approvalSlot 接线 |
| B0 step 帧 | 路线图已标「建议本轮并入」 | 三个 capability 各补 humanize_step |
| finance/hiker run list 端点 | `list_runs` 方法已有 | 补路由(为值守记录 P2 铺路) |

### P2 · 值守自动化(需后端新能力)

- **调度器**(全仓当前零调度零件,需从零建:进程内定时器即可起步)→ 定时巡检 + 门铃通知(托盘/角标);
- run 落库与 delta(对齐 B3 持久化):值守记录区 + 「变了吗」维度点亮;
- **盯住/哨兵**:卡与追问固化为例行;
- 就地审批(W4 通用化完成态)+ 远程审批全量进值守;
- Memory v1 注入副驾(对齐 PRD R3:finance 问Anna 与报销副驾优先);
- 催款函/续约简报生成(走 Create 管线产物);合同到期雷达(待字段核验)。

### P3 · 纵深(明确依赖,不承诺时间)

- **demo-erp 真记账化**(实现 docs/integration/demo-erp 的 23 表 ERD):发票/费用明细/预算级值守卡 + `erp.finance.query` 变真查询;
- **跨系统联查**:Hiker 客商 ↔ ERP 客户主数据映射(当前两侧客户集不同,需映射表)→ 客户回款健康分(合同额 × 应收 × 逾期,跨源合成);
- Crew 接真引擎(W7)后:值守卡「派成项目」(回款风险 → 催收 SOP 项目);
- L3 下钻通道(B2):值守卡溯源直達真参数/真返回。

---

## §9 拍板清单(开放决策点)

1. **值守页作为 Cowork 默认落点?**(建议:是;保守替代:Finance 为默认、值守作首项)
2. **派办催收闭环进 P1?**(建议:进——旗舰差异化,零件齐全,连带 Associate 干净退役;替代:P2)
3. **客户/合同 360 的形态**:右侧抽屉(建议,与副驾同容器规格)vs 独立页(重,P1 不建议)
4. **报销就地审批放 P2**(P1 值守卡深链报销页)——确认节奏
5. **Cowork 段标签**:「看板」→「值守」(建议)/「业务」/ 不改
6. **值守页要不要自己的副驾?**(建议:P1 不要——值守卡的「追问」路由到对应系统副驾,避免第四个 ReAct 面;P2 视用感再议)

---

## §10 交 Claude Design 的输入要点(brief 时展开)

- **要新设计的屏/件**:① 值守页(含值守卡解剖——本轮最重要的新原语);② Finance/Hiker「需要你」条与动作条;③ 客户/合同 360 抽屉(业务链时间线是新图形语言);④ 副驾内审批卡(窄容器版);⑤ 值守空态三形态。
- **不动的**:两看板五段式快照区、报销页、侧栏两段壳、LoopCard 语法。
- **必须遵守的既有决议**:Iris 视觉语言与 token、玻璃三档(值守卡不用玻璃,抽屉与副驾同档)、点缀纪律(数据密集区零点缀)、ProvenanceLine 语法、诚实三态(offline/error/empty)、三级下钻四护栏、零站位红线。
- **方向题**(给设计发挥):值守卡的 severity 视觉分层;业务链时间线的断链表达;「办妥」在值守语境的礼成形。

---

## §11 验收思路

- **真值核对**:每张值守卡的每个数字可指到 MCP 工具返回字段(抽查对照);
- **诚实性走查**:kill demo-erp / 摘 Hiker token / 清空审批 → 三源独立降级正确、零假数字、零站位;
- **闭环 e2e**:催收派办全链(发起→挂起→确认→写入→读回→办妥带任务号;拒绝→回草稿)入自动化测试(镜像报销链已有测试形态);
- **词表一致性**:副驾 Composer 与 Home 同源组件、LoopCard 当下行点亮(B0)、审批卡同形;
- **演示剧本 v2 对齐**:第 1 幕(财务)与第 5 幕(Hiker)升级为「值守 → 下钻 → 派办」连贯叙事,连排验证。

---

## 附录 A · 可用数据字段速查(规划的真实性边界)

**ERP(demo-erp,localhost:8970,只读 + 催收写对)**
- `erp.finance.get_dashboard_snapshot(period)` → `metrics[6]`{id: revenue/expense/profit/operating_cash_flow/accounts_receivable/accounts_payable, label, value, unit, trend, narrative} + `anomalies[2]`{id, title, severity, explanation} + `suggested_actions[2]`{id, label, target, payload}
- `erp.finance.get_receivables_aging(period, overdue_days)` → rows{customer, customer_id, overdue_amount, aging_days, currency}(现 3 行)
- `erp.finance.query(period, question)` → 演示级问答(P3 才有真查询)
- `erp.collection_task.create_draft(payload)` / `get_status(external_task_id)` → 催收任务写与读回(内存态,重启丢——演示可接受,标注即可)
- ⚠️ 发票/费用明细/预算/科目余额:**连接器不暴露**;23 表 ERD 仅设计文档(docs/integration/demo-erp/01-data-model.md),P3 前不得承诺相关卡片。

**Hiker(远程只读 MCP,11 工具全 L1)**
- `hiker.report.get_dashboard_summary()` → 8 个总量(contract_count/contract_amount/planned_receipt_amount/actual_receipt_amount/receivable_invoice_amount/invoiced_amount/unreceived_amount/uninvoiced_amount;金额为字符串小数)
- `hiker.report.get_collection_summary(filters)` → `reminders.summary`(逾期/今日/即将:count+amount×4 + window_days)+ `reminders.rows`{plan_number, contract_number, customer_name, currency, planned_amount, received_amount, unreceived_amount, planned_date, reminder_type, reminder_label, days_offset} + `aging`(5 桶 summary+rows)+ `risk`(summary+rows 含 invoiced/uninvoiced/risk_status/days_overdue)+ `customers.rows`{customer, customer_name, contract_count, contract_amount, planned_receipt_amount, actual_receipt_amount, unreceived_amount, receivable_invoice_amount, invoiced_amount, uninvoiced_amount}
- `hiker.contract.list_contracts(filters{customer_name,status,contract_number})` / `get_contract_detail(contract_number)` / **`get_business_chain(contract_number)`** → {contract, collection_plans[], receipts[], sales_invoices[], sales_orders[], delivery_orders[], receivables[], reconciliations[]}
- `hiker.report.get_invoice_summary()` / `get_po_receivable_summary()` / `hiker.master_data.search/get_detail` / `hiker.system.*`
- ⚠️ 世界地图/金额趋势/国家 Top5:MCP 无对应数据,维持既有「明确砍掉」决议;合同到期日字段待核验。

**报销(远程 MCP + 本地引擎审批门)**
- 本地:`ApprovalRequest`{id, run_id, action_type, risk_level, status(pending/approved/rejected/expired), payload+hash, draft_snapshot+hash};引擎挂起原语 `CapabilitySuspend(awaiting_approval)`
- 远程审批四件套:`reimbursement.list_approvals / get_approval / approve_intent / reject_intent`

**机制底座**:forge 引擎(chat/finance/hiker/reimbursement 已在引擎;create 单次调用;associate 待退役);model_profiles 按 run 切换;审计事件流;SQLite 落库仅 reimbursement/associate/crew;**调度器:无**;finance/hiker run:内存不落库、list 有方法无路由。
