# Crew 精修二轮 · 开发总纲(2026-07-21)

> 输入三源:①设计返稿第三轮(`docs/design/2026-07-21-crew-return/`,稿 3a–3k + 设计说明 §七–九,红线第 5 条修订为动效双层制、新增第 7 条动效不撒谎)②诊断 `05-refine2-diagnosis.md`(DEV-1..9)③像素提取 `06-extract-refine2.md`(前端切片的规格事实源)。
> 执行模式:Fable5 统领规划把关,Opus 执行切片;文件所有权互斥;路径限定小步提交(前缀 `feat(crew-r2)` / `fix(crew-r2)`);测试与实现同片。
> 基线:feat/crew-build @ 7b2253c;四门基线 pytest 801 / tsc 0 / vitest 349 / build ✓。

## 0. 契约(先于代码,各片按此对齐,不得私改)

- **C1 在飞信号**:任务序列化增两字段——`run_inflight: bool`(路由层注解,来源 CrewBackgroundRunManager 在飞表;queued+running 全程为 true)与 `run_started_at: str|null`(ISO;worker `start_task` 成功后写入,run 终态(done/blocked/failed)清空)。前端「执行中」判定一律 `status==="running" || run_inflight`;elapsed 由前端本地推进、以 `run_started_at` 校准,无值显「刚刚开始」。
- **C2 友好守卫**:`POST /start` 与 `POST /run-agent` 路由层前置校验;状态冲突返 **409** JSON `{detail, code, task_status}`——codes:`task_not_startable`(start 打到非 assigned/rework)/ `task_not_runnable`(run-agent 打到非 assigned/rework 或非 agent 任务);**在飞去重维持现状**(重复 run-agent 返 200 + 既有 run_ref)。run-agent 对已推进任务不再产生异步「执行受阻」频道事件(该事件仅保留给真实执行失败)。
- **C3 意图确认卡**:`say` 落库后**后台**意图检测(规则,零模型:作者为 human + mentions 非空 + 正文命中任务祈使正则族)→ 复用 CommandDraftingService 起草(有模型走模型、无则确定性 fallback)→ 产出频道 `command` 行,payload 增 `origin: "intent"` + `origin_message_id`(指向触发 say);**草稿态,不建任务不进图**;采纳走既有 confirm 端点(Boss-only 维持)。FE 按 `origin==="intent"` 渲染「听出一项新任务」变体 + 被派者为 Agent 时预告文案。
- **C4 阅读器入口**:频道产物 chip / 评审卡 / 抽屉产物卡的「全幅阅读」统一上抛 `onOpenReader({taskId, version?})`(prop 可选,缺省 no-op,保 W1 独立编译);详情页(S-D1)持画布区视图态 `graph | reader`,ESC/「回到图」返回。
- **C5 错误人话**:`inspect/friendlyError.ts`(S-D2 建)映射 C2 codes → 中文人话(如 `task_not_startable` →「该任务已被 Anna 自动推进,当前状态:待审」);S-D1/S-D2 消费;W1 各片错误展示维持现状不依赖它。

## 1. 切片与文件所有权

### W1a(立即发车,不依赖提取稿)

**S-A 后端(Opus)** — `services/crew/app/{schemas,lifecycle,service,agent_worker}.py`、`services/api/app/routes/crew.py`、`services/crew/app/command_drafting.py`(如需)、`tests/**`(后端相关)。禁碰 apps/desktop。
1. C1:schemas 增字段 + worker 写/清 `run_started_at` + 路由快照注解 `run_inflight`;
2. C2:两端点前置校验 + 409 code 体;移除 submitted 任务 run-agent 的误导事件路径(真实执行失败仍保留原链路);
3. C3:意图检测(正则族含:新任务|新增任务|加个任务|需要你|请你|帮我|负责|去做|测试|回归|new mission|need you|please.*test 等,大小写不敏感;作者 kind=human;排除 Anna/agent 作者)+ 后台起草(asyncio,不阻塞 say 响应;测试走确定性 fallback 同步断言可用注入)+ command 行 `origin` 字段;
4. DEV-8 服务端半:say mentions 过滤为真实成员 id,非成员静默丢弃;
5. 测试:在飞注解生命周期(submit→true,终态→false 且 started_at 清空)/ 409 双 code / submitted run-agent 同步 409 且**无**新频道事件 / 意图起草出 command 行且零任务创建 / 非成员 mention 丢弃 / confirm 采纳后任务入图且 agent 自动跑(既有 auto_pilot 断言复用)。

**S-E 全局 Enter(Opus,小片)** — `apps/desktop/src/pages/home/HomeComposer.tsx`、`apps/desktop/src/components/agent/AgentComposer.tsx` + 各自样式/测试。禁碰 crew/。
- Enter 发送 / Shift+Enter 换行 / `e.nativeEvent.isComposing` 守卫(组词中 Enter 完全放行为换行);running 或空文本时 Enter 不发送(沿既有守卫);既有 Ctrl+Enter 仍可用(兼容肌肉记忆);skill 快召面板开启时 Enter 语义维持面板选择;微提示文案改「Enter 发送 · Shift+Enter 换行」(mono 9px,常驻 ink-3、聚焦 ink-2,按稿 3k);vitest:Enter 发送/Shift 换行/isComposing 不发送 × 两组件。

### W1b(待 06-extract 落地后发车)

**S-B 画布(Opus)** — `apps/desktop/src/pages/crew/graph/**`、`ChartingTable.css`。禁碰 channel/、inspect/、CrewProjectDetailPage。规格源=06-extract §3a–3d + 设计说明 §八。
1. R5 三层状态即形色:左缘 5px 状态色条(七态精确色,浅深双值)+ 卡面轻染 + 20px 章;门三态(活跃 44→48 + 金线 + 金脉 4s);边四型对比(通电 ink32% / 休眠淡 / 焦点流 dash 5-7 / 返工 danger 上弧);
2. R2 执行流光:节点边框 1.5px iris→lavender `strokeFlow 4.5s linear ∞`(实现技法按提取稿;强度<呼吸;可多节点);执行判定接 C1(`run_inflight` 经 crewModel 类型透传,graphMapping 判定函数统一);
3. DEV-4:布局迁移改 **JS 位置补间**——elk 新结果不再依赖 CSS transform 过渡,rAF 插值 240ms (0.2,0,0,1) 逐帧 setNodes(边天然逐帧跟随,消除脱线);born 动画仅真新边(快照刷新同 id 不复播);
4. reduced-motion 全量降级(流光→静态 iris 描边+徽记);`agentActiveCount(tasks, members)` 导出(含在飞)供页面健康条;
5. vitest:七态映射色条类名 / 在飞判定 / 补间器(fake timers)/ born 不复播。

**S-C 频道(Opus)** — `apps/desktop/src/pages/crew/channel/**`、`channelModel.ts`、`channel.css`。禁碰 graph/、inspect/、页面。规格源=06-extract §3d(活动行)/3g/3h/3i/3k。
1. R1 附件 chip 家族:产物 chip(图标+名+vN+字数+动作:展开/全幅阅读(iris 主)/下载)统一嵌入产物卡/评审卡/交付事件;链接卡变体;328 宽动作收敛「全幅阅读 + …」;无产物无 chip;「全幅阅读/下载」上抛 C4 prop(缺省 no-op);
2. R2 活动行:`status==="running"||run_inflight` 的 agent 任务 → 「正在执行『任务』· 已运行 mm:ss」(runPulse 脉点;elapsed 本地推进 + `run_started_at` 校准);完成即隐;
3. R4a @拾取器:键入 `@` 弹浮层(composer 上方),继续输入过滤、↑↓/Enter、Esc 关;插入沿既有 `insertMention` 机制(textarea 内保持纯文本 `@名`,**消息渲染侧** token pill 人=iris-soft / Agent=delegate-soft);IME 组词中不触发不发送;空 @ 无匹配安静收起;
4. R4b 确认卡 FE:command 行 `origin==="intent"` → 「Anna(起草)·听出一项新任务」头 + 字段区 + [采纳上图/调整/忽略];被派者为 agent → 预告行 + 主按钮「采纳并开跑」;忽略=200ms 淡出下沉(reduced-motion 直接消失);
5. R6 Crew composer:Enter 发送/Shift 换行/isComposing/微提示(与 S-E 同规格,文件归本片);
6. vitest:拾取器(触发/过滤/键盘/IME)/ Enter 三态 / chip 动作上抛 / intent 卡两变体 / 活动行 elapsed。

### W2(W1 全绿后发车)

**S-D1 阅读器+接线(Opus)** — 新 `apps/desktop/src/pages/crew/reader/**`、`CrewProjectDetailPage.tsx`、`CrewMarkdown.css`(阅读器排版扩展段)。规格源=06-extract §3e/3f。
- R1 阅读器:画布区整体切换(频道栏保持右侧);顶部条=面包屑+版本切换+下载+回到图(ESC);阅读宽 720–820 居中;mono 页脚=版本·字数·产出者·时刻;双主题;
- C4 接线三入口(频道 chip/评审卡/抽屉);下载=blob 另存 `.md`(文件名 `产物名-vN.md`);
- 健康条「活跃 Agent」接 `agentActiveCount`;图上节点动作路径补 catch → 底栏瞬时提示(mono,4s 淡出)消费 C5。

**S-D2 抽屉+动作(Opus)** — `apps/desktop/src/pages/crew/inspect/**`(含新 `friendlyError.ts`)。规格源=06-extract §3j + 设计说明 §八。
- R3 信息序:产物(最新版默认展开,盒高放开)→ 验收标准 → 执行过程(默认折叠)→ 元信息;
- 三级 Trace:一级摘要行(模型·帧数·耗时·结果)吸顶可即点即关;二级步骤行;三级帧原文(text/thinking 帧 CrewMarkdown 渲染,工具帧等宽降噪);任意滚动深度可收起;
- DEV-1:动作前先拉最新快照校验可用性,动作后立即 refetch;按钮点击即 pending 态;
- DEV-2/C5:`friendlyError.ts` code→人话;`useTaskOps` 消费;双按钮收敛(agent 任务只「执行」,人任务只「开始」;`withAgentRun` 不再并列 start);
- vitest:信息序 / 三级折叠 / 友好文案映射 / 双按钮收敛。

## 2. 波次与门禁

```
W1a: S-A ∥ S-E            (即刻)
W1b: S-B ∥ S-C            (06-extract 落地后)
  → Fable:四门 + 契约集成检(C1 字段真流、C3 行真出)
W2:  S-D1 ∥ S-D2
  → Fable:四门 + 真机视觉终验(Playwright,按 3a-3k 对照)+ 偏差登记(本文件尾)+ 记账
```

验收红线:四门不倒退(801/349/0/✓ 起步,只增不减);设计红线 7 条(含动效双层制/不撒谎)复核;R1-R6 与 DEV-1..9 全覆盖对照表见终验节。

## 3. 偏差登记(实施中追加)

### 提取稿 6 冲突裁定(Fable,2026-07-21;S-B/S-C 按此为准)

| # | 冲突 | 裁定 |
|---|---|---|
| 1 | 节点宽 172 / 188 / 200×64 | **188 × min-h 66 维持生产现值**(《设计说明》§三 canonical;172/200 为演示画布变体);左 padding 改 16px 让位 5px 色条 |
| 2 | 章 20 vs 16 | **20px**(R5 明确升级近读层;3c 权威表) |
| 3 | 门尺寸三组值 | **常态(待就绪/已通过)44×44 r8,活跃 48×48**(canonical「44→48」;3a 已通过 48 与 3c legend 38 均为演示变体) |
| 4 | 抽屉宽 468 vs 480 | **480 维持生产现值**(《设计说明》§三) |
| 5 | composer「三处」vs 四入口 | 无实冲突:HomeComposer 一件覆盖 Chat+Create → 三组件四入口,按切片划分执行 |
| 6 | 微提示位置 左下 vs「右下」 | **按 markup:hint 底行居左、发送键居右**(三处 demo 一致;「右下」为文案笔误) |

另:①`railBreath` keyframes 定义但全稿未引用——**不实现**,登记备查;②3c 深色全家福的紧凑卡(r12/色条 4px)为图例排版,**生产几何两主题一致**(r14/色条 5px),仅色值换深值;③L3 帧原文:text/thinking 帧 markdown 渲染,工具帧(args/result)等宽降噪——采提取稿「渲染」主案。

### 实施偏差

- (预登)R4a composer 内联 mention 变 pill 在原生 textarea 不可行——composer 保持纯文本 `@名`(半成 token 高亮不做),token pill 只在消息渲染侧兑现;若设计强诉求需 contenteditable 重写,记 P1。**(S-C 已按此执行)**
- S-E:键位契约提为纯函数 `lib/composerKeys.ts`(repo 无组件测试栈,遵纯逻辑测试惯例);微提示取 9px mono(设计源)取代原 11.5px;报销页 composer 借道 AgentComposer 同获 Enter 发送,其写死 footnote 由 Fable 整合修正。
- S-A:①agent_worker 增本地 `_now()`(仿 lifecycle/service 各自持有的惯例);②say 签名不动,意图旗标独立成 `should_draft_intent` 谓词(15+ 调用方免动);③良性竞态引入 `CrewRunSkipped` 异常,终帧=平静 `done/skipped`「任务已推进,无需执行」。
- S-B:①补间取单次同步(放弃 30ms 错峰,rAF 插值下不值复杂度);②执行中端口点 top 27.5px 对齐 handle 中心(非稿字面 32px,避免状态切换时边跳位);③画布五层对齐 §3a alpha,深色双辉强度 ≈×2(**终验视觉 QA 重点**);④reviewLive 边(二轮第五型,不在 §3c 四型内)保持二轮亮 iris 样式;⑤就绪加号 glyph 落 TaskNode 本地(不动共享 stateSealGlyph,避免泄进 inspect 印章);⑥goldPulse 深色随 --gold 推导(与稿差 ≤4% alpha);⑦railBreath 未实现(裁定)。
- S-C:①cardRise 泛化为「新到产物卡」入场(run→产物归因不可靠推导);②elapsed 封顶 99:59;③「调整」复用标准 CommandDraftCard(头仍写「＋任务 · Anna 起草」,P1 可换文案);④多草稿意图卡主稿+「另起草 N 项」,采纳=全确认;⑤say 站内产物内联引用 chip **拒做**(ChannelMessage 无此字段,零捏造);⑥活动行 flex-wrap 自适应 328 栏(稿 520 定宽为演示宽);⑦两组件更名避 Windows 大小写冲突(AttachmentChip/ActivityRows,导出名不变)。
- Fable 整合:`inspect/friendlyError.ts`(C5)由 Fable 先铺(消除 S-D1/S-D2 时序耦合);W1 整合四门独立复核 **pytest 819 / tsc 0 / vitest 431 / build ✓**(2026-07-21)。
- W2 额度墙插曲:两片首发死于 Opus 配额(零 commit),半成品入 stash `w2-partial-before-quota-wall`,重置后干净基线重发,零损失。
- S-D1:面包屑连续同名段去重(产物名=任务名时诚实折叠);阅读正文色无恰配 token → 局部 `--reader-body` 双值;底栏提示居画布区;页脚深色用 --ink-2(与稿 #74747C 微差)。
- S-D2:`traceLevels.ts→traceModel.ts` 更名避 Windows 大小写碰撞;L2 tag `system→「生成」`;L1 模型名仅帧真报时显示;预检自足取 `task.project_id`。

## 4. 🏁 终验收轮(2026-07-21,Fable 亲自真机走查 + 整合修复)

**整合修复(切片落地后 Fable 抓的 6 处,全部带测试)**:
1. **首屏左锚**:fitView 撞 0.72 可读下限时 React Flow 居中裁两头 → 回锚左缘(阅读方向左→右;`CrewGraphCanvas` 双 rAF 后 setViewport);
2. **手打 @全名注册为真提及**(用户 #4 原始场景的残余陷阱):`buildSayPayload` 增花名册精确匹配(长名优先防前缀误吞),视觉 pill 与功能 mention 重新一致;
3. **采纳即派(R4b 契约缺口)**:确认卡「负责人」原本只是展示——`confirm_drafts` 增 `suggested_assignee`,采纳后首任务走正规 assign 通道(频道事件/通知/auto-pilot 自然触发,「采纳并开跑」语义补全);幽灵成员静默跳过;
4. **friendlyError 嵌套解包**:FastAPI 把 dict detail 渲染成 `{"detail":{...}}`,原解析读顶层 code 落空 → 解开一层(以真实 wire 形状补测试);
5. **Trace 步数语义**:「1373 帧」噪音(text_delta 微帧全计)→ frameCount 改 L2 步数,标签「N 帧→N 步」;
6. **报销页 footnote** 键位文案同步(S-E 连带)。

**终验四门(整合后):pytest 821 / tsc 0 / vitest 495 / build ✓**(vs 轮初基线 801/—/349/✓,净增 20 后端 + 146 前端测试,零回退)。

**真机走查实录(截图 `walkthrough3/`,服务 8000 + 真模型)**:
- **R1 ✓** 频道附件 chip(328 收敛为「全幅阅读+…」)→ 阅读器整版(面包屑/vN 版本 pill/下载/回到图/ESC 徽/页脚审计血统)→ ESC 回图;对照评审姿势成立(左读右审);
- **R2 ✓** 派 PRD 给 Agent·Scribe(未点任何执行钮)→ **三处同源同拍**:健康条「Agent 执行中·1」脉点 + 图上 strokeFlow 流光描边 + 频道「正在执行·刚刚开始」活动行(排队窗口 run_inflight 兜住,elapsed 诚实);跑完活动行消隐、产物卡接棒、评审卡挂出、**PRD 评审门转 48px 金线活跃态**;
- **R3 ✓** 抽屉①产物默认展开(1,712 字 markdown 富渲染+全幅阅读 chip)②验收③执行过程折叠(N 回合·N 步)→ 三级下钻(一级摘要吸顶可收);
- **R4a ✓** 键入 @An 弹拾取器(composer 上方、过滤、↑↓·Enter、「组词中 Enter 不触发」脚注);消息侧 mention pill;
- **R4b ✓★** 手打「@Andy 新任务:九屏全功能回归走查,输出问题清单。」Enter 直发 → **Anna 监察卡**(「听出一项新任务」+负责人 Andy「发言中 @ 指定」+真模型起草的项目上下文验收标准+「另起草 2 项」)→ 采纳上图 → **3 节点长上图**(「由频道生长」溯源行,重排全程连线无脱线=DEV-4 实证)→ 卡转「已确认·已下推」;
- **R5 ✓** 七态三层形色满屏可辨(完成绿脊沉底/待审薰衣草菱章/就绪 iris 加号/门金线);
- **R6 ✓** Enter 直发实测(R4b 即证);微提示「Enter 发送 · Shift+Enter 换行」三 composer 就位;
- **DEV-3 ✓** curl POST /start 打 submitted 任务 → 409 `{"detail":"「设计稿」当前状态为待审,无法开始。","code":"task_not_startable","task_status":"submitted"}`,裸英文 JSON 时代终结。

**遗留(不阻验收)**:①深色主题画布 QA 待真机切换(应用内开关,Playwright 媒体模拟不生效;S-B 深色双辉 ×2 强度请顺带过目)②走查用 proj_1 里 18:20 前采纳的 3 任务未派(修复前数据,演示无碍)③P1 池不变(看板/就地审批/悬挂 run 清扫/成员侧栏列项目/催收派办)+ R4a contenteditable 内联 pill。

## 5. 🏁 可用性收束轮(2026-07-21 晚,用户上手反馈后,Fable 亲手实施)

> 用户实测:①评审门抽屉给了「提交」入口 → 撞英文守卫卡死,验收标准复选框是死的;②整体上手复杂——「任务清晰,但不知道怎么操作 Canvas,要确认的内容有点多」,要求按第一性原则做高可用清晰使用路线,不必顾虑原设计。

**第一性拆解**:新手在 Canvas 前只有一个真问题——「现在轮到我做什么、点哪里」。答案 = 一条常驻回答这个问题的路 + 每个对象只剩一个动作。

**落地五件**(commit 见本轮;四门 pytest 822 / tsc 0 / vitest 504 / build ✓,+10 后端 +… 前端测试):
1. **门的双守卫(硬 bug 根修)**:根因=抽屉 drawerOps 从不判 is_gate,门(底层 todo)被 ready 分支给了认领/开始 → 用户点开始把门推进「执行中」→ 见「提交」→ 撞英文 400。修:`gateOps`(活跃→唯一「去评审」/休眠→「看依赖」/已过→无)+ `opsForTask` 统一入口(抽屉+轻检视);后端 /start、/submit 对门 409 `task_is_gate` 中文体 + lifecycle.start_task 门 backstop;friendlyError 补人话。
2. **「该你了」向导条**:健康条下常驻一行——永远只显最该办的一件事+一个按钮(优先级 我的返工 > 活跃门评审(Boss)> 我的提交 > 我的开工;`deriveNextUp` 纯派生,>1 件显「共 N 件」,零即隐不装忙)。评审件金脊、其余 iris 脊。
3. **一屏两键评审(主路)**:去评审(向导条/评审卡「全幅对照评审」/门抽屉/轻检视 四入口同归)→ 阅读器对照态:左读被评审产物全文,底部金印评审条钉「通过 / 驳回+批注」——**判后自动回图 + 点名环落门**,下游解锁/自动派/自动跑肉眼可见。canvasView 增 gateId;ArtifactReader 增 review prop;门已决(轮询追平)评审条自然消失。
4. **验收标准可勾选**:评审备忘(仅本机 localStorage,不上报——勾是「我核过」不是状态,零捏造);标签明示「评审备忘 · 仅本机」。
5. **门抽屉评审视角**:①待评审产物=producer 真产物就地读(来自『X』)②署名=「Boss · 评审人」不给改派 ③元信息「评审 · 通过或驳回」。

**真机走查(截图 walkthrough3/21·23·24·25,proj_3 全新项目)**:该你了条(金脊「『PRD 评审』待你裁定…[去评审]」)→ 一屏两键(左 PRD 全文右频道、底金印条)→ 通过 → 回图落章+设计稿自动派 Agent·Design 并开跑(流光+活动行)+技术预研派 Andy → **向导条消失(零即隐:安静=真没事)**;休眠门抽屉=待评审产物+可勾备忘(勾上绿)+唯一「看依赖」。

**偏差登记**:①向导条「共 N 件」为纯显示(不接收件箱跳转,避免侧栏导航耦合——P1 可接);②走查脚本曾误点向导条内『PRD 评审』文本(getByText 全局命中)——测试脚本问题非产品问题,已用画布/列表作用域定位;③门抽屉三级结构保留(产物/验收/过程/元信息编号不变),仅语义换评审视角。

## 6. 可用性收束二批(2026-07-21 深夜,用户二检五问;Fable 裁决,Opus 执行)

> 用户五问:①产物在哪提交/为何不能上传/下游能否读/输入框是什么 ②验收标准依据 ③执行过程与「现件留位」是什么 ④频道文档无法定位到图 ⑤微提示挤行 + 打开抽屉 vs 全幅阅读差异。

**全局裁决**(前因后果):
- **产物=文本是全链路脊柱**(Agent grounding/阅读器/评审/字数全靠它)。二进制上传会悄悄断 grounding,违背诚实协作 → 记 P1;本轮:**产物区即交付区**——①区内置交付面板(正文框=产物本身,白话标明 + 「上传 .md/.txt 读入」FileReader 纯前端 + 提交按钮 + 「提交即 vN:评审人全幅可读,下游 Agent 起草自动读取」),废除底部 SubmitInline 双入口;节点/向导条「提交」→ 开抽屉自动聚焦交付区。
- **验收标准标来源**:origin=sop→「来自 SOP 模板」/ channel→「Anna 起草 · 源自频道」;依据提示「对照上方产物逐条核对 · 勾选仅本机备忘」。
- **执行过程只属 Agent 任务**:人类任务与门整区隐藏(编号动态续);Agent 未跑改白话「Agent 开始执行后,这里会逐帧回放过程」——「现件留位」黑话清除。
- **对齐双向打通**:chip 内置准星「定位」(回图+点名环,阅读器态先回图);节点产物徽记(有产物显 vN);产物消息砍「打开抽屉」重复入口。心智一句话:**频道管读与定位,图管推进与管理**。
- **窄栏微提示让位**:Crew 频道撤常驻 hint,占位符并入「(Enter 发送)」,组词 warn pill 保留;宽 composer 不变(偏差:3k「常驻」在 328 栏让位功能)。

**切片**:O-A 抽屉交付区+来源+过程隐藏(inspect/**)∥ O-B 频道 chip 定位+去重+composer(channel/**)∥ O-C 节点徽记+页面接线(graph/TaskNode + page)。契约:`onLocate?: (taskId)=>void`(O-B 消费缺省 no-op,O-C 页面提供=回图+ring)。

**🏁 收轮(同夜)**:三片落地 d56c8a0(O-A)/ab4e606(O-B)/2364d90+776e111(O-C)+ Fable 整合(评审判后 ring 采纳 O-C 双 rAF 延迟同款)。四门 **pytest 822 / tsc 0 / vitest 537 / build ✓**(+33 前端测试)。真机按用户原话场景走查(截图 26/27/29):task_10_ch「执行九屏走查」(用户亲手卡住的那条,running)→ 该你了「去提交」→ 抽屉交付面板(标注「下面写的就是产物本身」+上传读入+「提交即 v1:评审人可读、下游 Agent 自动读取」;②「Anna 起草 · 源自频道」+「对照上方产物逐条核对」;③过程区人类任务整区消失、元信息动态续号)→ 写清单提交 → **done 落章 + 下游两任务应声解锁**(印证下游可读承诺)→ 频道 chip 准星定位平移聚焦节点;画布全节点产物徽记 vN;composer 占位符「…(Enter 发送)」工具钮一行。**偏差**:O-A submittable 取 opButtons 派生(与旧脚 提交 完全同口径);O-B 无 chip 行保留旧 AnchorChip(dispatchRingCall 直连,未走 onLocate 回图——registered,P1 统一);O-C artifactBadge 过滤空正文(徽记=真可读才显)。二进制附件上传 = **P1**(会断 Agent grounding 链,需独立设计,交付区文案已明示)。

## 7. 可用性三批(2026-07-22,用户四问;Fable 裁决,三 Opus 并行)

> 用户四问:①设计稿点去评审→全幅阅读打开却无评审按钮,怎么评?②交付区上传为何只限 md/txt——word/html 等也该支持;html 也该能在频道展开/全幅阅读 ③Boss 认领 Andy 已派任务撞「Cannot assign…expected todo or blocked」——Andy 在干 Boss 也认领如何协调?④除 icon 外没有明显通知弹窗/标识/历史。

**全局裁决**:
- **#1 评审等待态**:设计评审=双父门(需设计稿+技术预研双交付),门未活跃时阅读器评审条整条不渲染=沉默。裁决:评审条对**任意门**渲染——活跃门给通过/驳回;休眠门给**等待态**「评审待就绪——还差『X』交付后开评」,对方一交付 3s 轮询内同条 live 翻成按钮。`reviewReadiness` 纯函数镜像后端门就绪。
- **#2 泛文本+HTML**:`validateArtifactFile` 放开任意扩展(内容嗅探,已知二进制 docx/pdf/png 短路拒 + 人话「导出为 md/html/纯文本;附件直传 P1」),1MB 帽,`decodeTextFile` UTF-8 fatal + NUL 拒。`sniffArtifactKind` → **HTML 产物阅读器沙箱预览**(`iframe sandbox=""` 无脚本 + 预览/源码切换 + 页脚「HTML·沙箱预览」),chip 展开给源码块,下载 .html。**+ext 跟随嗅探**(chip 标 .html 不再一律 .md,Fable 收尾补)。
- **#3 接管式改派(协调模型)**:`assign_task` 放行 todo|blocked|**assigned**(未开工可接管);running/submitted/rework/done 不可静默接管→409 `task_not_assignable` 人话导向频道协调;门不可派→409 `task_is_gate`。接管**全程留痕**:频道「已改派给 @新(原 @旧)」+双方通知;同人幂等;ready 转派 Agent 仍自动跑。**连带修好一直坏的改派**(assigned 任务此前无法改派)。
- **#4 通知铃明显化**:**根因=铃写死 `enabled=source==="token"`,桌面免登录永不拉**(与 401 同族病)→ 改任意身份点亮。补:未读 iris 徽标 9+ 帽零即隐、面板按项目分组+**未读优先历史保留**(30 帽)、开面板置读、新通知单次摆动±9°、深链原本已通。已读走既有 PATCH 端点(非 localStorage)。

**切片**:U-A(pages/crew/** 前端:等待态+泛文本+HTML)3579d3b ∥ U-B(services/** 后端:接管改派)d4bbd17 ∥ U-C(components/shell/** 铃)0d28dcf + Fable 收尾(chip ext 嗅探)。**四门 pytest 833 / tsc 0 / vitest 563 / build ✓**(+11 后端 +25 前端测试)。

**真机四场景走查全过(截图 walkthrough3/31·34·37·40·41,proj_1)**:①设计稿去评审→阅读器底「评审待就绪——还差『技术预研』交付后开评」;提交技术预研后**同条 live 翻成 通过/驳回**(该你了亦从等待翻「设计评审待你裁定」);②Boss 认领 Andy 的技术预研→频道「『技术预研』已改派给 @Boss(原 @Andy)」+节点转 Boss+该你了「可以开工」,无 400;③上传 design-note.html→交付区读入「已读入 design-note.html」→提交→阅读器**沙箱真渲染**(彩色表格/色板/iris 标题)+预览/源码切换+页脚「HTML·沙箱预览(无脚本)」;④铃 9+ 徽标、面板按两项目分组(待你审/派工/由频道生长 kind 词+相对时间+iris 未读点+历史保留),点行深链 Home→Crew→项目并点名活跃门。

**偏差**:U-A reviewReadiness 落 readerModel;仅 passed 门隐藏评审条(rework-dormant 与首交付-dormant 均诚实归「等 X 交付」);decodeTextFile 仅 UTF-8(gb18030 P1)。U-C `enabled` 放宽至任意身份(与后端 local_session 现实一致,是行为要害改动);开面板标全部已读(非仅可见 30);相对时间用 relTime(刚刚/N 分钟前/HH:MM)。U-B 接管留痕超集覆盖 blocked 预派换人(被顶掉的预派人收通知,不无声掉)。二进制附件直传/gb18030 解码 = **P1**。
