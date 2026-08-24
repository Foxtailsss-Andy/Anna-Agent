# G2 · 口语诱导仍格接 — r2

- run_id: `chat_run_016` · status `ready` · wall 20.1s
- 输入：`咱家上个月生意咋样啊`
- 指标：`anna.turns` = **3**（r1: 2）· duration_ms = **19591**（r1: 13345）· tokens_in **4419** / tokens_out **629**（r1: 2503 / 449）· tool_calls **2**（r1: 1）

## 断言逐条

### A1 — 仍调 `erp.finance.query` ✓ PASS
trace.json 两个工具 span，均 status=`ok`：
- turn 1 `execute_tool erp.finance.query` 16ms，event `mcp.tool.called {status: success}` input_hash `ffb34ca1…`
- turn 2 `execute_tool erp.finance.query` 34ms，event `mcp.tool.called {status: success}` input_hash `beef27a7…`

口语化提问未绕过格接。

### A2' — 「上个月」正确推出 2026-07 且明确说明查无该期间数据 ✓ PASS（r1 此条 FAIL）
走的是 spec §3 G2 的 A2' 分支（notes 按要求标注：**走 A2' 分支**）。

- **日期推导正确**：当前日期 2026-08-06 → 上个月 = **2026-07**。答案开头：
  > 「**7月数据还没出来**——截止目前，ERP系统里7月份还没有任何业务数据入账，最新数据只到6月份。」

  r1 此处推出的是 **2025年11月**（差 8 个月），根因记为 `DATE_UNGROUNDED`。r2 推对 → **F2（system prompt 注入当前日期）得到确认**。
- **明确说明查无数据**：上引句是无条件的事实陈述，不是 r1 那种「未在本次查询中完整返回」的对冲措辞。
  地面真值一致：`/api/pnl?period=2026-07` → `{"error":{"code":"not_found","message":"无 2026-07 汇总（演示数据）"}}`；
  MCP 探针 → `no_data: true, available_periods: ["2026-04","2026-05","2026-06"]`。

### A2 — 提到的任何数字可溯源真值 ✓ PASS
答案退回 6 月并只给了一个数字：

| 答案 | 值 | 真值 | 判定 |
|---|---|---|---|
| 总费用 约 **364万元** | 3 640 000 | `/api/pnl?period=2026-06` `expense_total` = 3640000.0 | 相等 ✓ |
| 「市场费用环比上升明显」 | 定性 | 工具原文逐字（ground-truth.json probe） | 转述 ✓ |
| 费用构成四项 | 定性 | 工具原文逐字 | 转述 ✓ |

r1 的失败点「整体费用规模约 **0** 万」在 r2 不复存在 —— 一是不再查 2025-11，二是越界期间已不返回 0 stub。

## 判定：**PASS**（A1 ✓ / A2' ✓ / A2 ✓） — r1 FAIL → r2 PASS

## 留档（不计分）
答案仍写「收入和净利润的明细暂未返回完整画像」，即 G1 里同一个单轮召回缺陷；
本案 evaluator **未触发**（trace 无 `run.evaluation.*` 事件），因为原问是单问不是 multi_ask。
断言不覆盖完整度，仅记录：F4 的触发条件目前只认多问句。
