# R5 · Cowork 看板(财务/Hiker 五段式 + 滑出副驾)

**目标:** finance/hiker 两面看板以 DashboardKit 五段式渲染**真 snapshot**;未连 ERP/Hiker 整面未连接态;「向 Anna 追问」滑出副驾(玻璃容器 B:窄 LoopCard + Composer)接 assistant 流。
**边界:** 报销(R6)独立;看板数据由后端代码计算(BI,非模型),前端零推导零编造。

**前置:** R2、R3、R4(复用 `useRunStream`)。**读 CLAUDE-CODE-INSTRUCTIONS §8 + ACCEPTANCE §J。**

**Files:**
- Create: `apps/desktop/src/pages/cowork/FinancePage.tsx`+`.css`、`HikerPage.tsx`、`SlideOverCopilot.tsx`+`.css`、`snapshotView.ts`(+`.test.ts`)、`cowork.css`(ir-table 等页面级样式)
- Modify: `App.tsx`(cowork 区挂真页)

**Interfaces:**
- Consumes: `createFinanceDashboardRun/streamFinanceAssistant`(finance.ts)、`createHikerDashboardRun/streamHikerAssistant`(hiker.ts)、DashboardKit 全件、`useRunStream`、`StateNote`
- Produces: `<SlideOverCopilot open question target onClose>`(R6 报销页不用;finance/hiker 共用)

## Task 1: snapshot → 五段式映射(TDD 纯函数)

- [ ] **Step 1: `snapshotView.ts`**——真值形态映射,禁编造:

```ts
// Finance(字段出处 A1 §2 Finance 节):
//   anomalies[0](severity 最高优先)→ AlertBand 文案(title + explanation;关键数字保留 mono)
//   metrics → KpiCard 带;hero = metrics[0](后端排序即权威);deltaText = trend 原样,
//     deltaTone:仅当 trend 含 "▲/上升" 且指标属成本类(id 含 expense/cost)→ "warn",
//     含 "▲" 其余 → "ok",含 "▼" → 中性;无 trend → 不显示(不猜)
//   trends → TrendChart series(系列色仅 var(--iris)/var(--gold),第一序列 area:true)
//   receivables_aging → MetricBar 列(ratio = overdue_amount / max(overdue_amount);
//     aging_days ≥ 45 → tone "warn";valueText = "¥N · D 天" mono)
//   suggested_actions → InsightCard 建议(target === "finance_assistant" 的项渲染 AskChip)
//   narrative(metrics[].narrative 聚合)→ ReadingFold 正文
// Hiker:kpis → KpiCard 带(hero = kpis[0]);collection → MetricBar ×3(计划/实收/未收);
//   aging_buckets → MetricBar 列;top_customers → ir-table(mono 数字列);
//   risk_due_soon_count/risk_overdue_count → AlertBand(>0 才出);anomalies → InsightCard
```

  测试:空 anomalies → 无 AlertBand 数据;aging ratio 归一;risk 均 0 → alert null;字段缺省不 throw。
- [ ] **Step 2:** 跑测 FAIL → 实现 → PASS。

## Task 2: FinancePage

- [ ] **Step 1: 数据流**:首次进入自动 `createFinanceDashboardRun(period)`(period 初值 = 当月 `YYYY-MM`,页头期间 chip 可切上月);「刷新」重跑;等待中 `StateNote kind="loading"`(首屏)或保留旧快照 + 页头 mono 「刷新中…」(非首屏)。
- [ ] **Step 2: 状态裁决**(A1 §0 失败契约):`run.status === "failed"` 且 `error_code` 含 `not_connected|not_ready|not_configured`(connector 类)→ **整面** `StateNote kind="offline"`(文案含 error_code 原文,零演示数字);`model_not_configured` 等其余失败 → `StateNote kind="error"`(error_message 原文 mono)。看板是代码计算,模型未配不该失败——若真出现按错误态如实显示。
- [ ] **Step 3: 五段式拼装**(段序不动):页头(mono 眉题 COWORK · 财务经营看板 + 衬线标题 + 期间 chip + **ProvenanceLine**:`数据来源:ERP(只读)· 期间 {period} · 更新于 {HH:mm} · 由代码计算,非模型生成`)→ AlertBand → KPI 带(hero 唯一强调)→ 图表行 → 洞察/建议 → ReadingFold。数据密集区零光晕零点缀(本屏点缀名额 0)。
- [ ] **Step 4: 追问接线**:AlertBand/AskChip/建议动作 onAsk → `<SlideOverCopilot question={拼好的追问文本} target="finance">`。

## Task 3: SlideOverCopilot(容器 B)

- [ ] **Step 1:** 右侧滑出 420px,**全站唯一玻璃**(`backdrop-filter: blur(24px)` 瓷玻,压在被挤压的看板上;深浅两态都要);内部 = AgentSessionHeader(小)+ LoopCard(窄容器 <560 自动降级,container query 生效)+ AgentComposer + 答案正文。
- [ ] **Step 2:** open 时把注入的 question 直接发起 `streamFinanceAssistant(period, question)` / `streamHikerAssistant(question)`(用户免重打;composer 显示该问题为首条);后续追问走 composer。`useRunStream` 独立实例(与看板互不干扰);关闭 = stop + 收起(过程保留,重开可见)。
- [ ] **Step 3:** 副驾内失败/未连接同样帧驱动(assistant 流的 done{run.failed} 已由归一化收敛为 error 帧)。**注意**:finance/hiker 无 step 帧(B0 前),LoopCard 「当下」行会空、回合无 intent——**如实呈现**(工具点+叙述仍真),B0 合入后自动点亮;切片验收按此预期,勿在前端补写 intent。

## Task 4: HikerPage

- [ ] **Step 1:** 同 FinancePage 骨架(无 period;ProvenanceLine 来源写 `Hiker MCP(只读)`);段序:AlertBand(risk 计数)→ KPI 带 → 回款进度/账龄(MetricBar)→ top_customers ir-table(宽表自身横向滚动)→ anomalies 洞察。
- [ ] **Step 2:** 追问 → SlideOverCopilot target="hiker"。

## Task 5: 验收 + commit

- [ ] 四门全绿(snapshotView 测试新增)。
- [ ] Playwright:①ERP/Hiker MCP 未配 → 两面整版 offline 态,零数字;②配好后真快照:hero 唯一描边强调、图表渐变收于透明、ProvenanceLine 在;③点追问 → 副驾滑出、问题自动发出、流式渲染、blur 生效;④窄窗(1100px)副驾与看板挤压共存(侧栏自动收 64)。截图对照 preview S8。
- [ ] commit ×2:`feat(fe): R5 — 财务/Hiker 看板五段式(真快照)` / `feat(fe): R5 — 滑出副驾(容器 B)`

## 风险

- **字段形状偏差**:snapshot schema 以 services/{finance,hiker}/app/schemas.py 现状为准,映射表冲突改 snapshotView 并记录。
- **AlertBand 语义**:无 anomaly 时不渲染警示带(空段不占位),别用空壳撑版式。
- **副驾流与看板刷新并发**:两个独立 run,互不 await;共享 identity 缓存即可。
