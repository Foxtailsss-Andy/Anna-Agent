# R4 · Chat 灵魂一屏(LoopCard 真跑)

**目标:** Chat 区从问候空态到礼成收拢全链路真跑:`POST /api/chat/runs/stream` → 归一化 → `reduceTurns` → LoopCard 四态;PlanRail、回合叙述/答案、产物卡→沙箱画布、历史回看、Composer(调优真控件 + CTX 真环)。
**边界:** 审批卡(R6)、看板副驾(R5)不在此;「存入产物中心」「附件」按设计为虚线站位;L3 工具凭证无后端通道(B2)→ 工具步不出箭头(正确降级);thinking 帧缺(B1)→ 思考步同理。

**前置:** R2(流层)、R3(壳)。**读交接包 CLAUDE-CODE-INSTRUCTIONS §1/§2/§6 + ACCEPTANCE-CHECKLIST §D/§G 后动手。**

**Files:**
- Create: `apps/desktop/src/pages/chat/ChatPage.tsx`+`.css`、`useRunStream.ts`、`GreetingHero.tsx`(并入 ChatPage.css)、`TunePopover.tsx`+`.css`、`historyFrames.ts`、`errorApology.ts`(+两个 `.test.ts`)
- Modify: `apps/desktop/src/App.tsx`(chat 区挂真页)

**Interfaces:**
- Consumes: `streamChatRun/listChatRuns/getChatRun/getModelProfiles/getPromptTemplates`(R2 chat.ts)、`getSkills`(admin.ts)、`readSse/createNormalizer`、`reduceTurns/planProgress`、组件族(LoopCard/AgentComposer/PlanRail/AgentSessionHeader/ArtifactCard/ArtifactSandbox/StateNote)
- Produces(R5/R6 复用): `useRunStream`(签名见下)、`errorApology(message: string): string`

## Task 1: useRunStream(核心 hook,TDD 纯逻辑部分)

- [ ] **Step 1: 实现 `useRunStream.ts`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { Frame } from "../../lib/frames";
import { reduceTurns, type RunTree, type ToolLabels } from "../../lib/turns";
import { readSse } from "../../lib/api/sse";
import { createNormalizer } from "../../lib/api/normalize";

export interface RunStream {
  tree: RunTree;                 // reduceTurns(frames) 的实时结果
  frames: Frame[];               // v2 帧数组(回看/调试用)
  elapsedText: string;           // mm:ss 计时(前端职责)
  ctxPercent: number | undefined;// W5:model.call.started 的真值,无则 undefined(站位)
  usageText: string | undefined; // "model · ~N tokens",无真报则 undefined
  running: boolean;
  start: (open: () => Promise<Response>) => Promise<void>;
  stop: () => void;              // AbortController;中断 = 前端主动断流(后端按 client_disconnected 处理)
  reset: () => void;
}

export function useRunStream(toolLabels?: ToolLabels): RunStream {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const ctxRef = useRef<ReturnType<typeof createNormalizer> | null>(null);
  // 计时器:running 时 500ms 步进;done/error 停(动效纪律)
  ...
  const start = useCallback(async (open: () => Promise<Response>) => {
    abortRef.current?.abort();
    const normalize = createNormalizer();
    ctxRef.current = normalize;
    setFrames([]); setStartAt(performance.now());
    const res = await open();
    await readSse(res, (raw) => setFrames((prev) => [...prev, ...normalize(raw)]));
  }, []);
  const tree = useMemo(() => reduceTurns(frames, toolLabels), [frames, toolLabels]);
  ...
}
```

  细节纪律:①`stop()` 后 tree.state 停在当下(不伪造 done);页面对已中断 run 显示 `StateNote kind="error"` + 「已手动停止」?——**不**,中断非错误:显示素文案「已停止 · 已产生的过程保留」(权威帧仍在);②usage/ctx 从 normalizer 上下文读(R2 暴露的 getter);③组件卸载 abort。
- [ ] **Step 2:** `npx tsc --noEmit` 0 error。

## Task 2: 问候空态 + Composer 接线

- [ ] **Step 1: GreetingHero**(Chat 空态,七态之「空」):衬线问候(按时段:上午好/下午好/晚上好 + displayName)+ 鸢尾瓣 16(白名单「问候页 16」,本屏点缀 1/2)+ 居中 Composer。**问候语是前端时段映射,非模型文本,允许**;禁附加营销文案。
- [ ] **Step 2: Composer 槽位接线**(ACCEPTANCE §G 顺序):
  - 附件:`undefined`(虚线站位,W 报销面才有真上传)
  - 调优:`onTune` 打开 `TunePopover`(真控件):模型档案 select(`getModelProfiles()`,默认 default_profile_id)/ Skill select(`getSkills()`,含「跟随全局」空选项)/ 模板 select(`getPromptTemplates()`);选中即存 state,`tuneActive = 任一非默认`。**拼装决策 D-R4-1**:W2 模型档位 enum 不硬套后端任意 profile id,`modelTier` 保持 `undefined`(不渲染);档案选择收进调优 popover(真数据真控件)。
  - 权限 pill:`undefined`(W4 站位;报销面 R6 用真值)
  - CTX 环:`ctxPercent`(真值,来自 model.call.started;首帧前 undefined = 站位)
  - 发送:`streamChatRun(message, { modelProfileId, skillId, templateId })` → `runStream.start(...)`;running 时停止键 → `runStream.stop()`。

## Task 3: 运行视图(LoopCard 四态 + PlanRail + 叙述/答案 + 礼成)

- [ ] **Step 1: 布局**(交接包 preview S1 同构):主列(flex:1, maxWidth 820, gap 14)= AgentSessionHeader → 回合间叙述/答案(text_delta 正文,15/28 max 68ch)→ LoopCard → Composer;右栏 300px = PlanRail(`planProgress(tree.plan)` 为 null 时整个不渲染);行末尾 = ArtifactSandbox(挤压式)。
- [ ] **Step 2: LoopCard 接线**

```tsx
<LoopCard
  state={tree.state === "idle" ? "running" : tree.state}   // idle 不渲染卡,见 Step 3
  nowIntent={tree.nowIntent}
  elapsedText={runStream.elapsedText}
  turns={tree.turns}
  plan={planProgress(tree.plan)}
  usageText={runStream.usageText}
  persona={persona}                    // 全局设置(R8 外观卡),默认 true
  onLoadFull={undefined}               // B2 前无通道:不传 → truncated 无「展开更多」,正确降级
  ceremony={tree.state === "done" ? ceremonyOf(tree, runStream) : undefined}
  failure={tree.state === "error" ? failureOf(tree, runStream) : undefined}
/>
```

  - `ceremonyOf`:momentCount = Σ steps;planText = `计划 n/m`(有计划才有);usageText = 真报才有(null → 不传该段)。
  - `failureOf`(**诚实裁决 D-R4-2**):chat 无 resume 通道(B3)→ **不传 `onResume`**;传 `onCopyError`(复制 error 原文)+ 页面级「重新发起」按钮(tinted,卡外,明示会新开 run);`onAudit` 不传(chat 无审计端点)。若 LoopCard 对缺省回调仍渲染按钮,视为包缺陷:在切片内以 wrapper 隐藏并记录偏差,禁改包源码。
  - 失败致歉文案(卡外):`errorApology.ts` 纯映射(TDD):`timeout→执行超时` `model_not_configured→模型未配置` `client_disconnected→连接中断` 其余 → 通用致歉 + error 原文已在卡内 L3。**先致歉再归因,不甩锅用户**(语体 §3)。
- [ ] **Step 3: 状态机**:空(问候)→ running(首帧后滚动锚定 LoopCard)→ done(整卡收拢礼成条 320ms;答案正文 + 产物卡呈现)→ error(动效全停 + 致歉段);awaiting 本切片不出现(chat 无审批工具)。
- [ ] **Step 4: 产物 → 沙箱**:done 帧 `run.artifacts` → 每件一张 ArtifactCard(metaText = `网页产物/文档产物 · run <id 前 6>`;kind page→"网页产物",doc→"文档产物");`onOpen` → `SandboxFile{ id, path: title 加扩展名(page→.html,doc→.md), kind: page→"html", doc→"markdown", content }` → `<ArtifactSandbox open ... renderMarkdown={reactMarkdown}/>` 自动展开并定位;运行完成且有产物 → 自动 open。react-markdown 接法:`renderMarkdown={(src) => <ReactMarkdown>{src}</ReactMarkdown>}`。「存入产物中心」按包内实现保持虚线站位。

## Task 4: 历史回看

- [ ] **Step 1: `historyFrames.ts`(TDD)**——把已落库 run 重放为 v2 帧(真数据重放,非编造):

```ts
/** ChatRun(GET /api/chat/runs/{id}) → v1 原始帧序列 → 归一化。
 *  audit_events 逐条 → {type:"event",event};终帧按 status 合成 done/error(run 自身即真值)。
 *  实施第一步:先 GET 一条真 run 检视字段(audit_events/answer/artifacts/plan 是否在),不符则改此表并记录。 */
export function rawFramesFromRun(run: Record<string, unknown>): Record<string, unknown>[] {
  const events = (run.audit_events as Record<string, unknown>[] | undefined) ?? [];
  return [
    ...events.map((event) => ({ type: "event", event })),
    { type: "done", run },   // status:"failed" 由归一化收敛为 error 帧
  ];
}
```

  测试:done run → state "done" + plan/artifacts 透传;failed run → state "error";事件成系统步(kind system,无 l3)。
- [ ] **Step 2: 历史 UI**:Chat 区顶部轻量「历史」入口(mono 小字 chip)→ 滑出列表(listChatRuns 倒序:问题摘要 + 状态点 + 时间);点击 → `rawFramesFromRun` → LoopCard `state:"done"|"error"` 回看形态(青瓷书脊、零动画)+ 答案/产物同 Task 3。空列表 = `StateNote kind="empty" text="还没有对话记录"`。**注意**:ChatRun 存进程内存(A2 §5 B3),后端重启历史即空——空态即空态,不解释不伪造。

## Task 5: 验收 + commit

- [ ] **Step 1: 四门全绿**(tsc/vitest[新增 3 测试文件]/build/pytest)
- [ ] **Step 2: Playwright 实跑走查**(后端起,模型已配):①问候空态(点缀 ≤2)→ ②发问「用 plan.update 规划并生成一个介绍页」→ 运行中:呼吸点+微光唯二动效、step intent 逐帧上屏、PlanRail 出现即时刷新、工具步无箭头(无 L3,正确)→ ③礼成收拢:金线+「安」印+真 tokens(或不显示)→ 回看展开青瓷书脊 → ④产物卡点开沙箱:挤压式 240ms、HTML iframe sandbox 无脚本、tab 激活 iris tinted → ⑤断后端模型 key 重发 → 失败卡:胭脂书脊、error 原文 mono、致歉段、无 onResume 按钮 → ⑥停止键中断 → 过程保留素文案。逐屏截图对照 preview S1/S2/S2b/S3。
- [ ] **Step 3: commit**(建议 2-3 个:hook+空态 / 运行视图+沙箱 / 历史+打磨)`feat(fe): R4 — Chat 灵魂一屏(LoopCard 真跑)`

## 风险

- **流中 setFrames 频率**:text_delta 每 token 一帧 → useMemo(reduceTurns) 每帧全量重算;帧数千级内可接受(纯函数快),若卡顿再批量 flush(rAF 缓冲),**不许跳帧丢数据**。
- **StrictMode 双跑 effect**:start 由用户动作触发(非 effect),不受影响;计时器 effect 要幂等清理。
- **历史字段假设**:Task 4 Step 1 的先验步是硬性的——ChatRun 字段与假设不符时以现状为准改 historyFrames 并记录。
- **答案正文与叙述重复**:text_delta 既进 turns[].narration 又进 answerText(turns.ts 设计);渲染只取 answerText 作答案区、narration 作回合间叙述,**别双渲染同一段**(对照 preview S2 的呈现取舍:回合间短叙述在卡内,最终答案在卡外)。
