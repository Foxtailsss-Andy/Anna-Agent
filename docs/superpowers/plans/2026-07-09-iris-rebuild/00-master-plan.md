# 鸢尾 Iris 前端重建轮(FE Rebuild)实施总纲

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆掉现有渲染器(`apps/desktop/src` 全部 100 文件),以 2026-07-09《Iris 前端交付包》的生产级源码为地基**从零重建前端**,做到代码级+视觉级复刻;全部界面接真后端真数据(归一化层桥接现行帧契约),零套壳、零假数据;Electron 壳与后端本轮不动(B0 例外)。

**Architecture:** 交接包 `src/`(tokens + lib 纯函数 + 四组组件族)verbatim copy-in 为地基;新增三层:①`lib/api/`(SSE 读取器 + v1→v2 帧归一化 + 按域类型化客户端),②壳层(侧栏/主题/会话身份),③页面层(Chat/Cowork/Create/产物中心/设置 五面拼装)。帧契约以 `lib/frames.ts` 为唯一目标(v2);后端现行帧(v1)经归一化层做**真数据形态映射**,B 系列(下轮后端梳理)原生化 v2 后归一化层收缩删除。

**Tech Stack:** React 19.2 + TS 5.9 strict + Vite 7 + Electron 39;**零第三方样式依赖**(tokens.css CSS 变量 + 组件级 CSS;Tailwind/shadcn/radix/lucide 全部退役);@fontsource 随包字体(禁 CDN);react-markdown(沙箱 Markdown);vitest(node env 纯逻辑)+ pytest(后端不回归即可)+ Playwright 走查。

---

## 0. 文档树与使用方式

```
docs/superpowers/handoff/2026-07-09-iris-frontend/   ← 交接包 vendor 副本(唯一设计依据+验收基准)
  README.md / CLAUDE-CODE-INSTRUCTIONS.md / ACCEPTANCE-CHECKLIST.md
  src/**(生产源码,R1 copy-in 的来源)  preview/**(逐像素对照预览,免构建)
docs/superpowers/plans/2026-07-09-iris-rebuild/
  00-master-plan.md            ← 本文件:切片地图/执行协议/全局验收
  01-teardown-and-foundation.md ← R1 拆旧 + copy-in + 依赖瘦身 + 纯逻辑测试
  02-stream-normalizer.md      ← R2 SSE 读取器 + v1→v2 归一化 + 会话身份/API 底座
  03-shell-login-nav.md        ← R3 外壳:侧栏/导航/主题/问候起始页/登录
  04-chat-soul.md              ← R4 Chat 灵魂一屏(LoopCard×四态+PlanRail+沙箱画布+历史)
  05-cowork-dashboards.md      ← R5 财务/Hiker 看板五段式 + 滑出副驾
  06-reimbursement-approval.md ← R6 报销:审批卡 confirm/supplement + 附件 + 审计
  07-create-and-hub.md         ← R7 Create hero/workshop + 产物中心
  08-settings-dev-agents.md    ← R8 设置 Boss 5卡 + 开发者接管屏 + 模型档案 + Agent 指令
  09-acceptance.md             ← R9 七态审计/深色/动效降级/验收清单走查/四门
  10-backend-roadmap.md        ← B 系列:B0(可并本轮)+ B1/B2/B3(后端梳理轮执行)
  A1-backend-api-map.md        ← 附录:REST 接线地图(端点/鉴权/失败契约)
  A2-frame-contract.md         ← 附录:帧契约 v1→v2 映射(归一化层规格)
```

- 每个切片文档自包含:目标/边界、文件清单、Interfaces、带 checkbox 的 bite-sized 任务、验收命令与预期、风险。实施者只需读:交接包三文档 + 本文件 + 对应切片文档(+ 涉及接线时 A1/A2)。
- **冲突裁决顺序**:交接包源码/ACCEPTANCE-CHECKLIST(视觉与组件行为)> CLAUDE-CODE-INSTRUCTIONS(规格)> 本计划(拼装与接线)> 旧前端(仅作接线参考,git 历史可查,一律不复用其代码)。切片文档与代码现状冲突时以代码现状为准并在 commit message 记录偏差。
- 交接包原件:`<design-handoff-archive>`;R1 起以 repo vendor 副本为准。

## 1. 不可妥协红线(实现全程有效)

1. **真实开发**:全部界面接真端点真数据;禁 mock、禁演示数字、禁假 loading。站位 = 虚线 + 「即将上线」+ disabled(StateNote/stub 语法)。
2. **七态纪律**:每个数据面必须做全 空/加载/运行中(流式)/完成/失败/未连接/站位;失败读 `run.status/error_code/error_message`(HTTP 200 也可能是失败,A1 §0)。
3. **保真度**:颜色/间距/时长/文案逐字遵守交接包,**不得自行"优化"**;一律 `var(--*)`,不写死 hex;动效时长曲线照 CLAUDE-CODE-INSTRUCTIONS §4。
4. **诚实归一化**:归一化层只做真数据形态映射与解包(A2 §4);无 L3 就不出箭头,无 usage 就不显示,皮不盖真值。
5. **W2-W9 预留位**:留槽勿实现(CLAUDE-CODE-INSTRUCTIONS §10);`undefined` = 站位,实值 = 真控件。
6. **点缀纪律**:鸢尾瓣/「安」印每屏 ≤2 处、白名单位、永不动画;同一时刻至多一处在动;done/error 零动画。

## 2. 拆除与保留边界(R1 执行,此处为裁决表)

| 对象 | 处置 |
|---|---|
| `apps/desktop/src/**`(100 文件) | **全删**(git 历史留档;`*Api.ts`/`*Trace.ts` 的接线知识已固化进 A1/A2) |
| `index.html` | 重写(标题 Anna,入口不变 `/apps/desktop/src/main.tsx`) |
| `components.json`(shadcn) | 删 |
| package.json 依赖:tailwindcss、@tailwindcss/vite、tw-animate-css、class-variance-authority、clsx、tailwind-merge、radix-ui、lucide-react | **全部退役卸载**;vite.config.ts 去 tailwindcss 插件 |
| 保留依赖 | react、react-dom、react-markdown、@fontsource/*(三字体)、typescript、vite、@vitejs/plugin-react、electron*、vitest、playwright、png-to-ico |
| `apps/desktop/electron/**` | **不动**(`__ANNA_RUNTIME__.apiBase` 注入与交接包 `lib/runtime.ts` 完全兼容,已验证) |
| `services/**`、`tests/**`(pytest)、`skills/**`、`scripts/live-*.mjs` | **不动**(B0 例外,见 10 号文档) |
| vite.config.ts / tsconfig.json / vitest.config.ts | 微调(去插件;别名 `@` 保留;vitest include 不变) |
| 旧计划/进度文档 | 不动(历史);本轮新档一律进 2026-07-09-iris-rebuild/ |

## 3. 新前端目标结构

```
apps/desktop/src/
  main.tsx                      入口:字体 import + tokens.css + <App/>
  App.tsx                       壳组装:会话引导 → AnnaShell
  styles/tokens.css             (交接包 verbatim)
  lib/
    frames.ts turns.ts plan.ts runtime.ts   (交接包 verbatim;唯一契约)
    api/
      identity.ts               会话身份(session/current + X-Anna-* 头 + token)
      sse.ts                    SSE 读取器(getReader/decode/split "\n\n"/data:)
      normalize.ts              v1→v2 帧归一化(A2 §4 规格;纯函数族,vitest)
      client.ts                 fetch 封装(apiUrl + 头 + 错误规范化)
      chat.ts finance.ts hiker.ts reimbursement.ts create.ts admin.ts   按域类型化客户端
  components/
    agent/** anna/** cowork/** surfaces/**   (交接包 verbatim,不改内部)
    shell/                      新增:Sidebar.tsx SidebarItem.tsx UserChip.tsx(+ .css)
  pages/
    chat/ChatPage.tsx           + useRunStream.ts(帧数组 + reduceTurns 驱动)
    cowork/FinancePage.tsx HikerPage.tsx ReimbursementPage.tsx + copilot/SlideOverCopilot.tsx
    create/CreatePage.tsx
    hub/HubPage.tsx
    settings/SettingsPage.tsx DevTakeover.tsx
    auth/LoginPage.tsx
  fixtures/demo-run.ts          (交接包 verbatim;仅预览/单测用,禁止进生产路径)
```

规则:交接包文件 **verbatim copy-in 后不改内部**(发现必须改 = 先在切片文档记录偏差);新增代码全部走 tokens 变量 + 组件级 CSS,复用交接包组件优先于新写。

## 4. 切片地图与依赖

| 切片 | 内容 | 依赖 | 规模 | 后端净新增 |
|------|------|------|------|-----------|
| R1 | 拆旧清零 + vendor 交接包 + copy-in + 依赖瘦身 + tokens/字体 + turns/plan 纯逻辑 vitest + 四门恢复绿 | — | 大 | 无 |
| R2 | `lib/api/` 底座:identity/sse/normalize/client + 真流 fixture 采集 + vitest | R1 | 中 | 无 |
| R3 | 外壳:Sidebar(248→64 折叠)+ 五区导航 + Crew 站位 + data-theme + 问候起始页壳 + 登录页 | R1 | 中 | 无 |
| R4 | Chat 灵魂一屏:runs/stream 接线 → LoopCard 四态 + PlanRail + 叙述/答案 + 礼成 + 产物卡→沙箱画布 + 历史回看 + save | R2,R3 | 大 | 无 |
| R5 | Cowork 看板:finance/hiker 五段式(真 snapshot 映射)+ 未连接态 + 滑出副驾(assistant stream) | R2,R3(R4 的 useRunStream 复用) | 大 | 无 |
| R6 | 报销:runs/stream + awaiting_approval → ApprovalCard(confirm)+ missing_fields → supplement + 附件上传 + 审计链接 | R4(LoopCard 接线模式) | 中 | 无 |
| R7 | Create(hero/workshop/draft 账本接 create drafts)+ 产物中心(chat runs artifacts + create drafts 聚合) | R2,R3 | 中 | 无 |
| R8 | 设置 Boss 5 卡 + 开发者模式接管屏(runtime status/config/skills/探针/就绪矩阵/台账)+ 模型档案增删 + Agent 指令 | R2,R3 | 中 | 无 |
| R9 | 收官:七态逐面审计 + 深色走查 + reduced-motion + ACCEPTANCE-CHECKLIST 逐项打勾 + Playwright 截图 + 四门 | R1-R8 | 中 | 无 |
| B0 | (可选并本轮)finance/hiker/reimbursement handler 补 `humanize_step` → step 帧全覆盖 | 独立 | 小 | 3 handler + pytest |

推荐顺序:R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9;B0 可在 R4 后任意时点插入(做完 R5/R6 的「当下行」才有真 intent 可显,**强烈建议做**)。R5/R7/R8 之间无依赖可并行,但同一时刻只允许一个切片新增全局 CSS 文件。

## 5. 分支与提交约定

- [ ] T0:规划轮文档(本目录 + vendor 交接包 + 设计 brief)提交在 `feat/fe-iris-redesign`;执行时切 `git checkout -b feat/fe-iris-rebuild`。
- 每切片 1-3 个 commit,格式 `feat(fe): R<n> — <切片名>`(B0 用 `feat(runtime)`),review 修正 amend(amend 前确认 HEAD 是本切片 commit)。
- 不并 main;整轮完成后交 Andy + 用户评审(依惯例)。

## 6. 执行协议(Opus 4.8 subagent-driven)

每个切片按 superpowers:subagent-driven-development 执行;**implementer 一律用 Opus 4.8 subagent**(用户指定),规划/复审裁决由主会话(Fable 5)把关:

1. **fresh implementer subagent(Opus 4.8)** 按切片文档逐 checkbox 实施,TDD 步不许跳;实施前先复核代码现状。
2. **两级复审**:①保真度审(对照 ACCEPTANCE-CHECKLIST 对应节 + 切片「验收」节;像素值/时长/文案逐项)→ ②代码质量审(TS strict、effect/listener 泄漏、假数据混入、tokens 变量纪律、七态完整性)。
3. 复审问题回给原 implementer 修复并 amend。
4. 切片完成门(全过才进下一片):

```bash
npx tsc --noEmit                          # 0 error
npx vitest run                            # 全绿(新增纯逻辑测试)
npm run build                             # 成功
python -m pytest services/ tests/ -q      # 全绿(前端轮不减绿;B0 加新测)
```

5. **Playwright 实跑门**:`npx vite`(:5173)+ 后端 `python -m services.api.app.main`(:8000)起后,跑切片文档走查段,截图与交接包 `preview/index.html` 对应 Section 并排比对。

## 7. 全局验收(R9 详述,此处为总标准)

1. **逐像素**:ACCEPTANCE-CHECKLIST.md A-K 全清单逐项打勾(浅/深双主题),不符即打回。
2. **功能真跑**:Chat 问答全程(运行中→礼成→产物→沙箱)/看板+追问副驾/报销全审批链(含补录)/Create 生成→激活→产物中心/设置读写(档位增删+外观+开发者接管)。
3. **诚实性**:零死按钮、零假数据、零裸 error_code 横幅;断开后端/未连 ERP 走查未连接态。
4. **测试门**:§6.4 四命令全绿 + 无 console error。

## 8. 环境备忘(实施者需知)

- Windows 11 + Git Bash;dev 前端 `npx vite`(:5173,`/api` 代理到 :8000);后端使用本地 `.anna/runtime.json`（未提交）配置 `ANNA_RUNTIME_CONFIG_PATH`，并以 `.venv/Scripts/python.exe -m uvicorn services.api.app.main:app --port 8000` 启动。无运行时配置时模型/MCP 全部 unconfigured。桌面 runtime 随机端口经 `__ANNA_RUNTIME__.apiBase` 注入,**请求一律走 `lib/runtime.ts` 的 `apiUrl()`,禁写死 localhost**。
- Playwright 在 ESM 下通过当前 checkout 的 `package.json` 加载。
- 失败契约:业务失败 = HTTP 200 + `run.status:"failed"`(A1 §0);SSE 终止帧形态见 A2 §2。
- 身份:桌面免登录(session/current 本地回落);X-Anna-* 头与请求体 workspace_id/actor_user_id 必须一致否则 403。
- 只跑 Chromium(Electron):container queries/`color-mix`/`:has`/grid-rows 过渡放心用。

## 9. 全局不做清单(实施中不许"顺手"加)

- W2-W9 预留位的实现(只留槽):模型档位三档语义、多轮 thread、CTX 环之外的压缩动作、记忆管理、sub_run 嵌套渲染、/ 命令浮层、@ 引用、Create 四虚线标签点亮。
- Crew 页面重建(IA 中为站位;端点保留)。Associate 界面(后端能力保留)。
- L3 下钻的后端通道(B2)、thinking 帧(B1)、SSE resume(B3)——前端按「无则优雅降级」实现,槽位已留(`onLoadFull` prop、thinking 步无原文不出箭头)。
- 深色主题之外的第三主题;移动端适配(桌面 1440×900 基准,最小 ~1100px)。

## 10. 型别与命名总约定(跨切片一致性)

- 壳模式:`type ShellSection = "chat" | "cowork" | "create" | "hub" | "settings"`;Cowork 子项 `type CoworkItem = "finance" | "hiker" | "reimbursement"`;Crew 在侧栏渲染为 stub 项(非 ShellSection 成员)。
- 流 hook:`useRunStream(toolLabels?: ToolLabels): RunStream`;`RunStream.start(open: () => Promise<Response>, opts?: { append?: boolean })`、`stop()`、`tree: RunTree`、`elapsedText/ctxPercent/usageText`(R4 定义,R6 加 append,R5/R6 复用)。
- 归一化:`createNormalizer(): (raw: Record<string, unknown>) => Frame[]`(A2 §4;有状态闭包,每 run 新建)。
- 身份:`getIdentity(): Promise<AnnaIdentity>`;`AnnaIdentity = { workspaceId: string; userId: string; role: string; displayName: string; source: "token" | "local-runtime" }`;`identityHeaders(id)` 产 X-Anna-* 头。
- CSS:新增文件一律组件同名 `.css` + `ir-` 前缀类(Iris 层);交接包自带类名不改。
- 工具中文名表:`DEFAULT_TOOL_LABELS`(lib/turns.ts)为基表,各域扩展经 `toolLabels` prop 传入,禁止改基表语义。
