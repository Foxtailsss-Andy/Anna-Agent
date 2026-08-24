# L1 · 多工具链条 — **PASS**

- run_id: `chat_run_010` · status `ready` · 2026-08-06
- 输入：`把 2026 年 6 月的损益、应收账款 top 客户、应付账款 top 供应商各查一遍，给我一页汇总`
- 指标：turns 6 / duration_ms 35710 / tokens_in 13778 / tokens_out 1679 / tool_calls 7（全 ok）
- 工具名单：`plan.update` ×3、`erp.finance.query` ×3、`chat.emit_document` ×1
- 产物：`art_1`（kind `doc`，标题「2026年6月财务一页汇总」），event `chat.artifact.emitted`

| 断言 | 结果 | 证据 |
|---|---|---|
| A1 ≥3 次 `execute_tool` 全 ok | ✓ | 7 个 tool span，`status` 全为 `ok`；其中三项业务查询各 1 次 `erp.finance.query`（损益 / 应收 / 应付），无 A1' 降级情形——三项都被真实查到了 |
| A2 无 orphan span；root status=ok | ✓ | 遍历 20 个 span，无任何 `parent_span_id` 悬空，也无 `anna.orphaned` 属性；root `invoke_agent chat` `"status": "ok"` |
| A3 turns ≤ 8 | ✓ | root `anna.turns` = **6**，未撞 max_turns（默认 8） |

## 产物数字对账（红线复核，真值 = REST + aging 工具）

一页汇总 `artifacts[0].content` 逐数核对，**全部命中，零编造**：

| 产物中的数字 | 真值 | 判定 |
|---|---|---|
| 本月费用合计 ≈364 万 | `expense_total` 3,640,000 | ✓ |
| 应收总余额 ≈215 万 | `ar_balance` 2,150,000 | ✓ |
| 逾期(>30天) ≈98 万 | aging 480k+380k+120k=980,000 | ✓ |
| 逾期占比 ≈45.6% | 98/215 = 45.58% | ✓ 可推出 |
| 远东重工 48 万 / 72 天 | 480,000 / aging_days 72 | ✓ |
| 江南智能 38 万 / 64 天 | 380,000 / aging_days 64 | ✓ |
| 银河金融 12 万 / 41 天 | 120,000 / aging_days 41 | ✓ |
| 两家合计占逾期 87.8% | (48+38)/98 = 87.76% | ✓ 可推出 |
| 应付 Top5：42/32/24/11/9 万 | ap-top 420k/320k/240k/110k/90k | ✓ 五项全中，排序一致 |
| 应付总额 ≈118 万 | `ap_balance` 1,180,000 | ✓ |

## 判定说明

三条断言全过 + 产物零编造 → PASS。跨三个数据口径、七次工具调用、
最后 `chat.emit_document` 落成正式产物，链条完整且 trace 结构干净。

两条留档（不计分，归 judge 套件）：
1. **损益口径不全**：一页汇总的"损益概览"只有费用 364 万，**没有收入和利润**——
   与 G1 同一个病灶（单次合并查询只命中一个口径就收尾）。本案 A1 未要求全口径故不扣分，
   但作为"一页汇总"交付物，缺收入/利润是实质缺陷。
2. **口径错配的分析**：「收支剪刀差：本月费用 364 万 vs 应付 118 万」把
   期间费用（流量）与应付余额（存量）直接对比，结论不成立。属措辞/分析质量，v0 不打分。
