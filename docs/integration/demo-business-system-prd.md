# Anna 演示业务系统 需求文档（Demo Business System PRD）

> 版本 v0.1 · 2026-06-16 · 面向「快速搭一个简单业务系统支撑 Anna 全功能演示」
>
> 结论先行：**Anna 不直接连业务系统，只连 MCP。** 你们要建的「演示业务系统」是 MCP
> 背后的数据源。把数据按本文档备齐、让 MCP 把这些数据按固定契约吐出来，Anna 的
> 4 个模块（财务看板 / 财务助手 / Associate / 差旅报销）就能用一套**连贯一致**的演示
> 数据完整跑通。后期室友的真实业务系统就绪后，只需把 MCP 适配层的数据源从「演示库」
> 换成「真实库」，**Anna 一行不用改**。

---

## 1. 背景与目标

- 差旅报销已接通室友**真实云端报销 MCP**（探针 8/8 + 全栈 e2e 通过）。
- 财务看板 / 财务助手 / Associate 目前走**演示 ERP 连接器**，数据是写死的少量样例
  （`tools/demo_mcp_connector/data.py`），不足以撑起一场完整、可信、有故事线的演示。
- 室友正在开发真实业务系统；在它就绪前，我们快速搭一个**简单的演示业务系统**，提供
  一套**内部一致、跨模块联动**的演示数据。

目标：一次演示能讲完整故事链 ——
> 财务看板发现「逾期应收集中在两家客户」→ 问财务助手要明细 → 一键发起 Associate
> 应收回款目标、生成催收任务草案并审批执行 → 差旅报销提交一张带发票的差旅单并过审。

---

## 2. 架构与边界

```
┌─────────┐   MCP (JSON-RPC 2.0 / HTTP)   ┌──────────────────┐   读/写   ┌────────────────┐
│  Anna   │ ───────────────────────────▶ │  MCP 适配层       │ ───────▶ │  业务系统(DB)   │
│ (client)│ ◀─────────────────────────── │ (connector/adapter)│ ◀─────── │  演示库 → 真实库 │
└─────────┘   固定契约(本文件第 3 节)     └──────────────────┘          └────────────────┘
```

- **Anna**：只认 MCP 契约（工具名、入参、返回字段）。**不感知**底层是演示库还是真实库。
- **MCP 适配层**：把 JSON-RPC 工具调用翻译成对业务系统的读写。目前是
  `tools/demo_mcp_connector`（数据写死）；要做的是让它**读自一个真实的演示库**。
- **业务系统（要建的）**：一个简单的关系库 + 种子数据。后期替换为室友真实系统。

> 报销链路已经是真实云端的独立 MCP（室友实现），**不在本演示系统范围内**——但本文档
> 第 6 节给出「发票读取/校验」的契约扩展,演示期可由演示连接器模拟,生产期由室友报销系统实现。

**两种实施路径**（第 8 节详述）：
- **路径 A（最快，半天）**：不建新库,直接把演示连接器的 `data.py` 扩成「多期间 + 更完整 +
  互相对得上」的样例数据。够演示,但不是真系统。
- **路径 B（推荐,1–2 天）**：建一个**简单业务系统**（SQLite/Postgres + 种子数据 + 薄查询层），
  演示连接器改为读库。更接近真实架构,后期换真实库最平滑。

---

## 3. Anna 需要的 MCP 接口契约（**必须实现**，逐字段）

> 协议：JSON-RPC 2.0 over HTTP，`POST`，`Content-Type: application/json`。
> 业务数据放 `result.structuredContent`。`jsonrpc` 固定 `"2.0"`，`id` 原样回传。
> 两个端点：ERP（财务/催收）一个端点，报销一个端点（报销是室友云端,已就绪）。

### 3.1 ERP 端点 — `tools/list` 必须列全这 5 个工具

```
erp.finance.get_dashboard_snapshot     (财务看板)
erp.finance.query                      (财务助手)
erp.finance.get_receivables_aging      (财务助手 / Associate)
erp.collection_task.create_draft       (Associate 写)
erp.collection_task.get_status         (Associate 回读)
```
缺前 2 个 → Anna 判 ERP「unhealthy」。

#### 3.1.1 `erp.finance.get_dashboard_snapshot`（只读）
入参：`{ "period": "2026-06" }`
返回：
```json
{
  "period": "2026-06",
  "metrics": [
    {"id":"revenue","label":"本月收入","value":4820000.0,"unit":"CNY","trend":"+8.2% 环比","narrative":"…"}
    // 建议含: revenue / expense / profit / operating_cash_flow / accounts_receivable / accounts_payable
  ],
  "anomalies": [
    {"id":"ar_overdue","title":"逾期应收集中在两家客户","severity":"high","explanation":"…"}
  ],
  "suggested_actions": [
    {"id":"start_receivables_recovery","label":"发起应收回款改善目标","target":"associate","payload":{"period":"2026-06","focus":"逾期应收"}}
  ]
}
```
- `metrics[].value` 为数字；`unit`/`trend`/`narrative` 可空。
- `anomalies[].severity` ∈ `low|medium|high`。
- `suggested_actions[].target` ∈ `finance_assistant|associate|write_intent`（决定 Anna 上的跳转）。
- **一致性要求**：`profit = revenue − expense`；`accounts_receivable` 与 3.1.3 账龄行之和对得上。

#### 3.1.2 `erp.finance.query`（只读，自然语言问答）
入参：`{ "period": "2026-06", "question": "逾期超过 30 天的应收有哪些？" }`
返回：
```json
{
  "question": "…", "period": "2026-06",
  "answer": "【演示数据】…一段自然语言回答…",
  "rows": [ {"customer":"演示客户A","customer_id":"CUST-DEMO-A","overdue_amount":480000.0,"aging_days":72,"currency":"CNY"} ],
  "sources": ["erp.finance.query","演示租户账套 demo-erp-2026"],
  "suggested_actions": [ … 同上结构 … ]
}
```
- `answer` 是给用户看的主答案（Anna 直接展示）。
- `rows` 是支撑明细（结构自由,演示期可与账龄行一致）。
- 演示期可做「关键词路由」（命中应收/费用/收入/应付返回对应答案）；真实期由室友系统做真正查询。

#### 3.1.3 `erp.finance.get_receivables_aging`（只读）
入参：`{ "period": "2026-06", "overdue_days": 30 }`
返回：
```json
{ "period":"2026-06", "overdue_days":30, "currency":"CNY",
  "rows": [ {"customer":"演示客户A","customer_id":"CUST-DEMO-A","overdue_amount":480000.0,"aging_days":72,"currency":"CNY"} ] }
```

#### 3.1.4 `erp.collection_task.create_draft`（写，Associate 执行）
入参（Anna 经审批后调用）：`{ "workspace_id","actor_user_id","payload": { …催收任务内容… } }`
返回：
```json
{ "external_task_id":"TASK-2026-000123", "external_status":"created", "payload":{…}, "note":"…" }
```
- `external_task_id` 非空且唯一；后续 `get_status` 用它回读。

#### 3.1.5 `erp.collection_task.get_status`（只读回读）
入参：`{ "external_task_id":"TASK-2026-000123" }`
返回：`{ "external_task_id":"…","external_status":"created|in_progress|done",… }`
- `external_status` 必须与 create 当时一致（否则 Anna 停在 verify_pending）。

### 3.2 报销端点（室友真实云端,已就绪 — 仅列契约 + 第 6 节发票扩展）

6 个工具：`get_capabilities / get_policy / validate_draft / create_draft / submit / get_status`
（完整字段见 `docs/integration/reimbursement-mcp-server-spec.md`）。draft 字段：
`category, amount, currency, expense_date, merchant, reason, department_id, cost_center_id, project_id, attachments`。

> **演示业务系统要为报销提供的主数据**：部门、成本中心、员工、项目（见第 4 节）——这样报销
> 字段（DEPT-001/CC-001 等）能对上真实主数据，演示更可信。当前室友 v1 只校验非空,长期应校验主数据存在性。

---

## 4. 业务系统数据模型（实体 + 一致性）

一个「演示科技服务公司」(`tenant = demo-erp-2026`)。建议实体（简版即可）：

| 实体 | 关键字段 | 支撑 Anna 的 |
|---|---|---|
| **finance_period_summary**（按期间财务汇总）| period, revenue, expense, profit, operating_cash_flow, ar_balance, ap_balance | 财务看板 metrics |
| **expense_line**（费用明细）| period, category(差旅/市场/办公/人力…), amount, dept_id | 看板异常、财务助手「市场费用明细」追问 |
| **customer**（客户）| customer_id, name, credit_limit | 应收、催收 |
| **receivable**（应收/发票）| customer_id, invoice_no, amount, due_date, paid_amount, period | 应收账龄、财务助手、Associate |
| **supplier**（供应商）| supplier_id, name | 应付 |
| **payable**（应付）| supplier_id, amount, due_date, period | 看板 AP、财务助手「应付 Top5」 |
| **department**（部门）| dept_id(DEPT-001…), name | 报销/费用维度 |
| **cost_center**（成本中心）| cc_id(CC-001…), name, dept_id | 报销维度 |
| **employee**（员工）| emp_id, name, dept_id | 报销申请人 |
| **project**（项目）| project_id, name | 报销可选维度 |
| **collection_task**（催收任务）| task_id, customer_id, status, payload | Associate 写入回读 |
| **invoice_file**（发票文件,可选)| sha256, invoice_no, amount, vendor, recognized_json | 发票读取/校验（第 6 节）|

**一致性硬要求**（演示可信度的关键）：
1. `finance_period_summary.profit = revenue − expense`。
2. `ar_balance` = 该期间所有 `receivable` 未收金额之和；其中逾期（now − due_date > 30d）之和 =
   看板异常与账龄行之和。
3. 看板 `anomalies`「逾期集中在 A、C」= `receivable` 里 A、C 两客户逾期额最大。
4. `expense_line` 按 category 汇总 = `finance_period_summary.expense`；「市场费用」明细可被财务助手追问。
5. 至少 **3 个连续期间**（2026-04 / -05 / -06），这样 `trend`（环比）有依据。

---

## 5. 演示种子数据（一个连贯的故事）

为保持与现有界面一致、并能讲通故事，建议直接采用下表（数字已对齐当前演示并可扩展）：

**公司**：演示科技服务有限公司 · 账套 `demo-erp-2026` · 本位币 CNY · 期间 2026-04/05/06

**2026-06 财务汇总**（其它两期按 ±5~15% 造趋势）：
| 指标 | 值(CNY) | 趋势 |
|---|---|---|
| 收入 revenue | 4,820,000 | +8.2% |
| 费用 expense | 3,640,000 | +12.4% |
| 利润 profit | 1,180,000 | -3.1% |
| 经营现金流 | 760,000 | -18.0% |
| 应收 AR | 2,150,000 | +15.6% |
| 应付 AP | 1,180,000 | +4.0% |

**费用明细（2026-06，合计=3,640,000）**：人力 2,000,000 / 差旅 360,000 / 市场 620,000（环比+34%，看板异常）/ 办公 260,000 / 其他 400,000。

**客户 + 应收账龄（逾期合计 ≈ 98 万，集中 A、C）**：
| 客户 | id | 逾期额 | 账龄(天) |
|---|---|---|---|
| 演示客户A | CUST-DEMO-A | 480,000 | 72 |
| 演示客户C | CUST-DEMO-C | 380,000 | 64 |
| 演示客户F | CUST-DEMO-F | 120,000 | 41 |
（另造 2~3 个未逾期客户,凑齐 AR 余额 215 万。）

**供应商 + 应付 Top5**：造 5 家供应商，应付合计 118 万（供财务助手「应付 Top5」）。

**主数据（供报销对齐）**：
- 部门：DEPT-001 销售部 / DEPT-002 采购部 / DEPT-003 财务部 / DEPT-004 市场部
- 成本中心：CC-001 ACME 项目组 / CC-002 平台组 / CC-003 职能
- 员工：至少 2~3 人（含 Anna 当前 session 用户映射）
- 项目：PROJ-ACME / PROJ-PLATFORM

**催收任务**：空表，由 Associate 演示时写入（demo-task-xxxx）。

**发票**：准备 2~3 张样例发票（含 1 张餐饮 ¥860、1 张出租车 ¥128，与报销演示对应），见第 6 节。

> 所有对外文案保留「演示数据 / 演示租户」标注，避免被误认为真实账套（沿用现有 `DEMO_MARK`）。

---

## 6. 发票 / 附件 数据流（上传、读哪、验哪）—— 解决你提的痛点

**现状（已实现的一半）**：
1. 用户在 Anna 上传发票 → Anna 存到本地 `…/attachments/<workspace>/<user>/<sha256>/<name>`，
   返回 `anna://attachment/<sha256>/<name>`（含 sha256、size）。
2. 报销 `create_draft` 时，Anna `materialize_attachments_for_mcp` 把文件读出，附上
   `content_base64 + sha256 + size_bytes`，**随 draft.attachments 一起发给报销 MCP**。
   → **发票内容已经能到对方系统手里。**

**还缺的一半（要补的契约）—— "在哪读、在哪验"**：

| 问题 | 方案 |
|---|---|
| **在哪读发票内容** | 已定：报销 MCP `create_draft` 的 `draft.attachments[].content_base64`。对方系统在此处拿到原文（PDF/图片）做 OCR/解析。 |
| **在哪验发票** | 建议在报销 MCP `validate_draft` **或** `create_draft` 返回里新增 `invoice_check`，把「识别出的发票要素」和「与申报是否一致」回给 Anna 展示。 |

**建议的 `invoice_check` 返回结构（报销 MCP 扩展；演示连接器可先模拟）**：
```json
"invoice_check": {
  "status": "passed | mismatch | unreadable",
  "recognized": { "invoice_no":"08827193", "amount":860.00, "vendor":"上海老正兴菜馆", "date":"2026-06-14" },
  "checks": [
    {"field":"amount","declared":860.00,"recognized":860.00,"match":true},
    {"field":"date","declared":"2026-06-14","recognized":"2026-06-14","match":true}
  ],
  "message": "发票金额与申报一致"
}
```
- **演示期**：演示连接器对 `content_base64` 不做真 OCR，直接回 `status:passed` + 用申报值回填
  `recognized`（或读我们造的 `invoice_file.recognized_json`），即可演示「上传发票→识别→比对一致」。
- **生产期**：室友报销系统做真实 OCR/票据查验（真伪、重复报销、金额一致性），返回同结构。
- **Anna 侧要做的**：把 `invoice_check` 在对话流里展示成一张「发票核验」卡（识别要素 + 比对结果 +
  不一致时高亮风险）。附件上传入口在 Agentic Chat 缺字段卡 / 报销输入区已具备，需在设计上**显式露出**
  「上传发票」按钮（你提的：function 有但设计没体现）。

> 要不要把「发票必传」设为硬规则？由 `get_capabilities.attachment_required_above_amount`（已有该字段）
> 控制：>该金额必须有附件,Anna 会把 `attachments` 列为缺字段并主动追问上传。演示期可设为 0 或某阈值。

---

## 7. 验收标准（建好后用 Anna 的探针/自检过一遍）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | ERP `tools/list` | 返回 5 个 ERP 工具 |
| 2 | 财务看板 | `get_dashboard_snapshot` 返回 ≥6 指标 + 异常 + 建议动作；Anna 看板正常渲染、数字对得上 |
| 3 | 财务助手 | `query` 返回有 `answer`；问「逾期应收」「市场费用明细」「应付 Top5」都有合理回答 + 来源 |
| 4 | 账龄 | `get_receivables_aging` 返回 rows，且与看板 AR 一致 |
| 5 | Associate | `collection_task.create_draft` 返回非空 `external_task_id`；`get_status` 状态一致 |
| 6 | 报销主数据 | DEPT-001/CC-001 等能对上业务系统主数据 |
| 7 | 发票 | 上传发票 → `create_draft` 收到 `content_base64` → 返回 `invoice_check.status=passed` + 识别要素 |
| 8 | 一致性 | profit=收入−费用；AR=应收明细之和；异常客户=逾期 Top |
| 9 | 诚实标注 | 所有演示数据带「演示」标注 |

---

## 8. 实施建议（选型 + 工作量 + 迁移）

**推荐：路径 B（简单业务系统 + 连接器读库）**
- 库：**SQLite**（演示足够、零运维）或 Postgres（与室友真实系统一致则选 PG）。
- 种子：一个 `seed.sql` / `seed.py` 按第 5 节灌数据。
- 适配层：把 `tools/demo_mcp_connector` 的 `data.py` 从「写死」改成「查库」（保持 `connector.py`
  的工具契约不变，仅换数据来源）。**Anna 侧零改动。**
- 工作量：约 1–2 天（建表 + 种子 + 改 data.py 查库 + 过第 7 节验收）。

**更快：路径 A（仅扩充写死数据）** — 半天，先把 `data.py` 扩成多期间 + 互相对得上,够演示。

**迁移到室友真实系统**：真实系统就绪后，MCP 适配层把数据源从「演示库」换成「调用室友系统
REST/DB」即可；契约（第 3 节）不变，**Anna 与适配层都不用重写**。这正是 MCP 解耦的价值。

---

## 9. 给开发的任务清单（可直接派）

- [ ] 建库 + 第 4 节实体表（SQLite 起步）
- [ ] 灌第 5 节种子数据（3 期间、客户/应收账龄、供应商/应付、部门/成本中心/员工/项目、费用明细）
- [ ] 校验一致性（profit、AR=应收之和、异常=逾期 Top）
- [ ] 改 `demo_mcp_connector/data.py`：5 个 ERP 工具改为查库（契约不变）
- [ ] （可选）财务助手 `query` 加关键词路由（应收/费用/收入/应付）
- [ ] 发票：造 2~3 张样例发票 + `invoice_file.recognized_json`；演示连接器/报销 MCP 返回 `invoice_check`
- [ ] Anna 侧：报销 Agentic Chat 显式露出「上传发票」入口 + 「发票核验」结果卡
- [ ] 过第 7 节 9 条验收

---

### 附：Anna 侧已具备 / 待补

- ✅ 附件存储 + `content_base64` 物化 + 随 draft 发给 MCP（`services/reimbursement/app/attachments.py`）
- ✅ ERP/报销 MCP 客户端 + 探针 + 自检
- ⏳ 报销 Agentic Chat **显式**上传入口 + 发票核验卡（设计未体现,本轮补）
- ⏳ `invoice_check` 契约（演示连接器先模拟,室友报销系统后做真 OCR）
