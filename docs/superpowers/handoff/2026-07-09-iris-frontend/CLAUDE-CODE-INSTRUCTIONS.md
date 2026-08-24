# Claude Code 实现指令 · Anna 前端(鸢尾 Iris · Runtime 三级下钻)

> 本文件是给 AI 编码工具的**结构化实现规格**。目标:把本包源码接入 Anna 工程并扩展后续界面时,
> 逐字遵守下列规格,**不得自行"优化"颜色、间距、时长、文案或状态逻辑**。
> 上一版实现失败的根因是细节在传递中丢失——本文即保真度保险。

## 0. 工程约束

- React 19.2 函数组件 + Hooks;TypeScript 5.9 `strict` + `isolatedModules`;`jsx: react-jsx`;ES2022。
- 样式 = `src/styles/tokens.css` 的 CSS 变量 + 每组件一个 `.css`。**颜色/间距/圆角/阴影一律 `var(--*)`,不写死 hex**。
  若用 Tailwind:v4、关 preflight、色值仍走变量。
- 只跑 Chromium(Electron):可用 container queries、`color-mix`、`:has`、grid-rows 过渡。
- 字体随包(@fontsource),禁 CDN。API base 读 `lib/runtime.ts` 的 `apiBase()`,禁写死 localhost。
- 纯逻辑(`lib/*.ts`)禁 DOM/React 依赖,保持可 vitest 单测。
- 桌面窗口自适应:基准 1440×900,最小可用宽 ~1100px;侧栏 248→64px 可折叠;宽内容自身横向滚动。

## 1. 帧 → UI 映射表(哪个帧点亮哪个像素)

| 帧 | 点亮的 UI(组件 · 位置) |
|---|---|
| `step`(intent) | LoopCard 当下行文字(引擎原文,微光仅 running);`analyze/deliver` 追加 L2 思考步 |
| `thinking`(流式) | 该回合思考步的 L3 原文(有原文才出箭头) |
| `tool_start` | L2 工具步(实心 iris 点 + 转圈 + 「现在」);L1 摘要 toolCount+1 |
| `tool_done.ok` | 该步 ✓(celadon)+ 耗时;`drilldown` → L3(args/result/exit) |
| `tool_done.fail` | 该步 ✕(danger)+ **默认掀到 L3 留证**;所在回合 L1 转 ✕ |
| `event`(审计) | L2 系统步(空心灰点),**无 L3、无箭头** |
| `plan.updated` | LoopCard 计划条 + PlanRail 即时刷新(不占步骤行);无计划 = PlanRail 不渲染 |
| `text_delta` | 回合间叙述(run-narration,权威正文)/ Chat 答案气泡 |
| `awaiting_approval` | 书脊转琥珀、L1 ⏳、「等您示下」步(L3=原始 payload)、ApprovalCard 嵌 approvalSlot(reason+detail 驱动) |
| `done` | 整卡收拢为礼成条(320ms);消耗/时长来自 run.usage(真报才显示);run.artifacts → 产物卡 + 沙箱画布自动展开 |
| `error` | 书脊胭脂、动效全停、error 原文进失败步 L3、失败动作条(↻ 从断点续办 / 查看审计 / 复制错误)+ 已消耗如实展示 |

## 2. 三级下钻硬规则

1. 分组单元 = 回合(index 0 = 「准备」)。L1 折叠行 → L2 步骤列 → L3 素颜凭证。
2. **一个 Step 当且仅当有留存原文(l3 != undefined)才出箭头**;系统步永不可掀。
3. 默认态:done→全部折叠;running→当前回合展开;failed→失败回合展开且失败步掀到 L3;awaiting→审批回合展开。
4. **用户手动掀开/折叠后尊重用户选择**(实现:userOpen ?? autoDefault,已在 LoopCard 内)。
5. L3 三种数据形态:正常预览 / `truncated`(预览 + 「展开更多」+ 加载中,经 onLoadFull 懒加载)/
   `restricted`(🔒 脱敏摘要,完整凭证仅 run owner/开发者)。
6. 嵌套留位:未来 Step 可带 subTree(子运行自己的三级),在 L3 位置递归渲染,不改 L1/L2 结构。

## 3. 拟人层边界(铁律)

- flavor 通道 = `persona` prop(默认开、可整体关);拟人标签用衬线 + 鸢尾色,与权威文字视觉区分。
- **皮不盖真值**:✓/✕/⏳/转圈与耗时永远是素的;失败绝不写「办好啦」。
- **L3 一字不改**:args/stdout/推理原文/error 原文用 mono 原样呈现;脱敏只发生在后端。
- 语体(大小姐):敬称「您」;进行中「正在为您办理」;完成「都办妥了。」「请您过目。」;
  失败先致歉再归因;审批「提交前需要您确认」「等您示下」。禁:波浪号、颜文字、emoji、卖萌语气词。

## 4. 动效规格(时长与曲线,不得改)

| 名 | 规格 | 用途 |
|---|---|---|
| 呼吸 | box-shadow 光环 0→7px 收透明,`2.4s ease-out` 循环 | 当下点/当前步点/PlanRail 进行中(全屏唯一常驻) |
| 微光 | 文字渐变 iris↔lavender,background-position `5s linear` 循环 | 当下行文字(仅 running) |
| 掀开 | `grid-template-rows 0fr→1fr` + opacity,`240ms cubic-bezier(.2,0,0,1)` | L1→L2、L2→L3(禁测高) |
| 落笔 | SVG stroke-dashoffset 描画 `300ms` 一次性 | 礼成 ✓ / 计划项 ✓ |
| 收拢 | 高度过渡 `320ms` 同曲线 | done → 礼成条 |
| 留白 | 同一时刻至多一处在动;done/error 全部静止 | 全局 |
| 降级 | reduced-motion:呼吸→实心点、微光→纯色、掀开保留 | tokens.css 已含 |

## 5. 七态纪律(每个数据面必须全出,不只 happy path)

空 / 加载 / **运行中(流式)** / 完成 / 失败 / 未连接 / 站位。
运行中+完成+失败由 LoopCard 承担;空/加载/错误/未连接/站位用 `StateNote`(禁裸 error_code 横幅)。
站位 = 虚线 + 「即将上线」+ disabled,**绝不假响应**。未连接 = warn-soft + 等真实数据,**绝不演示数字**。

## 6. 组件契约速查

- `LoopCard`:`state / nowIntent / elapsedText / turns / plan / usageText / persona / onLoadFull / ceremony / failure / approvalSlot`。
  窄容器(<560px)自动降级(container query,勿用 JS 测宽)。
- `reduceTurns(frames, toolLabels)` → `RunTree`;`planProgress(items)` → `PlanProgress | null`。
- Composer 槽位固定(左→右):附件(站位)· 调优 · 权限 pill(W4)· CTX 环(W5,>80% 琥珀)· 弹性 ·
  模型档位(W2)· 停止(running)/ 发送(running 时 35% 禁用)。undefined = 站位,实值 = 真控件。
- 点缀:IrisPetal 仅白名单位(品牌行 13 / 空态 26 / 问候页 16),「安」印仅礼成条;每屏 ≤2 处;永不动画。
- `ApprovalCard`:variant confirm(字段网格 auto-fit ≥120px、值 mono、风险 chip 低=青瓷/中=琥珀/高=胭脂、
  ▸ 原始 payload 240ms 掀开)/ supplement(number/date/text 真输入,file=虚线站位);
  动作对 tinted「返回修改」+ filled「确认提交」,右下「运行已暂停,等您示下」;琥珀书脊 3px。

## 7. 沙箱画布 ArtifactSandbox(Coding Agent 手感)

- 触发:点产物卡(ArtifactCard.onOpen)或运行完成 → 宿主置 `open=true`;右侧**挤压式**展开
  (主列被压缩,非遮罩),宽度过渡 `240ms cubic-bezier(.2,0,0,1)`;默认宽 480。
- 头部:「画布」SANDBOX · 文件夹开关(有子路径才显示)· 「存入产物中心」虚线站位 · ✕。
- 产物 tab:胶囊,激活 = iris tinted(#EFEFFA / iris-deep + 1px 内描边);文件夹树 = coding agent 式可折叠目录,
  文件行带 mono 类型角标(html/md/py…)。
- 预览:HTML → `<iframe sandbox="" srcDoc>`(无脚本/无外联,与底注一致);Markdown/Doc → renderMarkdown
  (生产接 react-markdown,包内 MiniMarkdown 兕底);代码 → mono 11.5 + 行号;纯文本 → mono pre-wrap。
- 空态:鸢尾瓣 26px + 「产物将在此呈上」(占点缀名额);底注 mono 10「沙箱预览 · 无脚本 / 无外联」。
- 窄窗口:画布与主列挤压共存,主列 min-width 不足时宿主应收窄侧栏(264/248→64px)再让画布。

## 8. 看板五段式 DashboardKit(P3)

- 段序:AlertBand → KpiCard 带 → ChartCard(TrendChart/MetricBar)→ InsightCard/建议 → ReadingFold;ProvenanceLine 必在。
- Hero KPI 是**全屏唯一**强调卡(鸢尾描边+花晕);其余守瓷白;数据密集页禁光晕禁点缀。
- 「追问/建议动作」点击 → 滑出副驾(容器 B:LoopCard 窄降级 + AgentComposer)并注入问题(target=finance_assistant)。
- 副驾玻璃:blur 24 瓷玻,压在被挤压的看板上(唯一玻璃,透明有来由)。
- 未连 ERP:整面 StateNote offline;绝不渲染演示数字。

## 9. P4 界面(SurfaceKit)

- Create:hero(光晕+绽放鸢尾,仅此层级)→ 提交后立即回素面 workshop;五标签 1 真 4 虚线(W9 逐个点亮);
  draft 账本 = 全站唯一深色面板。礼成条在 Create 屏落「安」印(该屏唯一点缀)。
- 产物中心:来源过滤(Create 真 / Chat·Code 虚线);HubCard 动作「在 Chat 使用 / 引用到对话」;
  分组用 PetalDivider(计入点缀名额);数据源 run.artifacts,产物是一等公民。
- 设置:Boss 视角恰 5 卡;「开发者模式」开关后整屏接管现 RuntimeStatusPage 全部面板(不删内容,只分层);
  外观分段控件写 `<html data-theme>`;记忆卡 = W6 站位。

## 10. W2-W9 预留位(实现时留槽,勿画蛇添足)

W2 模型档位(Composer 已留)· W3 多轮 thread(礼成条即 turn 分隔)· W4 权限 pill/审批卡通用化 ·
W5 CTX 环 + 「压缩」系统步 · W6 「记忆」系统步 · W7 sub_run 嵌套(§2.6 留位)· W8 / 命令浮层 + @ 引用 · W9 Create 标签点亮。
