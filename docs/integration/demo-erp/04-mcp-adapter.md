# 04 · MCP 适配契约(系统 → Anna 的 5 个 ERP 工具)

> 这一层把本系统数据按 Anna 期望的**固定契约**吐出来。Anna 只认这层。可复用现有
> `tools/demo_mcp_connector`(JSON-RPC 信封 + 工具路由已就绪),把每个工具的数据来源从写死改为查本系统库。
> 协议:JSON-RPC 2.0 / HTTP;业务数据放 `result.structuredContent`;`jsonrpc:"2.0"`、`id` 原样回传。

## 0. `tools/list`(必须返回这 5 个)
```json
{"jsonrpc":"2.0","id":"...","result":{"tools":[
  {"name":"erp.finance.get_dashboard_snapshot"},
  {"name":"erp.finance.query"},
  {"name":"erp.finance.get_receivables_aging"},
  {"name":"erp.collection_task.create_draft"},
  {"name":"erp.collection_task.get_status"}
]}}
```

---

## 1. `erp.finance.get_dashboard_snapshot`(看板,只读)
**入参** `{ "period": "2026-06" }`
**取数**:`period_summary[period]` → 6 指标;环比 = 与上一期 period_summary 比;异常 = 跑文档02 §6 规则;suggested_actions 固定/规则生成。
**返回**(structuredContent):
```json
{
  "period": "2026-06",
  "metrics": [
    {"id":"revenue","label":"本月收入","value":4820000.0,"unit":"CNY","trend":"+8.2% 环比","narrative":"演示数据：主营收入环比增长。"},
    {"id":"expense","label":"本月费用","value":3640000.0,"unit":"CNY","trend":"+12.4% 环比","narrative":"演示数据：市场与差旅上升。"},
    {"id":"profit","label":"本月利润","value":1180000.0,"unit":"CNY","trend":"-3.1% 环比","narrative":"演示数据：利润率受费用挤压。"},
    {"id":"operating_cash_flow","label":"经营现金流","value":760000.0,"unit":"CNY","trend":"-18.0% 环比","narrative":"演示数据：回款放缓。"},
    {"id":"accounts_receivable","label":"应收账款","value":2150000.0,"unit":"CNY","trend":"+15.6% 环比","narrative":"演示数据：逾期占比上升。"},
    {"id":"accounts_payable","label":"应付账款","value":1180000.0,"unit":"CNY","trend":"+4.0% 环比","narrative":"演示数据：账期稳定。"}
  ],
  "anomalies": [
    {"id":"ar_overdue","title":"逾期应收集中在两家客户","severity":"high","explanation":"演示数据：演示客户A、C 合计逾期 86 万,账龄超 60 天。"},
    {"id":"mkt_spike","title":"市场费用单月跳增","severity":"medium","explanation":"演示数据：市场费用环比 +34%,主要为一次性会展支出。"}
  ],
  "suggested_actions": [
    {"id":"start_receivables_recovery","label":"发起应收回款改善目标","target":"associate","payload":{"period":"2026-06","focus":"逾期应收"}},
    {"id":"ask_expense_detail","label":"追问市场费用明细","target":"finance_assistant","payload":{"period":"2026-06","question":"本月市场费用明细构成是什么？"}}
  ]
}
```
字段约束:`metrics[].value` 数字;`severity∈low|medium|high`;`target∈finance_assistant|associate|write_intent`。

---

## 2. `erp.finance.query`(财务助手,只读自然语言)
**入参** `{ "period":"2026-06", "question":"逾期超过 30 天的应收有哪些？" }`
**取数**:对 `question` 做关键词路由,组织答案 + 支撑行 + 来源:

| 命中关键词 | 数据 | answer 模板 |
|---|---|---|
| 应收/逾期/账龄 | get_receivables_aging | 「应收余额 X,逾期(>30天)Y,集中在 A(..)、C(..)…建议催收」 |
| 费用/市场/差旅 | §2.2 费用明细 | 「本月费用 X,市场 620k(环比+34%,会展)…」 |
| 收入/营收 | 收入线 | 「本月收入 X,SaaS/实施/运维 …」 |
| 应付/供应商 | AP Top5 | 「应付 X,Top5:云420k/外包320k/会展240k/办公110k/差旅90k」 |
| 利润/现金流 | period_summary | 「利润 X(环比-3.1%),现金流 Y 低于利润,因回款放缓」 |

**返回**:
```json
{
  "question":"...", "period":"2026-06",
  "answer":"【演示数据】截至 2026-06,演示租户应收余额约 215 万,逾期(>30天)约 98 万,集中在演示客户A(48万)、演示客户C(38万)。建议优先催收并复核市场费用预算。",
  "rows":[{"customer":"演示客户A","customer_id":"CUST-DEMO-A","overdue_amount":480000.0,"aging_days":72,"currency":"CNY"}],
  "sources":["erp.finance.query","演示租户账套 demo-erp-2026"],
  "suggested_actions":[{"id":"start_receivables_recovery","label":"发起应收回款改善目标","target":"associate","payload":{"period":"2026-06","focus":"逾期应收"}}]
}
```
> 真实系统期:把关键词路由换成真正的语义查询/取数即可,契约不变。

---

## 3. `erp.finance.get_receivables_aging`(只读)
**入参** `{ "period":"2026-06", "overdue_days":30 }`
**取数**(SQL 概念):
```sql
SELECT c.name customer, si.customer_id,
       SUM(si.total_amount - si.paid_amount) overdue_amount,
       MAX(julianday('2026-06-30') - julianday(si.due_date)) aging_days, 'CNY' currency
FROM sales_invoice si JOIN customer c ON c.customer_id=si.customer_id
WHERE si.status IN ('open','partial')
  AND (julianday('2026-06-30') - julianday(si.due_date)) > :overdue_days
GROUP BY si.customer_id ORDER BY overdue_amount DESC;
```
**返回** `{ "period":"2026-06","overdue_days":30,"currency":"CNY","rows":[ {customer,customer_id,overdue_amount,aging_days,currency} ] }`

---

## 4. `erp.collection_task.create_draft`(写,Associate 执行)
**入参** `{ "workspace_id","actor_user_id","payload":{ customer_id, target_amount, sop/nodes/reason… } }`
**取数/写**:insert `collection_task`(status=created,生成 `external_task_id=TASK-2026-00000N`,存 payload_json)。
**返回** `{ "external_task_id":"TASK-2026-000001","external_status":"created","payload":{…},"note":"演示数据" }`
- `external_task_id` 非空唯一;之后 get_status 用它回读。

## 5. `erp.collection_task.get_status`(只读回读)
**入参** `{ "external_task_id":"TASK-2026-000001" }`
**返回** `{ "external_task_id":"...","external_status":"created","customer_id":"...","target_amount":480000.0,"note":"演示数据" }`
- `external_status` 必须与 create 当时一致(否则 Anna 停在 verify_pending)。

---

## 6. 报销主数据(非 MCP 工具,但室友报销系统要对齐)
本系统 ORG 模块提供:部门(DEPT-001…)、成本中心(CC-001…)、员工(EMP-001…)、项目(PROJ-ACME)。
室友报销系统的 `validate_draft` 应能用这些校验申报字段存在性(当前 v1 只校验非空)。可由本系统开一个
只读接口 `GET /master/departments|cost-centers|employees` 供报销系统同步,或两边共用同一主数据库。

---

## 7. 错误约定(与现有契约一致)
- Token 错误 → HTTP 401;未知工具 → JSON-RPC error `tool_not_found`;参数错 → `invalid_arguments`。
- 业务错误统一 `{"error":{"code","message","retryable"}}`,如 `task_not_found`(retryable:false)。
