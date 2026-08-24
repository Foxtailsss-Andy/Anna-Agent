# Anna PRD v2 · 可观测的长程 Agent Runtime

> **取代**：PRD v1.0 / v1.1 / MVP 架构（已移 `docs/archive/`，仅历史可查）。
> **能力地图** = [Agent Harness 能力清单](harness-checklist.md)（33 项 · 三档对标 Grok/Pi/Waku）。
> **术语契约** = 根 [CONTEXT.md](../../CONTEXT.md)。**诊断依据** = better-harness 实测（13 finding + 冻结五维）。
> **实施规格** = [Agent Rebuild SPEC](../superpowers/plans/2026-08-06-agent-rebuild/00-spec.md)。

## 1. 产品定义

**Anna 是一个可观测的长程 Agent Runtime。**

一个 Agent（Anna 本体 = 身份 + 判断层 + 记忆），在权限约束下用工具持续工作数百轮，
全程 Trace 可见、中断可续、花费有闸、结果可被评测集判真。个人 AGI 方向研究项目，拟开源。

**不是**：ERP 助手、工作流引擎、多租户 SaaS。ERP / Hiker / 报销是 **connector 演示件**，不是产品组成部分。

## 2. 三档对标定位

| 档 | 角色 | 我们怎么用 |
|---|---|---|
| **Grok Build** | **标杆**（xAI 商业 harness，62 crate） | 能力清单的**完备性来源**——它有而我们没有的项，逐项判"建设/不适用" |
| **Pi** | **敏捷迭代基准**（792 行 loop + 4 工具） | **最小可行形态与迭代节奏**的标尺；其工具语义直接移植（Python 原生重写） |
| **Waku** | **中间态**（能力规模居中；**技术上独立 Python 实现，非基于 Pi**——它把 pi 当子进程工具） | 证明"orchestrator 该长什么样"的中量级样板：记忆三支柱 / 检索门 / release gate / usage 台账 |

**Anna 的定位**：做 Pi 明确拒绝做的那一层（memory / evals / 判断层 / 子代理编排 = "the orchestrator's job"），
同时保持 Pi 级别的迭代速度，向 Grok 的完备度收敛。

## 3. 北极星（唯一）

**在 Trace 全程可见的前提下，跑完一个多百轮的开发闭环任务。**

从一句需求到测试全绿：工具失败自纠、上下文自压缩、被中断能续办、花费撞总闸挂起而非死亡、交付前过判断层。
量化：L 系列长程评测通过率 + better-harness 五维环比 + cost per outcome。

## 4. 现状基线（2026-08-06 冻结）

**Checklist 记分板**：33 项中 **已有 15 · 部分 8 · 缺 10**
**better-harness 五维**：任务理解 62 · 可控执行 71 · **改动验证 48 · 可靠交付 41** · 经验沉淀 52

**一句话**：**内核循环与观测判断是三档对照下的领先项；能力面与记忆是三档对照下的垫底项。**
实测最长 7 轮、上下文只用 2%、19 条 trace 只出现 3 个工具名、跨 run 零状态传递、中断即报废。

**9 个守住项**（不得回退）：ReAct 循环 · 工具错误观察化 · 插话 · MCP 连接器 · 双层压缩 ·
判断层 · 出境披露 · OTel Trace · 评测在环。

**10 个建设项**（按 checklist 优先级）：中断恢复 · 命令执行 · 文件写编辑 · 检索 · 累计预算 ·
项目约定文档 · 语义记忆 · 情景记忆 · agent 可读运行时 · CI 受理门。

## 5. 产品支柱

| # | 支柱 | Checklist 锚 | 现状 → 目标 |
|---|---|---|---|
| **P0** | 观测与判断（**守住**） | A1/A3/A4 · D3/D5 · E3 · F4 | 领先 → 补 `tool_approval` span + agent 可读 |
| **P1** | 行动面 | B1/B2/B3/B4 · D1/D2 | 无 → 有（含权限模式与审批门） |
| **P2** | 耐久性 | E2 | 中断即报废 → 可续办 |
| **P3** | 总预算 | C4 | 无 → 累计不重置 |
| **P4** | 记忆 | C2/C5/C6 · E5 | 无 agent 记忆 → 三支柱 + `ANNA.md`/`AGENTS.md` |
| **P5** | 受理门 | F5 · E4 | 无 CI → 绿灯被锁住 |

### Memory 专章（本轮认定：Anna 今天没有 agent 记忆）

实证：`services/memory` 是 `BusinessMemoryItem` CRUD（业务数据库，非 agent 记忆）；chat 只写不读；
系统提示词全部 per-run 即用即弃；**无 SOUL.md / AGENTS.md / CLAUDE.md 等价物**——
Anna 进入工作目录读得到文件清单，**读不到项目约定**。

目标形态（Grok 结构为蓝图，Pi 惯例为接口）：

| 支柱 | 内容 |
|---|---|
| procedural | `ANNA.md`（自身身份/偏好，可提议自更新，经批准入库）+ **workdir `AGENTS.md` 沿目录上溯** |
| semantic | 先接既有 store（finance 样板），再升检索门 → embedding/MMR/query expansion |
| episodic | 过往 run 可检索并回灌（今天数据全在库，零回灌） |
| 整理 | 每 N 轮蒸馏 + 离线整理（Grok `dream` 形状） |

## 6. 场景与非目标

**主场景** = 长程开发任务（一句需求 → 自主建→跑→改→复跑 → 测试全绿）。次场景 = 问答与数据格接。
**非目标**：多租户 / 商用化 / 域功能扩张 / 新 UI 设计 / 把 Anna 变成编码 CLI（Anna 是 runtime，编码是它的能力之一）/
为提分做特化优化（**分数是结果不是目标**）。

## 7. 发布判据

L 系列长程 case 通过为发布前提；确定性评测回归 0 容忍；pass^k 下降 >2pp 阻发布；
每次发布出 better-harness 五维环比 + checklist 记分板环比。

## 8. 旧世界处置

PRD v1.x + MVP 架构 → `docs/archive/`。域服务（finance/hiker/reimbursement/associate）随 SPEC 分批
退役为 connector + run profile。本文件 + `harness-checklist.md` + 根 `CONTEXT.md` = 当前唯一产品权威。
