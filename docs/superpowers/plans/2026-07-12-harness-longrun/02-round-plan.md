# Harness Runtime 长时间运行轮 · 执行计划

> 2026-07-12 · Fable 5 · 基于:00-diagnosis(D1-D5/L1-L5)+ 01-eval-guide(P1-P5/gate 规格)+ Anthropic《Harness design for long-running apps》+ forge-harness reference(Desktop/harness-reference/forge-harness/,10 章)
> 立场:**有现成的不重新开发**——本轮每一片先指认参考图纸,再写最小接线;eval-first,每片先写 gate 再写实现。

## 0. 对齐结论(证据都来自本次 main 码检,file:line 可查)

### 0.1 上一轮 WorkBuddy 吸收(W1-W9)再审视

| 项 | 当时判断 | 今天(main)事实 | 裁定 |
|---|---|---|---|
| W1 Loop 可观测(step 帧/plan.update/usage/轮上限8) | 最高优先 | **已全部存活在 main**:engine/plan_tool.py ✅、StepEvent×5 处 ✅、chat orchestrator:40 `MAX_CHAT_MODEL_TOOL_ROUNDS=8` ✅、harness_runtime:123 model.call.completed ✅ | ✅ 已落地,本轮直接受益(观测是长跑的仪表盘) |
| W3 持久化+多轮 | T1 梯队 | chat schemas 无 thread/conversation 字段;RunRegistry=OrderedDict 内存(run_registry.py:4-24) | **= 本轮 L1+L2,主菜** |
| W5 autocompact | T1 梯队 | context_compaction.py:24-25/45-46/73-75 —— LLM-summary 层 seam+断路器常量已从 forge 参考搬入,注释明言"later slice" | **= 本轮 L4,按 03 章图纸接上** |
| W4 权限模式 | T1 梯队 | B2/B3 已给 **create** 面落了 permission_mode 参数链+workdir read 工具(0b58de1);未推广 | 部分已落;全面推广**不在本轮**(非长跑核心) |
| W2 模型分档/辅助小模型 | T1 梯队 | 未做 | **不做**。L4 摘要就用当前主模型(简单方案);分档留待有真实成本压力时 |
| W6 记忆闭环 / W7 SubAgent+Crew / W9 沙盒 | T2/T3 | 未做 | 不在本轮(R3/值守轮/Code 轮的事) |
| W8 Composer 命令中枢 | T2 | 前端已被 Iris+Home 重建覆盖 | **作废**(计划过时,勿再引用) |

### 0.2 forge-harness reference 使用清单(回答"现成代码用上了么")

| 章 | 内容 | 使用状态 |
|---|---|---|
| 02 agent-loop / QueryConfig / RunState | 主循环结构、不可变配置+State 重写 | ✅ 已移植(engine 各文件 docstring 自证) |
| 03 context-compaction | 五层压缩顺序、阈值族、断路器、autocompact 完整逻辑 | ◐ 便宜层+常量已移植;**LLM-summary 层本轮 L4 移植**(compact 调用+post_compact_messages 重建+tracking 传递,图纸=03 章 auto_compact.py 全文) |
| 01 orchestration | submit_message 单轮组装;messages 数组随 session 延续 | ◐ 组装模式已同构;**L1 按同款把历史 messages 拼进下一轮** |
| 04 tools | 读并行/写串行、fail-closed 默认 | ◐ fail-closed 已同构;读并行/写串行**L5 参考**(并发闸的工具侧纪律) |
| 05 memory / 06 hooks / 07 sandbox / 00 system-prompt | — | 货架上,本轮不动(对应记忆轮/治理轮/Code 轮) |
| 08 evaluation | 验证专员 subagent prompt | 货架上;正式评测期(01-eval Part II)取用 |
| vendor/hermes-agent | 传输层模式已借;ContextCompressor 等 | **不再作为压缩图纸**——03 章是更对口的唯一蓝本,避免双源(推翻上一轮"搬 hermes ContextCompressor"的想法) |

### 0.3 外部标准 ↔ 本轮路线映射

诊断的 L1-L5 与评测文档五支柱、官方文章逐条对得上,路线不变:

| 断点→切片 | 支柱 | 官方依据 |
|---|---|---|
| D1→L1 会话连续性 | (task horizon 前提) | 文章:结构化交接/连续 session;reference 01 章 messages 延续 |
| D2→L2 持久化 | **P2 状态外置** | Effective harnesses:「任何时刻冷重启都能恢复现场」 |
| D3→L3 后台运行+断线恢复 | **P3 恢复力** | 「任意时点断连,任务不判死」 |
| D4→L4 压缩深化+续办 | **P1 上下文治理** | 「任意时长任务不因窗口耗尽失败」;03 章图纸 |
| D5→L5 并发闸 | **P4 环境中介**(并行隔离项) | 「并行 run 之间状态隔离」;04 章读并行/写串行 |

## 1. 执行计划(L1→L5,eval-first)

**通则**:每片 = ①先写 gate(pytest,`tests/gates/test_gate_<支柱>.py`,单任务/单次/代码判分/分钟级,红)→ ②最小实现(TDD)→ ③四门+gate 绿 → ④真流走查。分支 `feat/harness-longrun`,每片 1-2 commit。帧契约只增不改;诚实性红线;不动 Cowork 面。

### L1 · 会话连续性(多轮 Chat)
- **Gate(先写)**:三轮引用测试——同 thread 发「记住数字 47」→「它加 3 是多少」,第二轮请求的 messages 必须含第一轮 user/assistant 对(fake model 断言),终态 ready。
- **改什么**:`ChatRun += thread_id`(首轮=自身 run_id);`POST /api/chat/runs[/stream]` 收 `thread_id`;orchestrator 组装同 thread 历史(user/assistant 对,近 N 轮,交给既有 cheap compaction 吃长度);审计 `chat.thread.continued {thread_id, prior_turns}`。**不动引擎**(reference 01 章同款:历史进 messages,组装在 harness 层)。
- **前端**:Home 追问带 thread_id + 会话内历史渲染(最小改)。
- **验收**:真流两轮追问,第二轮回答引用第一轮事实;trace 可见 thread 关联。

### L2 · Run 持久化(P2)
- **Gate P2**:跑一条 run 至终态 → 新建 store 实例(模拟重启)→ list/get 原样还在(含 audit_events/plan/artifacts 元数据)。
- **改什么**:`services/runtime/app/run_store.py`(SQLite,`.anna/state/anna-runs.sqlite3`,照 reimbursement state_store 惯例:save/get/list,UPSERT,surface 维度);chat/create 终态 write-through,list/get 路由内存 miss 落库查;thread 历史组装(L1)改从 store 读——**L1 落地后立刻切换,避免双源**。
- **验收**:杀 uvicorn 重启,侧栏历史/产物中心还在;同 thread 续聊仍通。

### L3 · 后台运行 + 断线恢复(P3,本轮核心件)
- **Gate P3**:发起 run → 流到一半杀 SSE 连接 → run 继续跑完(终态 ready 落库)→ `GET /runs/{id}/stream?from_seq=n` 重连,重放缺失帧后续传到 done。
- **改什么**:run 与请求协程解耦——提交即 `asyncio.create_task` 入后台,帧写「帧日志」(内存 ring + 落库 seq 序列,复用 L2 的库);SSE 端点变订阅者(from_seq 重放+实时续传);client 断连只关订阅不杀 run(删除 orchestrator:231-240 的 client_disconnected 判死路径);停止按钮 = 显式 `POST /runs/{id}/stop`(区别于断线)。
- **前端**:`useRunStream` 重连(EventSource onerror → 指数退避 → from_seq 续订);关窗重开能回到跑动中的 run。
- **验收**:真流跑长任务,关窗 10 秒重开,进度衔接、终态正常;停止按钮仍即时生效。

### L4 · 长任务续办 + autocompact(P1)
- **Gate P1**:喂必然超阈值的长历史 → 任务不因窗口失败,审计出现 `context.autocompact.applied`,压缩后模型仍能引用早期关键事实(fake 模型断言 summary 消息在场);Gate 续办:max_turns 顶到 → run 进 `awaiting_continue`(不 fail)→ `POST /runs/{id}/continue` → 跑完。
- **改什么**:①按 03 章图纸接 LLM-summary 层:`compact_conversation`(主模型单发,摘要 prompt 含「已完成勿重做」)+ `build_post_compact_messages` 重建 + `AutoCompactTrackingState` 传递/重置/断路(常量已在);挂在 streaming_model 既有 cheap 层之后,阈值沿用已移植的 forge 常量;②max_turns 耗尽路径从 `tool_loop_exhausted` fail 改为 suspend(复用审批门原语的暂停语法,「预算用尽·继续?」),continue 端点复用 run 状态机。
- **验收**:真流长任务触发压缩(临时调低阈值)后回答仍记得早期实体;顶轮次后前端出现续办卡,点继续跑完。

### L5 · 并发与稳定性(P4 并行隔离)
- **Gate P4**:并发发起 4 条 run(两 workspace)→ 全部终态正常、审计无串扰(每 run 的 audit_events 只含自己的事件)、超过闸值的 run 排队而非报错。
- **改什么**:每 workspace 并发信号量 + 模型调用速率闸(简单令牌桶,配置 `runtime.json → concurrency`);排队状态入帧(`queued` 事件);多 run 并行 pytest 压测(线程/asyncio 混合路径)。
- **验收**:多开任务互不拖死;闸值行为可观测。

## 2. 协议

- **执行方式**:沿用 subagent-driven——Fable 5 出任务简报/验收把关,Opus 4.8 实施,每片两级复审 + 四门(tsc/vitest/build/pytest)+ gate + 真流走查(dev 双服务:uvicorn 带 `ANNA_RUNTIME_CONFIG_PATH` + vite;走查踩坑备忘:composer 是 Ctrl+Enter 发送)。
- **gate 纪律**:gate 文件进 `tests/gates/`,CI 常跑;已完成支柱的 gate 在后续片合并前必须保持绿(防退化,eval 文档红线的开发期版)。
- **正式评测(Phase 0 全量)不阻塞本轮**:TB2.0 Harbor adapter、scorecard 首跑等按 01-eval Part III 另开工作流,在 L 轮收口后启动;本轮只交付五个 smoke gate。
- **顺序**:L1→L2→L3→L4→L5 严格串行(依赖链);单片内 TDD 步不许跳。

## 3. 本轮不做(防蔓延)

帧契约 v1→v2 迁移 / Cowork 面改动 / Crew 与多用户 / 模型分档与辅助小模型 / 记忆系统 / SubAgent / 沙盒硬化 / MCP 自助添加 / 进程级崩溃恢复(L2 保证记录不丢+诚实标记 interrupted,进程内恢复到此为止;Electron 崩溃自动续跑属后续轮)。
