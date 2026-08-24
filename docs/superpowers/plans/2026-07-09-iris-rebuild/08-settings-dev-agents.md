# R8 · 设置(Boss 5 卡 + 开发者接管屏 + 模型档案 + Agent 指令)

**目标:** 设置 Boss 视角**恰 5 卡**(连接/模型档案/记忆站位/外观/关于);「开发者模式」开关后整屏接管运行时面板(内容不删只分层,D4 解法);模型档案增删真链路;Agent 附加指令(五 key)读写;拟人层全局开关;运行时重启入口。
**边界:** 记忆卡 = W6 站位(端点在但 UI 管理下轮);admin 端点鉴权差异见 A1 §2。

**前置:** R2、R3。**读 CLAUDE-CODE-INSTRUCTIONS §9 设置节 + ACCEPTANCE §K 设置行。**

**Files:**
- Create: `apps/desktop/src/pages/settings/SettingsPage.tsx`+`.css`、`DevTakeover.tsx`+`.css`、`ModelProfilesCard.tsx`、`AgentDirectivesPanel.tsx`、`apps/desktop/src/lib/persona.ts`、`apps/desktop/src/lib/api/runtimeControl.ts`
- Modify: `App.tsx`(PersonaContext 供给;settings 区挂真页)

**Interfaces:**
- Consumes: admin.ts 全函数(R2)、SurfaceKit(SettingsCard/Switch/SegmentedControl/DraftLedger)、`applyTheme/loadTheme`(R3)、StateNote
- Produces: `PersonaContext`(`{ persona: boolean; setPersona }`,localStorage `anna.persona`,默认 true;R4/R5/R6 的 LoopCard `persona` prop 改从此处取——R4 先用本地缺省,本切片统一接管)、`restartRuntime()`(runtimeControl.ts:封装 `window.__ANNA_RUNTIME__.restartRuntime`,浏览器 dev 环境不可用时按钮禁用+说明)

## Task 1: Boss 视角 5 卡

- [ ] **Step 1: 数据**:进页拉 `getRuntimeStatus()` + `getRuntimeConfig()`(并行);加载/错误态 StateNote。
- [ ] **Step 2: 恰 5 卡**(`set-grid` 版式对照 preview S11):
  1. **连接**:statusChip 汇总(erp/hiker/reimbursement MCP 三态:已连接=ok / blocked=warn 文案含 error_code 原文);desc 写明「断开后对应看板进入未连接态,不做演示数字」。
  2. **模型档案**:`ModelProfilesCard`——列表(config.values.model_profiles:label/provider/model_name/`api_key_configured` 徽记/default 徽记);「新增档案」表单(id/label/provider/endpoint/model_name/api_key → `addModelProfile`;409/400 错误原文);删除(非 default;`deleteModelProfile`);保存后若响应 `requires_restart_after_save` → 卡内提示 + 「重启运行时」按钮(`restartRuntime()`,Electron 环境真重启)。
  3. **记忆**:W6 站位(statusChip「即将上线」stub 语法),desc 照设计文案。
  4. **外观**:SegmentedControl 浅/深(`applyTheme`,写 `<html data-theme>`)+ **Switch「拟人陪伴层」**(PersonaContext;desc:「关闭后仅保留素颜权威信息,不影响任何真值」)。
  5. **关于**:`Anna · 鸢尾 Iris · 桌面版` + mono 行 `v{package.json version} · tokens v2 · spec V1.0`(版本经 `import.meta.env` 注入或 vite define,取真值)。
- [ ] **Step 3:** PetalDivider(分组名额)+ Switch「开发者模式」(36×20,开=iris 渐变;状态存 localStorage `anna.devmode`)。

## Task 2: DevTakeover(开发者接管屏)

- [ ] **Step 1:** 开关开启 → 整屏替换为开发者面板(Boss 5 卡隐藏,关闭即回);内容 = 旧 RuntimeStatusPage 全部信息**换 Iris 皮**(内容不删只分层):
  - **运行时总览**:getRuntimeStatus → model/三 MCP/skill/tools 分块(DraftLedger 深色 mono 面板呈现原始值,或 ir-table;真值原文)
  - **就绪矩阵**:getDomainReadiness → 每域一行(readiness_status 色点 + blocking_reasons 原文)
  - **校验探针**:「运行校验」filled → validateRuntime;getValidationLedger 台账列表(时间 + 结果)
  - **Skill 注册表**:getSkills(active 徽记)
  - **Agent 台账**:getAgentRunsLedger(域/状态/事件数/时间,ir-table 横向滚动)
  - **治理总览**:getGovernanceStatus(harness 摘要/tool_registries/memory 计数)
  - **Agent 指令**:`AgentDirectivesPanel`——五 key(chat/finance/hiker/reimbursement/create)textarea,载入 config.values.agent_directives,保存 → `putRuntimeConfig({ agent_directives })`;保存成功注明「已注入系统提示,下次 run 生效」。
- [ ] **Step 2:** 各块独立加载/错误态(一块失败不拖垮整屏);无数据 = empty 态。

## Task 3: PersonaContext 统一

- [ ] **Step 1:** `lib/persona.ts` + App 供给;R4 ChatPage / R5 副驾 / R6 报销页的 `persona` prop 改接 context(一处 grep 校验无遗漏:`persona={`)。
- [ ] **Step 2:** vitest:persona.ts 读写往返。

## Task 4: 验收 + commit

- [ ] 四门全绿。
- [ ] Playwright:①Boss 视角**恰好 5 卡**(数一遍);②新增模型档案 → 列表即时出现 + 重启提示;删除即消失;③外观切深色全站生效且持久化(刷新仍深);④拟人层关闭 → Chat 回合拟人标签消失、✓/✕ 素值不变;⑤开发者模式开 → 接管屏全面板真数据;关 → 回 Boss 5 卡;⑥Agent 指令保存后 GET 回读一致。对照 preview S11。
- [ ] commit ×2:`feat(fe): R8 — 设置 Boss 5 卡 + 模型档案/外观/拟人层` / `feat(fe): R8 — 开发者接管屏 + Agent 指令`

## 风险

- **api_key 安全**:新增表单的 api_key 只写不读(后端脱敏契约);列表永远只显 `api_key_configured` 布尔。
- **重启按钮**:浏览器 dev(非 Electron)`__ANNA_RUNTIME__` 不存在 → 按钮禁用 + 「桌面环境可用」说明,禁伪装成功。
- **接管屏信息密度**:数据密集面零点缀零光晕(设计 §J 同理);宽表自身滚动,页面不横滚。
