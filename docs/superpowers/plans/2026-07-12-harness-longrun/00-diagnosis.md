# Harness Runtime · 长时间运行轮 — 诊断与路线(提案)

> 2026-07-12 · Fable 5 · 基于 main(ed725da,Home 合并轮已入)代码侦察
> 目标(用户原话):攻克 Harness Runtime 的长时间运行问题,开始解决用户体验和 Anna 核心的内容。

## 一、诊断:今天的运行时在"长"字上的五个断点

| # | 断点 | 代码事实 | 用户感受 |
|---|---|---|---|
| D1 | **会话失忆(无多轮)** | ChatRun 只带单条 `message`(chat/app/schemas.py);capability 不拼任何历史;Home「追问」= 全新 run | 追问一句,Anna 不记得上一句——最直接的体验伤 |
| D2 | **重启即失(无持久化)** | `RunRegistry` = 进程内存 dict + max_runs 上限(runtime/app/run_registry.py);ChatRun/CreateRun/audit 全不落库 | 重启桌面 App,历史对话/构建记录清零 |
| D3 | **断线即死(run 绑死 SSE)** | 引擎在请求协程内驱动;client 断连 → `client_disconnected` → run 直接 failed(chat/orchestrator stream_run 注释明示不可恢复) | 关窗/切网,跑了十分钟的任务作废 |
| D4 | **长任务硬顶(无续办)** | `MAX_CHAT_MODEL_TOOL_ROUNDS = 8`(W1 刚从 4 提上来);顶到 = `tool_loop_exhausted` 失败;autocompact 的 LLM-summary 层留了 seam 未接模型(context_compaction.py 注释) | 复杂任务跑一半被预算杀死,只能重来 |
| D5 | **并发未闸(架构欠账)** | 2026-06-28 拍板「异步无状态并发+速率闸」,现状 orchestrator 每请求驱动、无队列无速率闸;多 run 并行未压测 | 多开任务时互相拖慢/踩配额 |

**已经健全的**(不用重做):cheap compaction 已在 streaming_model 每次调用生效(带 `context.compaction.applied` 审计);retryable 错误分类;审批门原语;帧契约与前端观测(本轮刚打通)。

## 二、路线提案(按用户体验痛感排序,每片独立可交付)

- **L1 · 会话连续性(多轮 Chat)** —— run 升级为「会话内的一轮」:引入 `thread_id`(会话),同会话历史消息(user/assistant 对)拼进下一轮请求,交给已就位的 cheap compaction 吃长度;Home 前端会话态天然就绪(同页追问);审计记录 thread 关联。**最小改法**:ChatRun 增 thread_id + orchestrator 组装历史;不动引擎。
- **L2 · Run 持久化** —— ChatRun/CreateRun + audit_events 落 SQLite(照 reimbursement state_store 惯例);RunRegistry 换双写;侧栏历史/产物中心跨重启长存。(= 旧 B3 前半)
- **L3 · 后台运行 + 断线恢复** —— run 与 SSE 解耦:提交即入后台任务(asyncio task + 帧序列落库),SSE 变「订阅」(`GET /runs/{id}/stream?from_seq=n` 重放+续传);关窗不杀任务,回来接着看;前端 useRunStream 加重连。**这是"长时间运行"的核心件。**
- **L4 · 长任务续办与压缩深化** —— max_turns 顶到 → 不 fail 而 suspend(「预算用尽 · 续办?」审批卡语法);autocompact LLM-summary 层接真模型;上下文环>80% 的前端警示已就绪。
- **L5 · 并发与稳定性** —— 每 workspace 并发闸 + 模型调用速率闸;多 run 并行压测;Electron runtime 崩溃后 run 恢复(依赖 L2/L3)。

**推荐执行顺序 L1 → L2 → L3 → L4 → L5**:L1 最小改动、体验增益最大;L2 是 L3 的地基;L3 兑现"长时间运行";L4/L5 收尾核心化。每片四门 + 真流验证,惯例同前。

## 三、边界

- 不动帧契约 v1→v2 大迁移(仍按 10-backend-roadmap 的 B1 节奏另议);前端仅 useRunStream 重连与会话态小改。
- Cowork 面不动;Crew/多用户并发不在本轮。
