# 验收对照清单 · Anna P1(设计方逐项打勾)

> 逐像素对照基准:`preview/index.html`(同源码渲染)。每项给出精确值,不符即打回。

## A. 色彩(token → hex,浅色 / 深色)

- [ ] 鸢尾主色 `--iris` #575BC4 / #8B8ED9(深色 iris 文字亮度一律 ≥ #8B8ED9)
- [ ] 鸢尾深 `--iris-deep` #44479F;soft #EFEFFA;lavender #B7B9E8;渐变按钮 #6165CF→#4B4FB2(深 #6A6ED6→#5155BE)
- [ ] 金线 `--gold` #CBBB8E / #A6996F,只做滚边(头像描环、礼成条左沿、「安」印),每屏 ≤2 处
- [ ] 墨字三级 #232328 / #6C6C72 / #A3A3A8(深 #ECECF0 / #A8A8B0 / #74747C)
- [ ] 语义:ok #3E9C82 · warn #B98A2F · danger #BE4A44(deep #A93B36)· delegate #9C56B8
- [ ] 背景渐变 #F9F8F4→#F6F5F0;卡面 #FFF→#FDFCF9;深色面 #232328→#1E1E22(非反相:您的话语变纸 #EFEDE5)

## B. 质感配方

- [ ] 瓷面卡:border 1px rgb(35 35 40/8%) · radius 16 · shadow `0 1px 2px 4% + 0 8px 24px 5%` + inset 顶高光 85%
- [ ] Loop 卡:radius 18 · 左上鸢尾晕 radial 6% + shadow `0 1px 2px 5% + 0 12px 32px 7%` · 书脊 3px
- [ ] 书脊状态色:运行 iris→lavender 渐变 / 审批 琥珀 / 失败 胭脂 / 回看 青瓷 #3E9C82→#9ED4C3
- [ ] 第二级(L3)面板:#FAF9F5→#F7F6F1 · border 7% · radius 10 · mono 11/1.8;失败版 #FBEFEE + 红 18% 边

## C. 字体与字阶

- [ ] 衬线 Noto Serif SC 500/600 仅仪式(礼成、问候、拟人标签);黑体做事;JetBrains Mono 账本
- [ ] 当下行 15.5/24·500;步骤行 13/20(当前步 13.5·500);L3 mono 11/19;耗时 mono 10.5;礼成「礼成」衬线 13.5·600
- [ ] 正文 15/28 max 68ch;caption 11.5·300

## D. 三级下钻(结构与状态)

- [ ] L1 = 回合折叠行:▸/▾ + 时态图标(转圈/✓/✕/⏳,素的)+「第 n 回合 / 准备」+ 拟人标签(衬线鸢尾,可关)+ 聚合摘要(思考 · 调用 N 次工具)+ 耗时
- [ ] L2 类型点:思考=空心 lavender 描边 2px · 工具=实心 iris · 系统=空心灰 #D6D4CE · 错误=实心胭脂;9px,压左轨(1px 发丝)
- [ ] **无 L3 的步无箭头不可掀**(系统步永不可掀);有推理原文的思考步可掀全文(>12 行折叠 + 展开全文)
- [ ] L3 三形态:正常(args/result/exit 字段行,key 52px 灰)/ truncated(「已截断预览 · 全文 N bytes」+ 展开更多 + 加载中转圈)/ restricted(🔒 琥珀条「受限视角 · 已脱敏摘要…」+ 虚线边)
- [ ] 默认态:done 全折叠;running 当前回合开;failed 失败回合开 + 失败步掀到 L3;awaiting 审批回合开;**用户手动后不被自动态覆写**
- [ ] 失败卡:书脊胭脂、当下行「…,未能完成」#A93B36、动作条 ↻从断点续办(filled)/查看审计/复制错误(tinted)+ 「已消耗 ~N tokens」如实展示
- [ ] 礼成条:✓(17px 青瓷 soft 圆,落笔描画)+ 衬线「礼成」+ N 个瞬间 · 计划 n/m + mono 消耗/时长 + ▸ 回看 + 左沿 2px 金线 + 「安」印(-4°)
- [ ] 计划条:计划 n/m(12·500)+ 分段 22×4px(done=iris→lavender 渐变)+ 「正在:…」+ 右侧 mono 模型·tokens
- [ ] 窄容器 <560px:只显当下行+计划条,回合树折叠为「▸ 过程 N 个瞬间」(container query)

## E. 动效(时长/曲线)

- [ ] 呼吸 2.4s ease-out 光环 0→7px 收透明(当下点;全屏唯一常驻)
- [ ] 微光 5s linear iris↔lavender 文字渐变(仅 running)
- [ ] 掀开 240ms cubic-bezier(.2,0,0,1),grid-rows 实现(无测高跳变)
- [ ] 落笔 300ms stroke 描画一次性;收拢 320ms
- [ ] done/error 状态下**零动画**(呼吸/微光/转圈全停)
- [ ] prefers-reduced-motion:呼吸→实心点、微光→纯色、掀开保留

## F. 七态与诚实红线

- [ ] 每个数据面能演示七态:空/加载/运行中(流式)/完成/失败/未连接/站位
- [ ] 站位 = 虚线边 + 「即将上线」+ disabled;无假响应、假数字、假 loading
- [ ] 未连接 = warn-soft 说明,无演示数据;错误 = danger-soft + error 帧原文 mono,无裸 error_code 横幅
- [ ] 过程文案全部来自帧(step.intent 原样);拟人层可整体关闭;L3 原文与视觉稿逐字一致

## G. Composer 与周边

- [ ] 槽位顺序:附件(虚线站位)· 调优 · 权限 pill · CTX 环 · 弹性 · 模型档位 · 停止/发送
- [ ] focus-within 边框转 iris 35%;运行中发送 35% 禁用 + 停止键(tinted + 9px 黑方块)
- [ ] CTX >80% 转琥珀;权限非默认 = iris tinted 激活态
- [ ] 发送键 34px 鸢尾渐变圆 + 阴影 `0 2px 8px rgb(87 91 196/30%)` + inset 高光
- [ ] PlanRail:无计划不渲染;底注「plan.updated · 引擎权威帧驱动」mono 10

## H. 沙箱画布 Sandbox

- [ ] 点产物卡 → 右侧**挤压式**自动展开(宽度过渡 240ms cubic-bezier(.2,0,0,1),非遮罩浮层);✕ 收起
- [ ] 产物 tab 激活 = iris tinted(#EFEFFA + iris-deep + 内描边 14%);「存入产物中心」= 虚线站位
- [ ] 文件夹树:可折叠目录 ▸/▾ + 文件行 mono 类型角标(html/md/py/txt);选中行 iris tinted
- [ ] 预览四类型:HTML = 沙箱 iframe(sandbox=""、无脚本/无外联)· Markdown 排版(衬线标题)· 代码 mono 11.5 + 行号 · 纯文本 pre-wrap
- [ ] 空态 = 鸢尾瓣 26px + 「产物将在此呈上」;底注 mono 10「沙箱预览 · 无脚本 / 无外联 · N 个产物」
- [ ] 产物卡:40px iris-soft 图标砖 + 名 14/600 + meta 11 ink-3 + 「在画布打开 ↗」iris 13/500

## I. 通用审批卡(§6.4)

- [ ] 琥珀书脊 3px + 标题「提交前需要您确认」13.5/600 + 风险 chip(低=青瓷 / 中=琥珀 / 高=胭脂 soft 底)
- [ ] 字段网格 2-3 列:label 10.5 ink-3 + 值 12(账本值 mono);▸ 原始 payload 掀开 240ms,mono 原文一字不改
- [ ] 动作对:tinted「返回修改」+ filled「确认提交」;右下「运行已暂停,等您示下」11 ink-3
- [ ] 缺信息变体「请您补充」:number/date/text 真输入(focus 边框 iris 35%),file = 虚线站位「即将上线」

## J. 看板五段式(P3)

- [ ] 段序不动:警示带 → KPI 带 → 图表行 → 洞察/建议 → Anna 解读;ProvenanceLine 必在(含「由代码计算,非模型生成」)
- [ ] 警示带:琥珀渐变书脊 3px + 「最需关注」13/600 warn-ink + 关键数字 mono + 「向 Anna 追问」iris tinted chip
- [ ] Hero KPI = 全屏唯一强调卡:鸢尾描边 22% + 左上花晕 + 阴影 8px 24px rgb(87 91 196/8%);值 mono 28/600,普通卡 22/600
- [ ] 图表渐变全部收于透明(Sparkline/TrendChart 面积 0.28/0.22→0);系列色仅 iris + gold;基线 var(--line)
- [ ] 指标条 8px 圆角 4:琥珀=风险项,鸢尾=常规;值 mono 12
- [ ] 洞察/建议:追问 chip = iris tinted;Anna 解读可折叠(240ms,阅读版式 68ch)
- [ ] 未连接 ERP:整面 StateNote offline,零演示数字;数据密集区零装饰零光晕

## K. Create / 产物中心 / 设置(P4)

- [ ] Create hero:光晕三团收于透明 + 绽放鸢尾 52(仅 hero/空态层级)+ 衬线 display 30「描述,即构建」
- [ ] workshop 五标签:1 真(iris tinted 激活)+ 4 虚线「即将上线」;draft 账本 = 全站唯一深色面板(#232328→#1E1E22,mono 11)
- [ ] 产物中心:来源过滤 Create 真 / Chat·Code 虚线;网格卡 38px icon 砖 + 名 13.5/600 + 类型·版本·状态 11 + 来源 mono 10 + 「在 Chat 使用」(iris tinted)/「引用到对话」(tinted)
- [ ] 瓣饰分隔线仅用于分组(线 + 12px 瓣 + 线,占每屏点缀名额)
- [ ] 设置 Boss 视角恰 5 卡(连接/模型档案/记忆 W6 站位/外观/关于);外观分段控件切 [data-theme]
- [ ] 开发者模式开关(36×20,开=iris 渐变):开启后整屏接管运行时状态页,内容不删只分层
