# 设计稿 v2 提取 · 1a/1b 项目详情三区(附录一)

> 来源:`docs/design/2026-07-17-crew-return/Crew-组织协同-设计稿 v2.dc.html` 384-1215 行,由 Explore 代理蒸馏(2026-07-17)。**与原稿冲突时以原稿为准。**

# 1a 项目详情三区 · 浅色(384-813)

## 1. 整体布局
**外框**:1440×900,`r20`,`overflow:hidden`,`display:flex`;背景 `linear-gradient(180deg,#F8F7F3,#F5F4EF)`;边 `1px rgba(35,35,40,.10)`;阴影 `0 2px 6px rgba(35,35,40,.06),0 28px 70px rgba(35,35,40,.13)`。
内部从左到右:**侧栏 232px** + **主列 flex:1(纵向)**。主列 = 面包屑条(52px)+ 健康条(60px)+ 内容行(flex,含画布 flex:1 与 频道 328px)。

- **侧栏 232px**(app 级导航,非三区):`bg rgba(250,249,245,.82)` `backdrop-filter:blur(36px)`,右边 `1px rgba(35,35,40,.08)`,`padding:18px 14px 14px`。含 Anna 叶标+Home/Cowork/**Crew**(选中:白底 r999 内阴影)三段切换;导航项 收件箱(badge2 #575BC4)、**项目**(选中 `bg#EFEFFA color#575BC4`)、子项 登录页重设计(3/7)/营销物料(4/7)、团队(2+3)/SOP 模板/资源;底部 Agent 中心、自检通过 pill(#3E9C82 点)、Boss 卡(28px 头像 #55589E)。
- **面包屑条 52px**:`padding:0 20px`,下边 `1px rgba(35,35,40,.08)`。项目 › 登录页重设计 + `SOP·功能迭代与设计` pill + **视图切换条** + `共识·3` pill + 铃铛(badge2)。
- **画布区**:`flex:1;position:relative;overflow:hidden`;背景 `linear-gradient(180deg,#FCFBF8 0%,#F8F7F2 46%,#F2F0E9 100%)`。
- **频道区**:`328px` 定宽;左边 `1px rgba(35,35,40,.08)`;`bg rgba(253,252,249,.75)`。

**视图切换条**(面包屑内,右侧):容器 `flex;bg rgba(120,120,128,.09);r10;padding:2px`。`图`(选中):`padding:4px 12px;r8;bg#FFF;shadow 0 1px 2px rgba(35,35,40,.08);12px/600` + iris 图标节点图;`列表`:`12px #6C6C72`;`看板·P1`:`12px #A3A3A8;border:1px dashed rgba(35,35,40,.14);r8;margin-left:2px`。

## 2. 健康条(60px)
`padding:0 20px;gap:16px`;`bg linear-gradient(180deg,#FFFFFF,#FDFCF9)`;下边同上;`box-shadow:inset 0 1px 0 rgba(255,255,255,.7)`。内容:
- 标题「登录页重设计」`Noto Serif SC 16px/700`。
- **进度段**:7 条 `6px×16px r2`,前 3=`#3E9C82`,第 4=`#575BC4`,后 3=`rgba(35,35,40,.10)`;尾随 mono `11px #6C6C72`「进度 3/7 · 执行 1」。
- chip「Agent 执行中 · 1」:`padding:4px 12px;r999;bg rgba(156,86,184,.10);color#7A3F93;12px`,前置 `10px 方点 r3.5 #9C56B8`。
- chip「等我处理 · 1」:`bg rgba(185,138,47,.10);color#8A6420;12px`。
- 头像堆(24px,`border:2px solid #FFFFFF`,重叠 `margin-left:-7px`):B `#55589E` → A `rgba(120,120,128,.16)` → 3 个 Agent(`r8;bg#EFE7F4`;图标 #7A3F93:文档线/相机方块/勾)+ 面板图标。
- **零值隐藏规则**:计数为零的 chip 不渲染(见 1b「Agent 执行中」消失)。

## 3. 画布制图桌五层
1. **纸面**(容器底):`linear-gradient(180deg,#FCFBF8 0%,#F8F7F2 46%,#F2F0E9 100%)`。
2. **主格线**:`repeating-linear-gradient` 0deg+90deg,`rgba(87,91,196,.05) 0 1px, transparent 1px 110px`(110px 网格)。
3. **微点**:`radial-gradient(rgba(35,35,40,.065) 1px, transparent 1.15px);background-size:22px 22px;position:11px 11px`。层 2/3 共用羽化 `mask:radial-gradient(118% 108% at 50% 42%,#000 52%,transparent 99%)`。
4. **双辉光**(blur64):A `left:16%;top:-34%;66%×60%;radial(closest-side,rgba(87,91,196,.09),transparent 70%);auroraDrift 30s`;B `right:-16%;bottom:-30%;50%×54%;rgba(203,187,142,.10);auroraDrift2 40s`。
5. **灯下白纱**:`linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,0) 90px)`。
+ **工作框**:`inset:10px;border:1px rgba(87,91,196,.09);r14;box-shadow:inset 0 1px 0 rgba(255,255,255,.6)`;**四角规矩线** `10px×10px` L 形 `1.5px rgba(87,91,196,.35)`。
节点层容器:`1200×660;transform:scale(.9) translate(-14px,4px)`(**mock 静态排版参考,实机由 elk 计算布局 + React Flow 平移缩放,勿硬编码**)。

## 4. 节点与边(1a;坐标=mock 层内 left/top,宽 188px 除非注明)
通用卡:`bg linear-gradient(180deg,#FBFAF7,#F6F5F0);border:1px rgba(35,35,40,.08);r14;padding:11px 13px 10px`。待就绪卡:`bg rgba(255,255,255,.5);border:1px dashed rgba(35,35,40,.17)`。角色点 4px:产品#55589E/设计#9C56B8/工程#3E9C82/验收#B98A2F。连接桩 8px:完成/激活边 `1.5px rgba(62,156,130,.7)` 或 `#575BC4`,待就绪 `rgba(35,35,40,.22)`。

- **需求简报** `20,96`:产品·Boss(16px #55589E)·✓(#3E9C82 圆勾)。
- **PRD 起草** `248,96`:`v2` 徽章·产品·Agent·Scribe(#EFE7F4/#7A3F93 文档图标)·✓。
- **PRD 评审 ◇**(门)`497,105 w52`:46px 菱形 rotate45 r9,`grad #FFFFFF→#FBFAF6;border:1px rgba(62,156,130,.55)`(已通过=绿),内绿勾;标签 `10.5px #6C6C72`;`通过 14:12` mono。
- **设计稿** `596,40`(全屏唯一呼吸):`grad #FFFFFF→#FCFBF8;border:1px rgba(87,91,196,.5);shadow …,0 10px 28px rgba(87,91,196,.13),inset…`;外呼吸环 `inset:-2px;r16;annaBreath 2.4s`;设计·Agent·Design;状态「执行中」`shimmerInk 5s`;状态点 #575BC4 圆内空心环;**底部微光条** `left/right:13px;bottom:0;h2.5px;grad transparent→#B7B9E8 30%→#575BC4 55%→transparent 85%;bg-size:220%;barSweep 2.2s`。左桩 #575BC4/右桩灰。
- **技术预研** `596,200`:工程·Andy(`rgba(120,120,128,.16)`)·✓。
- **设计评审 ◇**(门)`830,105 w52`:菱形 `bg rgba(255,255,255,.55);border:1px dashed rgba(35,35,40,.18)`;「审」#A3A3A8;标签灰;下挂两审阅头像 B+A(14px,opacity.6)。
- **实施** `20,420`:虚线卡·工程·Andy(op.6)·「待就绪」#A3A3A8·虚线空心状态圈;3 桩(上 left110/右/下 left110)。
- **代码评审 ◇**(门)`326,429 w52`:虚线菱形「审」#A3A3A8,仅标签。
- **验收合并** `424,420`:虚线卡·验收·Boss(op.5)·待就绪·左桩。
- **性能验收:50 节点** `300,548`(新生长):虚线卡·验收·Andy(op.6)·待就绪;**溯源行**(上 `1px dashed rgba(35,35,40,.10)`):分支图标 #575BC4 +「由频道生长 · #a1283」mono `9px #A3A3A8`;上桩 left90。

**边**(SVG 1200×660):需求→PRD起草 `M212 128 H432` 实线 `rgba(35,35,40,.30)1.5`;PRD起草→PRD评审 `H486` 实;**PRD评审→设计稿** `M556 128 C…592 72` **虚线流动** `rgba(87,91,196,.55)1.75;dasharray 5 7;dashFlow 1.1s`(**全图唯一流动=供电边**);PRD评审→技术预研 `…592 232` 实;设计稿→设计评审 `M784 72…819 128` 虚 `rgba(35,35,40,.18)dash 5 4`;技术预研→设计评审 `M784 232…` 实;设计评审→实施 `M856 160 C856 320 114 240 114 414` 虚(折返第 2 行);实施→代码评审 `M208 452 H315` 虚;代码评审→验收合并 `H418` 虚;实施→性能验收 `M114 487 C…394 542` 虚。
**图例/控件**:左下 缩放条(−/`90%`/+ 白底 r999 shadow + 全屏图标)+ mono「节点 7 · 门 3 · 2 行」;右下「图例」pill(条形图标)+ mono「同步 14:26:12 · 轮询 3s」。

## 5. 频道列(328px)
**头部 46px**:`padding:0 16px`;Anna 叶标 + `项目频道 13px/600` + mono `Anna 主持` + 展开图标。**编年脊线**:`position:absolute;left:23px;top:14px;bottom:8px;width:1px;bg rgba(35,35,40,.08)`;每条消息 `padding-left:26px`,时间轴节点在 left:0 处以 `15px 方块 bg#F8F7F3` 盖住脊线(叶标/头像)。消息间 `gap:8px`。署名:Anna=`Noto Serif SC 12.5px/700 #575BC4`;Agent/人=`12px/600`(Scribe #7A3F93、Andy #232328);时间 mono `9.5px #A3A3A8`;`#a****` 编号 mono `9px #C6C6CB` 右对齐;正文 `12.3px/1.7 #3E3E44`。@chip:`@Boss`=`bg#EFEFFA #575BC4`,`@Agent·*`=`bg#EFE7F4 #7A3F93`,`r999;padding:0 6px;11px`。
消息序列(真文案):①Anna 13:02 #a1271「工作图已按 SOP 建好:6 任务·3 评审门,『设计稿』与『技术预研』并行。@Boss 请确认派工建议。」②Anna 14:02 #a1276「『PRD 评审』已驳回…@Agent·Scribe,节点转入返工。」+ 驳回引用块 `bg rgba(190,74,68,.06);r8;color#A14741`「验收标准缺『校验中』态的可测口径」。③Agent·Scribe 14:07 #a1277 + **附件卡**(`grad #FFFFFF→#FDFCF9;border rgba(35,35,40,.10);r12`):文档图标+「登录页重设计 PRD」+ `v2` + `1,318 字`;「已按批注补『校验中』的可测口径。」;两 pill「打开抽屉」「跳到节点」(定位图标)。④Anna 14:12 #a1279「『PRD 评审』通过——『设计稿』解锁。@Agent·Design 开始执行。」+ 内联「设计稿」pill。⑤Andy 14:18(**无 #a**)「验收标准建议补一条:画布 50 节点内平移缩放不掉帧。@Boss」。⑥Anna 14:20 #a1283 **任务草案卡**(`border rgba(87,91,196,.30);r12`):头「＋任务 · Anna 起草 #575BC4」+「已确认·已下推」绿勾 #2E7A64;标题「性能验收:50 节点流畅度」;「建议:Andy · 依赖『实施』· 验收:1440×900 平移缩放 60fps」;pill「跳到新节点」+ mono「audit 可溯」。⑦Anna 14:26 #a1284「报销 SGD 182.40 已到「审批」步。@Boss」。
**composer**(`padding:10px 14px 12px`,上边线):输入框 `bg#FFF;border rgba(35,35,40,.12);r12;padding:7px 12px`,占位「说点什么…」`12.3px #A3A3A8` + 纸飞机 #575BC4;右侧两枚 28px 圆钮(光圈/定位 icon + 加号),均 `border rgba(35,35,40,.12);r999`。

# 1b 项目详情三区 · 深色(非反相,814-1215)

## 6. token 级差异(相对 1a)
- **外框**:`bg linear-gradient(180deg,#18181B,#151518)`;边 `rgba(255,255,255,.08)`;阴影 `…rgba(0,0,0,.3),0 28px 70px rgba(0,0,0,.45)`。
- **底/卡面**:画布底 `linear-gradient(180deg,#1B1B20 0%,#17171A 46%,#121215 100%)`;完成卡 `#1E1E22→#1B1B1F` `border rgba(255,255,255,.06)`;待就绪卡 `bg rgba(255,255,255,.025);border dashed rgba(255,255,255,.15)`;头部/健康条条面 `#232328→#1E1E22`。
- **文字**:主 `#ECECF0`,次 `#A8A8B0`,弱 `#74747C`,极弱/编号 `#4A4A52`;正文 `#C9C9D0`。
- **iris 亮化 #8B8ED9**(替 #575BC4);辅色深化:绿 `#58B79A`、紫 `#CDA3E0`/点 `#B87FD4`、金 `#D6AA5A`、terracotta `#D96A63`、暖橙 chip `#D8B382`。角色点:产品 #7B7EC0。
- **网格/辉光**:格线 `rgba(139,142,217,.055)`;微点 `rgba(255,255,255,.06)`;辉光 A `rgba(139,142,217,.075)`、B `rgba(166,153,111,.07)`;白纱 `rgba(255,255,255,.045)…90px`;工作框 `border rgba(139,142,217,.10)` 角标 `rgba(139,142,217,.4)`。
- **侧栏/健康条**:侧栏 `bg rgba(26,26,30,.85)`;Crew 选中 `bg#2A2A30`;项目选中 `bg rgba(139,142,217,.14)`;侧栏各 badge #8B8ED9(字 #17171A)。头像堆边 `2px solid #232328`,Agent 头像 `bg rgba(184,127,212,.18) 图标#CDA3E0`。连接桩底色 `#232328`(替 #FFFFFF)。

**场景差异(评审时刻 T2 16:42,无 Agent 执行)**:
- **健康条**:进度第 4 段 `bg rgba(139,142,217,.65);border:1px #8B8ED9`;mono「进度 3/7 · **待审 1**」;**「Agent 执行中」chip 消失**(计数 0),仅剩「等我处理 · 2」(`bg rgba(214,158,90,.13);#D8B382`)。
- **设计稿节点** `596,40`:加 `v1` 徽章(#8B8ED9);状态「**待审**」#B0B3E4;状态形改为 `16px 菱形 rotate45 border 1.5px #8B8ED9`;卡 `border rgba(139,142,217,.5);shadow …0 10px 28px rgba(139,142,217,.09)`——**无呼吸环、无 barSweep**(静止);右桩 #8B8ED9。
- **设计评审门(金门)** `830,105`:菱形 `bg#232328;border:1.5px #A6996F`,`animation:goldPulseDark 4s`(**全屏唯一动静**);「审」#C4B58C;标签 `#ECECF0/600`;mono「**待审 · 双人**」#C4B58C;审阅头像 B+A(14px,**无 opacity**=激活)。
- **供电边转移**:亮 iris 边改为 **设计稿→设计评审** `M784 72…819 128` `rgba(139,142,217,.7)1.75`(**亮但不流动**,无 dash 无动画);其余边 `rgba(255,255,255,.30)` 或虚线 `rgba(255,255,255,.16)`。
- **PRD 评审门**:绿 `border rgba(88,183,154,.55)`,勾 #58B79A,「通过 14:12」。
- **画布底栏**:缩放条 `bg#232328`;「节点 7·门 3·2 行」;右下**仅** mono「同步 16:42:08 · 轮询 3s」(**无「图例」pill**)。

**频道(1b)**:`bg rgba(30,30,34,.75)`;脊线 `rgba(255,255,255,.07)`;消息 `gap:14px`。序列:①Anna 14:12 #a1279「『PRD 评审』通过——『设计稿』解锁。@Agent·Design 开始执行。」②Agent·Design 16:40 #a1291 **附件卡**(`grad #232328→#1E1E22;border rgba(255,255,255,.09)`):「登录页视觉稿」+`v1`;「3 屏 · 空/校验中/错误三态真图。@Boss @Andy 请审。」③Anna 16:40 #a1292 **评审卡**(`border rgba(166,153,111,.5)` 金):金菱形章(15px,border #A6996F,审 #C4B58C)+「评审卡 · 设计评审」+ mono「对象 · 视觉稿 v1」;「验收:空/校验中/错误三态真图各一 · 暖 terracotta 口径」;双动作钮「**通过**」(`bg rgba(88,183,154,.14);#58B79A;border rgba(88,183,154,.35)`+勾)与「**驳回＋批注**」(`bg rgba(217,106,99,.12);#D96A63;border rgba(217,106,99,.35)`);mono「就地驱动状态机」。④Boss 16:42(**无 #a**)**米白纸面气泡**(`bg#EFEDE5;r12;墨字#232328`=签名件):「我先看三态真图,Andy 看性能口径,老规矩。」⑤Anna 14:26 #a1284「Andy 的差旅报销(SGD 182.40)已到「审批」步。@Boss 收件箱可直达。」
**composer(1b)**:输入框 `bg#232328;border rgba(255,255,255,.12);r12;padding:8px 12px`,占位 #74747C + 纸飞机 #8B8ED9;下方两 pill「@ 成员」「＋任务」(`border rgba(255,255,255,.12);#ECECF0`)+ mono「Ctrl+Enter 发送」#4A4A52(与 1a 圆钮布局不同,**以 1b 为准实现 composer 双 pill + Ctrl+Enter 提示**)。

## 7. 全部标注/注释文本(设计师意图,全文保留)
- 1a 标题行:`项目详情 · 三区(浅色)`;副 mono:`1440×900 · 时刻 T 07-17 14:26 · Boss 视角 · 设计稿执行中(全屏唯一呼吸)`。
- **1a 底注**:`画布 90% · elkjs 分层 DAG:『设计稿』∥『技术预研』纵向并行,主链过『设计评审』后折返第二行——不再是一条长队 · 画布=制图桌:纸面渐变 + 110px 主格线×22px 微点双尺网格(四缘羽化)+ 灯下白纱 + 双辉光 + inset 工作框与四角规矩线,画布因此有"景深",节点浮其上 · 全图唯一流动=供电边流入执行中的『设计稿』· #a 编号=audit 可溯`
- 1b 标题行:`项目详情 · 三区(深色 · 非反相)`;副 mono:`时刻 T2 07-17 16:42 · 评审时刻 · 无 Agent 执行 = 无呼吸(不装忙) · 金线:活跃评审门(全屏唯一)`。
- **1b 底注**:`深色非反相:底 #17171A / 卡面 #232328→#1E1E22 / iris 亮化 #8B8ED9 · Boss 的话=米白纸面+墨字(签名件) · 评审时刻全画布静止——唯一动静=活跃金门 4s 缓脉(等人,不装忙) · 待审『设计稿』=薰衣草描边+菱形章,其供电边亮 iris · 无执行 Agent=无呼吸、无流动`

**关键动画名**:`annaBreath`(节点呼吸环)、`barSweep`(执行微光条)、`shimmerInk`(「执行中」字)、`dashFlow`(供电边流动)、`auroraDrift`/`auroraDrift2`(双辉光)、`goldPulseDark`(1b 金门 4s 缓脉)。
