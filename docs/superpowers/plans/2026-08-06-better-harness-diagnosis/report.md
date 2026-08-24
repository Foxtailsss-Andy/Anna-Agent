# better-harness 双路诊断 Anna · 统一报告（2026-08-06）

> 评测框架 = QoderAI/better-harness（唯一判断依据，实操跑得，非读码臆断）。
> 结构化发现全文 = 同目录 `findings.json`（13 条：4 High / 6 Medium / 3 Low，每条含
> evidence / impact / expected output / scoped repair / acceptance）。
> Route A 原生产物：`routeA-evidence-bundle.json`、`routeA-render/report.md`（渲染器 validate: pass）、
> `routeA-doctor.json`、`routeA-analyze.json`、`routeA-usage-summary.json`。

## 冻结维度分数

任务理解 **62** · 可控执行 **71** · 改动验证 **48** · 可靠交付 **41** · 经验沉淀 **52**

## Route A（原生 CLI，实操佐证）

跑通：evidence-bundle（exit 0，三 lane + lead 全 available）、doctor（exit 2 partial，PLUGIN_NOT_INSTALLED）、
usage-summary（38 sessions / 16,901 responses）、`harness render --validate` → **pass**。
显式不可得：**Anna 不在框架 provider 矩阵**（qoder/codex/claude/cursor/qwen/copilot/pi/kimi/workbuddy/grok），
无适配器能读 Anna 自己的 journal —— Route A 结构上测的是"Claude Code 开发 Anna"这层，不是"Anna 跑自己的 loop"。
0 资产计数属实（无 .claude/skills、无 AGENTS.md/CLAUDE.md）。`--include-memories`/`--include-user-home` 未授权未传。

## Route B 主诊断 · Top 5（全文见 findings.json）

1. **无执行面**——8 个 registry 共 33 个工具名，零 shell/write/search/test；19 条 trace 只出现过 3 个工具名 → 任何 episode 都无法闭合验证环（chat_tool_registry.py:22-29）。
2. **中断 run 不可恢复且飞行中产物蒸发**，而 trace 仍声称它们存在（run_store.py:234-275 + routes/chat.py:151-152 + capability.py:305-316）。
3. **无总预算**——max_turns 每次续办重置，无累计轮数/token/墙钟上限（query_config.py:58、orchestrator.py:834,900）。
4. **跨 episode 零学习**——8 次同题零状态传递、thread_id===id ×21、saved_memory_id 全 null；chat 从不检索记忆（finance/orchestrator.py:511-520 有现成写法）。
5. **Evaluator 续办把被取代的草稿一并发出**——G1-r2 同一条消息里既有"净利润未返回"又有"净利润 118 万元"，2/2 复现。

## 差异清单 —— Anna vs 框架眼中"合格的 Agent Work Loop"

| 框架要求（出处） | Anna 实测 | 对长程开发的意义 |
|---|---|---|
| agent 能触发系统/观察结果/判断结果，中间没有人（agent-verify-loop.md:13-17） | 19 条 trace 共 3 个工具名 | 验证闭环不可能成立 |
| Agent loop 需要 turn limits | 上限 8，最长实测 7 轮 | 数百轮的任务差 1.5 个数量级 |
| 长跑需要上下文预算 | 窗口 200,000，最低剩余 **98%** | autocompact 建好但真实 episode 从未触发 |
| 重复工作落到耐久 owner | R1 同题 8 跑，零状态传递 | 第 N 次的教训带不到 N+1 |
| 会话连续性/恢复 | 全部实现；24/24 单轮线程、0 awaiting_continue、interrupted 无续办路径 | 长跑必然被中断，中断即报废 |
| 反馈回流资产 | 5 技能 5 周未动，0/24 run 带 skill_id | 学习只能靠人改 Python + 重构建 |
| 交付受理边界 | Route A: 0 observed and 0 connected signals，无 CI | agent 产出从未撞上真实受理门 |
| 可观测六门 | 五门 Pass、Correlatable Partial | **长板**，只缺 agent 侧读取与跨 run 关联 |

**证据支持的长板**（无奉承）：① 工具错误从致死改为可观察并被后窗印证——r1 `error.type` 挂根 span 致 run 死于第 2 轮，r2 挂 execute_tool span 后 loop 改参续跑到第 7 轮交付（全语料唯一完整 failure→diagnosis→repair→revalidate 链，唯一 Outcome-supported 项）；② 判断层不是橡皮图章（R1 run-3 自我 flagged/needs_user 且 gaps 与人类判据一致）；③ trace 是真资产（OTel 规范、重启后可重建、5.6ms、驱动过真实修复）；④ 评测套件自带 baseline/comparison/fix_verdicts/cost_per_outcome 与 INFRA 显式作废——达到框架要求的可比后窗规格。

## 最短修复路径（Operationalize 1→60）

1. **给 loop 装上"手"**（#1）——owner chat_tool_registry.py + capability.py。在**既有** workdir 牢笼与 ask 门内只加两件：allow-list 约束的命令执行工具（返回 exit code + 截断 stderr）与 workdir 内写文件工具，复用 capability.py:363-371 越界校验，不新开权限通道。验收：新增 tests/gates/test_gate_exec.py + pytest tests/gates -q 全绿 + 一个"跑检查→拿非零退出码→修正→复跑通过"的 eval 用例。
2. **让被中断的长任务能续办**（#2）——interrupted 从终态降为可续办态，复用 _prepare_resume（orchestrator.py:810-838）与 seq 续接（routes/chat.py:154-159）；产物产生即落盘。验收：扩写 test_gate_p2_restart.py。
3. **给 run 装总闸**（#3）——query_config.py 加累计轮数/token/墙钟预算，续办与 evaluator 续段**累加而非重置**，触顶走 awaiting_continue。验收：扩写 test_gate_continue.py。

顺序理由：无 1 则其余无意义；1 使长跑可能，长跑必遇中断（2）；1+2 之后无上限自主消耗才成为真风险（3）。紧随其后：#4 按 finance/orchestrator.py:511-520 既有写法把记忆检索接进 chat（扩既有不造新资产）、#5 最小 CI 跑已全绿的四门 + 11 gate。

## 显式 unobserved（不猜）

会话恢复行为（suspended_messages 21/21 null，无 episode 被中断过）· 轮数/上下文上限的实际行为（从未接近）· autocompact 生产触发（最大单段 23,460 tok vs ~167k 阈值）· 非优雅 kill 后的真实恢复（未真 kill）· 跨域 skill 误路由是否发生（所有 run skill_id=null，代码可达已证、实际发生未证）· 另四个技能是否对真实模型跑过 · agent_directives 是否曾非空 · 被作废 run chat_run_021 的内容（1,661 字真实交付因 INFRA 整条排除——"FABRICATION: 0"不覆盖全语料）。

## 不得据本报告主张

Anna 能处理长程任务（7 轮 2% 是 smoke 不是 horizon 测试）· 会话连续性可用或已坏（从未行使）· H1 改善是 Anna 侧护栏（上游修复，Anna 零改动）· R1 2/3 是部分成功（pass^3 两轮均 0）· 3/8→7/8 是耐久基线（k=1）· 从工具/技能计数推质量 · 只读工具面是 bug（评测 spec §0 显示是刻意阶段边界——是**门槛**不是**缺陷**）。
