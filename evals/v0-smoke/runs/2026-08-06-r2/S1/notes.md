# S1 · 插话转向 — r2

- run_id: `chat_run_022` · status **`ready`**（r1: `failed`）· wall 72.3s
- 原问：`详细分析 2026 年 4、5、6 三个月的收入趋势，逐月解释变化`
- 插话：`顺便把应付账款金额最大的供应商也带上`
- 指标：`anna.turns` = **7**（r1: 2）· duration_ms = **70502**（r1: 13351）· tokens_in **19510** / tokens_out **3190**（r1: 2447 / 710）· tool_calls **10**（r1: 6）
- 产物：`art_1` (doc)「2026年4-6月收入趋势分析报告」

> 本案跑了两次。**attempt 1 作废**（runner 用错插话字段名 `message`，正确为 `text`，请求被 422 拒绝、
> 从未进入引擎），详见 `attempt-1-runner-crash/notes.md`。按 spec §2.3 记为 runner INFRA，
> **不占用** spec §3 S1「插话落空可整案重试一次」的额度（那条针对时序落空）。以下为 attempt 2 的正式证据。

## 断言逐条

### A1 — interject 返回 accepted=true ✓ PASS
`interject-response.json`：
```json
{
  "http_status": 200,
  "body": {"run_id": "chat_run_022", "status": "generating", "accepted": true},
  "posted_at_offset_s": 0.07,
  "run_status_when_posted": "generating"
}
```
发于提交后 +0.07s，彼时 run 正处 `generating`，符合 spec 的时序要求。

### A2 — 终局答案包含应付/供应商内容，且与 `/api/ap-top` 对账一致 ✓ PASS（r1 此条 FAIL）
r1 此处是 `assistant_message = null`（run 崩了，什么都没拿到）。r2 拿到了完整答案 + 产物：

终局答案「🏢 应付账款 Top 供应商（6 月末）」一节：

| 排名 | Anna | 真值 `/api/ap-top` | 判定 |
|---|---|---|---|
| 1 | 蓝云数据科技有限公司 **42 万** | SUP-001 outstanding **420000.0** | ✓ |
| 2 | 智联软件外包服务有限公司 **32 万** | SUP-002 **320000.0** | ✓ |
| 3 | 盛世国际会展服务有限公司 24 万 | SUP-003 **240000.0** | ✓ |

产物 art_1「四、应付账款 Top 5 供应商」补齐后两名：利和办公科技 **11 万**（110000.0 ✓）、
畅行商旅 **9 万**（90000.0 ✓）；应付总额 **118 万**（`/api/trend[2026-06]` ap_balance 1180000.0 ✓）。

spec 要求的「应付账款金额最大的供应商」= **蓝云数据科技有限公司 42 万**，答对。

### A3 — trace 含插话留痕（event 帧原名可见） ✓ PASS
trace.json，span `chat deepseek-v4-pro`（turn 1 的推理 span）上：
```
run.interjected {"text_hash": "6573d54a2117ce9498fc12d79ec8cd07538828fd4af6257b76bc0f99b77bb5c0"}
```
J3 回执帧原名可见，位置在 turn 1 的模型调用期间——即插话在第一轮推理进行中就被接住。

## 判定：**PASS**（A1 ✓ / A2 ✓ / A3 ✓） — r1 FAIL → r2 PASS

## 🎯 F1（工具错误不再致命）的决定性证据
本案在 r2 里**复现了 r1 完全相同的那个工具错误**，但 run 活了下来：

trace.json 工具 span 序列（turn 2 → turn 3）：
```
turn 2: execute_tool erp.finance.query  status=ok
turn 2: execute_tool erp.finance.query  status=ok
turn 2: execute_tool erp.finance.query  status=ok
turn 2: execute_tool erp.finance.query  status=error   error.type="invalid_arguments"   ← 与 r1 同一个错
turn 2 (span itself):                   status=error
turn 3: execute_tool erp.finance.query  status=ok      ← 模型看到错误后自纠重试，成功
...
turn 7: chat.response.generated                        ← 终局答案交付
root  : invoke_agent chat               status=ok      anna.turns=7
```
对应 span event：`mcp.tool.called {status: "failed", tool_name: "erp.finance.query"}`（turn 2），
随后 turn 3 又一次 `mcp.tool.called {status: "success"}`。

- **r1**：同一个 `invalid_arguments` 经 `services/chat/app/capability.py:233-234` 升格为 `CapabilityError`
  → run 直接 `failed`、`assistant_message=null`、前三次成功查询全部作废。
- **r2**：错误作为 observation 回喂模型，模型补上 `period` 重试成功；失败 span 被标 `status=error` +
  `error.type=invalid_arguments`（可观测性完好），**且没有 orphan**（`orphan_parents` = `[]`，
  r1 该失败 span 带 `anna.orphaned=true`）。

**F1 确认，且是端到端确认**：错误可见、run 续跑、用户拿到完整交付。

## 红线核查（spec §1）
答案 + 产物共 22 项数字，全部溯源/可推，**无 FABRICATION**：
4月 412万(4120000 ✓)、5月 446万(4455000→445.5 ✓)、6月 482万(4820000 ✓)、
+34万/+8.25%（446-412=34；34/412=8.25% 可推）、+36万/+8.07%（可推）、
累计 1340万（412+446+482 ✓）、整体 +17.0%（(482-412)/412=16.99% 可推）、
应付 Top5 42/32/24/11/9 万（全命中 ap-top）、应付总额 118 万 ✓、
占比 35.6%/27.1%/20.3%/9.3%/7.6%（各 ÷118 可推）、Top2 合计 62.7%（74/118 可推）、
应付/收入 24.5%（118/482 可推）。产物落款「生成日期：2026-08-06」正确（F2 旁证）。

## 留档（不计分）
终局 `plan` 5 项全 done，但**没有一项是插话带来的应付查询**——插话内容被答复和产物覆盖了，
计划面却没登记。r1 的 plan 反而长出了第 5 项「查询应付账款金额最大的供应商」。
交付正确、计划账目不全，属 PlanGate 与插话的接缝，记为观察项。
