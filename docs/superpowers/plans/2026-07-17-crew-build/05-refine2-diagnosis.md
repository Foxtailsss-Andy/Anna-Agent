# Crew 精修二轮 · 六点诊断(2026-07-21)

> 用户完整体验精修一轮成果后提出 6 个优化点。本文 = 代码级根因诊断(两个 Explore 并行下钻 FE/BE,Fable 交叉核对),**只诊断不修**;修复分两路:纯工程项见 §3 DEV 清单(下轮实施),涉及视觉/交互的进 `DESIGN-BRIEF-2026-07-21-anna-crew-v2.md`(R1-R6,交 Claude Design)。
> 基线:feat/crew-build @ 74abc1d(41 commit,四门 801/349/0/build✓)。

## 1. 总表

| # | 用户症状 | 根因(一句话) | 归属 |
|---|---|---|---|
| 1 | 产物(PRD)在对话框里太小 | 频道栏定宽 328px;产物消息卡**根本不内嵌正文**(只有标题+摘要行);唯一可读处=评审卡 ~300×320px 滚动盒;抽屉产物盒也仅 260px 高 | 设计 R1 + DEV-6 |
| 2a | 点「执行」报 `Cannot start task…expected 'assigned'` | 报错实为 **POST /start(「开始」钮)**;抽屉/轻检视对 agent 任务「执行+开始」双按钮并存,3s 轮询陈旧窗口内 auto-pilot 早已把任务跑到 submitted | DEV-1/2/3 |
| 2b | 报错是裸 JSON | `ApiError.body`(原始响应文本)被**逐字**塞进内联红字 `.ir-insp-err`;图上节点按钮路径更糟——**无 catch,静默吞掉** | DEV-2 |
| 2c | 点完连线消失 | 非持久丢边(结构上不可能空边不空点)——是**重排瞬态**:节点带 240ms transform 滑移、边被即时钉到终点坐标 + 新边有 240ms 隐形期再 300ms 描画;auto-pilot 连环转移期间瞬态反复出现 | DEV-4 |
| 3a | Agent 执行没有动效圈 | 执行动效**其实存在**(running 节点底部扫描条 2.2s + iris 描边;焦点另有呼吸)——但短跑任务在两次 3s 轮询**之间**就 assigned→submitted,前端从未观察到 running;快照又无任何在飞字段可兜底 | DEV-5 + 设计 R2 |
| 3b | 思考 Runtime 全是 markdown 源码、读不动 | Trace=LoopCard 平铺工具帧**原文**(thinking/text/args/result 全裸文本),非渲染 markdown | 设计 R3 |
| 3c | 打开后没法点「瞬间」关闭 | 「过程 N 个瞬间」是 LoopCard 内层折叠;trace 区本身**无折叠控件**且 `flex:1` 贪占抽屉滚动区,关闭只能整个抽屉 ✕/Esc(Esc 还在改派/提交态被抑制) | DEV-7 + 设计 R3 |
| 3d | 看不到产物具体是什么 | 产物其实在抽屉上方 260px 小盒里(markdown 已渲染),被 trace 挤到视野外——信息序反了 | 设计 R3 |
| 4a | 输 @ 没拉起成员 | mention 只有「@ 成员」按钮选择器;`onChange` 纯 `setText`,**键入 @ 零监听**;手打 `@Andy` 不产生 mention id → 不通知、不重跑,纯死文本 | 设计 R4a + DEV-8 |
| 4b | 频道派任务图上没反应、Anna 没监察 | 服务端 `say()` 零意图检测、零建任务(建任务仅三处:模板实例化/+任务 confirm/AI 分解);「+任务」起草服务(CommandDraftingService)存在但只挂在显式按钮上 | 设计 R4b + DEV-8 |
| 5 | 画布平淡不突出 | 节点=白卡+细边+4px 职能点+状态小字;状态靠读字不靠形色(工程无 bug,纯设计命题) | 设计 R5 |
| 6 | Enter 应发送 | 三处发送 composer(HomeComposer/AgentComposer/Crew Composer)全为 Ctrl+Enter;**全库零 `isComposing` 守卫**——直接改 Enter 发送会让中文输入法确认字词即误发 | DEV-9 + 设计 R6 |

## 2. 逐点证据(file:line)

### 2a/2b 「Cannot start」400 与裸 JSON

- 错误串源:`services/crew/app/lifecycle.py:134-137`(`start_task` 状态守卫);`CrewLifecycleError → HTTP 400`:`services/api/app/routes/crew.py:456-457`。**同步打到它的唯一 HTTP 路径 = POST /tasks/{id}/start**(crew.py:524-530)。
- 「执行」走的是 run-agent(节点钮 `TaskNode.tsx:202-216` → `CrewProjectDetailPage.tsx:203-204` → `crew.ts:296-304`),**立即返 200**、不校验状态(crew.py:552-572);状态转移在后台 worker(`agent_worker.py:223-230`)。对 submitted 任务点执行 → 后台抛 `CrewAgentError` → 频道吐**误导性「执行受阻」事件 + blocked 通知**,而任务其实原地待审(`service.py:328-350`;状态不变)。
- 双按钮并存:`inspectModel.ts:118-122`(`withAgentRun` 保留次级「开始」)+ `drawerOps("ready")` 含 start(`:57-63`)——用户在抽屉/轻检视里点了陈旧的「开始」。
- 陈旧窗口:`POLL_MS = 3000`(`CrewGraphCanvas.tsx:59`),首拍 3s 后才来;auto-pilot 在 approve 响应后毫秒级 assigned→running、数秒后 →submitted(`service.py:240-303,816-861` + `crew.py:127-136` 时序)。
- 裸 JSON 渲染点:`useTaskOps.ts:45-57`(`setError(e.body)`)→ `NodeInspectPopover.tsx:188` / `TaskDrawer.tsx:231`(`.ir-insp-err`,inspect.css:306);**图上节点按钮路径无 catch**(`CrewProjectDetailPage.tsx:168,204` `void …runAgent` 无 `.catch`)= 未处理 rejection,界面无反馈。

### 2c 连线消失(重排瞬态,非持久丢边)

- 结构排除:节点与边同门在 `layout` 真值上(`CrewGraphCanvas.tsx:263-265, 331-350`);`useElkLayout` 的 result **永不回 null**(初始 null → 空图给空 map → elk 失败给 fallbackPositions → 陈旧代际只跳过被取代者,`useElkLayout.ts:154-192`)——所以「只丢边不丢点」的持久态在代码上不存在。
- 真机制:重排时节点按 `transition: transform 240ms` 滑移(`ChartingTable.css:208-210`),React Flow 把边端点**即时**钉到最终坐标 → 滑移期间边与节点视觉脱开;新边另有 born 动画:240ms 全隐(dashoffset:100)+ 300ms 描画(`graphMotion.ts:110-112`、`ChartingTable.css:688-697`、`edges.tsx:68-77`)。auto-pilot 连环状态转移(过门→解锁→自动派→自动跑)让 3s 一拍的快照连续触发重排,瞬态反复出现 = 用户看到「线没了」。

### 3a 执行动效(存在但看不见)

- 已有:running 节点底部扫描条(`TaskNode.tsx:200`,`crewg-bar-sweep 2.2s` @ ChartingTable.css:421-432)+ iris 描边(`:302-306`);呼吸只属焦点(`TaskNode.tsx:154`,`deriveFocus` 唯一,graphMapping.ts:183-201)。
- 看不见的根因:前端只能靠轮询**恰好命中** `status==="running"`;短跑(比如 ~10s 内)在两拍之间完成 → 全程只见 assigned→submitted。快照无在飞信号:`CrewTask` 无 run 状态布尔、无 `started_at`;`run_ref` 跑完**不清除**,不能当在飞旗(`schemas.py:26-53`、`crewModel.ts:13-35`);run 行的 `created_at/updated_at` 在 SQLite 里有但**任何 crew 端点都不吐**(`run_store.py:178-184` 只回 payload)。elapsed 目前只能靠 frames 首帧时间戳客户端算(`crewTrace.ts:33-35`、`TaskDrawer.tsx:288-289`)。

### 3b/3c/3d Trace 与产物

- Trace 数据:`GET /api/crew/runs/{run_ref}/frames`(crew.py:574-588),帧=chat 同族(text_delta/tool_start/tool_done/step/thinking/event)+ 首尾 scaffold;`framesToTrace → LoopCard`(`crewTrace.ts:62-92`),L3 面板全**裸文本**(`LoopCard.tsx:94-158`)。
- 「瞬间」= LoopCard 的「过程 N 个瞬间」折叠(`LoopCard.tsx:296-298`);trace 区无自身折叠、`flex:1` 贪高(`inspect.css:363,385`);抽屉关闭=✕/scrim/Esc(`TaskDrawer.tsx:80-86,108,120-122`),Esc 在改派/提交态被抑制(`:82`)。
- 产物在抽屉「产物」节,markdown 已渲染、最新版默认展开,但盒高仅 260px(`inspect.css:382`)且位于 trace 之上——用户滚进 trace 后自然「看不到产物」。

### 4 @ 与监察

- Composer:`@ 成员` pill 开列表 → `insertMention` 文本追加 `@名` 并记 `{id,name}`(`Composer.tsx:49-54,120-160`);`buildSayPayload` 只发「选择器插入且文本仍含 @名」的 id(`channelModel.ts:113-124`);渲染端明示「不做自由文本解析」(`:42-44`)。
- 服务端:`say()` 只做通知(mention → 收件箱@我)+ agent 被 @ 且持 assigned/rework 任务时重跑(`service.py:381-411,863-883`);**不建任务**。建任务仅三处:`lifecycle.py:44` / `service.py:527`(confirm)/ `decomposition.py:103`。起草服务 `CommandDraftingService` 已存在(`command_drafting.py`),只被显式 `POST …/channel/command` 调用——R4b 可复用它做意图起草。
- 附注:API 层对 mentions 里的**非成员 id 不校验**,会写下无人认领的通知行(小卫生项,DEV-8 顺手修)。

### 6 Enter 盘点

- 三处发送 composer 全 Ctrl/⌘+Enter:`HomeComposer.tsx:283-286`(Chat+Create 同件)/ `AgentComposer.tsx:81-89`(Cowork 问 Anna)/ Crew `Composer.tsx:89-94`。
- **全库 grep `isComposing|compositionstart|keyCode` 零命中**——现在无害(发送要修饰键),改 Enter 发送必须三处同步补 `e.nativeEvent.isComposing` 守卫。
- 表单类多行框(任务提交说明/共识编辑/驳回批注/Agent 附加指令)均无 Enter 处理,按钮提交——**不改**(它们是表单不是对话)。

## 3. 开发修复清单(DEV,下轮实施;均不依赖设计返稿,可先行)

| # | 修复 | 要点 |
|---|---|---|
| DEV-1 | 动作前置校验 + 立即 refetch | 任何任务动作先拉最新快照再判可用;动作成功/失败后都立即 refetch(不等 3s);按钮点击即置 pending 态 |
| DEV-2 | 错误友好化 | `ApiError.body` 解析出 `detail` 人话化(状态冲突 → 「该任务已由 Anna 自动推进到待审」类文案);图上节点路径补 catch;引入全局轻提示(toast)通道 |
| DEV-3 | 后端守卫友好化 | `/start`/`run-agent` 对已推进任务返回**幂等友好体**(409 + 机器可读 code + 当前状态),不再裸 400 文本;对 submitted 任务的 run-agent 不再吐「执行受阻」误导事件 |
| DEV-4 | 连线瞬态修复 | 重排时边随节点同步过渡(边 path 参与 240ms 过渡或重排期间冻结边端点跟随);born 动画只给真正新生边,快照刷新不复用 born;auto-pilot 连环转移合并为一次重排 |
| DEV-5 | 在飞信号上桥 | 快照任务序列化增 `run_state`(queued/running/none)+ `run_started_at`(跑完清除或另字段);健康条/节点动效/频道活动行三处同源消费;elapsed 服务端时刻起算 |
| DEV-6 | 产物下载 | 产物「下载」端点或客户端另存(.md);R1 阅读器的工程半 |
| DEV-7 | 「瞬间」折叠可靠化 | trace 区自身可折叠(默认折叠,产物先行);「过程 N 个瞬间」开关任何滚动深度可达、点击即收 |
| DEV-8 | mention/监察工程半 | @ 键入触发拾取器(前端);`say` mentions 服务端校验成员;R4b 意图起草端点(复用 CommandDraftingService,草稿态零捏造) |
| DEV-9 | Enter=发送 | 三处 composer:Enter 发送 / Shift+Enter 换行 / `isComposing` 守卫;微提示文案换「Enter 发送」;表单多行框不动 |

## 4. 与设计的接口

R1-R6 详见 `docs/superpowers/DESIGN-BRIEF-2026-07-21-anna-crew-v2.md`;DEV 清单与设计返稿解耦,可并行:DEV-1/2/3/4/5/9 不等返稿;DEV-6/7/8 的 UI 面等 R1/R3/R4 返稿定版式。
