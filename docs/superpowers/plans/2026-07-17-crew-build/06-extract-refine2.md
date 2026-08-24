# 06 · 精修二轮设计稿提取(3a–3k)

## 提取纪律
本文件逐像素提取自 `docs/design/2026-07-17-crew-return/Crew-组织协同-设计稿 v2.dc.html`(NEW 版,451738 B / 3542 行)第三轮新增区 `#3a`–`#3k`(NEW 行 49–1584)。**零发明**:所有色值 / 尺寸 / 缓动均逐字抄自该文件的内联 style;凡与《设计说明-Crew增补.dc.html》数字不符者标 `[冲突]` 并两值并列。任何取舍 / 折中 / 落地偏差属开发计划(07-refine2-devplan.md),不在本文件。文中所有值可直接 Ctrl-C,工程无需再开 441KB 源文件。

**全局 token 速查(本轮无新增主色,全部既有 token 派生)**
- iris 主色 `#575BC4`(浅)/ `#8B8ED9`(深);深压态 `#43478F`;lavender 提亮 `#8B8ED9`→`#B7B9E8`;iris-soft 底 `#EFEFFA`(浅)/ `rgba(139,142,217,.16)`(深)
- ok 绿 `#3E9C82`(浅)/ `#58B79A`(深);深文字 `#2E7A64` / `#7ECBB2`
- danger 红 `#BE4A44`(浅)/ `#D96A63`(深);深文字 `#A2352F` / `#E79089`
- gold 金 描边 `#CBBB8E`(浅)/ `#A6996F`(深);「审」金字 `#8A7B52`(浅)/ `#C9BC93`(深)
- delegate 紫(Agent)accent `#7A3F93`(浅)/ `#9C56B8`;主按钮紫 `#7A4FB0`;soft 底 `#EFE7F4`(浅)/ `rgba(156,86,184,.22)`(深);深文字 `#C89AD8`
- 职能点:产品 `#55589E` · 设计 `#9C56B8` · 工程 `#3E9C82` · 验收 `#B98A2F`
- ink 文字(浅):`#232328` / `#3E3E44` / `#6C6C72` / `#A3A3A8` / `#C6C6CB`;(深):`#ECECF0` / `#C4C4CC` / `#A8A8B0` / `#74747C` / `#5A5A62`
- 面板/纸面(浅):画布 `linear-gradient(180deg,#FCFBF8,#F2F0E9)`、卡 `#FBFAF7/#F7F6F1`、panel `#FAF9F5`、hairline `rgba(35,35,40,.06–.12)`;(深):画布 `#17171A`/`#141417`、卡 `#232328`/`#1D1D21`、panel `#1A1A1E`、hairline `rgba(255,255,255,.06–.12)`
- 字体:正文 `'Noto Sans SC'`;标题/署名 `'Noto Serif SC'`;数据/代码/时刻 `'JetBrains Mono'`

---

## 3a / 3b · R5 九节点整图(浅 / 深)

### 外层容器
- 尺寸:`width:1440px;height:640px;border-radius:20px;overflow:hidden;position:relative;display:flex;flex-direction:column`
- 浅底:`background:linear-gradient(180deg,#FCFBF8 0%,#F8F7F2 46%,#F2F0E9 100%);border:1px solid rgba(35,35,40,.10);box-shadow:0 2px 6px rgba(35,35,40,.06),0 28px 70px rgba(35,35,40,.13)`
- 深底:`background:#17171A;border:1px solid rgba(255,255,255,.08);box-shadow:0 2px 6px rgba(0,0,0,.3),0 28px 70px rgba(0,0,0,.5)`;画布区再叠 `linear-gradient(180deg,#1B1B1F,#161619)`

### 健康条(顶栏,height:48px)
`display:flex;align-items:center;gap:14px;padding:0 22px;z-index:3`;浅 `background:linear-gradient(180deg,#FFFFFF,#FDFCF9);border-bottom:1px solid rgba(35,35,40,.08)`;深 `background:linear-gradient(180deg,#232328,#1E1E22);border-bottom:1px solid rgba(255,255,255,.08)`
- 项目名:`Noto Serif SC 15px/700`,浅 `#232328` / 深 `#ECECF0`
- 进度小格(6 枚,gap:3px):每格 `width:6px;height:15px;border-radius:2px`;色序 = ok/ok/iris/danger/空/空 →
  - 浅:`#3E9C82`,`#3E9C82`,`#575BC4`,`#BE4A44`,`rgba(35,35,40,.10)`,`rgba(35,35,40,.10)`
  - 深:`#58B79A`,`#58B79A`,`#8B8ED9`,`#D96A63`,`rgba(255,255,255,.12)`,`rgba(255,255,255,.12)`
  - 尾随 `进度 2/6`(mono 11px,浅 `#6C6C72` / 深 `#A8A8B0`)
- 「Agent 执行中 · 1」chip:`padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600`;浅 `background:rgba(87,91,196,.10);color:#43478F` + 8px 脉点 `#575BC4;animation:runPulse 2s ease-in-out infinite`;深 `background:rgba(139,142,217,.16);color:#B7B9E8` + 脉点 `#8B8ED9`
- 「阻塞 · 1」chip:`padding:4px 12px;border-radius:999px;font-size:12px`;浅 `background:rgba(190,74,68,.10);color:#A2352F` + 8px 静点 `#BE4A44`;深 `background:rgba(217,106,99,.16);color:#E79089` + 点 `#D96A63`
- 右侧 `flex:1` 撑开 + mono 10px 说明「健康条 ↔ 图 ↔ 频道活动行 · 三处同源同拍」(浅 `#A3A3A8` / 深 `#74747C`)

### 画布背景五层(`flex:1;position:relative;overflow:hidden`)
1. 主格线:`repeating-linear-gradient(0deg,<c> 0 1px,transparent 1px 110px)` × 同款 90deg;`<c>` 浅 `rgba(87,91,196,.05)` / 深 `rgba(139,142,217,.06)`;`mask-image:radial-gradient(120% 116% at 50% 46%,#000 52%,transparent 99%)`(四缘羽化)
2. 微点:`radial-gradient(<c> 1px,transparent 1.15px);background-size:22px 22px;background-position:11px 11px`;`<c>` 浅 `rgba(35,35,40,.065)` / 深 `rgba(255,255,255,.05)`;同款 mask
3. 顶辉(iris 光斑):`left:14%;top:-30%;width:60%;height:58%;border-radius:999px;background:radial-gradient(closest-side,<c>,transparent 70%);filter:blur(64px);animation:auroraDrift 30s ease-in-out infinite`;`<c>` 浅 `rgba(87,91,196,.08)` / 深 `rgba(139,142,217,.14)`
4. 底辉(gold 光斑):`right:-14%;bottom:-28%;width:48%;height:52%;...;animation:auroraDrift2 40s ease-in-out infinite`;`<c>` 浅 `rgba(203,187,142,.09)` / 深 `rgba(166,153,111,.12)`
5. 内框:`inset:10px;border:1px solid <c>;border-radius:14px`;浅另加 `box-shadow:inset 0 1px 0 rgba(255,255,255,.6)`;`<c>` 浅 `rgba(87,91,196,.09)` / 深 `rgba(139,142,217,.12)`

### 任务节点卡(整图内 `width:172px`)
基础卡:`position:relative;border-radius:14px;padding:11px 13px 10px 16px;overflow:hidden;transition:transform .18s,box-shadow .18s`(左 padding 16px 让位色条)
- hover:`transform:translateY(-2px);box-shadow:0 10px 26px rgba(35,35,40,.10)`
- 左缘色条(书脊):`position:absolute;left:0;top:0;bottom:0;width:5px;background:<状态色>;border-radius:14px 0 0 14px`
- 卡内布局:标题行(标题 `13.5px` + 可选版本 pill + 职能点 mono 8.5px)、`margin-top:9px` 署名行(头像 16px + 名 11px + 状态词 mono 9.5px + 右「章」20px)
- 头像形状规则:**人=圆 `border-radius:999px`,Agent=方圆角 `border-radius:5px`**(16px);阻塞卡底另加卡点行

**七态卡样(3a 快照实见 4 态,完整 7 态见 3c)**

| 态 | 色条(浅/深) | 卡面染(浅/深) | 边框 | 标题色/重 |
|---|---|---|---|---|
| 完成 | `#3E9C82`/`#58B79A` | `linear-gradient(180deg,#FBFAF7,#F7F6F1)`(沉入面板)/ `#1D1D21` | 浅 `1px rgba(35,35,40,.08)` / 深 `1px rgba(255,255,255,.08)` | `#6C6C72`(浅)/`#A8A8B0`(深)· 600 |
| 执行中(焦点跑) | `#575BC4`/`#8B8ED9` | 浅 `linear-gradient(180deg,rgba(87,91,196,.055),rgba(87,91,196,.02)),linear-gradient(180deg,#FFFFFF,#FCFBF8)` / 深 `linear-gradient(180deg,rgba(139,142,217,.12),rgba(139,142,217,.04)),#232328` | strokeFlow 描边(见下) | `#232328`/`#ECECF0` · 600 |
| 阻塞 | `#BE4A44`/`#D96A63` | 浅 `linear-gradient(180deg,rgba(190,74,68,.08),rgba(190,74,68,.04)),linear-gradient(180deg,#FFFFFF,#FDFCF9)` / 深 `linear-gradient(180deg,rgba(217,106,99,.14),rgba(217,106,99,.05)),#232328` | 浅 `1px rgba(190,74,68,.55)` + `box-shadow:0 8px 22px rgba(190,74,68,.12)` / 深 `1px rgba(217,106,99,.55)` + `0 8px 22px rgba(0,0,0,.4)` | `#232328`/`#ECECF0` · 600 |
| 待就绪(休眠) | `rgba(35,35,40,.12)`/`rgba(255,255,255,.1)` | 浅 `rgba(255,255,255,.45)` / 深 `rgba(255,255,255,.02)` | `1px dashed rgba(35,35,40,.16)` / `1px dashed rgba(255,255,255,.14)` | `#6C6C72`/`#A8A8B0` · 500 |

- 执行中节点 **strokeFlow 描边流光**(伪层,叠在卡上,`position:absolute;inset:-1.5px;border-radius:15px;padding:1.5px;pointer-events:none`):
  - 浅:`background:linear-gradient(115deg,#575BC4,#8B8ED9,#B7B9E8,#8B8ED9,#575BC4)`
  - 深:`background:linear-gradient(115deg,#8B8ED9,#B7B9E8,#6E72C0,#B7B9E8,#8B8ED9)`
  - 共通:`background-size:300% 100%;animation:strokeFlow 4.5s linear infinite;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude`
  - 卡本体另加 box-shadow 浅 `0 1px 2px rgba(35,35,40,.04),0 10px 28px rgba(87,91,196,.14)` / 深 `0 10px 28px rgba(0,0,0,.45)`
  - 执行中卡左侧另有连线端口点:`left:-4px;top:32px;width:9px;height:9px;border-radius:999px;background:#575BC4/#8B8ED9;border:2px solid #FCFBF8/#161619;box-shadow:0 0 0 2px rgba(87,91,196,.25)/rgba(139,142,217,.3)`
- 执行中章:`20px;border-radius:999px;background:#575BC4/#8B8ED9;box-shadow:0 0 0 3px rgba(87,91,196,.16)/rgba(139,142,217,.2)`,内套 `7px` 白/深环
- 阻塞卡点行:`font-size:10.5px;margin-top:8px;padding-top:7px;border-top:1px dashed rgba(190,74,68,.22)/rgba(217,106,99,.28);color:#A2352F/#E79089`,文「卡点:测试库权限未开通」;阻塞章 20px 实心 danger + 白/深叹号 + `box-shadow:0 1px 3px rgba(190,74,68,.4)`
- 完成章:20px 实心 ok + 白/深勾;待就绪章:20px `border:1.5px dashed rgba(35,35,40,.22)/rgba(255,255,255,.22)` 空环
- 版本 pill(如 `v2`):`mono 9px;border:1px solid rgba(35,35,40,.10)/rgba(255,255,255,.12);border-radius:999px;padding:0 5px`

### 门节点(◇ 菱形,3a/3b 实见 2 态)
- **已通过**:`width:48px;height:48px;transform:rotate(45deg);border-radius:9px`;浅 `background:linear-gradient(135deg,#FFFFFF,#FBFAF6);border:1.5px solid rgba(62,156,130,.6)` / 深 `background:linear-gradient(135deg,#232328,#1E1E22);border:1.5px solid rgba(88,183,154,.6)`;内 ok 勾 16px(`transform:rotate(-45deg)`);标签「PRD 评审 ◇」10.5px + 「通过 14:12」mono 9px
- **待就绪(休眠)**:`width:44px;height:44px;transform:rotate(45deg);border-radius:8px`;浅 `background:rgba(255,255,255,.5);border:1.5px dashed rgba(35,35,40,.2)` / 深 `background:rgba(255,255,255,.03);border:1.5px dashed rgba(255,255,255,.2)`;内 serif「审」12px `#A3A3A8/#74747C`;标签「设计评审 ◇」+ 「待就绪」
- **活跃·金线**态见 3c(整图快照未含活跃门)

### 边 · 四型(SVG viewBox `0 0 1440 592`)
| 型 | 浅 | 深 |
|---|---|---|
| 已通电(实线) | `stroke:rgba(35,35,40,.32);stroke-width:1.75` | `stroke:rgba(255,255,255,.28);stroke-width:1.75`(曲线段 `.30/.24`) |
| 休眠(虚线) | `stroke:rgba(35,35,40,.16);stroke-width:1.5;stroke-dasharray:5 4` | `stroke:rgba(255,255,255,.14);stroke-width:1.5;stroke-dasharray:5 4` |
| 焦点流动 | `stroke:#575BC4;stroke-width:1.9;stroke-dasharray:5 7;animation:dashFlow 1.1s linear infinite`(叠在灰实线上) | `stroke:#8B8ED9;...` 同 |
| danger 边(去阻塞节点) | `stroke:rgba(190,74,68,.55);stroke-width:1.75` | `stroke:rgba(217,106,99,.6);stroke-width:1.75` |

### 焦点呼吸 vs 非焦点执行(强度阶梯,红线修订)
- 整图内执行中节点用 **strokeFlow 描边(状态层)**,可多节点同屏;3a 快照中「设计稿」= 唯一执行节点,示描边流光,**未叠呼吸**(此快照无「当下焦点」呼吸态)。呼吸(annaBreath,注意力层)全屏唯一、强度高于流光,专属于最近一次 transition 的焦点节点(见 3d)。
- caption(3a):PRD 已过 → 设计稿在跑 ∥ 技术预研卡权限阻塞 → 下游休眠;此为真实可达态。
- caption(3b):深色非反相 —— 底 `#17171A`、卡 `#232328`、iris `#8B8ED9`、danger `#D96A63`、ok `#58B79A`,色条/章语义位与浅色 1:1。

---

## 3c · 七态 + 门 全家福(权威态表)

**节点标注口径(3c 表头)**:`200×64 · r14 · 左缘 5px 色条 · 章 20px · 标题 13.5/600`
`[冲突]` 节点宽:全家福标注 `200×64`;整图实测 `width:172px`;《设计说明》§三 `宽 188,min-h 66`。三值并存,落地取一见 devplan。
`[冲突]` 章尺寸:稿(3a/3c 整图与全家福)`20px`;《设计说明》§三「右侧章 16px」。

### 七态 · 浅色(每态:色条 / 卡面 / 边框 / 章形 / 状态词)
| # | 态 | 色条 | 卡面 | 边框 | 章(近读层,色盲靠形状) | 状态词色 | 动效 |
|---|---|---|---|---|---|---|---|
| 01 | 待就绪 | `rgba(35,35,40,.12)` | `rgba(255,255,255,.45)` | `1px dashed rgba(35,35,40,.16)` | 20px `border:1.5px dashed rgba(35,35,40,.25)` 虚环 | `#A3A3A8`(待就绪) | 无 · 退后 |
| 02 | 就绪待认领 | `#575BC4` | `linear-gradient(180deg,#FFFFFF,#FDFCF9)` | `1px solid rgba(35,35,40,.12)` + `box-shadow:0 1px 2px rgba(35,35,40,.04)` | 20px `border:1.5px solid #575BC4` + iris 加号 | `#575BC4`(就绪/待认领) | 无 |
| 03 | 执行中 | `#575BC4` | `linear-gradient(180deg,rgba(87,91,196,.055),rgba(87,91,196,.02)),linear-gradient(180deg,#FFFFFF,#FCFBF8)` + `box-shadow:0 6px 18px rgba(87,91,196,.12)` | strokeFlow 描边(`inset:-1.5px;r15;padding:1.5px`,5 色见 3a) | 20px 实心 `#575BC4` + `box-shadow:0 0 0 3px rgba(87,91,196,.16)` 内 7px 白环 | `#575BC4/600`(执行中) | strokeFlow · **强度<呼吸** |
| 04 | 已提交待审 | `#8B8ED9`(薰衣草) | `linear-gradient(180deg,#FFFFFF,#FDFCF9)` | `1px solid rgba(139,142,217,.6)` + `0 1px 2px rgba(35,35,40,.04)` | **菱形空章** 18px `transform:rotate(45deg);border-radius:5px;border:1.5px solid #8B8ED9`(呼应门◇) | `#7A7DC7`(待审) | 无;版本 pill `v1`(`color:#575BC4;background:#EFEFFA`) |
| 05 | 阻塞 | `#BE4A44` | `linear-gradient(180deg,rgba(190,74,68,.08),rgba(190,74,68,.04)),linear-gradient(180deg,#FFFFFF,#FDFCF9)` + `box-shadow:0 6px 18px rgba(190,74,68,.1)` | `1px solid rgba(190,74,68,.55)` | 20px 实心 `#BE4A44` + 白叹号 + `box-shadow:0 1px 3px rgba(190,74,68,.4)` | `#BE4A44/600`(阻塞) | 洗色(最刺眼);卡点行 `#A2352F` 10px + `border-top:1px dashed rgba(190,74,68,.22)` |
| 06 | 返工 | `#BE4A44` | `linear-gradient(180deg,#FFFFFF,#FDFCF9)`(**无洗色**) | `1px solid rgba(190,74,68,.4)`(细边) + `0 1px 2px rgba(35,35,40,.04)` | 20px `border:1.5px solid #BE4A44` + **回环**图标 | `#BE4A44`(返工) | 无;版本 pill `v1→v2`(`color:#BE4A44;background:rgba(190,74,68,.08)`) |
| 07 | 完成 | `#3E9C82` | `linear-gradient(180deg,#FBFAF7,#F7F6F1)`(沉入面板色) | `1px solid rgba(35,35,40,.08)` | 20px 实心 `#3E9C82` + 白勾 | `#A3A3A8`(完成);标题 `#6C6C72/600` | 无(墨迹已干) |

章形七款(色盲安全)= 虚环 / 加号 / 实心 / 菱形 / 叹号 / 回环 / 勾。三层语义:左缘色条=远读层、章=近读层、轻染=氛围层,任一层单独成立。

### 七态 · 深色(全家福右侧 `#17171A` 面板,卡 r12、色条 4px、padding `9px 10px 8px 13px`)
| # | 态 | 色条 | 卡面 | 边框 | 状态词色 |
|---|---|---|---|---|---|
| 01 待就绪 | `rgba(255,255,255,.1)` | `rgba(255,255,255,.02)` | `1px dashed rgba(255,255,255,.14)` | `#74747C` |
| 02 就绪 | `#8B8ED9` | `#232328` | `1px solid rgba(255,255,255,.12)` | `#B7B9E8` |
| 03 执行中 | `#8B8ED9` | `linear-gradient(180deg,rgba(139,142,217,.12),rgba(139,142,217,.04)),#232328` | strokeFlow(`inset:-1.2px;r13;padding:1.2px`,深 5 色) | `#B7B9E8` |
| 04 待审 | `#B7B9E8` | `#232328` | `1px solid rgba(139,142,217,.55)` | `#B7B9E8`(菱形章 `border:1.5px solid #B7B9E8`) |
| 05 阻塞 | `#D96A63` | `linear-gradient(180deg,rgba(217,106,99,.14),rgba(217,106,99,.05)),#232328` | `1px solid rgba(217,106,99,.55)` | `#E79089` |
| 06 返工 | `#D96A63` | `#232328` | `1px solid rgba(217,106,99,.4)` | `#E79089` |
| 07 完成 | `#58B79A` | `#1D1D21` | `1px solid rgba(255,255,255,.06)` | `#74747C` |

### 门 ◇ 三态
| 态 | 全家福浅(legend) | 整图浅(canvas) | 深(legend) | 备注 |
|---|---|---|---|---|
| 待就绪 | `38×38 r7`;`background:rgba(255,255,255,.5);border:1.5px dashed rgba(35,35,40,.2)`;「审」11px `#A3A3A8` | `44×44 r8` dashed | `26×26 r6`;`rgba(255,255,255,.03);border:1.5px dashed rgba(255,255,255,.2)` | 退后 |
| **活跃·金线** | `44×44 r8`;`background:linear-gradient(135deg,#FFFDF8,#FBF6EA);border:1.5px solid #CBBB8E;animation:goldPulse 4s ease-in-out infinite`;「审」12px `#8A7B52/700` | (44→48 加重) | `30×30 r7`;`background:rgba(166,153,111,.14);border:1.5px solid #A6996F;animation:goldPulseDark 4s ease-in-out infinite`;「审」`#C9BC93/700` | 金线 + 金脉 = 关卡仪式 |
| 已通过 | `38×38 r7`;`background:linear-gradient(135deg,#FFFFFF,#FBFAF6);border:1.5px solid rgba(62,156,130,.6)`;ok 勾 13px | `48×48 r9` ok 勾 | `26×26 r6`;`#232328;border:1.5px solid rgba(88,183,154,.6)`;勾 `#58B79A` | 落章 |

`[冲突/变体]` 门尺寸随语境:全家福 legend `38/44/38`,整图 canvas `44/44/48`,3c 说明文 + 《设计说明》§三/§八 canonical 「44→48」(常态 44,活跃 48)、`r8`。落地取 canonical 44→48。
goldPulse 光晕:浅 `0 0 0 4px rgba(203,187,142,.12)`↔`0 0 0 8px rgba(203,187,142,.22)`;深 `rgba(166,153,111,.10)`↔`rgba(166,153,111,.18)`(4→8px,与《设计说明》金门缓脉一致)。

### 边 · 四型(3c 图示,对比拉大)
- 已通电:实线 `rgba(35,35,40,.32)` / `1.75px` + 终点港点 `r2.8 rgba(35,35,40,.4)`
- 休眠:`rgba(35,35,40,.16)` / `1.5px;dasharray:5 4` + 港点 `r2.5 rgba(35,35,40,.18)`
- 焦点流动:`#575BC4` / `1.9px;dasharray:5 7;animation:dashFlow`(dashFlow=`to{stroke-dashoffset:-24}`)+ 港点 `#575BC4`
- 返工回路:`#BE4A44` / `1.4px;dasharray:3 3` 上弧 + 箭头;**驳回时画入,通过后消隐(不留疤)**

深色 reduced-motion 注(3c 面板脚注):流光冻结为静态 iris 描边 · 呼吸→静态章 · 门金线保留。

---

## 3d · R2 运行时存在感

### 动效双层制账本(逐行抄自 3d 右侧表,4 列 `88px 1fr 88px 96px`)
| 层级 | 动效 / 缓动 | 强度 | 允许数量 |
|---|---|---|---|
| 注意力层 | 呼吸 · `2.4s ease-out ∞` | 晕 `0→7px` | 全屏唯一 |
| 状态层 | 描边流光 · `4.5s linear ∞` | `1.5px 边` | 多节点同屏 |
| 频道 | 活动行脉点 · `2s ease` | `.45→1` | 每 run 一行 |
| 降级 | reduced-motion 冻结 | 静态 | 徽记代替 |

强度阶梯:**呼吸 > 流光 > 脉点**,确保焦点始终唯一。

### strokeFlow 技法(执行中描边——逐字)
- keyframes:`@keyframes strokeFlow{0%{background-position:0% 50%;}100%{background-position:300% 50%;}}`
- 技法 = **渐变盒 + 遮罩挖空法**:一层比卡略大的伪盒(`position:absolute;inset:-1.5px;border-radius:15px;padding:1.5px;pointer-events:none`),铺 3× 宽横向渐变(`background-size:300% 100%`),靠 `strokeFlow` 平移 `background-position`(0%→300%)让渐变横向流动;用 `-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude` 挖掉内容区,只留 1.5px 描边环。**非** border-image、**非** 进度环。
- 浅渐变 `linear-gradient(115deg,#575BC4,#8B8ED9,#B7B9E8,#8B8ED9,#575BC4)`;深 `linear-gradient(115deg,#8B8ED9,#B7B9E8,#6E72C0,#B7B9E8,#8B8ED9)`
- 缓动 `4.5s linear infinite`;演示卡本体浅底 `linear-gradient(180deg,rgba(87,91,196,.055),rgba(87,91,196,.02)),#FFFFFF`

### 焦点呼吸(annaBreath)
- keyframes(既有):`@keyframes annaBreath{0%{box-shadow:0 0 0 0 rgba(87,91,196,.32);}70%{box-shadow:0 0 0 7px rgba(87,91,196,0);}100%{box-shadow:0 0 0 7px rgba(87,91,196,0);}}`(深 annaBreathDark:`rgba(139,142,217,.38)`→`0`)
- 用法:卡后一枚独立层 `position:absolute;left:0;right:0;top:6px;bottom:6px;border-radius:14px;animation:annaBreath 2.4s ease-out infinite;pointer-events:none`;焦点卡本体 `border:1px solid rgba(87,91,196,.5);box-shadow:0 6px 18px rgba(87,91,196,.12)`
- 演示三档:① 焦点呼吸(注意力层·全屏唯一·晕环 0→7px)② 执行流光(状态层·可多节点·1.5px 边 iris→薰衣草)③ reduced-motion(降级·静态·iris 描边 + 徽记 `border:1.5px solid #575BC4`,状态用小 pill「执行中」代替动效)

### runPulse(频道/健康条脉点)
- keyframes:`@keyframes runPulse{0%,100%{opacity:.45;}50%{opacity:1;}}`;用法 `animation:runPulse 2s ease-in-out infinite`,8px(健康条)/7–8px(活动行)圆点

### 频道「正在执行」活动行(exact layout)
- 行容器:`width:520px;position:relative;padding-left:28px`;编年脊线 `position:absolute;left:7px;top:2px;bottom:2px;width:1px;background:rgba(35,35,40,.08)`
- 结点(Agent 图标):`left:1px;top:2px;width:14px;height:14px;border-radius:5px;background:#EFE7F4;border:2px solid #FFFFFF`(方圆角=Agent)
- 抬头行:`Agent·Scribe 12px/600 #7A3F93` + 时刻 `mono 9.5px #A3A3A8`(16:38) + 右 `mono 9px #C6C6CB`「#a1288 · activity」
- 「正在执行」pill(`margin-top:6px`):`inline-flex;gap:9px;background:linear-gradient(90deg,rgba(87,91,196,.09),rgba(87,91,196,.02));border:1px solid rgba(87,91,196,.28);border-radius:999px;padding:6px 14px`
  - 脉点 8px `#575BC4;animation:runPulse 2s` + 「正在执行」12px `#3E3E44` + 任务 chip(白底 999 pill,齿轮 icon +「PRD 起草」)+ 竖分隔 `1px×12px` + elapsed `mono 11px #575BC4/600`「已运行 00:24」
  - **elapsed 格式 = `已运行 MM:SS`**(前端本地推进,后端起跑时刻校准)
- **完成后**:此行消隐,由**产物卡接棒**(`cardRise` 入场):`border:1px solid rgba(35,35,40,.1);border-radius:12px;padding:9px 11px;box-shadow:0 1px 2px rgba(35,35,40,.04);animation:cardRise .5s cubic-bezier(.2,0,0,1) both`;内含文件 icon(24px `#EFEFFA`)+「PRD-登录页重设计」12px/600 + `mono 9px`「v2 · 2,005 字 · 交付于 00:31」+「全幅阅读」999 pill
  - `@keyframes cardRise{0%{opacity:0;transform:translateY(10px) scale(.98);}100%{opacity:1;transform:translateY(0) scale(1);}}`
- 深色活动行:pill `background:rgba(139,142,217,.12);border:1px solid rgba(139,142,217,.3)`;文「正在执行『PRD 起草』」`#ECECF0`;elapsed `#B7B9E8 mono 10.5px`「00:24」;脉点 `#8B8ED9`

### 健康条 · 三处同源同拍
- 0 running:`background:rgba(120,120,128,.09);color:#A3A3A8;padding:5px 13px;border-radius:999px`「活跃 Agent 0」+ 静点 `rgba(35,35,40,.2)`(无脉动)+ 副「无 running」
- 1 running:`background:rgba(87,91,196,.1);color:#43478F/600`「活跃 Agent 1」+ 脉点 `#575BC4;animation:runPulse 2s` + 副「running 点亮」`#575BC4`
- 同一「在飞」信号驱动三处:图上流光节点、频道活动行、健康条计数——同源、同拍、同生同灭。计数为零的 chip 直接隐藏。

### 红线 · 动效不撒谎
选「流光」非「进度环」:后端只给「在飞」信号(run 状态 + 起跑时刻),无确定进度%;流光只说「活着」,不谎报百分比;状态一变动效即撤。elapsed 前端本地推进、后端时刻校准。工程半:快照增「在飞 run 信号 + 起跑时刻」字段,三处同订阅。

### reduced-motion 变体
`@media (prefers-reduced-motion: reduce){*{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important;}}`(既有全局规则,非本轮新增)。语义降级:流光→静态 iris 描边 + 徽记;呼吸→静态章;门金线保留。

---

## 3e / 3f · R1 产物阅读器(浅 / 深)

### 整体(`width:1440px;height:900px;border-radius:20px;display:flex`)
浅 `background:linear-gradient(180deg,#F8F7F3,#F5F4EF)`;深 `background:#141417`。三列:图标轨(64)+ 阅读列(flex:1)+ 频道列(328)。

### 左图标轨(width:64px)
浅 `background:rgba(250,249,245,.82);backdrop-filter:blur(36px);border-right:1px solid rgba(35,35,40,.08)` / 深 `background:#1D1D21;border-right:1px solid rgba(255,255,255,.06)`;顶 Iris 双瓣 logo(浅瓣 `#575BC4`+`#B7B9E8` / 深 `#8B8ED9`+`#5E62A8`)、房/人/日历(激活项日历 `background:#EFEFFA` 浅 / `rgba(139,142,217,.16)` 深,icon iris)、`flex:1`、底 Boss 头像 30px 圆 `#55589E`。

### 阅读列顶栏(height:52px)
浅 `background:linear-gradient(180deg,#FFFFFF,#FDFCF9);border-bottom:1px solid rgba(35,35,40,.08)` / 深 `background:#232328;border-bottom:1px solid rgba(255,255,255,.07)`;`gap:10px;padding:0 22px`。内容左→右:
1. 「产物阅读器」+ 书本 icon,12.5px `#575BC4/#8B8ED9`
2. 分隔「|」
3. 面包屑:`登录页重设计 › PRD 起草 › PRD-登录页重设计`(前二 12.5px `#6C6C72/#A8A8B0`,末项 600 `#232328/#ECECF0`,chevron 11px)
4. **版本切换**:`v2 ⌄` pill —— `mono 10.5px;color:#575BC4;background:#EFEFFA;border:1px solid rgba(87,91,196,.2);border-radius:999px;padding:2px 9px;cursor:pointer`(深 `#B7B9E8;background:rgba(139,142,217,.16);border rgba(139,142,217,.28)`)
5. `flex:1`
6. **下载**:`padding:5px 12px;border:1px solid rgba(35,35,40,.12)/rgba(255,255,255,.12);border-radius:999px;font-size:12px` + 下载 icon `#6C6C72/#A8A8B0`
7. **回到图**:同款 pill + 「返回图」icon `#575BC4/#8B8ED9`
8. **ESC** 键徽:`mono 9.5px;border:1px solid rgba(35,35,40,.12)/rgba(255,255,255,.12);border-radius:6px;padding:2px 7px`(ESC 或「回到图」都回画布,阅读位置不丢)

### 阅读列正文(`max-width:780px;margin:0 auto;padding:0 40px`,外层 `padding:40px 0 30px`)
`[核对]` 阅读宽 780(在《设计说明》§八「720–820」区间内,无冲突)。markdown 排版沿 Iris 答复排版:
| 元素 | 规格(浅 / 深文字) |
|---|---|
| eyebrow | `mono 11px;letter-spacing:.14em;color:#A3A3A8/#74747C` |
| h1 | `Noto Serif SC 26px/900;line-height:1.4;margin:10px 0 0;color:#232328/#ECECF0` |
| h2 | `Noto Serif SC 17px/700;margin:26px 0 8px`(首个)/`24px 0 8px`;`color:#232328/#ECECF0` |
| 正文 p | `15px;line-height:1.85;color:#3E3E44/#C4C4CC;text-wrap:pretty`;`<b>` `#232328/#ECECF0` |
| ul/li | `margin:0 0 0 20px;15px;line-height:1.85;color:#3E3E44/#C4C4CC`;li `margin:3px 0` |
| 表格 | `border:1px solid rgba(35,35,40,.1)/rgba(255,255,255,.1);border-radius:12px;mono 11.5px`;列 `56px 108px 108px 1fr`;表头 `background:#FAF9F5/#1D1D21;color:#6C6C72/#A8A8B0`;单元 `padding:7px 10px` |
| 代码/口径块 | `background:#FAF9F5/#1D1D21;border:1px solid rgba(35,35,40,.08)/rgba(255,255,255,.08);border-radius:10px;padding:10px 14px;mono 12.5px;color:#3E3E44/#C4C4CC;line-height:1.7` |

### 阅读列页脚(height:38px,mono 行)
浅 `background:#FAF9F5;color:#6C6C72` / 深 `background:#1A1A1E;color:#74747C`;`mono 10.5px`:`v2 · 2,005 字 · 产出者 Agent·Scribe · 2026-07-20 16:31`,右侧 `#A3A3A8/#5A5A62`「审计血统 · markdown 沿 Iris 答复排版」(分点 `#C6C6CB/#4A4A52`)。

### 右频道列(width:328px)—— 对照评审关键:阅读器占画布,频道留右
- 头(52px):对话 icon + 「登录页重设计 · 频道」13.5px/600 + 右「对照中」mono 9.5px(深屏无「对照中」字)
- 时间线项(`padding:16px 16px 0;gap:14px`):
  - 产物 chip 项:`Agent·Scribe 11.5px/600 #7A3F93/#C89AD8` + 时刻;chip `border:1px solid rgba(87,91,196,.4)/rgba(139,142,217,.4);border-radius:11px;padding:8px 10px;box-shadow:0 2px 8px rgba(87,91,196,.1)`(深无阴影,`background:#232328`),内文件 icon 22px + 「PRD-登录页重设计」+「v2 · 2,005 字 · 阅读中」
  - **评审卡(Anna)** —— 阅读器开着时评审卡驻留频道:署名 `Anna Noto Serif SC 11.5px/700 #575BC4/#8B8ED9` + Iris 瓣结;卡 `border:1px solid rgba(203,187,142,.75)/rgba(166,153,111,.7);border-radius:12px;padding:10px 12px;box-shadow:0 2px 10px rgba(203,187,142,.14)`(深 `background:#232328`,金调)
    - 头:门◇小徽 15px `border:1.5px solid #CBBB8E/#A6996F` 内「审」+「评审卡 · PRD 评审」12px/600 + 右「对象 · v2」
    - 「全幅对照评审」当前行:`background:#EFEFFA/rgba(139,142,217,.14);border:1px solid rgba(87,91,196,.3)/rgba(139,142,217,.32);border-radius:8px;padding:6px 9px`,文 `#43478F/#B7B9E8 600` + 右「当前」mono 8.5px
    - 双动作按钮(`flex:1;border-radius:999px;padding:6px 0;font-size:11.5px/600`):**通过** `background:rgba(62,156,130,.1)/rgba(88,183,154,.14);color:#2E7A64/#7ECBB2;border:1px solid rgba(62,156,130,.4)/rgba(88,183,154,.4)` + ok 勾;**驳回＋批注** `background:rgba(190,74,68,.08)/rgba(217,106,99,.12);color:#BE4A44/#E79089;border:1px solid rgba(190,74,68,.4)/rgba(217,106,99,.4)`
- 频道 composer(底,`padding:12px 16px 16px`):`background:#FFFFFF/#232328;border:1px solid rgba(35,35,40,.12)/rgba(255,255,255,.12);border-radius:12px;padding:9px 12px`;占位「对 Boss / @成员 说…」12px `#A3A3A8/#74747C`;`mono 9px`「Enter 发送 · Shift+Enter 换行」+ 发送 24px `#575BC4/#8B8ED9`

深色注(3f caption):正文 `#C4C4CC` 落 `#1B1B1F` 底,长度到 780 上限;表格/代码块/页脚沿浅色规格给深值。

---

## 3g · R1 附件 chip 家族

### 产物附件 chip · 一行三动作(主件)
容器:`display:flex;align-items:center;gap:10px;background:linear-gradient(180deg,#FFFFFF,#FDFCF9);border:1px solid rgba(35,35,40,.1);border-radius:12px;padding:10px 12px;box-shadow:0 1px 3px rgba(35,35,40,.05);max-width:520px`(深 `background:#232328;border rgba(255,255,255,.1)`)
- 图标:`32px;border-radius:9px;background:#EFEFFA`(深 `rgba(139,142,217,.18)`)+ iris 文档 icon `#575BC4/#8B8ED9`
- 名:`13px/600 #232328/#ECECF0`(单行省略)
- 元:`mono 10px #A3A3A8/#74747C`「.md · v2 · 2,005 字」
- 三动作(靠右 `gap:6px`):
  1. **展开**(中性):`border:1px solid rgba(35,35,40,.12)/rgba(255,255,255,.14);border-radius:999px;padding:4px 11px;font-size:11px;color:#232328/#ECECF0`
  2. **全幅阅读**(**主动作 · iris 描边**):`border:1px solid rgba(87,91,196,.45)/rgba(139,142,217,.5);background:#EFEFFA/rgba(139,142,217,.16);border-radius:999px;padding:4px 11px;font-size:11px;color:#43478F/#B7B9E8;font-weight:600` + 扩展 icon `#575BC4/#8B8ED9`(深屏文缩为「全幅」)
  3. **下载**(icon-only):`28px;height:28px;border:1px solid rgba(35,35,40,.12)/rgba(255,255,255,.12);border-radius:8px` + 下载 icon `#6C6C72/#A8A8B0`
- 规则:全幅阅读=iris 描边(主动作);展开/下载=中性描边。宽度自适应。

### 链接卡变体 · 外部 URL(同族不同图标)
同款容器;图标 `32px;border-radius:9px;background:#F2F1EC`(深 `rgba(255,255,255,.06)`)+ **中性地球 icon** `#6C6C72/#A8A8B0`(不与产物抢色);标题「Figma · 登录页视觉稿 三态」13px/600;元 `mono 10px`「figma.com/file/aX9…/login-redesign」;单动作 = `28px` 外链 icon「在浏览器打开」。

### 内联引用 chip · say 内(站内产物)
外层 say 气泡 `background:#F2F1EC/#232328;border-radius:12px;padding:9px 13px;font-size:13px;line-height:1.9;color:#232328/#ECECF0`;内联 chip:`display:inline-flex;align-items:center;gap:4px;background:#FFFFFF/#1A1A1E;border:1px solid rgba(87,91,196,.3)/rgba(139,142,217,.35);border-radius:999px;padding:1px 8px;font-size:11.5px;vertical-align:1px`(深 `color:#B7B9E8`)+ iris 文件 icon +「PRD-登录页重设计 v2」(深缩「PRD v2」)。

### 三原则(底部三卡 `background:#FAF9F5;border:1px solid rgba(35,35,40,.07);border-radius:12px`)
- 三档阅读:① chip(一行)→ ② 展开(内嵌 markdown)→ ③ 全幅阅读(阅读器)。逐档放大,不强跳。
- 统一语法:产物卡 / 评审卡 / Agent 交付事件卡都嵌同一 chip;不再有「只有标题、点不动」的产物消息。
- 零捏造:字数 / 版本 / 时刻均来自真实产物元数据;**无产物则无 chip**。

### 328px 溢出行为
窄频道(328)内三动作**收敛为「全幅阅读 + …」**,余下(展开/下载)进溢出菜单「…」。

---

## 3h · R4a @拾取器 + mention token

### 浮层位置与容器
- **位置**:`position:absolute;left:0;bottom:calc(100% + 10px)` —— **在 composer 上方**(避让中文 IME 候选窗)
- 尺寸/容器:`width:308px;background:#FFFFFF;border:1px solid rgba(35,35,40,.1);border-radius:14px;box-shadow:0 18px 44px rgba(35,35,40,.16),0 2px 6px rgba(35,35,40,.06);padding:6px`(深:`width:300px;background:#232328;border rgba(255,255,255,.1);box-shadow:0 14px 34px rgba(0,0,0,.5)`)
- 头:`padding:5px 8px 7px`「成员 · 过滤「An」」mono 9.5px `#A3A3A8/#74747C` + 右「↑↓ · Enter」mono 9px `#C6C6CB`(过滤行为:随「An」实时过滤)
- 向下指针(浅):`position:absolute;left:26px;bottom:-6px;width:12px;height:12px;background:#FFFFFF;border-right/border-bottom 1px;transform:rotate(45deg)`

### 拾取器行解剖(头像 / 姓名+职能 / 徽记)
- **当前项(iris 高亮)**:`display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:9px;background:#EFEFFA;border:1px solid rgba(87,91,196,.28)`(深 `background:rgba(139,142,217,.16);border rgba(139,142,217,.3)`)
- **头像形状规则**:**人 = 圆** `26px;border-radius:999px;background:rgba(120,120,128,.16);color:#3E3E44`(深 `rgba(255,255,255,.14);#ECECF0`)首字母;**Agent = 方圆角** `26px;border-radius:8px;background:#EFE7F4`(深 `rgba(156,86,184,.22)`)+ Agent 图元 `#7A3F93/#C89AD8`
- 名 `12.5px/600 #232328/#ECECF0` + 职能 `mono 9px #6C6C72/#A8A8B0`
- 徽记:人 = `9.5px;color:#6C6C72;border:1px solid rgba(35,35,40,.14);border-radius:999px;padding:1px 8px`「人」;Agent = `mono 9px;color:#7A3F93;background:#EFE7F4;border-radius:999px;padding:1px 8px`「AGENT」(深 `#C89AD8;background:rgba(156,86,184,.22)`)
- 分隔 `height:1px;background:rgba(35,35,40,.06);margin:4px 8px`;底 hint「继续输入过滤 · 组词中 Enter 不触发」mono 9px

### composer(键入 `@An` 态)
`background:#FFFFFF;border:1px solid rgba(87,91,196,.4);border-radius:12px;padding:12px 14px;box-shadow:0 2px 10px rgba(87,91,196,.1)`(深 `background:#232328;border rgba(139,142,217,.4)`);正文 13.5px `#232328/#ECECF0`;半成 token「@An」`background:#EFEFFA;color:#43478F;border-radius:6px;padding:1px 5px;font-weight:600`(深 `rgba(139,142,217,.2);#B7B9E8`);**闪烁光标**`display:inline-block;width:1.5px;height:15px;background:#575BC4/#8B8ED9;vertical-align:-3px;animation:caretBlink 1s step-end infinite`(`@keyframes caretBlink{0%,49%{opacity:1;}50%,100%{opacity:0;}}`);底 hint + 发送 28px `#575BC4/#8B8ED9`。

### mention token pill(选中即高亮,`border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600`)
- **人 = iris-soft**:`background:#EFEFFA;color:#43478F`(「@Andy」)
- **Agent = delegate-soft**:`background:#EFE7F4;color:#7A3F93`(「@Agent·Design」)
- **无匹配**:`color:#A3A3A8;border-bottom:1.5px dashed rgba(35,35,40,.2);padding:0 2px 1px`(「@张三」)—— 留作死文本(不通知不派单)

### IME 与空 @
- 中文 IME 守卫:组词过程不误触发/不误发送;浮层出现在**上方**,不与 IME 候选窗打架。
- 空 @ 不弹硬错:无匹配时浮层安静收起,@名 留作普通文本,不通知不派单、不报错。
- R4a=纯前端增补(通知/Agent 重跑的服务端链路已存在);选中后 @名 成 token,派单与通知走既有选择器路径。

---

## 3i · R4b Anna 监察 · 任务确认卡

### 标准确认卡(频道监察连演第 2 幕)
- Anna 署名:`Noto Serif SC 12.5px/700 #575BC4` + 「起草」10.5px `#6C6C72` + 时刻 mono 9px + 右「未落图」mono 9px `#C6C6CB`
- 卡:`background:linear-gradient(180deg,#FFFFFF,#FDFCF9);border:1px solid rgba(87,91,196,.4);border-radius:12px;padding:12px 14px;box-shadow:0 2px 10px rgba(87,91,196,.1);position:relative;overflow:hidden`
- **草稿态标记**:`position:absolute;right:12px;top:11px;mono 8.5px;color:#A3A3A8;border:1px dashed rgba(35,35,40,.2);border-radius:999px;padding:1px 8px`「草稿」
- 头:iris 瓣 icon `#575BC4` +「Anna 监察 · 听出新任务」11.5px/600 `#575BC4`
- 任务名行:「从 Boss 的发言里听出一项新任务:」12.5px `#3E3E44` + **粗任务名** `Noto Serif SC 14px #232328`「『全功能回归测试』」
- 字段(`gap:6px`,标签 `width:44px;color:#A3A3A8`):
  - 负责人:值「Andy」`#232328/600` + tag「发言中 @ 指定」`mono 9px;color:#575BC4;background:#EFEFFA;border-radius:999px;padding:1px 7px`
  - 依赖:值「实施」+ tag「Anna 建议 · 可改」`mono 9px #A3A3A8`
  - 验收:值「覆盖九屏主流程」`flex:1` + tag「草稿 · 可改」`mono 9px #A3A3A8`
- 三按钮(`margin-top:12px;gap:8px`):
  1. **采纳上图**(主):`background:#575BC4;color:#FFFFFF;border-radius:999px;padding:5px 16px;font-size:11.5px/600;box-shadow:0 1px 3px rgba(87,91,196,.35)`
  2. **调整**:`border:1px solid rgba(35,35,40,.14);border-radius:999px;padding:5px 13px;font-size:11.5px`
  3. **忽略**:纯文字 `font-size:11.5px;color:#A3A3A8;padding:5px 8px`
- 采纳后事件(连演第 3 幕):「已上图并派给 @Andy」+ 溯源 chip「由频道生长 · #a7」(`border:1px solid rgba(87,91,196,.25);border-radius:999px;padding:1px 8px;font-size:10px;color:#43478F` + 分支 icon)

### Agent 预告变体(被派者是 Agent → 采纳即 auto-pilot)
卡同款(`max-width:420px`),草稿标记同款,头同款;任务「『验收预检:九屏走查』」
- 字段:负责人 = **Agent pill**「@Agent·Check」`background:#EFE7F4;color:#7A3F93;border-radius:999px;padding:1px 8px;font-weight:600;font-size:11px`;依赖「实施」
- **开跑预告横条**:`background:#EFE7F4;border:1px solid rgba(156,86,184,.3);border-radius:9px;padding:7px 10px` + 紫脉点 7px `#9C56B8;animation:runPulse 2s` +「采纳后 **Agent·Check 将立即执行**」`11px #7A3F93`
- 按钮:**采纳并开跑**(主,delegate 紫)`background:#7A4FB0;color:#FFFFFF;border-radius:999px;padding:5px 15px;font-size:11.5px/600;box-shadow:0 1px 3px rgba(122,79,176,.35)` + ▶ 播放 icon;+ 调整 + 忽略

### 忽略消隐动画
「忽略」= **200ms 淡出下沉**;安静消隐、不留痕、不记账,Anna 不追问。

### 草稿态语义(零捏造)
未采纳 = 不进图、不进审计;采纳后节点走生长动画,事件卡带「由频道生长 · #aN」溯源。与「＋任务」共用同一起草卡语法,只是触发从按钮变成 Anna 听懂。**图生长第四来源**(前三:驳回返工 / ＋任务 / 阻塞上报);确认门 = ADR-002:模型起草,人落章。R4b 需新后端意图起草端点(复用「＋任务」起草服务)。

### Anna 监察口吻(轻,5 条备选文案)
1. 「从 Boss 的发言里听出一项新任务——要采纳吗?」
2. 「听出你在给 Andy 派活,先替你拟成卡。」
3. 「这条像是新任务,草稿在此;不对就忽略。」
4. 「采纳后我才上图、才记账;现在只是草稿。」
5. 「误听了?点忽略,我就当没提过。」
（口吻要轻:「听出一项新任务」而非「已为你创建」——她在建议,不在替你拍板。）

---

## 3j · R3 抽屉信息序改版 + 三级 Trace

### 任务抽屉(width:468px;height:720px)
`[冲突]` 抽屉宽:稿 `468px`;《设计说明》§三「480 宽」。
容器 `background:linear-gradient(180deg,#FAF9F5,#F7F6F1);border:1px solid rgba(35,35,40,.1);border-radius:16px;box-shadow:0 20px 50px rgba(35,35,40,.09)`。**新信息序 = 产出先行**,四段带序号 ①②③④:
- 头(`padding:16px 20px 14px;border-bottom`):任务名「设计稿」`Noto Serif SC 16px/700` + 状态 pill「已提交待审」(薰衣草菱形徽 `9px border:1.5px solid #8B8ED9`)+ 「回频道」pill + 关闭 X;第二行 Agent·Design 署名 + AGENT 徽
- **① 产物(默认展开)**:序号徽 iris `15px;background:#575BC4;color:#FFFFFF;mono 9px`「1」+「产物」12.5px/700 +「默认展开」tag `mono 9px;color:#575BC4;background:#EFEFFA`。产物卡 `border:1px solid rgba(87,91,196,.35);border-radius:12px;padding:10px 12px;box-shadow:0 2px 8px rgba(87,91,196,.08)`:文件 icon 26px +「登录页视觉稿」+「v1 · 3 屏 · 16:40」+「全幅阅读」iris chip;下附 3 枚缩略条 `flex:1;height:44px;border-radius:6px`(渐变占位)
- **② 验收标准**:序号徽灰 `15px;background:rgba(35,35,40,.14);color:#6C6C72`「2」+「来自 PRD v2」tag mono 8.5px;三条勾选行(复选框 `12px;border-radius:4px;border:1.5px solid rgba(35,35,40,.25)` + 文 11.5px `#3E3E44`)
- **③ 执行过程(默认折叠)**:整行可点 `padding:8px 11px;background:#FFFFFF;border:1px solid rgba(35,35,40,.1);border-radius:10px;cursor:pointer`:序号「3」+「执行过程」12.5px/700 + meta「2 回合 · 17 帧 · 42s」mono 9px + chevron-down;下附 caption「默认折叠 · 点开进三级下钻(见右)」
- **④ 元信息(沉底 `margin-top:auto`)**:序号「4」+「元信息」;`flex-wrap;gap:6px 14px;mono 9.5px #6C6C72` chips:「依赖 · PRD 评审 ✓」「下游 · 设计评审 ◇」「提交 16:40」「改派 · 可」
- 底操作组(`padding:12px 20px 16px;border-top`):**去评审**(主)`background:#575BC4;color:#FFFFFF;border-radius:10px;padding:8px 18px;font-size:12.5px/600` +「改派」`border:1px solid rgba(35,35,40,.12);border-radius:10px;padding:8px 14px` + 右 mono 9px「操作随状态变化」

### 执行 Trace · 三级下钻 + 即点即关(对齐产品统一件 StageStepTrace)
容器 `border:1px solid rgba(35,35,40,.1);border-radius:16px;overflow:hidden`
- **一级 · 执行摘要(sticky 吸顶)**:`display:flex;align-items:center;gap:9px;padding:11px 16px;background:#FAF9F5;border-bottom:1px solid rgba(35,35,40,.08);position:sticky;top:0`。「一级」pill(`mono 9px;color:#575BC4;background:#EFEFFA;border:1px solid rgba(87,91,196,.25);border-radius:999px;padding:1px 8px`)+「执行摘要」12.5px/600 + **摘要行**`mono 10px #6C6C72`:`GPT-4o · 17 帧 · 42.3s · 产物 v1` + 右「收起」控件(chevron-up + `border:1px solid rgba(35,35,40,.14);border-radius:999px;padding:3px 11px`)
- **二级 · 步骤列表**:「二级」pill +「步骤列表 · 每帧一行:类型 + 首行摘要」。步骤行 `background:#FAF9F5;border:1px solid rgba(35,35,40,.08);border-radius:9px;padding:8px 11px`:类型 tag(读取/生成/校验)`mono 8.5px;background:#FFFFFF;border:1px solid rgba(35,35,40,.1);border-radius:5px;padding:1px 6px` + 摘要 `mono 10.5px #3E3E44`(单行省略)+ chevron-right
- **三级 · 展开帧(原文)**:`border:1px solid rgba(87,91,196,.35);border-radius:9px;box-shadow:0 2px 10px rgba(87,91,196,.08)`;头 `background:#EFEFFA;padding:8px 11px`:类型 tag「生成」+「三态布局草案 → 产物 v1」600 +「三级 · 原文」pill + chevron-up;**L3 正文** `padding:12px 14px;max-height:196px;overflow:hidden;position:relative`:caption「原文 · markdown 渲染后展示 · 长文内滚 ▾」mono 9px,随后 **markdown 渲染**(标题 `Noto Serif SC 14px/700`、p `12.5px/1.8`、ul `12.5px`)—— **L3 = markdown 渲染,非等宽**(或等宽降噪备选);底渐隐 `height:40px;background:linear-gradient(180deg,transparent,#FFFFFF)`
- **即点即关**:展开与收起控件**同位吸顶**,任何滚动深度顶部「收起」一键回折叠(不被长内容推走)
- **原文不再裸奔**:帧原文若是 markdown 则渲染后展示(或等宽降噪排版),长文内滚,不贪占抽屉滚动区

病根修:产物曾在 260px 小盒被过程挤出视野;新序把产物提第一,Boss 第一眼见结果;过程默认折叠,元信息沉底。

---

## 3k · R6 composer 微提示(Enter 发送)

### 微提示文案与两态
- 文案:`mono 9px`「Enter 发送 · Shift+Enter 换行」
- **blur/常驻态**:色 `#A3A3A8`(ink-3)
- **focus/聚焦态**:提亮至 `#6C6C72`(ink-2)——「聚焦:提示提亮 ink-3 → ink-2」(习惯迁移期需持续但安静的提醒)
- 深色 composer:hint `#74747C`
- **组词中 warn 变体**(替换 hint):`inline-flex;gap:6px;mono 9px;color:#B98A2F;background:rgba(185,138,47,.1);border-radius:999px;padding:2px 9px` + 5px 金点 `#B98A2F` +「组词中 · Enter 不发送」;同时发送键降为 `background:rgba(87,91,196,.4)`。caption:「isComposing 守卫:确认字词的 Enter 不误发」
- **placement**:位于 composer 底部动作行(`display:flex;align-items:center;margin-top:14px`),hint 居左、发送键 `margin-left:auto` 居右。`[注]` 稿标题/《设计说明》§八称「右下常驻」,但 3k 三处 demo 的 markup 均把 hint 放在**底行左侧**、发送键在右;落地以实际 markup 为准(hint 左 / 发送右),或按说明置右下,见 devplan。

### 三处 composer demo
1. HOME · CHAT(blur):`border:1px solid rgba(35,35,40,.12)`;占位「问点什么,或让我开始一个项目…」`#A3A3A8`;hint `#A3A3A8`;发送 28px `#575BC4`
2. COWORK · 问 ANNA(focus):`border:1px solid rgba(87,91,196,.5);box-shadow:0 0 0 3px rgba(87,91,196,.12),0 1px 3px rgba(35,35,40,.05)`;文「帮我把这周的进度理一理」+ caretBlink 光标;hint `#6C6C72`
3. CREW · 频道(IME 组词中):同 focus 边;文「这版三态口径 <u>huigui</u>」(组词串 `border-bottom:2px dotted #575BC4;padding-bottom:1px`);warn pill 替 hint;发送键 dimmed `rgba(87,91,196,.4)`

### 惯例修订与范围
- 旧:`Ctrl+Enter` 发送 / `Enter` 换行 → **新:`Enter` 发送 / `Shift+Enter` 换行**
- 一次改全 · 四入口 chips:`Home Chat` · `Cowork · 问 Anna` · `Create` · `Crew · 频道`
  `[冲突]` 处数:3k 标题「一次改全三处」与《设计说明》§八「三处」,但两处的枚举 chips 均列 **四** 项(含 Create)。以四入口为准(说明与稿的「三」为笔误)。
- **表单多行框不改**:提交说明 / 共识 / 驳回批注仍按钮提交(避免误发长文),仅对话 composer 改键
- IME 守卫(工程半):全库补 isComposing 守卫;现为零,不补则中文输入法确认字词即误发

---

## 附:新增 keyframes / CSS 变量汇总

### 本轮新增 5 条 @keyframes(NEW 行 39–43,逐字)
```css
@keyframes strokeFlow{0%{background-position:0% 50%;}100%{background-position:300% 50%;}}
@keyframes runPulse{0%,100%{opacity:.45;}50%{opacity:1;}}
@keyframes railBreath{0%,100%{opacity:.85;}50%{opacity:1;}}
@keyframes caretBlink{0%,49%{opacity:1;}50%,100%{opacity:0;}}
@keyframes cardRise{0%{opacity:0;transform:translateY(10px) scale(.98);}100%{opacity:1;transform:translateY(0) scale(1);}}
```
用途:`strokeFlow`=执行中描边流光(4.5s linear);`runPulse`=频道/健康条/预告脉点(2s ease-in-out);`caretBlink`=输入光标闪烁(1s step-end);`cardRise`=活动行完成后产物卡入场(.5s cubic-bezier(.2,0,0,1) both);`railBreath`=在 3a–3k 定义但**未见被引用**(疑为侧轨/图标轨呼吸预留,登记备查)。

### CSS 自定义属性(custom properties / :root 变量)
**无。** 全文件 `grep ':root' / '--xxx:'` 零命中——所有颜色/尺寸均为字面内联值(《设计说明》以 `--gold`/`--delegate`/`--edge`/`--panel`/`--user`/`ink-2`/`ink-3` 等 token 名描述,但设计稿 HTML 未落成 CSS 变量,工程需自行建立 token→字面值映射;映射依据见本文件顶部「全局 token 速查」)。

### 复用的既有 keyframes(本轮引用,定义未变)
`annaBreath`(2.4s,0→7px 呼吸)/`annaBreathDark`/`dashFlow`(`to{stroke-dashoffset:-24}`,1.1s 供电流)/`goldPulse`(4→8px 金脉,4s)/`goldPulseDark`/`auroraDrift`(30s 顶辉)/`auroraDrift2`(40s 底辉)。reduced-motion 全局 media query(行 44)既有,非新增。

---

## 附:旧屏是否被改动

**旧屏全部未改动(old screens untouched)。**
- `git diff --no-index --stat`:`1 file changed, 1547 insertions(+)`,**0 deletions**。
- 逐字核验:`grep '^-[^-]'` 命中 **0** 行真实删除;新增 1436 行。
- 结构核验:新增内容为一整节 `<section>`(NEW 行 47–1587)前插于旧内容之前,含总览(49–63)+ 3a–3k(65–1584);旧内容(第二轮 2a/2b、第一轮 1a–1h/1g、设计说明链接)自 NEW 行 1589 起原样保留,anchor id 与顺序不变。
- 单一 diff hunk(`@@ -36,9 +36,1556 @@`)成因:5 条新 keyframes 插在 `<style>` 内 `auroraDrift2` 之后(行 39–43),与新 `<section>` 之间仅隔 3 行未改上下文(`@media`/`</style>`/`</helmet>`),≤ git 默认上下文窗,故合并为一段;不代表旧内容位移或被改。

---

### 三行小结
- Delta:1547 行插入 / 0 删除(旧屏零改动);新增区 = NEW 行 49–1584 一整节 + 5 条 keyframes(行 39–43)。
- 覆盖:3a/3b 九节点整图(浅/深)· 3c 七态+门全家福 · 3d R2 双层动效 · 3e/3f 产物阅读器(浅/深)· 3g 附件 chip · 3h @拾取器 · 3i 确认卡 · 3j 抽屉+三级 Trace · 3k composer 微提示,共 11 屏全提取。
- 冲突:6 处已标 `[冲突]`——节点宽(172/188/200×64)、章尺寸(20 vs 16)、门尺寸(38·44 / 44·48 / 44→48)、抽屉宽(468 vs 480)、composer 改键处数(三 vs 四入口)、微提示位置(左下 markup vs「右下」文案);均两值并列留 devplan 裁。
