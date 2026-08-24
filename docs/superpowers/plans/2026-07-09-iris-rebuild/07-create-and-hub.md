# R7 · Create 与产物中心

**目标:** Create 面(hero → workshop → draft 账本)接 `POST/GET /api/create/drafts` + activate 真链路;产物中心以 create drafts 为一等数据源(Chat/Code 来源过滤 = 虚线站位,按设计);「在 Chat 使用/引用到对话」为真导航动作。
**边界:** Create 后端为**同步非流式**(A2 §1.1)——无 LoopCard 直播,等待用加载态,禁假流式;W9 四虚线标签不点亮。

**前置:** R2、R3(+R4 的 ChatPage 供预填)。**读 CLAUDE-CODE-INSTRUCTIONS §9 + ACCEPTANCE §K。**

**Files:**
- Create: `apps/desktop/src/pages/create/CreatePage.tsx`+`.css`、`apps/desktop/src/pages/hub/HubPage.tsx`+`.css`、`draftView.ts`(+`.test.ts`)
- Modify: `apps/desktop/src/components/shell/AnnaShell.tsx`(加 ShellBus)、`pages/chat/ChatPage.tsx`(消费预填)

**Interfaces:**
- Consumes: `createDraft/listDrafts/activateDraft`(create.ts)、SurfaceKit(CreateHero/WorkshopTabs/DraftLedger/SourceFilter/HubGrid/HubCard/PetalDivider)、`AgentComposer/StateNote`
- Produces: **ShellBus**(React context,R3 壳的小扩展):`{ navigate(section: ShellSection, cw?: CoworkItem): void; prefillChat(text: string): void }`;ChatPage 挂载时消费 pending 预填(一次性)。

## Task 1: ShellBus(壳扩展,先行)

- [ ] **Step 1:** AnnaShell 内建 `const ShellBusContext = createContext<ShellBus>`;`prefillChat` 存 `pendingRef` + navigate("chat");ChatPage `useShellBus().consumePrefill()` 取走后置 composer value。
- [ ] **Step 2:** `npx tsc --noEmit`;commit `feat(fe): R7 — ShellBus 跨区导航/预填`

## Task 2: draftView(TDD 纯函数)

- [ ] **Step 1: `draftView.ts`**——CreateRun → 呈现模型(先跑一条真 run 检视字段,以 services/create/app/schemas.py 为准):

```ts
// ledgerLines(run):DraftLedger 行(全真值):
//   `draft <run_id 前 6> · <artifact.title ?? prompt 摘要> · <status>`
//   `kind: <artifact.kind>` / `artifacts <0|1>` / 状态行(draft→「草稿 · 待激活」,activated→「已激活」,failed→error_message 原文)
// hubItems(runs):HubCard[]:name=artifact.title;metaText=`<kind 中文> · <status 中文>`;
//   sourceText=`来源 Create · run <id 前 6>`;无 artifact 的 failed run 不进网格(在 Create 页历史可见)
```

  测试:draft/activated/failed 三形态行;failed 不进 hub;字段缺省不 throw。
- [ ] **Step 2:** 实现 → PASS。

## Task 3: CreatePage

- [ ] **Step 1: hero 态**(空态层级,允许光晕+绽放鸢尾 52,本屏点缀名额在此):CreateHero + AgentComposer(placeholder「描述您要构建的东西…」);提交 → `createDraft(prompt, "skill")`,等待中 composer 禁用 + `StateNote kind="loading" text="正在构建草稿 · 同步生成,请稍候"`(**同步请求的真实等待,非假流式**)。
- [ ] **Step 2: workshop 态**(提交后立即回素面):WorkshopTabs 五标签(draft 真 + files/terminal/diff/preview 四虚线 stub,W9);DraftLedger = `ledgerLines(run)`(全站唯一深色面板);产物内容预览(artifact.content 按 kind 渲染:markdown → react-markdown / 代码 → mono+行号,复用 ArtifactSandbox 的呈现语言但**行内面板**即可);动作行:「激活」filled(→ activateDraft → 状态行变「已激活」+ 礼成落「安」印——该屏唯一点缀,与 hero 光晕不同屏)+ 「再来一稿」tinted(回 hero)。失败 run:StateNote error + error_message 原文。
- [ ] **Step 3: 历史**:listDrafts 倒序纵列(status 点 + title + 时间),点击 → workshop 态回看。空 = `StateNote kind="empty" text="还没有构建记录;从上方描述开始"`。

## Task 4: HubPage

- [ ] **Step 1:** SourceFilter:`all`/`create` 真,`chat`/`code` stub(设计定死;chat 产物中心化待 B3 产物索引);PetalDivider 分组(按状态:已激活 / 草稿;计入点缀名额);HubGrid + HubCard(`hubItems`);`onUseInChat` → `shellBus.prefillChat(\`基于产物《${title}》(run ${id6}):\`)`;`onQuote` → `prefillChat(\`引用《${title}》的内容:\n> …\`)`(引言取 artifact.content 首 200 字,真内容)。
- [ ] **Step 2:** 空态 = `StateNote kind="empty" petal text="产物将在此陈列;先去 Create 构建一件"`(占名额)。加载/错误态齐全。

## Task 5: 验收 + commit

- [ ] 四门全绿。
- [ ] Playwright:①hero → 提交 → 同步等待(loading 态,无假进度)→ workshop:draft 账本深色面板真行、四标签虚线禁用;②激活 → 「安」印礼成;③产物中心:过滤/分组/网格卡齐,「在 Chat 使用」跳 Chat 且 composer 已预填;④全部空态/错误态走查。对照 preview S9/S10。
- [ ] commit ×2:`feat(fe): R7 — Create hero/workshop 真链路` / `feat(fe): R7 — 产物中心 + ShellBus 引用`

## 风险

- **同步 POST 超时**:create 生成可能数十秒,fetch 无超时即可(桌面本机);UI 等待文案如实,禁进度百分比(没有真值)。
- **产物内容体量**:content 直接内嵌 run;网格卡不渲染 content,详情才渲染。
- **激活语义**:activate 仅对 status=draft 合法;按钮按状态禁用,409/400 错误原文展示。
