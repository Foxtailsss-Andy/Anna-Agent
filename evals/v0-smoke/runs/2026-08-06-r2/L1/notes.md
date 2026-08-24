# L1 · 多工具链条 — r2

- run_id: `chat_run_020` · status `ready` · wall 34.2s
- 输入：`把 2026 年 6 月的损益、应收账款 top 客户、应付账款 top 供应商各查一遍，给我一页汇总`
- 指标：`anna.turns` = **6**（r1: 6）· duration_ms = **32918**（r1: 35710）· tokens_in **14169** / tokens_out **1690**（r1: 13778 / 1679）· tool_calls **7**（r1: 7）
- 产物：`art_1` (doc)「2026年6月财务一页汇总」

## 断言逐条

### A1 — ≥3 次 `execute_tool` 全 ok ✓ PASS
trace.json 7 个 `execute_tool` span，**全部 status=ok**：
`plan.update`(0ms) → `erp.finance.query`(15ms) → `erp.finance.query`(10ms) → `erp.finance.query`(17ms)
→ `plan.update`(6ms) → `chat.emit_document`(0ms) → `plan.update`(0ms)

三个主题各查一次（损益/费用、应收 top、应付 top），三次 `erp.finance.query` 的 `input_hash` 互不相同。
无需降级到 A1'。

### A2 — 无 orphan span；root status=ok ✓ PASS
- 20 个 span，`orphan_parents` = `[]`（所有 parent_span_id 均能在本 trace 内找到对应 span_id）
- 无 span 带 `anna.orphaned` 属性
- root `invoke_agent chat` status = `ok`

### A3 — turns ≤ 8 ✓ PASS
root 属性 `anna.turns` = **6** ≤ 8，未撞 max_turns（默认 8）。

## 判定：**PASS**（A1 ✓ / A2 ✓ / A3 ✓） — r1 PASS → r2 PASS（保持）

## 红线核查（spec §1）— 产物 15 项数字全对账
| 答案/产物 | 值 | 真值 | 判定 |
|---|---|---|---|
| 本月费用 ≈364 万 | 3 640 000 | `/api/pnl?period=2026-06` expense_total 3640000.0 | ✓ |
| 应收总余额 ≈215 万 | 2 150 000 | `/api/trend[2026-06]` ar_balance 2150000.0 | ✓ |
| 逾期 ≈98 万 | 980 000 | 工具原文「逾期(>30天)约 98万」 | ✓ |
| 逾期占比 45.6% | — | 98/215 = 45.58% | 可推 ✓ |
| 远东重工 48 万 / 72 天 | 480 000 | rows[0] overdue_amount 480000.0, aging_days 72 | ✓ |
| 江南智能制造 38 万 / 64 天 | 380 000 | rows[1] 380000.0, 64 | ✓ |
| 银河金融 12 万 / 41 天 | 120 000 | rows[2] 120000.0, 41 | ✓ |
| 合计 86 万，占逾期 88% | — | 48+38=86；86/98=87.76% | 可推 ✓ |
| 蓝云数据 42 万 | 420 000 | `/api/ap-top` SUP-001 outstanding 420000.0 | ✓ |
| 智联软件外包 32 万 | 320 000 | SUP-002 320000.0 | ✓ |
| 盛世国际会展 24 万 | 240 000 | SUP-003 240000.0 | ✓ |
| 利和办公科技 11 万 | 110 000 | SUP-004 110000.0 | ✓ |
| 畅行商旅 9 万 | 90 000 | SUP-005 90000.0 | ✓ |
| 应付总额 ≈118 万 | 1 180 000 | `/api/trend[2026-06]` ap_balance 1180000.0 | ✓ |
| TOP3 占 83% / 蓝云一家占 36% | — | (42+32+24)/118=83.05%；42/118=35.6% | 可推 ✓ |

**15/15 全通过，无 FABRICATION。** 产物落款「生成时间：2026-08-06 16:17」为正确当前日期（F2 旁证）。

## 留档（不计分，与 r1 同一条）
产物「一、损益概况」一节仍只有费用 364 万，**没有收入 482 万和净利润 118 万**——
根因是工具路由只认 `应收/费用/收入/应付/利润` 关键词（ground-truth.json 已记：`{question:'损益'}` 直接返回
「未能解析该问题」），模型用「费用」代替了「损益」后就没再补查收入/利润。
本案 evaluator **未触发**（trace 无 `run.evaluation.*`），说明 F4 的 `multi_ask` 触发器没把这类
「三主题合并请求」识别为多问。A1 按字面（≥3 次工具全 ok）成立，不因此翻转；记为 F4 覆盖面缺口。
