# Agent Rebuild · SPEC（唯一现行规格）

> Spec ID: agent-rebuild-v1 · Status: 待用户拍板（§5 决策点）
> **上位** = [PRD v2](../../../product/PRD-v2-agent-runtime.md) · **能力地图** = [Harness Checklist](../../../product/harness-checklist.md)（33 项）
> **诊断** = [better-harness report](../2026-08-06-better-harness-diagnosis/report.md)（13 finding，冻结五维）
> **取代**：`2026-08-06-long-horizon-loop/00-spec.md`（已删）、本文件早期残稿
> **沿用**：`2026-08-06-better-harness-fixes/00-plan.md` §三 T1-T12 **任务详规**（865 行代码级，按本 SPEC 阶段重排）

## 1. 裁断三条

用户授权"推倒重建、可整体/部分移植"。基于 better-harness 实测 + 三档 checklist 对照：

### 1.1 推倒：域外壳（"系统性腐烂"的实体）

**证据**：8 张工具注册表 / 33 个工具名 / **19 条真实 trace 只有 3 个被调用**；5 个 `CapabilityHandler`；
每域一套 orchestrator（chat 2,208 行 + finance/hiker/reimbursement/create/associate）。
对照 checklist **B4**：Grok 用 4 层协议/运行时/类型/API 分层管一套工具面，我们用 8 张域表管一套残缺工具面。

**动作**：8 registry → **1 统一 ToolRegistry**；5 handler → **1 AgentHandler(run profile)**；
per-domain orchestrator → **1 run orchestrator**。域 = 配置（工具子集 + 权限模式 + prompt 叠层），不是代码分支。

### 1.2 保留：checklist 的 9 个守住项

A1 循环 · A3 工具错误观察化 · A4 插话 · B6 MCP 连接器 · C3 双层压缩 · D3 判断层 · D5 出境披露 ·
E3 OTel Trace · F4 评测在环。**证据**：可控执行 71 分；全语料唯一 Outcome-supported 的
failure→repair→revalidate 链就在这个 loop 里（r2 S1）；trace 已驱动过真实修复。**重写它们没有证据支持。**

### 1.3 移植：Pi 的工具语义 + Grok 的记忆结构

**否决整体移植 Pi**，四条理由：①语言边界（TS vs 25.7k 行 Python / 937 测试）；②移植所得恰是最易自建的
（4 工具 ≈ 600-900 行 Python）；③**会丢掉我们唯一的领先项**——Pi 刻意不做 memory/evals/判断层；
④Pi 自身定位就是被嵌入（waku 的 `delegate_task` 是业界已验证用法）。

**因此移植语义不移植代码**：
- **Pi → 工具层**：read/write/edit/bash 的 schema、错误约定、`blocked → tool result` 纪律、**AGENTS.md 沿目录上溯**；Python 原生实现，跑在 Anna 的 loop 里，吃 Anna 的 trace / 预算 / 审批门。
- **Grok → 记忆层**：archive / index / MMR / query expansion / dream 离线整理的**分层形状**（Rust→Python 重写）。
- **Waku → 编排层样板**：检索门 / release gate / usage 台账的做法（我们已部分具备）。
- **pi CLI 作编码分包商**（`delegate_coding`）留 **R5 可选**——**前提是 Anna 先有自己的手**，否则百轮发生在 pi 内部，Anna 的 trace/预算/判断层全部失效，直接违背北极星。

## 2. 阶段（= Checklist 优先级带）

| 阶段 | Checklist 项 | 内容 | 验收 AC（真机跑通为准） |
|---|---|---|---|
| **R0 耐久脊柱** | E2 | 逐轮 checkpoint（引擎 opt-in 钩子）+ `interrupted` 降为可续办 + 产物即落盘 | **AC-R0**：多轮 run 中途 kill 后端 → 重启 → 从落盘续跑到完成，产物不蒸发 |
| **R1 装手** | B1·B2·B3·B4·D1·D2 | 统一 ToolRegistry；`run_command`（allow-list/exit code/截断）+ `write_file` + `edit` + `grep/glob`；权限模式落地 + chat 侧 ask 拦截点 + `tool_approval` span | **AC-R1**：跑检查→非零退出码→改文件→复跑通过；trace 里 failure→repair→revalidate 链完整；越界写被拒；审批可跨请求存活 |
| **R2 上闸** | C4·E5 | run 级累计预算（turns/token/墙钟），续办与评估续段**累加不重置**，触顶 `awaiting_continue`；预算注入提示词 | **AC-R2**：低预算 run 触顶挂起而非死亡且可续；提示词含剩余预算 |
| **R3 记性** | C2·C5·C6 | `ANNA.md` + workdir `AGENTS.md` 上溯；chat 接记忆检索（finance 样板）；情景回灌 | **AC-R3**：同题第二次跑带上第一次的教训（trace 可见记忆命中） |
| **R4 一致性与受理** | F5·F2·E4 + F-06/07/08/13 | plan 合并语义；评估续答整份重写；技能正文对齐工具面；最小 CI；跨 run usage 台账 | **AC-R4**：一条消息里不再自相矛盾；plan 项不被覆盖；CI 锁住四门+gates |
| **R5 长程验穿** | 全部 | **L 系列长程 case**；评测红线补"编造能力"；（可选）pi 分包商 | **AC-L**（北极星首样本）：一句需求 → 自主建→跑→改→复跑至 pytest 全绿 → 中途 kill 一次仍续办至完成 → 全程 trace 可见 |

**顺序论证**：R0 先行因 R1 的审批续跑要踩 checkpoint；无 R1 则其余无意义；有手之后无上限自耗才成真风险（R2）；
R3 让第 N 次教训带到 N+1；R4 锁住绿灯；R5 一次验穿。

**域外壳退役**分批：R1 建统一 registry 时 chat 先切；finance/hiker/reimbursement 在 R3 后作为 run profile 迁移；
最后删 per-domain orchestrator。**不做大爆炸**——每批四门 + 11 gate 必须全绿。

## 3. 回归锁（守住项的硬约束）

任何阶段结束时：四门（pytest ≥937 / tsc 0 / vitest ≥632 / build ✓）+ 11 gate + **evals v0 不低于 7/8**。
任一守住项回退 = 该阶段不予验收。

## 4. 非目标

多 agent 派遣（R5 后）· OTLP 导出 · 前端新设计 · Crew v3（另立 spec）· 整体移植 Pi（见 §1.3）·
包/市场（checklist F3，开源后再议）· 为提分做特化优化。

## 5. 需用户拍板的决策点

1. **Phase C 边界解除**：v0 评测 spec §0 写明"行动面任务不评"，诊断判其为"门槛不是缺陷"。R1 打开它——须你亲手拍板。
2. **命令 allow-list 初值**：提案 `{python, pytest, git}`，argv 直执不过 shell（无管道/重定向/通配）。
3. **预算默认值**：提案 run 累计 24 轮 / 150,000 tokens / 1,200s；人工 continue 追加整份配额，自主续段不追加。
4. **审批粒度**：v0 = per-run per-tool（批准一次 `write_file` = 本 run 该工具后续放行）。粗但确定；arg 级留后。
5. **F-06 契约反转**：评估补办从"补差量+拼接"改为"整份重写"。与上一轮修复方向相反，理由：拼接防丢、重写防矛盾，**评测证明矛盾是真实发生的那个**。
6. **`ANNA.md` 自更新权限**：Anna 可提议、经你批准后写入（不允许静默自改）。

## 6. 验收哲学

**实操是唯一验证**。四门绿只是入场券；每阶段以 AC 真机跑通为准；全部完成后**再**跑 better-harness 复诊 +
checklist 记分板重算，看是否自然抬升——**不为提分做任何针对性动作**。

## 7. Traceability

Spec ID: agent-rebuild-v1 · Story: 重定位轮（memory: anna-agent-refounding-round）·
能力地图: `docs/product/harness-checklist.md` · 诊断: better-harness findings.json ·
任务详规: `../2026-08-06-better-harness-fixes/00-plan.md` §三
