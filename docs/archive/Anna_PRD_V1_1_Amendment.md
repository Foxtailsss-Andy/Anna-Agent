# Anna PRD v1.1 修订案

> **Date** 2026-07-03 ｜ **Status** 已拍板执行 ｜ **Base** `Anna_PRD_V1_0.md` + `Anna_Product_Planning_MVP_Architecture.md`
> **触发**:2026-07-02/03 全项目成熟度审计(`docs/design/2026-07-02-anna-maturity-and-pipeline-observability.md`)+ 域接线轮(finance+报销 参考对)收官 + 定位拍板。
> 本文只记录**相对 v1.0 的增删改**,未提及条款一律沿用 v1.0 / MVP 架构文档。

---

## 0. 定位重申(不变量,所有修订的前提)

**Anna = 由 forge-harness 构成的 Harness AIOS。**forge-harness 是底座本体而非参考;`services/runtime/app/engine/` 是唯一合法 Agent Loop;旧手写循环判定为错误设计,按域逐个退役(当前 finance+报销已完成)。纪律:**先清晰定位 → harness 稳定性第一 → 产品功能跑通 → 前端与后端持续调优。**

## 1. 修订一:Chat 功能升级定义

**现状问题**:Chat 只有纯文本流式对话,无工具——未达 v1.0 P0 验收「能通过对话查询 ERP 数据」。

**新定义**:Chat = **带工具的通用助手**(仍遵守 §16.1「Chat 不做重」:不做重编排、不做跨域长任务——那是 Cowork/Crew 的事)。
- 接平台引擎(`QueryEngine + ChatCapabilityHandler`),获得 ReAct 工具循环与逐 token 思考流;
- 工具范围 v1:**ERP 只读查询**(复用 finance 工具注册表的只读子集,fail-closed);后续按 Skill 扩展;
- 过程可见:Stage/Step(见修订三)。

**验收(替换原 P0 行)**:在 Chat 中提问业务问题,Anna 调用 ERP MCP 工具作答,过程逐 token 可见、工具调用有卡片、审计完整。

## 2. 修订二:Associate → Crew 改判

- v1.0 P0 中 **Associate(目标拆解/SOP/DAG/Workcell)正式退役出 MVP 范围**(UI 已于 0.2.0 删除;后端保留为素材,前端不复活)。
- 继任者 = **Crew**(人机协同项目编排 OS,独立设计稿待 Andy 评审),定位 **post-MVP**;
- §18.2 验收指标中「Associate 可视化(5-8 Workcell DAG)」**作废**,由 Crew alpha 的验收另行定义;
- §14.5 演示剧本中 Associate 段落删除(见修订六)。

## 3. 修订三:Stage/Step 可观测性 = 一等产品特性

**定义**:每一次 Agent run,用户必须能看到 **准备 →(第 N 轮:思考[逐 token] → 行动[工具/插件] → 观察)→ 终态(完成/耗尽/失败/等待审批)**。

**产品理由**:① 信任——企业用户不接受黑盒 Agent 动业务系统;② 差异化——「看得见 Harness 在想什么、调了什么」是 demo 最强卖点;③ 可调试——用户即验收者。

**技术承接(已就绪,只差前端)**:引擎帧(`text_delta`/`tool_start`/`tool_done`/`awaiting_approval`)+ 审计事件帧已在 finance/报销 SSE 全量产出;`Transition.reason` 即轮次边界。前端统一 `AgentTrace` 组件加 Stage 分组层,五个 surface 复用(方案 = 成熟度报告 §5)。

**验收**:Chat / Cowork(三副驾)/ Create 全部呈现 Stage/Step;任何 surface 不得出现原始事件字符串(今日 Hiker 的 pill 即反例);等待审批以显式状态卡呈现。

## 4. 修订四:Business Memory v1 范围

**范围(三类,对应 v1.0 §6/10.3)**:① 字段口径(指标定义、单位、期间);② 业务规则(阈值、政策要点);③ SOP 片段。
- **载体**:forge 05 分类记忆结构改造(Anna 化:按 workspace 分域、带来源与置信标注);**不做向量 RAG**(维持 defer 裁决,v1 用结构化检索);
- **注入点**:finance 问Anna 与报销副驾优先,Chat 随后;
- **写入**:v1 人工录入 + 运行后建议沉淀;Review Queue 维持 P1;
- **验收**:Agent 回答中引用 memory 条目且可溯源(审计含 memory 命中记录)。

## 5. 修订五:Create 闭环定义

**闭环 = 生成 → 沙箱校验 → fixture 测试 → eval 门(forge 08 对抗自检)→ 注册 → 被实际调用 → 版本留痕。**
- 现状止步于「注册」;新增两环:**eval 门**(生成物过对抗性自检才可注册)与**被调用证明**(注册的 Skill 能在 Chat/Cowork 中真实使用);
- Create 全程 SSE 过程可见(接引擎后免费获得,修订三覆盖);
- **验收(替换原 P0 行)**:≥1 个 Skill 走完全链并在对话中被调用,演示可复现。

## 6. 修订六:演示剧本 v2(替换 v1.0 §14.5)

**主题:差旅报销闭环 + 财务/客户洞察(全部真实数据,零 mock)**
1. 打开 Anna,Cowork 财务看板:真实 ERP(demo-erp:8970)驱动的指标与风险卡;
2. 问Anna(财务):追问某指标 → **逐 token 看到思考、工具卡片逐个亮起、上下文 N% chip**(Stage/Step 观察点 ①);
3. 报销:自然语言提交差旅报销(含附件)→ Anna 校验草稿、创建外部单据 → **触发审批挂起**(`awaiting_approval` 状态卡,Stage/Step 观察点 ②);
4. 用户确认 → 直接提交外部系统 → 回读核验(挂起/恢复闭环);
5. Hiker 看板:全球客户与合同,问Anna·Hiker 跨库查询(观察点 ③);
6. Create:生成一个新 Skill → 沙箱校验 + eval 门 → 注册 → **回到 Chat 用它回答一个问题**(修订五闭环);
7. Admin:本次全部 run 的审计链、模型消耗、Skill 版本。
**达标线**:连续演示 3 次无阻断性失败(v1.0 §18.2 唯一未验证指标,R3 完成)。

## 7. 路线图 R1-R4(已拍板)

| 轮 | 主题 | 内容 | 出口判据 |
|---|---|---|---|
| **R1** ✅ | 统一底座 | hiker → chat(+ERP 只读工具,补修订一)→ create 接引擎;hiker 时骨架抽取(watermark/终态吞集/_sse_frame/共享测试 fake);`stream_model` 重试;temperature/max_tokens(引擎侧)。**Associate descope**(退役+headless,其继任 Crew 后端已用 `call_model`,归零无意义)——associate+crew 保留 `call_model` 待 Crew 轮 | **已达成(2026-07-05,542 passed)**:5 个 LIVE MVP surface 全在引擎上;骨架抽取完;重试+采样参数落地;Chat 查 ERP 达 PRD §1 验收。`call_model` 本轮不 deprecated(associate+crew 合法使用) |
| **R2** | 可观测性 surface 轮 | 统一 AgentTrace + Stage 分组;前端消费 text_delta/tool_*/awaiting_approval;hiker/报销渲染止血;Chat/Create 过程流 | 修订三验收达成 |
| **R3** | 产品功能补全 | Business Memory v1(修订四);Create eval 门+被调用闭环(修订五);演示剧本 v2 连排 3 次 | MVP 闭环 100%;剧本达标 |
| **R4** | 治理与 0.3.0 | forge 06 Hooks(事件模型平台化);HTTPS(Andy);真 Auth(Crew 设计 2 档);打包发布 0.3.0;Crew alpha 排期 | 0.3.0 安装包;Crew kickoff |

**维持 defer(不进 R1-R4)**:声明式 L1 流水线、向量 RAG、经理审批工作流+外部 APM(三处 CI/CD 净新增);多租户商业化等 v1.0 §14.4 不做项不变。

## 8. 验收指标修订(相对 §18.2)

| 指标 | 修订 |
|---|---|
| Associate 可视化 | **作废**(修订二) |
| Chat 查 ERP | **恢复为硬指标**(修订一,R1 出口) |
| Stage/Step 覆盖 | **新增**:三 surface 100% 呈现,零原始事件串(R2 出口) |
| Skill 生成闭环 | **加严**:含 eval 门 + 被调用证明(R3 出口) |
| Memory 引用可溯源 | **新增**(R3 出口) |
| Demo 稳定性 3 连 | 保留,R3 验证 |
| 其余(MCP 成功率/工具留痕/写确认) | 保留,当前已达标 |
