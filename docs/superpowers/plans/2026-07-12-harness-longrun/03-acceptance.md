# Harness Runtime 长跑轮 · 验收记录

> 2026-07-13 · 分支 `feat/harness-longrun`（base main 8306165）· eval-first + subagent-driven（Fable 5 把关 / Opus 4.8 实施 / 每片两级复审）
> 计划见 [02-round-plan.md](02-round-plan.md)。本文件是收口验收：五片各自交付什么、gate 是什么、真流证据是什么。

## 测试基线（四门 + gate）

| 门 | 入轮基线(main) | 收轮 |
|---|---|---|
| pytest | 622 | 709 (+87) |
| vitest | 122 | 146 (+24) |
| tsc --noEmit | 0 error | 0 error |
| build | ✓ | ✓ |
| tests/gates/ smoke gate | — | 6/6 绿（thread / P2 / P3 / P1 / continue / P4） |

每片 eval-first：先写 `tests/gates/` 的分钟级代码判分 gate（RED），再实现（GREEN）；已完成支柱的 gate 在后续片必须保持绿（防退化）。

## 逐片验收

### L1 · 会话连续性（多轮 Chat）
- **交付**：`ChatRun.thread_id`（首轮自指）；`POST /api/chat/runs[/stream]` 收 `thread_id`；orchestrator 在 harness 层组装同 thread 近 6 轮 user/assistant 对（跳过失败轮），不动引擎；审计 `chat.thread.continued`；前端 Home 追问延续 + 「会话第 N 轮」chip（仅真证据渲染）。
- **gate**：`test_gate_thread_continuity.py` — 第二轮 model 请求含第一轮 QA 对，事件仅现于续轮。
- **真流证据**：API 两轮 47→50（记住 47，加 3 得 50）；浏览器两轮追问 chip「会话第 2 轮」+ 答案 50，0 pageerror。截图 `docs/progress/hl-l1-*.png`。
- commits `00a12b8`(RED) `0f3bbb7`(GREEN) `1661c5c`(FE)

### L2 · Run 持久化（P2 状态外置）
- **交付**：`run_store.py`（SQLite `anna-runs.sqlite3`，WAL）；chat/create 终态 write-through；list/get 内存 miss 落库；重启清扫非终态→`interrupted`；计数器从 store 最大序号种子化（防重启重铸 id 覆盖持久化 run）。L1 历史组装切库源。
- **gate**：`test_gate_p2_restart.py` — 终态 run 经模拟重启后 list/get 深等，非终态→interrupted。
- **真流证据**：杀 uvicorn 重启后 `GET /runs` 仍列出 run；跨重启续同 thread 答「PLUM」，新 run 铸 chat_run_002 不覆盖。
- commits `e5f194e`(RED) `634f6d6`(GREEN)

### L3 · 后台运行 + 断线恢复（P3 恢复力，本轮核心件）
- **交付**：run 与 SSE 解耦——`POST /runs/submit` 即时返回 + 后台 asyncio 任务；帧日志 `frame_journal.py`（内存 ring 4096 + 落库 seq，每帧 additive `seq`）；`GET /runs/{id}/stream?from_seq=N` 可续订（回放 >N 再实时跟随，终态关闭）；`POST /runs/{id}/stop` 显式停止（区别于断线）；client 断连只关订阅不杀 run。前端 submit+订阅+指数退避重连状态机 + 续看跑动中任务 + 停止指令失败诚实提示。
- **gate**：`test_gate_p3_disconnect.py` — 掉订阅后 run 跑完 ready，from_seq 续订 seq+1 无缺无重到 done，无 client_disconnected。
- **真流证据**：API 掉线于 seq5 → run 存活 ready → from_seq=5 续订收 76 帧从 seq6 连续到 done；浏览器发长诗任务→硬刷新→历史打开跑动中 run→实时续到「诗完」完成，0 pageerror。截图 `docs/progress/hl-l3-*.png`。
- commits `c91bed1`(RED) `94ba2a6`(GREEN) `00fc795`(WAL) `2ce76d4`(FE) `0e971f6`(stop 诚实)

### L4 · 长任务续办 + autocompact（P1 上下文治理）
- **交付**：按 forge-harness 03 章图纸接 LLM-summary 压缩层（`autocompact_messages`：阈值→摘要中段→`<conversation_summary>`重建，5 段模板含「已完成勿重做」，断路器 MAX=3 退回便宜截断，成功重置 tracking）；summarize 走当前主模型单发无工具；挂两个 chokepoint（call_model 同步 + streaming_model 异步）。max_turns 耗尽从 fail 改 `awaiting_continue` 挂起（引擎 `suspend_on_exhaust` opt-in，默认关字节等价）；`POST /runs/{id}/continue` 从 `suspended_messages` + 续办 nudge 恢复，seq 跨挂起连续（`max_frame_seq+1`）；`awaiting_continue` 不被清扫、跨重启可续。前端续办卡 + 挂起识别（不误触重连）。
- **gate**：`test_gate_p1_context.py`（超阈值 run 完成 ready + 压缩事件 + 摘要携早期事实 + 中段缺席 + 断路器兜底）；`test_gate_continue.py`（烧穿→awaiting_continue→continue→ready，seq 连续，清扫跳过）。
- **真流证据**：autocompact 真模型触发两次（before/after 审计），压缩后仍答出早期事实 FIREFLY-9 / 88000 SGD；真模型 10 项计划烧穿 8 轮→awaiting_continue{turns_used:8}→continue→10/10 完成。
- commits `a888023`(RED) `e4c6cb0`(GREEN) `f6b8b6f`(中段断言) `014ff14`(FE)

### L5 · 并发与稳定性（P4 并行隔离）
- **交付**：`concurrency.py` — `WorkspaceRunGate`（每 workspace asyncio 信号量，`acquire→waited`）+ `ModelCallBucket`（线程安全令牌桶，calls/min+burst，只延不拒，同步/异步双用）；`run.queued` 于排队开始时审计+入帧（订阅者实时可见），状态仍 generating；continue 重新竞争槽位；桶挂三 chokepoint（含 L4a summarize）；`runtime.json → concurrency` 默认 3/30（单用户零影响）。
- **gate**：`test_gate_p4_concurrency.py` — 单槽下每 workspace 第二 run 带 run.queued、跨 workspace 不互阻、审计零串扰、每 run seq 从 1 连续。
- **真流证据**：单槽配置下 A 无排队 ready、B 带 1 run.queued 后 ready 答 SECOND-DONE、审计隔离干净。
- commits `acbfea1`(RED) `24decef`(GREEN)

## 终审（全分支 opus）

任务级五片全过审后，全分支终审（16 commit）仍抓出两个跨片问题——**印证两级复审的价值**：
1. **帧日志活回填 gap**（Important）：run 超 4096 帧 ring 时，重连回填期间 ring 淘汰过快 → 活订阅视图静默跳帧（持久化完整）。修复 `f77b66f`：gap 检测→回磁盘重读。
2. **落库读路径无逐行防御**（Important）：单坏行使整个 surface 历史 500。修复 `f77b66f`：五处 rehydrate 逐行 try/except（对齐 frames 路径）。
3. 修复①又被终审二次抓出**死循环边界**（gap 帧磁盘也缺失时零挂起点空转→事件循环挂死，比原静默跳帧更险）→ stall guard `45e1276`（backfill 无进展则诚实跳过不可恢复帧，服务 ring 而非空转；测试用 fuel 上限把任何回归转成快速失败而非挂死 CI）。三级抓错链（任务级绿→全分支抓 gap→修复引入更险边界→再抓 stall）是本轮工程纪律的最强证据。

Minor triage：绝大多数 ACCEPT（默认配置下透明 / 单用户桌面无碍 / 参考实现亦无），少数一行级 fast-follow 已折进修复波（threadIdRef 清理 / 续办卡 hint 措辞 / conftest tracker 重置）。

## 本轮不做（守边界，未越界）
帧契约 v2 迁移 / Cowork 面 / Crew 与多用户 / 模型分档辅助小模型 / 记忆系统 / SubAgent / 沙盒硬化 / MCP 自助添加 / 进程级崩溃自动续跑（L2 保证记录不丢 + 诚实 interrupted，进程内恢复到此为止）。

## 走查环境备忘（接手必读）
- dev 后端必须 `ANNA_RUNTIME_CONFIG_PATH=<repo>/.anna/runtime.json`（否则 model_not_configured）；chat 需 demo-erp :8970 在跑（否则 mcp_call_failed，且 nohup 子进程随会话中断反复被杀，走查前先重启）；composer 是 **Ctrl+Enter** 发送；vite 探活用 `http://localhost:5173`（IPv6）；身份头 ws_crew_demo / acc_boss。
- 压缩/并发走查用 `.anna/runtime.json` 的副本改 `model_context_window` / `concurrency.per_workspace_runs`，配置路径隔离 state 目录到 scratchpad，不污染真库。
