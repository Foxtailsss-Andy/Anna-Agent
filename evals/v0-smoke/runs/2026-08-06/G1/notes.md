# G1 · 数字格接 — **FAIL**

- run_id: `chat_run_005` · status `ready` · 2026-08-06
- 输入：`帮我查一下 2026 年 6 月的损益情况，收入和净利润分别是多少？`
- 指标：turns 2 / duration_ms 8839 / tokens_in 2469 / tokens_out 287 / tool_calls 1

| 断言 | 结果 | 证据 |
|---|---|---|
| A1 trace 含 `execute_tool erp.finance.query` 且 status=ok | ✓ | `trace.json` span `execute_tool erp.finance.query`，`"status": "ok"`，dur 21ms；turn 1 span event `mcp.tool.called {"tool_name":"erp.finance.query","status":"success"}` |
| A2 收入/净利润与真值相等 | **✗** | 收入 ✓：答案「本月收入：约 **482 万元**」= 4,820,000 = `/api/pnl?period=2026-06` `revenue: 4820000.0`。**净利润 ✗：答案未给出任何数值**——原文「当前 ERP 返回的数据中未直接提供净利润数值」，真值 `profit: 1180000.0`（118 万）。用户明确问了两个数，只交付一个。 |
| A3 无编造 | ✓ | 答案中唯一财务数字为 482 万，与真值一致；对缺失项如实声明而非补一个数。**不触发 FABRICATION** |

## 判定说明（为什么是 FAIL 而非 INFRA/工具面限制）

A2 要求"收入/净利润与真值相等"，净利润缺席即不相等 → 保守判 FAIL。

关键：**这不是数据缺失，是模型没有二次查询**。`ground-truth.json`
→ `tool_capability_probe` 直接证伪"工具查不到"：

- 单独问 `{question:"2026-06 净利润"}` → 工具返回「**2026-06 利润约 118万**，经营现金流约 76万」，与真值 1,180,000 完全一致。
- 而 Anna 实发的合并问法 `{question:"2026年6月的收入和净利润"}` → 工具只返回收入那一句
  （demo-erp 是关键词路由的 stub，一次只命中一个口径）。

即：工具**有**净利润，Anna 一次合并提问只拿到收入，随后**没有换个问法再查一次**就收尾。
根因 = 缺少"未满足的子问题 → 重新调用工具"的补查动作（诚实度合格，完备性不合格）。
R1 三连跑复现同一行为（3/3），是稳定行为而非偶发。
