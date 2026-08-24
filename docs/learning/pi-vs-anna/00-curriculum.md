# Pi ↔ Anna 源码对照学习 · 课纲

> 2026-07-24 开课。目的:彻底弄明白 runtime 运行原理,能指出 Anna 的问题在哪、如何优化。
> 学习期**不开发、不提交**;`feat/judgment-round` 暂停于 J2(bdf2040),J3/J4 待续。

## 教材与教法

- **对象**:[earendil-works/pi](https://github.com/earendil-works/pi),本地克隆于 `<pi-checkout>`(depth 1)。
- **参考书**:[dg-ai-notes.pages.dev](https://dg-ai-notes.pages.dev/) 十章源码精读(ch01 定位 / ch02 三层架构 / ch03 Agent Loop / ch04 模型调用 / ch05 工具 / ch06 消息 / ch07 事件驱动 / ch08 上下文工程 / ch09 压缩 / ch10 会话)。
- **教法**:不复述书。① 真源码为最终裁判,引用带 `文件:行号`;② 术语规范化,给契约原文;③ 每课末尾做 Anna 对照。
- **纪律**:不用比喻和类比;基于专业名词与真实代码。

## ★ 正式授课载体(2026-07-24 定稿)

应用户要求,全部课程已整理为一组**本地自包含 HTML**(桌面文件夹,双击即开,含互动演示与动画):

`<anna-runtime-school-checkout>/`
- `index.html` 学习地图 + L1 地基课 + 判卷讲评 + 消息数组互动演示 + 词汇表
- `02-two-loops.html` 两个主循环逐行对照(runLoop vs AgentLoop.run,循环动画)
- `03-model-layer.html` 模型调用层(SSE/累加器/重试铁律/错误即值)
- `04-tools.html` 工具系统(五段管线 vs fail-closed 白名单,治理立场)
- `05-events.html` 事件与帧(EventStream vs FrameJournal,UI=折叠,帧序动画)
- `06-context.html` 上下文工程与压缩(双层压缩 vs 摘要压缩)
- `07-sessions.html` 会话持久化与恢复(JSONL 树 vs SQLite 双表)
- `08-verdict.html` 终课判词:A 榜(Anna 领先 6 项)+ B 榜(9 条带行号的优化清单 P0-P2)

本目录的 md(00/01)保留为源码级附录;后续答疑与勘误回到对话进行。

## 课程表

| 课 | 对应书章 | 内容 | 讲义 | 状态 |
|---|---|---|---|---|
| L1 | ch01-03 | 定位 / 三层架构 / 主循环解剖 | [01-architecture-and-loop.md](01-architecture-and-loop.md) | ✅ 2026-07-24 |
| L2 | ch03 收尾 | 两个主循环逐行对照:`runLoop` vs `AgentLoop.run`;`Agent` 类 vs Anna orchestrator | | |
| L3 | ch04 | 模型调用层:pi-ai 流式协议 vs `streaming_model.py`;错误即值契约 | | |
| L4 | ch05 | 工具系统:定义/校验/执行/拦截 vs Anna toolset + MCP + 治理门 | | |
| L5 | ch06-07 | 消息模型与事件驱动:`AgentMessage` 联合类型、`EventStream` vs Anna 帧协议 + 前端折叠 | | |
| L6 | ch08-09 | 上下文工程与压缩:两段变换 vs Anna compaction | | |
| L7 | ch10 | 会话:存储/恢复/分叉 vs Anna run_store + 长跑轮成果 | | |
| 终课 | — | 结构性差异总清单 → 问题定位与优化判词 | | 出口 |

## 两边的核心锚点

| 关切 | Pi(`Desktop\pi`) | Anna |
|---|---|---|
| 主循环 | `packages/agent/src/agent-loop.ts`(792) | `services/runtime/app/engine/agent_loop.py`(347) |
| 事件/钩子契约 | `packages/agent/src/types.ts`(437) | `services/runtime/app/event_stream.py` + `engine/capability.py` |
| 产品注入 | `AgentLoopConfig` 10 钩子 | `CapabilityHandler` 协议 |
| 模型层 | `packages/ai` | `engine/streaming_model.py`(486)+ `model_provider.py` |
| 工具 | `coding-agent/src/core/tools/` | `*_tool_registry.py` + `toolset.py` |
| 高层封装 | `agent/src/harness/agent-harness.ts`(1084) | `harness_runtime.py` + `harness_catalog.py` |
| 压缩 | `transformContext` + `core/compaction/` | `context_compaction.py` + `autocompact.py` |
| 会话 | `core/session-manager.ts` | `run_store.py` + `run_registry.py` |
| 插话 | `getSteeringMessages`(一等公民) | J3(未实现) |
| 治理 | **无**(README 明示,靠容器化) | 自有治理层(gates、J1 PlanGate、J2 Evaluator) |
