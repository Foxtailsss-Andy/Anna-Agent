# Agent Harness 能力清单（Anna 的对标 Checklist）

> **三档参照**：**Grok Build = 标杆**（xAI 商业化 Rust harness，62 crate，实取自本机源码）·
> **Pi = 敏捷迭代基准**（最小可行 loop，792 行 agent-loop.ts + 4 工具）·
> **Waku = 中间态**（能力规模介于两者；**技术上独立 Python 实现，非基于 Pi**，它把 pi 当子进程工具调用）。
> **Anna 现状**列的判定依据 = better-harness 实测诊断（13 finding + 冻结五维），不是读码印象。
> 判定：**对比** = 已有，需与标杆比质量 · **建设** = 无，需新建 · **守住** = 我们领先，勿削。

## 记分板

| 档 | 项数 | Anna 已有 | 部分 | 缺 |
|---|---|---|---|---|
| A 内核循环 | 5 | 4 | 1 | 0 |
| B 能力面 | 7 | 1 | 2 | 4 |
| C 上下文与记忆 | 6 | 2 | 1 | 3 |
| D 治理与判断 | 5 | 3 | 1 | 1 |
| E 耐久与观测 | 5 | 3 | 2 | 0 |
| F 工程化 | 5 | 2 | 1 | 2 |
| **合计** | **33** | **15** | **8** | **10** |

---

## A · 内核循环（Anna 最强档，守住）

| # | 项 | Grok 标杆 | Pi 敏捷 | Waku 中间 | Anna 现状 | 判定 |
|---|---|---|---|---|---|---|
| A1 | ReAct 主循环 | `xai-grok-agent` + `xai-agent-lifecycle` | `agent-loop.ts` 792 行 | `loop/agent.py` 115 行 | `agent_loop.py` 374 行，流式+钩子 | **守住** |
| A2 | 终止守卫（轮次上限） | 有 | 有 | `max_iterations=10` | `max_turns=8`，可 0=无限 | **对比**：段级有，run 级无（→C4） |
| A3 | 工具错误处理 | retry.rs + circuit-breaker | `blocked → tool result` | surface-don't-crash | **F1 已修**：观察化回喂 | **守住** |
| A4 | 中途插话/转向 | `xai-interjection-core` | 无（TUI 层） | 无 | J3 插话，drain 在轮首 | **守住**（与标杆同级） |
| A5 | 提示队列 | `xai-prompt-queue` | 无 | 无 | 无 | **建设**（低优先，长程排队用） |

## B · 能力面（Anna 最弱档，北极星的前提）

| # | 项 | Grok 标杆 | Pi 敏捷 | Waku 中间 | Anna 现状 | 判定 |
|---|---|---|---|---|---|---|
| B1 | 命令执行（shell/bash） | `xai-grok-shell` ×3 crate + pty | `bash` 工具 | 无（委托 pi） | **无** | **建设 · P0**（F-01） |
| B2 | 文件写/编辑 | `xai-grok-tools/implementations` | `write` / `edit` | 无 | **无**（只读 read_file） | **建设 · P0**（F-01） |
| B3 | 检索（grep/glob/ls） | 有 + `xai-codebase-graph` | `find/grep/ls` 可选 | 无 | **无** | **建设 · P0** |
| B4 | 工具协议与运行时分层 | `xai-tool-protocol` + `tool-runtime` + `tool-types` + `tools-api`（**4 层**） | 单层（name+schema+fn） | 单层 registry 58 行 | 8 张域 registry，33 名，**实跑只 3 个** | **对比→重建**：收成 1 层统一 registry |
| B5 | 沙箱/隔离 | `xai-grok-sandbox` | **刻意不做**（"run it in a container"） | 无 | 无（workdir 牢笼 + 路径校验） | **对比**：Windows 无 OS 沙箱，收容=牢笼+ask（[[anna-grokbuild-teardown]] W9 佐证） |
| B6 | MCP / 外部连接器 | `xai-grok-mcp` | **刻意拒绝**（CLI+README 替代） | opt-in bridge | **有**（ERP/Hiker/报销三连接器） | **守住** |
| B7 | 子代理派遣 | `xai-grok-subagent-resolution` | **刻意不做** | `delegate_task` → pi 子进程 | `delegate.py` 原语在，只读、未接线 | **对比**：需 contained-write + 预算回卷 |

## C · 上下文与记忆（Anna 缺口最深档）

| # | 项 | Grok 标杆 | Pi 敏捷 | Waku 中间 | Anna 现状 | 判定 |
|---|---|---|---|---|---|---|
| C1 | 系统提示装配 | `xai-grok-config` 分层 | <1k token + AGENTS.md | SOUL.md + 时间 + 记忆 | Skill 正文+工具须知+workdir 清单+Boss 指令+时间 | **对比** |
| C2 | 项目约定文档 | 有 | **AGENTS.md 沿目录上溯** | SOUL.md（agent 身份） | **无** | **建设 · P1**：`ANNA.md`（身份）+ workdir `AGENTS.md`（约定） |
| C3 | 上下文压缩 | `xai-grok-compaction` | 无 | 窗口截断 | 双层（廉价+autocompact） | **守住**（实测从未触发≠没机制） |
| C4 | token 估算与预算 | `xai-token-estimation` | 无 | usage.jsonl 台账 | 单 run 内 usage 有，**无累计总闸** | **建设 · P0**（F-03） |
| C5 | 语义记忆（检索） | embedding + index + **MMR** + query_expansion | **刻意不做** | FTS5 + 检索门 | store 在，**chat 从不读** | **建设 · P1**（F-04） |
| C6 | 情景记忆 + 整理 | archive + **dream** 离线整理 | **刻意不做** | episodes + consolidation | run 历史全在库，**零回灌** | **建设 · P1** |

## D · 治理与判断（Anna 有独门长板）

| # | 项 | Grok 标杆 | Pi 敏捷 | Waku 中间 | Anna 现状 | 判定 |
|---|---|---|---|---|---|---|
| D1 | 权限模式 | 有（+ sandbox） | **刻意拒绝** | 无 | readonly/ask/full 字段在，**chat 无拦截点** | **对比→补拦截点**（F-01） |
| D2 | 审批门 HITL | 有 | 无 | 无 | `CapabilitySuspend` 在（报销用），chat 未接 | **对比**：+ `tool_approval` span |
| D3 | 判断层（计划/评估） | 生命周期钩子 | **刻意不做** | 无 | **PlanGate + Evaluator + 出境披露** | **守住**（三档独有） |
| D4 | 熔断与重试 | `xai-circuit-breaker` + retry.rs | 无 | 无 | 流式首 token 前重试 | **对比**：无熔断，长程需要 |
| D5 | 密钥与出境 | `xai-grok-secrets` | 无 | .env | J4 出境披露 + 零出境锁 | **守住** |

## E · 耐久与观测（Anna 第二强档）

| # | 项 | Grok 标杆 | Pi 敏捷 | Waku 中间 | Anna 现状 | 判定 |
|---|---|---|---|---|---|---|
| E1 | 会话持久化 | `xai-chat-state` + `xai-sqlite-journal` | **JSONL 会话树**（fork/时间旅行） | SQLite chat_log | run_store + frame journal（seq/可重放） | **对比**：无分支/时间旅行 |
| E2 | 中断恢复 | `xai-crash-handler` | 会话文件天然可续 | 无 | **`interrupted` 是终态**，产物蒸发 | **建设 · P0**（F-02） |
| E3 | Trace / Span | `xai-tracing` + macros | EventStream 四脸同源 | JSONL + 可选 OTel | **OTel span 树 + 瀑布 + 装配器 gate** | **守住**（三档最强） |
| E4 | 遥测与成本 | `xai-grok-telemetry` + mixpanel | 无 | **usage.jsonl 永久台账** | 单 run audit 有，**无跨 run 台账** | **建设 · P2** |
| E5 | agent 可读运行时 | `runtime_context` 挂 span | 无 | 无 | 数据在 span 上，**agent 读不到** | **建设 · P1**（F-09） |

## F · 工程化

| # | 项 | Grok 标杆 | Pi 敏捷 | Waku 中间 | Anna 现状 | 判定 |
|---|---|---|---|---|---|---|
| F1 | 扩展机制 | `xai-grok-hooks` + plugins-types | **extensions ~30 钩子**（registerTool / on tool_call 可 block） | 无 | loop 有 opt-in 钩子（handler 级，非用户级） | **对比**：无用户可写扩展点 |
| F2 | 技能机制 | 有 | SKILL.md 渐进披露 | SKILL.md + `create_skill` 自写 | 5 个 SKILL.md，**人写、5 周未动、0/24 run 用过** | **对比→修**（F-08 正文与工具面矛盾） |
| F3 | 包 / 市场 | `xai-grok-plugin-marketplace` | `pi install npm:/git:`，2100+ | 社区 skills 目录 | 无 | **建设 · P3**（开源后再议） |
| F4 | 评测在环 | 有（内部） | **刻意不做** | 确定性 + judge + release gate | **v0 套件 + cost per outcome + 证据链** | **守住** |
| F5 | CI 受理门 | 有 | 有 | `make gate` | **无 CI**（四门+11 gate 全靠人手） | **建设 · P2**（F-05） |

---

## 优先级合并（Checklist → 施工序）

| 优先 | Checklist 项 | 为什么是这个位置 |
|---|---|---|
| **P0-a** | E2 中断恢复 | 长程必遇中断；且 B1/B2 的审批续跑要踩它的 checkpoint |
| **P0-b** | B1 + B2 + B3 + B4 + D1 + D2 | 无手则一切无意义；工具面重建与权限/审批同批落地 |
| **P0-c** | C4 累计预算 | 有手之后无上限自耗才成真风险 |
| **P1** | C2 + C5 + C6 + E5 | 让第 N 次的教训带到 N+1；agent 能看见自己 |
| **P2** | F5 + E4 + F2 + D4 | 锁住绿灯、看清成本、修技能矛盾、长程熔断 |
| **P3** | A5 + B7 + E1(分支) + F1 + F3 | 长程成熟后的加速件 |

## 校准说明

1. **"刻意不做"不算缺陷**：Pi 拒绝 memory/evals/权限/子代理是它的设计取舍（"the orchestrator's job"）。
   Anna 的定位是 orchestrator，所以这些**必须做**——这正是 Anna 相对 Pi 的存在理由。
2. **不为对齐而对齐**：Grok 的 62 crate 有大量与 Anna 定位无关的项（TUI/pager/语音/更新/mermaid/announcements），
   本清单已剔除，只保留 harness 本体项。
3. **守住项不得回退**：A1/A3/A4/B6/C3/D3/D5/E3/F4 共 9 项是三档对照下 Anna 的领先或持平项，
   任何重构以"不回退这 9 项"为硬约束（回归锁 = 四门 + 11 gate + evals v0）。
