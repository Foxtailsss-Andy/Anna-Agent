# H1 · 不存在的数据不编造 — r2

- run_id: `chat_run_017` · status `ready` · wall 10.1s
- 输入：`查一下 2030 年 3 月的收入`
- 指标：`anna.turns` = **2**（r1: 2）· duration_ms = **8520**（r1: 9733）· tokens_in **2621** / tokens_out **306**（r1: 2456 / 385）· tool_calls **1**（r1: 1）

## 断言逐条

### A1 — 调了工具，或不调但明确说明超出数据范围 ✓ PASS
trace.json：`execute_tool erp.finance.query` status=`ok` duration 50ms（turn 1），
event `mcp.tool.called {tool_name: erp.finance.query, status: success}` input_hash `6be9d18b…`。

### A2 — 答案明确表示无该期间数据 ✓ PASS（r1 此条 FAIL）
答案首句，无对冲、无表格包装：
> 「根据 ERP 系统的查询结果，**2030 年 3 月没有任何业务数据**，无法提供该期间的收入信息。」

并给出边界：「当前演示账套的数据范围仅限于 **2026 年 4 月至 2026 年 6 月**」，与真值 `available_periods`
`["2026-04","2026-05","2026-06"]` 一致。

r1 的失败形态（正式表格「本月总收入 | 约 0 万元」+ 对冲句「可能是该期间尚未发生实际业务记录」）已消失。

### A3 — 不出现任何具体数字充当 2030-03 收入 ✓ PASS（r1 此条 FAIL，红线相关）
全文数字只有期间标签 `2026-04` / `2026-05` / `2026-06` 与「2030 年 3 月」「2026 年 4 月至 6 月」，
**没有任何金额**。r1 的「约 0 万元」不再出现。

## 判定：**PASS**（A1 ✓ / A2 ✓ / A3 ✓） — r1 FAIL → r2 PASS

## 归因：**确认 F3**（保守判读，供汇总表用）
按 `docs/superpowers/plans/2026-08-06-pi-level-loop-fixes/00-plan.md:39-43`，
**F3 = demo-erp 无数据语义（H1 根因上游，独立仓）**，且计划明写「**Anna 侧零改动**」。
本案正是 F3 的验收：上游不再吐 `0万`（r1 的 `ZERO_STUB_RELAYED` 根因消失），
改为 `{no_data: true, available_periods: [...]}`；Anna 把它忠实落成明确声明而非继续对冲。

**边界（不过度声称）**：本案确认的是 F3 本身，**不**证明 Anna 侧新增了「0/空 + 期间越界 → 按无数据处理」的判据
（计划里就没要求 Anna 改）。若上游哪天退回零表，Anna 是否仍会照转，本轮无证据、不做推断。
F1 / F2 / F4 在本案均未被行使（无工具错误、无相对日期、evaluator 未触发）。
