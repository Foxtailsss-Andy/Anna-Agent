# 鸢尾 Iris 落地实现记录

- 日期:2026-07-09
- 分支:`feat/fe-iris-redesign`(从 `feat/wb-w1-loop-observability` 切出;**未并 main,待评审**)
- 设计源:`Anna 设计说明 · Iris.dc.html`(§0-§10 实现蓝本)+ `Anna 重设计 · 墨与信号.dc.html`(高保真画布 3a-3d / 4a-4f / 5a-5f)
- 落地顺序:严格按设计说明 §10 六步(换血→灵魂→统一→铺面→深色→分层)
- 质量门(每步过):`npx tsc --noEmit` 0 · `npx vitest run` 93 · `npx vite build` ✓ · `pytest` 588(后端全程未改)

## 六个 commit

| 阶段 | commit | 内容 |
|---|---|---|
| P1 换血 | `53382e4` | styles.css `:root` → Iris tokens(`#2970ff`→`#575BC4` 瓷白鸢尾);旧名全部保留为别名指向 Iris 值(全 app 100% 走 `var()`,零组件改动即换肤);字体三栈(衬线 Noto Serif SC / 黑体 MiSans→PingFang / 等宽 JetBrains Mono);质感配方 class + 动效 keyframes 打底 |
| P2 灵魂 | `1357c08` | `loopCardModel.ts`(纯逻辑 + 9 vitest,把 Trace 拍平成无轮次「瞬间」);`LoopCard.tsx`(运行/礼成/失败三态 + 时间线 + 掀开第二级 + 计划条);接进 ChatThread 替换 StageStepTrace |
| P3 统一(上) | `3044aec` | ChatComposer → Iris Composer 家族(附件站位/调优/权限 pill W4 站位/CTX 环 W5 站位/模型档 pill/停止键接 hook.stop/发送);`AgentSessionHeader`(金线「安」印 + 大小姐语体状态句) |
| P4 铺面(一) | `7e2514d` | `IrisPetal` 组件(§5 三色固定花瓣);问候页衬线 display + 鸢尾瓣 +「您」文案;侧栏品牌瓣;共享 `.panel` 升级瓷面材质(一处改全 surface 跟随) |
| P5 深色 | `619ea2b` | 材质配方去字面白(走 `var(--surface/-2/sunken)` + `--edge-highlight` token);`[data-theme=dark]` + OS 深色覆写(只改源 token,别名级联);`theme.ts` + 设置「外观」卡(浅/深/跟随系统) |
| P6 分层 | `d9d9db5` | 设置默认 Boss 视角 5 卡(账户/外观/模型档案/记忆 W6 站位/关于金线鸢尾);「开发者模式」开关展开完整 RuntimeStatusPage(功能不删只分层,D4 密度解法) |

## 已验收(真实渲染)

- **LoopCard 三态**:用真实编译 CSS 静态渲染 + 深色态,逐项对上画布 3b/3c/3d。
- **深色主题**:真实 app 端到端切换(设置外观卡)—— 非反相、瓷变墨、鸢尾提亮、对比度达标。
- **设置分层**:真实 app 切 Boss/开发者视角。
- **问候页 / Composer 槽位 / 侧栏品牌瓣**:真实 app 验收。

## 验收轮(2026-07-09,Fable 5 验收官)—— 差距修复记录

以 Zip 设计为标准逐条审计,修复 9 项未达标(commit 见 git log 验收提交):

1. **字体随包(§2/§9.6,Mac/Win 一致)** ✅:@fontsource/noto-serif-sc(500/600)+ noto-sans-sc(300/400/500/700,补 Windows YaHei 缺失细字重)+ jetbrains-mono(400/500/600),woff2 unicode-range 切片离线打包(dist +~28MB);栈序 PingFang(Mac 原生)→ 随包 Noto → YaHei。
2. **您的话语气泡(§4)** ✅:渐变 #5E62AC→#4F5296 白字 16/16/5/16 + 内高光;深色=米白纸墨字(--user-grad/--user-ink token 级联)。
3. **主按钮 filled(§4)** ✅:发送键 / 侧栏 CTA 鸢尾渐变(--iris-grad token,深色 #6A6ED6→#5155BE)。
4. **时间线左发丝轨贯穿(3b)** ✅。
5. **礼成落笔(§3)** ✅:✓ stroke 描画 300ms(reduced-motion 静止)。
6. **失败态对齐 3d** ✅:live + 历史两路径都保留 LoopCard/trace 留证(forceStatus 防误显礼成),前端按 error 类型映射大小姐致歉句(chatFailure.ts + 测试)+ 原始错误 mono 留证;actions/追问对失败 turn 抑制。
7. **容器 B 迁移(§6.2)** ✅:Finance/Hiker QaColumn → LoopCard compact(当下行 + ▸ 过程 N 个瞬间 + 计划条;failed/awaiting 自动展开);onStep 权威帧透传两 API;思考旁白经 Moment.text 掀开可见。
8. **瞬间耗时(3b)** ✅:相邻审计 created_at 差值(真实数据;缺时间戳不编造)。
9. **§7 细节** ✅:Create hero 衬线;Hero KPI 鸢尾描边+花晕;侧栏 248px;产物中心「来源」过滤(Create 真 + Chat/Code 虚线站位);顺手修两处把注释提前闭合的 `*/` CSS 语法错(esbuild 警告清零)。

验收视觉:accept-light/dark 静态稿(真实构建 CSS + 随包字体)对照画布 3b/3c/3d/4d 逐项核过;四门 tsc 0 / vitest 100 / build ✓(0 css warning)/ pytest 588。

## 仍欠(如实,后续轮)

1. **通用审批卡(§6.4)未落地**:报销页(1573 行)审批流仍是原组件(经 token 换肤)。= LoopCard 琥珀形态,需 live 报销 MCP 验证,随报销面深度铺面一起做。
2. **报销双栏(容器 C)未换 LoopCard**:同上,风险面留待 live 环境。
3. **「从断点续办」按钮**:W3 会话续接后端未上,诚实不渲染。
4. **第二级入参/回执全文**:D8 审计载荷扩展(后端,设计说明 §9.1-9.2)。
5. **LoopCard 运行/礼成态在真模型下的实跑走查**:dev 无模型;桌面版(真 DeepSeek)一跑即见,建议作为人工验收步骤。
6. **W2-W9 预留位**:权限 pill / CTX 环等站位,随各 W 点亮。

## 怎么看活的效果

```bash
# dev(前端 + 后端,greeting/settings/dark 可看;LoopCard 运行态需真模型)
npx vite --port 5173
ANNA_DEV_LOGIN_AUTOFILL=1 .venv/Scripts/python.exe -m uvicorn services.api.app.main:app --port 8000 &
# 桌面版(真 DeepSeek,可看 LoopCard 活的运行现场)
npm run build && npx electron .
```
