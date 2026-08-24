# S1 attempt 1 — 作废（runner 侧 bug，非 Anna 行为）

**不计分。** 保留仅为审计完整性。

- run_id: `chat_run_021` · status `ready` · turns 5 · 无 `run.interjected` 事件 · 答案无应付内容

## 作废原因
本 runner 的 driver 用错了插话请求体字段名：POST 了 `{"message": ...}`，
而 `services/api/app/schemas.py:75-78` 的 `InterjectChatRunRequest` 只有一个字段 `text: str`。
因此插话请求被 FastAPI 以 422 拒绝，**从未进入引擎**；引擎没有收到插话，
trace 无 `run.interjected` 属正确行为，不构成 Anna 的能力失败。

driver 随后在把含中文的 422 响应体打到 cp1252 控制台时抛 `UnicodeEncodeError` 而退出，
导致 `interject-response.json` 未落盘。run.json / trace.json 为事后从 API 补取。

## 处置
按 spec §2.3「INFRA_FAIL ≠ 能力 FAIL」，本次记为 runner INFRA，**不占用 spec §3 S1 的
「run 结束太快导致插话落空 → 允许整案重试一次」那一次重试额度**（那条针对时序落空，本次是请求根本没发出去）。
修正字段名后整案重跑，正式证据在上级目录 `S1/`。

## 附带留档（不计分）
attempt 1 的答案本身数字全对：4 月 412 万 / 5 月 446 万 / 6 月 482 万，
与 `/api/trend` revenue 4120000 / 4455000 / 4820000 相符；+34 万(+8.25%)、+36 万(+8.07%)、
合计 1340 万、累计 +70 万(17.0%) 均可由真值直接推出。
惟「6 月环比并未出现爆发式跳升（仅比 5 月多 2 万）」一句把「环比增量之差」（36-34=2）
误述为「6 月比 5 月多 2 万」，实际 6 月比 5 月多 36 万 —— 表述错误而非编造，记 judge 候选。
