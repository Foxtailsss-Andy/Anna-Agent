# WorkBuddy 吸收轮总纲(交接级开发计划)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **给接手人**:本文件是地图,不是实现细节。每个工作流(W1-W9)有独立下钻文档,自包含「现状锚点(文件:行号)→ 要开发什么 → 实现什么效果 → 位置在哪里 → 怎么调用 → 验收门」。只读本文件 + 你要做的那份下钻,即可开工。

**Goal:** 按优先级把 WorkBuddy(腾讯 2C 综合 Harness Agent)已验证的机制吸收进 Anna,前后端对齐:先把 Loop 过程做权威可观测(计划面板/步骤帧/消耗),再补模型分档、会话持久化、权限模式、上下文摘要压缩、记忆闭环、SubAgent,最后开沙盒/Code 模式。

**Architecture:** Anna 现状 = 5 个静态 surface Agent 跑在自研 ReAct 引擎(`services/runtime/app/engine/`)上 + Crew 黑板看板(AI 执行空壳)+ Business Memory 雏形 + 便宜层上下文压缩。本轮原则:**接线优先于新建**——大量零件已在仓内(`vendor/hermes-agent` 整套、model_profiles、CapabilitySuspend、autocompact 断路器)只差接线;结构性新能力(SubAgent/沙盒)放后。

**Tech Stack:** FastAPI + 自研 QueryEngine(services/);React 19 + TS strict + Vite 7 + Tailwind v4(apps/desktop);SQLite(.anna/state/);vitest + pytest;Playwright 走查。

## Global Constraints(每个 W 隐含遵守)

- **诚实性红线**:只渲染真数据;站位控件必须禁用态+「即将上线」,绝不做假响应。
- **ADR-002**:模型负责想、代码负责管——每个模型输出(标题/摘要/记忆选择/计划)都要过代码校验门。
- **帧契约(R2)不破坏**:SSE 帧 `text_delta / tool_start / tool_done / event / done / error` 只增不改;新帧型是**新增**(如 `step`),旧前端忽略未知帧不崩。
- 后端改动一律 TDD;测试基线只增不减(接手时:FE 53 vitest、BE 552 pytest、tsc 0 error、build 成功——以实际为准)。
- Windows 优先;中文 UI 保留英文术语;uvicorn 无 --reload,改后端必须重启。
- 每个 W 完成过四门:`npx tsc --noEmit` / `npx vitest run` / `npm run build` / `python -m pytest services/ tests/ -q`。

---

## 0. 文档树

```
docs/superpowers/plans/2026-07-07-workbuddy-absorption/
  00-master-plan.md                    ← 本文件:背景/优先级/依赖/协议/验收
  01-loop-observability-plan-panel.md  ← W1 Loop 可观测性权威化 + 计划面板 + 消耗 chip(前后端)
  02-model-tiers-aux-agents.md         ← W2 模型分档(lite/default/craft)全面化 + 标题/摘要辅助小模型
  03-session-persistence-multiturn.md  ← W3 run 持久化统一 + Chat 多轮续接
  04-permission-modes-approval.md      ← W4 权限模式 + 审批通用化 + composer 权限选择器
  05-context-autocompact.md            ← W5 LLM 摘要压缩层(autocompact)+ 上下文指示全局化
  06-memory-v1-closure.md              ← W6 Memory v1 验收闭环 + memorySelector 预筛
  07-subagent-crew-engine.md           ← W7 SubAgent(one-shot 委派)+ Crew 接真引擎
  08-composer-command-hub.md           ← W8 Composer 命令中枢(/技能、@产物、场景入口)
  09-sandbox-code-mode-gate.md         ← W9 沙盒激活路径 + Code 模式门(指向既有 spec)
```

背景材料(不必读完,查证据时用):
- WorkBuddy 逆向解析原文:用户提供的 `workbuddy_article_standalone.html`(六层架构/16 Agent/三层记忆/上下文管理);本轮盘点结论存于记忆 `anna-workbuddy-benchmark.md`。
- 上一轮交接:`docs/superpowers/HANDOFF-2026-07-07-fe-react-pipeline.md`(其 阶段A→W1、阶段B 已并入 W1/W8、阶段C 打散进各 W、阶段D→W9)。
- Code 模式设计 spec:`docs/superpowers/specs/2026-07-07-anna-code-mode-design.md`(W9 的唯一设计依据)。

## 1. WorkBuddy 学到什么(30 秒版)

六层架构(UI→Agent→工具→扩展→记忆→安全);16 内置 Agent 主从式、**模型按角色分档(lite/default/craft)**、最小工具集裁剪;SubAgent 两模式(one-shot+fork / persistent team)+ 四通道(SendMessage / TaskList 黑板 / agent-notification 注入 / 文件系统);三层记忆(云端画像/用户规则/工作区日志+蒸馏)+ **memorySelector(lite)预筛≤5条**;上下文三层防御(预筛+延迟加载 / compact 40% 预防 / contextSummary 90% 抢救);权限四模式(plan/acceptEdits/bypassPermissions/default)在 Spawn 时设定;`requestMaxStepLimit=100`。

**对 Anna 的两个印证**:Crew 看板(depends_on/assignee/状态机)与 WorkBuddy TaskList 同为黑板模式,方向已对;Anna 的 fail-closed 工具白名单比 WorkBuddy 更严格。**真正代差**:多 Agent 调度、辅助小模型分档、记忆三层化、LLM 摘要压缩、权限分级。

## 2. WorkBuddy 前端截图解读 → 工作流映射(前后端对齐的依据)

用户提供 4 张实拍截图(欢迎页 / composer「+」菜单 / Loop Agent 运行现场 ×2)。逐要素映射:

| 截图要素 | WorkBuddy 做法 | Anna 现状 | 归属 |
|---|---|---|---|
| 欢迎页场景 chips(日常办公/代码开发/设计创意;文档处理/金融服务/数据分析) | 场景预设引导首条输入 | Chat 有问候页+模板动作(P4 已弱化为可选) | W8 |
| composer 内联模型选择器(GLM-5.2 下拉) | 模型选择就在输入框上 | chat 有选择器但收在[调优]抽屉;其余模式无 | W2(后端)+W8(前端) |
| composer 底条「选择工作空间」「默认权限」下拉 | **权限模式是 composer 一等公民**,运行中变红「允许完全访问」 | 无权限模式概念;审批 UI 仅报销页 | W4 |
| 「+」菜单:添加文件/模式/专家/技能/连接器 | 命令中枢,`@` 引用文件、`/` 调技能 | skill_id 后端已有,无 / 入口;无 @ 引用 | W8 |
| 运行现场:逐行「运行校验、定位代码/整理…计划/修改、运行校验: <路径>」 | **每步一行权威意图描述**(图标+动词+对象) | liveNote 是前端按帧型猜的文案(HANDOFF 问题1) | W1 |
| 右栏「任务进程」checklist(完成划线,进行中高亮) | Loop Agent 维护计划清单,实时打勾 | 无计划面板;只有 Stage/Step trace | W1 |
| 右栏「产物」列表(zip/md)+ 对话内产物卡 + 画布打开 md | 产物一等公民 | 已有(C6/C7 闭环+产物中心)✅ 仅需接计划面板同栏 | W1 |
| 每条消息「共消耗 ◇ 193.25」+「已完成 3m12s」 | per-message 消耗/耗时 chip | context% 审计已有(仅 finance 显示);无消耗/耗时 chip | W1 |
| 「查看所有变更 (13)」 | 文件变更 diff 汇总入口 | 无文件写工具(Code 模式范畴) | W9 |
| 「深度思考」折叠段 | 思考过程可折叠 | trace 有思考轮但边界不清(HANDOFF 问题1) | W1 |
| 场景本身:改代码→跑脚本→"脚本太慢了"→优化→重跑 | **Loop Agent + 沙盒执行真实代码**,权限门放行 | create sandbox 仅评审、激活被硬 block | W9 |

## 3. 优先级排序(核心决策)与理由

排序依据:① 用户明确痛点优先;② 成熟度——接线活 > 半新建 > 结构新建;③ 依赖关系(lite 档是 W5/W6 的地基;权限模式是 W9 的地基)。

| 序 | 工作流 | 一句话 | 性质 | 依赖 | 规模 |
|---|---|---|---|---|---|
| W1 | Loop 可观测性权威化 + 计划面板 | 后端发权威步骤帧+计划工具,前端计划面板/消耗 chip;先拆 ChatPage | 扩展既有帧契约 | — | 大 |
| W2 | 模型分档 + 辅助小模型 | model_profiles 加 tier 并推广全 5 面;lite 档跑标题/摘要 | **纯接线**(机制已好只接 chat) | — | 中 |
| W3 | run 持久化 + 多轮续接 | chat/finance/create 落 SQLite;conversation_id 续聊 | 半新建(报销 state_store 有范式) | — | 中 |
| W4 | 权限模式 + 审批通用化 | run 级 default/readonly/bypass;审批卡通用组件+composer 权限 pill | 接线(CapabilitySuspend 引擎已通用) | — | 中 |
| W5 | autocompact 摘要压缩层 | lite 模型结构化摘要中段历史;断路器接线;上下文指示全局化 | 接线+小新建(阈值/断路器已在) | W2 | 中 |
| W6 | Memory v1 闭环 + 预筛 | chat 读/finance 写/命中审计;memorySelector(lite)≤5条 | 接线+小新建(store/路由已在) | W2(W3 更佳) | 中 |
| W7 | SubAgent + Crew 接真引擎 | one-shot 委派工具+结果注入;Crew worker 走真 ReAct | 结构新建(vendor 有参考件) | W2、W4 | 大 |
| W8 | Composer 命令中枢 | / 技能、@ 产物引用、场景 chips、选择器上浮 | 前端为主 | W2、W4 | 中 |
| W9 | 沙盒激活 + Code 模式 | hardened sandbox 里程碑解锁 python 工具激活;Code 模式按既有 spec | 大工程(已有 spec) | W4(强)、W1 | 大 |

**明确不做清单(T3,对齐 Anna 定位,实施中不许"顺手"加)**:云端画像记忆(2C 跨设备场景)/ PWA/CLI/`anna://` 深链 / Plugins 打包生态 / 工具延迟加载 ToolSearch(Anna 单面 ≤11 工具无上下文压力,工具规模上来再议)/ persistent team Agent+SendMessage(先做 W7 one-shot;Crew 黑板已覆盖协调语义)/ OS 级 FileProvider/NetworkExtension 沙盒(Windows 代价过大,W9 用进程级替代)。

**与路线图的关系**:W3+W6 就是 R3 已列的「run 持久化」「Memory v1」,本计划把它们展开到可执行;W4+W9 属 R4 治理线提前铺路;W1/W2/W5 是 HANDOFF 阶段A/C 的落实。执行前建议与 Andy 对齐一次本排序。

## 4. 依赖图与并行车道

```
W1 ──────────────┐(W1.T1 ChatPage 拆分是所有前端改动的地基,最先做)
W2 ──┬─ W5       │
     ├─ W6       ├──→ W7 ──→ (persistent team, 本轮不做)
W4 ──┴─────┬─────┘
W3 ────────┤(独立,可全程并行)
W8(需 W2/W4 的选择器契约,前端车道)
W9(需 W4;spec 已有,单独立项)
```

- 车道A(前端重):W1 → W8;车道B(引擎/接线):W2 → W5 → W6;车道C(数据):W3;车道D(治理):W4 → W9。W7 在 B/D 汇合后启动。
- 同一时刻只允许一个 W 改 `apps/desktop/src/styles.css`(追加到文件尾)与 `services/runtime/app/engine/`(引擎是共享地基,改动必须 TDD+两级复审)。

## 5. 分支与执行协议

- **前提**:当前 `feat/fe-refinement` 等三条 FE 分支未并 main(HANDOFF 问题10)。**本计划文档提交到 feat/fe-refinement;执行开工前先和 Andy 定合并策略**,然后每个 W 从当时的集成分支切 `feat/wb-w<n>-<slug>`,1 W = 1 分支 = 1 轮评审。
- 每 W 按 superpowers:subagent-driven-development:fresh implementer 按下钻文档逐 checkbox 实施 → 两级复审(契约符合性审 + 代码质量审)→ 原 implementer 修复。
- commit 约定:`feat(harness): W<n>.T<m> — <任务名>` / 前端 `feat(fe): …` / 纯接线 `wire(…)`。
- 每 W 收尾:四门全绿 + Playwright 实跑该 W 下钻文档「走查」节 + 截图归档 `docs/progress/`。

## 6. 全局验收(整轮完成的定义)

1. **Loop 现场对照**:Chat 发一个多步任务,能看到——权威步骤行(后端帧)、计划面板实时打勾、产物卡+画布、每条消息消耗/耗时 chip。与 WorkBuddy 截图 3/4 同构。
2. **分档生效**:Admin 可给 profile 标 tier;历史列表出现 lite 模型生成的标题;审计里能看到 aux 任务用的是 lite 档。
3. **重启存活**:杀掉后端重启,Chat/Create 历史仍在;同一 conversation 能续聊。
4. **权限可选**:composer 能选 default/readonly/bypass;readonly 下写工具不可见;default 下高危写触发通用审批卡(非报销页也能审)。
5. **压缩可见**:长对话触发 autocompact,trace 里出现压缩事件,上下文 % 指示在所有 surface composer 可见。
6. **记忆闭环**:chat 回答命中 Business Memory 时 trace 出现「记忆命中」;审计含 memory.hits;设置页可管理记忆。
7. **委派可见**(W7 完成后):一次委派在 trace 中呈现为可折叠子块;Crew 任务卡能点开真实 run trace。
8. 四门全绿 + 零 console error + 诚实性走查(零死按钮/假数据)。

## 7. 关键文件索引(全 W 通用,下钻文档各有细表)

| 关注点 | 位置 |
|---|---|
| 共享引擎(循环/暂停/步限) | `services/runtime/app/engine/agent_loop.py`(工具分派 ~210,CapabilitySuspend ~214-229,max_turns ~175/244)、`query_config.py:43` |
| 模型调用 chokepoint(压缩/审计挂点) | `services/runtime/app/harness_runtime.py:56-96`、`engine/streaming_model.py` |
| 上下文压缩(便宜层+预留断路器) | `services/runtime/app/context_compaction.py`(阈值 126-148,截断 196-243,断路器 48/71-83 未接) |
| 运行时配置(profiles/directives/skill) | `services/runtime/app/config.py`(model_profiles :63/93-106,agent_directives :64/108,memory 路径 :56) |
| Chat 编排/capability/工具注册 | `services/chat/app/{orchestrator,capability}.py`、`services/runtime/app/chat_tool_registry.py` |
| 记忆 store/路由 | `services/memory/app/store.py`、`services/api/app/routes/admin_governance.py:148-183` |
| 持久化范式 | `services/reimbursement/app/state_store.py`;内存 LRU:`services/runtime/app/run_registry.py:12-49` |
| Crew(黑板+空壳 worker) | `services/crew/app/{schemas,agent_worker,service}.py`、`services/api/app/routes/crew.py` |
| 工具风险分级投影 | `services/api/app/projections/tool_registry.py:78-139` |
| 沙盒(评审版) | `services/create/app/sandbox.py`;激活 block:`services/create/app/orchestrator.py:229-236`;探针 `services/api/app/projections/governance.py` |
| vendored 参考件(只读,按件移植) | `vendor/hermes-agent/agent/{title_generator,context_compressor,memory_manager,curator}.py`、`tools/delegate_tool.py` |
| FE 帧消费/trace | `apps/desktop/src/features/agentic/{agentStream.ts,agentTraceModel.ts,StageStepTrace.tsx}` |
| FE Chat(W1 要拆) | `apps/desktop/src/features/chat/ChatPage.tsx`(~600 行)、`{canvasModel.ts,CanvasPanel.tsx,chatTrace.ts}` |
| FE 壳/历史/设置 | `apps/desktop/src/AnnaShell.tsx`、`features/admin/{RuntimeStatusPage,ModelProfilesPanel}.tsx`、`features/agents/AgentCenter.tsx` |
| FE 审批(要抽通用) | `apps/desktop/src/features/reimbursement/ReimbursementPage.tsx:225-234,314-333` |
| FE 上下文指示(要全局化) | `apps/desktop/src/features/finance/ContextUsageIndicator.tsx` |

## 8. 型别与命名总约定(跨 W 一致性,冲突以此为准)

- 新 SSE 帧:`step`(W1)——`{ type:"step", phase:"analyze"|"tool"|"deliver"|"compact", intent:string, tool?:string, turn:number, agent_id?:string }`。
- 计划工具名:`plan.update`(引擎原生,W1);委派工具名:`agent.delegate`(W7);二者归 `services/runtime/app/engine/` 层,不归某个 surface。
- 模型档位:`tier: "lite" | "default" | "craft"`(W2,ModelProfile 新字段;命名与 WorkBuddy 对齐,便于讨论)。
- 权限模式:`permission_mode: "default" | "readonly" | "bypass"`(W4,run 级字段;v1 不做 plan 模式)。
- 会话续接:`conversation_id: str`(W3,ChatRun 新字段)。
- 辅助任务模块:`services/runtime/app/aux_tasks.py`(W2 建立,W5/W6 复用其 `run_aux_completion`)。
- 通用审批卡组件:`apps/desktop/src/features/agentic/ApprovalCard.tsx`(W4 从报销页抽出)。
- 审计事件命名沿用 `<域>.<对象>.<动作>`:`run.title.generated` / `context.autocompact.applied` / `memory.hits` / `agent.delegated` / `plan.updated`。
