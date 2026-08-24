# Anna 前端交付包 · 鸢尾 Iris(P1:Runtime 三级下钻 + Tokens)

**版本** 2026-07-09 v2(合并《Runtime 三级下钻 Brief》)
**目标环境** React 19.2 + Vite 7 + Electron 39 · TypeScript 5.9 strict · CSS 变量 + 组件级 CSS

## 这是什么

这不是设计示意稿,而是**可直接 copy-in 的生产级源码**。`src/` 下的 `.tsx/.css` 按你们的工程规范编写
(函数组件 + Hooks、纯逻辑与展示分离、tokens 驱动、零第三方样式依赖),复制进工程即可接 SSE 真数据。
`preview/index.html` 用**同一份源码**在浏览器免构建渲染,供逐像素对照;它不是交付物本体。

## 内容

```
src/
  styles/tokens.css                    设计令牌(§1 浅/深双主题)+ 动效关键帧(§3)+ reduced-motion 降级
  lib/frames.ts                        帧契约 discriminated union(含 L3 下钻预览通道 ToolDrilldown)
  lib/turns.ts                         帧 → 回合三级树归约(纯函数,可 vitest 单测)
  lib/plan.ts                          plan.updated → 进度归约(纯函数)
  lib/runtime.ts                       apiBase:window.__ANNA_RUNTIME__ 兜底 VITE_ANNA_API_BASE
  components/agent/LoopCard.tsx|.css   灵魂组件:三级下钻 × 四态 + 礼成条 + 计划条 + 窄容器降级
  components/agent/AgentSessionHeader.tsx|.css   身份头(金线描环「安」头像)
  components/agent/AgentComposer.tsx|.css        Composer 家族(槽位固定 + 站位纪律)
  components/agent/PlanRail.tsx|.css             右栏任务进程(无计划不渲染)
  components/agent/ArtifactSandbox.tsx|.css      沙箱画布:挤压式滑出 + 产物 tab + 文件夹树 + HTML/MD/代码/文本预览
  components/agent/ArtifactCard.tsx|.css         行内产物卡(点击 → 画布自动展开并定位)
  components/agent/ApprovalCard.tsx|.css         通用审批卡(§6.4 W4:confirm 对账 + supplement 补充两变体)
  components/cowork/DashboardKit.tsx|.css        看板五段式套件(AlertBand/KpiCard/Sparkline/TrendChart/MetricBar/InsightCard/AskChip/ReadingFold/ProvenanceLine)
  components/surfaces/SurfaceKit.tsx|.css        P4 套件:Create(hero/workshop/draft 账本)· 产物中心(过滤/网格卡)· 设置(卡/开关/分段控件)
  components/anna/IrisPetal.tsx        鸢尾瓣 + 「安」印 + 绽放鸢尾 + 瓣饰分隔线(§5 白名单/上限)
  components/anna/StateNote.tsx        状态语法:空/加载/错误/未连接/站位
  components/anna/MiniMarkdown.tsx     零依赖 Markdown 兕底(生产传 react-markdown 替换)
  fixtures/demo-run.ts                 四态示例帧序列(仅预览/单测用)
preview/                               浏览器对照预览(免构建)
CLAUDE-CODE-INSTRUCTIONS.md            给 Claude Code 的结构化实现指令(帧→UI 映射 + 规格表)
ACCEPTANCE-CHECKLIST.md                逐项验收对照清单(设计方按此打勾)
```

## 接入步骤

1. **令牌**:`main.tsx` 里 `import '@/styles/tokens.css'`(全局一次)。深色 = `<html data-theme="dark">`。
2. **字体**:`@fontsource/noto-sans-sc`、`@fontsource/noto-serif-sc`、`@fontsource/jetbrains-mono` 随包引入
   (Windows 建议随包 MiSans/HarmonyOS Sans 补细字重)。**禁 CDN**(Electron 离线)。预览页的 Google Fonts 链接仅预览用。
3. **组件**:整个 `components/` 与 `lib/` 复制到 `src/` 下(路径别名 `@` 已按你们约定使用相对导入,无需改动)。
4. **接数据**:SSE 帧 push 进数组 → `reduceTurns(frames, TOOL_LABELS)` → `<LoopCard state=… turns=…>`。
   `state` 由 RunTree.state 映射:`running/awaiting/done/error`。计时(elapsedText)为前端职责。
5. **L3 懒加载**:`onLoadFull={(stepId) => api.fetchToolResult(runId, stepId)}`(后端下钻通道,已脱敏)。
6. **沙箱画布**:`<ArtifactSandbox open files activeId onActivate onClose>` 放进主列 flex 行末尾;
   点产物卡 / 运行完成 → 置 open=true 自动展开(挤压式 240ms)。Markdown 传 `renderMarkdown` 接 react-markdown。

## 设计红线(实现时不可妥协)

- **诚实**:站位 = 虚线 + 「即将上线」+ 禁用,绝不假响应/假数字/假 loading;空态就是空态;
  过程文案全部来自引擎权威帧,前端只做「事件名→中文标签」映射。
- **七态**:每个数据面必须实现 空 / 加载 / 运行中(流式)/ 完成 / 失败 / 未连接 / 站位,不只 happy path。
- **拟人层**:flavor 是独立、可关的通道(`persona` prop);皮不盖成败真值;L3 素颜,persona 一字不改。
- **动效**:同一时刻至多一处在动;完成/失败全部静止;`prefers-reduced-motion` 已在 tokens.css 降级。
- **点缀**:鸢尾瓣/「安」印每屏至多 2 处,白名单见 IrisPetal.tsx 注释;永不动画。

## 范围与后续

本包 = P1(Chat 灵魂一屏组件族)+ P2(tokens/双主题)+ 沙箱画布 + 通用审批卡 + 看板五段式(P3)+ Create/产物中心/设置分层套件(P4)。
五面共用组件已齐;剩余落地工作为页面级拼装(壳/侧栏/路由)与真实数据接线,均按 CLAUDE-CODE-INSTRUCTIONS.md 执行。
