# Crew — 人机协同项目编排模块 设计文档

- **状态**:草案 v0.1,待 Roommate 评审
- **日期**:2026-06-21
- **作者**:Anna (with Boss)
- **取代**:现有 `Associate`(应收回款版)的产品定位将被泛化;财务版作为一个 SOP 模板保留
- **一句话**:把 Anna 现有的「目标→DAG→审批→治理」内核,泛化成一个**人和 Agent 同构**的项目协作 OS,对标 Asana 的 Agentic Work Management。

---

## 1. 背景:Anna 现状与差距

### 1.1 今天的 Associate 是什么
- 入口:Cowork 的一个 tab,标题写死「应收回款改善目标」(`AssociateReceivablesPage.tsx`)。
- 流程:Boss 输入 `期间+目标` → 模型加载 Skill、用 MCP 读 ERP 应收账龄 → emit 一个 `goal plan`(goal + summary + DAG nodes)→ 节点带 `write_intent` → 审批 → 写 `erp.collection_task.create_draft` → readback 校验 → completed。
- 后端:`AssociateReceivablesOrchestrator`,同步 ReAct tool-loop(≤5 轮),**治理很硬**:payload hash、node snapshot hash、idempotency key、readback verify、全程 audit。
- 已打通的亮点:Chat 的「转为 Associate 目标」handoff(`onOpenAssociateGoal`)。

### 1.2 与「项目制协作」愿景的差距
现有 Associate ≈「财务目标→DAG→审批→写回 ERP」的治理引擎。`owner` 只是模型填的字符串;**没有人员、技能、IM、协作、可视化**。愿景需要的是一个跨职能项目编排器,现有版本只是它的一个垂直切片。

### 1.3 可直接复用的地基(★)
`BaseOrchestrator` + `harness_runtime` 模型环、`emit_goal_plan`、node 状态机、approval/hash/snapshot/idempotency/readback/audit 整套治理、`SkillLoader`(SOP)、`state_store` 持久化、`workspace_id/actor_user_id` 数据模型、Chat→Associate handoff、MCP gateway。

---

## 2. 愿景与定义

> **Crew = Anna 内置的「人机协同项目编排」模块。** Boss 定目标,Crew 按 SOP 拆解 → 匹配人/Agent → 分发 → 在 Anna 内执行/评审/返工 → 实时可视化,全程统一治理。任一节点的执行者都可以是真人或 Anna Agent。

**对标 Asana「Agentic Work Management」(2026-06 发布,定位 "operating system for human-agent teams"),三点差异化**:
1. **治理native**:Anna 已有 approval/hash/audit,Asana 现在才补。
2. **本地优先 / 自有模型(mimo)**:数据在用户手里。
3. **执行在 Anna 内**:human↔agent 替换从第一天就无缝。

---

## 3. 已锁定的决策(Decision Log)

| # | 决策 | 取舍理由 |
|---|---|---|
| D1 | 模块改名 `Associate` → **`Crew`** | 对齐 Chat/Cowork/Create 的 C 命名;命名"那支人+Agent 混编的队伍" |
| D2 | **升一级 sidebar**,与 Chat/Cowork/Create 平级 | 它是入站主工作区,会长很大,需要自己的二级导航 |
| D3 | **Cowork 保留原名**,定位为 ERP/业务系统中枢(财务 → 供应链/制造…) | 不限于财务;Crew 与之正交,不必改 Cowork |
| D4 | 目标 = **可信 Demo,尽量做全** | 脊柱全真打穿,边缘留接缝 |
| D5 | 通知**先发邮件**(单向门铃),WebSocket 实时留 Tier C | 实时太复杂,邮件薄而可靠 |
| D6 | **协作全程在 Anna 内**(执行+评审+反馈),不接外部 IM(MVP) | human/agent 同构、治理统一、可视化变真;一整个 IM 子系统缩水 |
| D7 | 多用户用**真 Auth + 租户隔离 + Team 模式**(顺带补齐 Anna 平台地基) | 比"假身份切换"更真,且本就是 Anna 早晚要做的基建 |
| D8 | 演进采用 **B:旁开新模块 `services/crew/`**,收割财务版模式,财务 Associate 不动 | 不碰存量、产品边界干净(可独立成产品) |
| D9 | MVP 权限 **两档:Boss / 成员** | 够用、不过度设计 |
| D10 | 小办公室 V1 = **状态驱动像素小人**(参考 Marvis,资源有限下做到最好) | 可视化要真状态驱动,保真度量力而行 |
| D11 | SOP 模板首发 **产品设计 + 营销物料**;前端美观与合理性 = 一等要求 | 双场景撑可信度;demo 颜值重要 |

---

## 4. 分层架构

★ = 可直接复用 Anna 现有地基。

| 层 | 子系统 | 复用 / 新建 |
|---|---|---|
| **L0 地基**(平台级) | F1 Auth & 登录会话 · F2 租户/Workspace + Team + 成员角色 + **数据隔离强制** | 新建;`workspace_id/actor_user_id` 数据模型★已就位 |
| **L1 Crew 核心域** | C1 Project(目标+SOP) · C2 SOP 模板库 · C3 拆解→DAG · C4 任务状态机 | ★复用 `emit_goal_plan`、node 状态机、`SkillLoader`、`state_store` |
| **L2 人 & 分配** | P1 人/Agent registry(角色·技能·状态) · P2 匹配引擎(Agent 提议 → Boss 确认/改派) | 新建;P2 用 `harness_runtime`★ |
| **L3 分发 & 协作** | D1 My Tasks/Inbox · D2 邮件门铃(只出不进) · D3 反馈回路(没空/协调→Boss) | 新建,均薄 |
| **L4 执行 & 治理** | E1 人执行(配合 Chat) · E2 Agent worker 执行 · E3 评审/审批 + audit | ★复用 `BaseOrchestrator`/`harness_runtime` + approval/hash/idempotency/audit |
| **L5 可视化** | V1 Board/Timeline(Asana 取向) · V2 小办公室(Marvis 取向,像素小人,状态驱动) | 新建;V1 先 V2 后 |
| **L6 表面/IA** | S1 Crew 一级 sidebar + 二级导航(Projects / My Tasks / Team / Templates) · S2 Chat→Crew handoff | ★handoff 已通;sidebar 改造 |

---

## 5. 演进策略(选 B)

**B:旁开新模块**。新建 `services/crew/`,把财务版的好模式(治理、状态机、emit)**收割**过来,财务 `Associate` 原封保留。重复的核心(治理)抽到 `services/_shared/governance` 公共层共享,避免双份维护。

- 好处:不碰能跑的财务 demo(零回归风险);产品边界干净,未来可整块拎出去成独立产品。
- 代价:少量初期重复 → 用公共治理层化解。

---

## 6. 数据模型草图(关键实体)

```
Workspace(租户)         { id, name }
Team                    { id, workspace_id, name }
Account/User            { id, workspace_id, email, name, auth, role: boss|member }
Member(资源)            { id, workspace_id, kind: human|agent, user_id?, agent_cfg?,
                          role: PM|前端|后端|UIUE|设计|外包|agent, skills[], status }
AgentWorker(=Member的agent化) { allowed_tools[], model, system_prompt, limits }
SopTemplate             { id, name(产品设计|营销物料), description,
                          task_skeleton[]: { title, role_required, depends_on[],
                                             is_gate, acceptance_criteria } }
Project(原 Run)         { id, workspace_id, owner_user_id, goal_text,
                          sop_template_id, status, created_at }
Task(原 GoalNode)       { id, project_id, title, desc, status, assignee_member_id?,
                          role_required, depends_on[], is_gate, acceptance_criteria,
                          artifact?, blocker?, snapshot_hash }
Assignment              { task_id, member_id, proposed_by(agent), confirmed_by(boss), status }
Artifact                { task_id, type: markdown|file|link, version, content/url }
Approval/Review(★复用)  { task_id, status, comment, payload_hash, audit }
Notification            { to, subject, deep_link, task_id, idempotency_key, sent_at }
Feedback                { task_id, member_id, kind: decline|coordinate, note }
AuditEvent(★复用)       { ... }
```

任务状态机:`todo → assigned → running → submitted → in_review →(approved → done | rejected → rework → running …)`;另有 `blocked`。

---

## 7. 协作模型:「协作在 Anna 内,邮件只是门铃」

- 任务全生命周期活在 Anna;**邮件只在指派/驳回时发**,带深链直接打开对应任务。**不做入站邮件解析**。
- 每人有 **My Tasks/Inbox**(学 Asana):被指派→出卡→接受/去做/提交/评审。
- 反馈进 Anna:assignee 点「没空/需协调」→ Boss 的 Inbox 收到 → 手动改派(MVP)。
- **多用户 = 真登录**:不同账号登录看到各自 My Tasks;数据按 `workspace_id` 隔离。Demo 单机/共享 host,真多机走 ERP demo 那条 localhost→host 老路,留 Tier C。

---

## 8. 建造顺序 + MVP 切片(Tier A 脊柱)

**依赖序(必须遵守)**:`L0 → L1 → L2 → L3 → L4 → L5 → L6`。

**MVP = 能演完整故事的最薄竖切**(剧本:做一个新产品设计):
1. **真登录** 3 账号(Boss / 室友 / 1 个 Agent 身份)+ 1 Team,按 workspace 隔离。
2. **1 SOP 模板「产品设计」** → 拆 5–6 个任务 DAG。
3. **匹配**:Agent 提议人选 → Boss 一键确认。
4. **分发**:邮件门铃 + 各人 My Tasks 出卡。
5. **执行**:【PRD撰写】落 **Agent worker** 真产草稿;人类节点真人在 Anna 内做。
6. **高光闭环**:提交→自动下推【PRD评审】到 Boss→**驳回+批注→返工→再提→通过→下推【UI设计】**。
7. **可视化**:Board + 简版像素小办公室(真状态驱动)。
8. 全程进**统一 audit**。

**第二个 SOP 模板「营销物料」** 用于撑双场景可信度(Tier A 收尾或 Tier B)。

---

## 9. 深度三档

- **🟢 Tier A 全真打穿**:§8 的 1–8 条 + 第二个模板。
- **🟡 Tier B 骨架可信但简化**:容量只做状态不做调度;反向重排=Boss 手动;邮件门铃(真实但薄);小办公室像素小人 V1(状态驱动,轻动效)。
- **🔴 Tier C 占位/不做**:真接 Lark/Telegram、WebSocket 实时在场、排期/容量引擎、真多机部署、入站邮件解析、高级分析。

---

## 10. 盲点清单(评审重点)

部分已在决策中解决,余下需评审/在后续 spec 钉死:

1. **权限模型** → D9 定为 Boss/成员 两档:Boss 拆/派/审/改派;成员 看 My Tasks/接受/拒绝/执行/提交/反馈。
2. **交付物存储**:MVP = markdown 正文 + 链接/上传位,带版本。
3. **评审标准**:SOP 模板每个 gate 携带 `acceptance_criteria`,评审不拍脑袋。
4. **长生命周期 & 提醒**:持久状态(★state_store)+ 到期提醒/催办(MVP 可简单)。
5. **并发与占用**:任务 ownership / 乐观锁防冲突(★复用 snapshot hash)。
6. **Agent worker 护栏**:可用工具白名单、时长/成本上限;产出必须过同一评审门(ADR-002「代码负责管」)。
7. **失败/超时/升级**:不接/跑挂/超期 → 信号浮到 Boss 控制塔;MVP=Boss 手动。
8. **租户隔离强制**:每条查询按 `workspace_id` 过滤,防跨团队泄漏(D7)。
9. **控制塔视图**:Boss 总览"什么卡住/谁迟了/等我审什么"。
10. **模板维护**:MVP=手写预制;未来=AI Studio 式生成器。

---

## 11. 前端 / IA(美观为一等要求)

- **左栏一级**:`Chat / Cowork / Crew / Create`(底部 Admin)。
- **Crew 二级导航**:`Projects(项目)/ My Tasks(我的任务)/ Team(成员)/ Templates(模板)`。
- **核心视图**:
  - **Project Board / Timeline**(Asana 取向,严肃)——任务卡按状态/泳道,实时反映真状态。
  - **My Tasks / Inbox**——每人的待办与待审。
  - **小办公室**(Marvis 取向,像素小人)——叠加视图,按真实 run 状态驱动头像/动作。
- **设计参考**:Claude Desktop(整体气质,见项目既定原则)+ Asana(PM 视图与信息架构)+ Tencent Marvis(办公室游戏化)。
- **硬要求**:布局合理、视觉精致;**禁止"假装繁忙"**——办公室每个动作都对应真实状态。

---

## 12. 非目标(本期不做)

真接 Lark/Telegram;入站邮件/IM 解析;WebSocket 实时在场;排期/容量优化引擎;真多机生产部署;多租户计费;高级分析报表。

---

## 13. 留给 Roommate 的问题

1. §5 演进策略选 B(旁开新模块 + 公共治理层),认可否?有无更省的合并路径?
2. §10 盲点是否还有遗漏(尤其 Agent worker 护栏、租户隔离强制、失败升级)?
3. §8 MVP 边界是否合理——有没有该从 Tier B 提到 A,或从 A 砍到 B 的?
4. 数据模型(§6)是否够支撑后续,有无关键实体缺失?

---

## 14. 下一步(子项目拆分 → 逐个 spec → plan → 实现)

1. **评审本蓝图**(Roommate)。
2. 按序出 spec:
   - **Spec #1 — L0 地基**:Auth + Tenant + Team + 隔离(一切前提)。
   - **Spec #2 — L1 Crew 核心**:Associate→Crew 收割 + SOP 模板 + 拆解 + 状态机。
   - **Spec #3 — L2+L3**:registry + 匹配 + Inbox + 邮件门铃 + 反馈。
   - **Spec #4 — L4 执行&治理**:human + agent worker + 评审 audit。
   - **Spec #5 — L5+L6**:Board + 小办公室 + sidebar/IA。
3. demo 单机/共享 host,真多机留后。
