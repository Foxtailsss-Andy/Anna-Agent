# Anna 报销 MCP 服务器对接规范 (v1)

> 给"报销系统方"(室友)的实现规范。你要新立一个 **MCP 服务器**,作为 Anna 与你报销系统之间的"翻译层"。
> Anna 是 **MCP client**,代码已固定、不会为你改动。本文档逐条对齐了 Anna 源码里**实际发出的请求**与**期望的返回**——按此实现即可打通。
>
> 你可以用任意语言实现(Java / Node / Go / Python 均可),只要 HTTP + JSON 行为与本文一致。
> 仓库里 `tools/demo_mcp_connector/connector.py` 是一个可运行的参照实现,实在拿不准就对照它。

---

## 0. 总览:你要做什么

```
Anna (MCP client)  ──HTTPS + JSON-RPC 2.0──▶  你的 MCP 服务器(翻译层)  ──你系统的 REST API──▶  你的报销系统
                   ◀──固定格式的 result───────                          ◀───────────────────
```

- 对外:开放**一个 HTTP(S) POST 端点**(例如 `https://你的域名/reimbursement/rpc`),只讲 JSON-RPC 2.0。
- 对内:在端点里把 Anna 的 6 个工具调用,翻译成对你报销系统 REST API 的调用。
- 鉴权:校验 `Authorization: Bearer <token>`(token 由你生成,线下给我们)。
- 部署:与报销系统同机或同内网,对外暴露 HTTPS 域名。

**Definition of Done(完成的标准)**:用本仓库 `scripts/probe-reimbursement-mcp.mjs` 跑你的端点,全部 ✓(见第 7 节)。

---

## 1. 传输与信封 (JSON-RPC 2.0 over HTTP)

### 请求(Anna → 你)
- 方法:`POST <你的端点 URL>`
- 头:`Content-Type: application/json`;若配置了 token,则带 `Authorization: Bearer <token>`
- Body:
```jsonc
{
  "jsonrpc": "2.0",
  "id": "anna-7",                 // 字符串,每次不同
  "method": "tools/call",         // 只有两种:"tools/list" 或 "tools/call"
  "params": {
    "name": "reimbursement.create_draft",
    "arguments": { /* 见第 3 节各工具 */ }
  }
}
```

### 成功响应(你 → Anna)
```jsonc
{
  "jsonrpc": "2.0",               // 必须是字符串 "2.0"
  "id": "anna-7",                 // ★必须原样回传请求里的 id,否则 Anna 判 mcp_response_invalid
  "result": {
    "structuredContent": { /* 业务返回,见各工具 */ }
  }
}
```
> Anna 取业务数据的顺序:`result.structuredContent`(**推荐用这个**) → 否则找 `result.content[].text` 里的 JSON → 否则把 `result` 本身当数据。统一用 `structuredContent` 最稳。

### 错误响应(你 → Anna)
```jsonc
{
  "jsonrpc": "2.0",
  "id": "anna-7",
  "error": {
    "code": "draft_not_found",    // 自定义短码,会出现在 Anna 审计/报错里
    "message": "外部报销草稿未找到",
    "retryable": false            // true 表示"可重试"(Anna 审批失败后可让用户重提)
  }
}
```

### Anna 对响应的硬校验(任一不满足 → `mcp_response_invalid`)
1. HTTP 状态码 2xx(`raise_for_status`)。
2. body 是 JSON 对象。
3. `body.jsonrpc === "2.0"`。
4. `body.id === 请求的 id`(★精确回传)。
5. 有 `error` 时按错误处理;否则 `result` 必须是对象。

---

## 2. `tools/list`(能力发现)——决定"是否 connected"

Anna 启动/自检时先发 `tools/list`(`params:{}`)。你必须返回**全部 6 个工具名**,缺一个 Anna 就判 `missing_tools`、状态 `unhealthy`,连不上。

返回(放在 `result` 里,可不用 structuredContent 包):
```json
{
  "tools": [
    { "name": "reimbursement.get_capabilities" },
    { "name": "reimbursement.get_policy" },
    { "name": "reimbursement.validate_draft" },
    { "name": "reimbursement.create_draft" },
    {
      "name": "reimbursement.submit",
      "inputSchema": {
        "type": "object",
        "properties": {
          "external_reimbursement_id":   { "type": "string" },
          "idempotency_key":             { "type": "string" },
          "expected_draft_snapshot":     { "type": "object" },
          "expected_draft_snapshot_hash":{ "type": "string" }
        },
        "required": ["external_reimbursement_id"]
      }
    },
    { "name": "reimbursement.get_status" }
  ]
}
```

### ⚠️ 隐藏门槛 A —— `submit` 必须声明 inputSchema
Anna 自检项 `backend_submit_snapshot_contract` 会检查:`tools/list` 里 `reimbursement.submit` 的 `inputSchema.properties` **必须同时含** `expected_draft_snapshot` 和 `expected_draft_snapshot_hash`。
**否则整体"运行自检"会 blocked,无法进入端到端测试。**
> 你**不必真的去校验**这两个值的内容——只要 schema 里声明了、调用时收下不报错即可(它们是 Anna 侧的防篡改快照,Anna 自己管)。

### ⚠️ 隐藏门槛 B —— 别给 draft 声明多余的 required
若你给 `validate_draft` / `create_draft` 声明 `inputSchema` 且其中 `draft.required` 含**第 4 节 10 个字段以外**的字段,Anna 自检项 `mcp_schema_compatibility` 判 failed。
**最省心:这两个工具不声明 draft 的 `inputSchema`(或 required 留空)。**

---

## 3. 六个工具:Anna 传入 ⇄ 你必须返回

> 所有 `arguments` 都会带 `workspace_id` 和 `actor_user_id`(字符串,用于多租户/操作者标识)。下表省略不再重复。
> "必返字段"是 Anna 代码会**直接读取**的;缺失会导致流程卡住或报错(已标注后果)。

### 3.1 `reimbursement.get_capabilities`(只读,自检会调)
- 传入:`{ workspace_id, actor_user_id }`
- 必返:**任意 JSON 对象**即可(Anna 不强校验)。建议回真实能力,例:
```json
{ "categories": ["travel","meal","office","transport","other"],
  "currencies": ["CNY"], "supports_create_draft": true, "supports_submit": true,
  "required_fields": ["category","amount","currency","expense_date","merchant","reason","department_id","cost_center_id"] }
```

### 3.2 `reimbursement.get_policy`(模型可能调,用于风险/限额)
- 传入:`{ category, amount, currency, department_id, cost_center_id }`
- 必返:
```json
{ "risk_level": "low", "blocked": false,
  "requires_confirmation": true, "requires_manager_approval": true,
  "policy_checks": [], "policy_summary": "金额在报销限额内。" }
```
> `blocked:true` 会让 Anna 拒绝继续。

### 3.3 `reimbursement.validate_draft`(只读;自检 + 正式流程都会调)★关键
- 传入:`{ draft: { ...第4节字段... } }`
- 必返:
```json
{ "valid": true,
  "missing_fields": [],
  "normalized_draft": { /* 可选:你规整后的草稿,会回填 */ },
  "policy_summary": "草稿校验通过。",
  "risk_level": "low" }
```
- Anna 放行去"创建草稿"的条件:`valid===true` **且** `blocked!==true` **且** `missing_fields` 为空。
- 若 `missing_fields` 非空(如 `["merchant"]`),Anna 会**回头向用户补问**这些字段——所以**只在真的缺字段时**才返回它。
- 这里返回的 `policy_summary` + `risk_level` 会成为**审批卡片上的权威值**(Anna 后续不让模型篡改)。

### 3.4 `reimbursement.create_draft`(写!创建一张报销草稿)★关键
- 传入:`{ source:"Anna", source_run_id, idempotency_key, draft:{...} }`
- 必返:
```json
{ "external_reimbursement_id": "REIMB-2026-000123",   // ★非空!否则流程停在草稿前
  "external_status": "draft",
  "created": true,
  "idempotent_replay": false }
```
- **`external_reimbursement_id` 必须非空**,这是你系统里这张单的唯一 ID,后续 submit/get_status 都用它。
- **幂等**:同一个 `idempotency_key` 再次调用,**返回同一张单**(`idempotent_replay:true`),**不要重复建单**。

### 3.5 `reimbursement.submit`(写!把草稿提交进审批流)★关键
- 传入:`{ source:"Anna", source_run_id, confirmation_id, idempotency_key, external_reimbursement_id, expected_draft_snapshot, expected_draft_snapshot_hash }`
- 必返:
```json
{ "external_reimbursement_id": "REIMB-2026-000123",   // ★必须有(Anna 直接 [] 取值)
  "external_status": "submitted",                      // ★必须有
  "submitted": true }
```
- `external_reimbursement_id` 与 `external_status` **二者缺一会让 Anna 后端 500**。
- `expected_draft_snapshot(_hash)`:**可选使用**——若想做乐观锁(快照对不上就拒绝提交,返回 `retryable:false`),可以;不想用就忽略。Anna 不要求你校验。
- **幂等**:同 `idempotency_key` 重复提交,返回同一结果,不要二次入流。

### 3.6 `reimbursement.get_status`(只读;提交后回读核验)★关键
- 传入:`{ external_reimbursement_id }`
- 必返:
```json
{ "external_reimbursement_id": "REIMB-2026-000123",
  "external_status": "submitted" }
```
- Anna 判定本次报销 `completed`(成功闭环)的条件:回读的 `external_reimbursement_id` == 之前的 ID **且** `external_status` == **submit 当时返回的那个状态值**。
- 所以 **submit 返回的 `external_status` 和紧接着 get_status 返回的要一致**。若你系统提交后状态会变(如 `in_approval`),让 **submit 与 get_status 返回同一个值**即可(不必非叫 `submitted`)。状态不一致不会报错,但会停在 `verify_pending`、不算 `completed`。

---

## 4. 草稿(draft)字段字典

Anna 在 `validate_draft` / `create_draft` 的 `arguments.draft` 里传这些(可能部分为空,模型逐步补全):

| 字段 | 类型 | 含义 |
|---|---|---|
| `category` | string | 报销类别(travel/meal/office/transport/other 等) |
| `amount` | number | 金额 |
| `currency` | string | 币种(如 CNY) |
| `expense_date` | string | 发生日期(YYYY-MM-DD) |
| `merchant` | string | 商户/供应商 |
| `reason` | string | 事由 |
| `department_id` | string | 部门 |
| `cost_center_id` | string | 成本中心 |
| `project_id` | string | 项目(可选) |
| `attachments` | array | 附件 `[{name, uri}]`(**v1 先不接,见第 8 节**) |

> 这就是"字段对照表"的左列。请填右列:**你系统里对应的字段名**,我据此核对映射。

---

## 5. 鉴权与安全

- Anna 配了 token 时,每个请求都带 `Authorization: Bearer <token>`。**请在服务器侧校验**,无效返回 HTTP 401。
- token 由你生成(随机长字符串即可),**线下**发我们;我们只存本地 `runtime.json`,不入库、不入 git。
- **先用沙箱/演示租户**跑通,再切真实租户。Anna 的"自检/探针"全程**只读**(只调 get_capabilities + validate_draft),不会写你系统;真正写(create/submit)只在人工审批通过后发生。

---

## 6. 端到端调用时序(一次正常报销)

```
1. tools/list                         → 你回 6 个工具(含 submit.inputSchema)
2. tools/call get_capabilities        → 能力对象
3. tools/call validate_draft {draft}  → {valid:true, missing_fields:[], policy_summary, risk_level}
4. tools/call create_draft  {draft}   → {external_reimbursement_id:"REIMB-...", external_status:"draft"}
   ── 此处 Anna 弹出审批卡,等人工点"通过" ──
5. tools/call submit {external_reimbursement_id, idempotency_key, expected_draft_snapshot...}
                                       → {external_reimbursement_id:"REIMB-...", external_status:"submitted"}
6. tools/call get_status {external_reimbursement_id}
                                       → {external_reimbursement_id:"REIMB-...", external_status:"submitted"}
   ── Anna 核对一致 → 本次报销 completed,去你后台应能看到这张单 ──
```

---

## 7. 自测(接 Anna 之前,先在你这边验)

仓库提供了零依赖的 Node 探针脚本 `scripts/probe-reimbursement-mcp.mjs`:

```bash
# 只读检查(协议层 + tools/list 隐藏门槛 + validate_draft)
node scripts/probe-reimbursement-mcp.mjs https://你的域名/reimbursement/rpc <token>

# 加 --write:对沙箱租户跑完整 create→submit→get_status(会真建一条单!)
node scripts/probe-reimbursement-mcp.mjs https://你的域名/reimbursement/rpc <token> --write
```
全部 ✓ 即满足 Anna 契约。没有 Node 也可用 `curl` 手测(见仓库 README 示例)。

---

## 8. v1 范围与后续

- **v1 先不接 attachments**(附件涉及 Anna 侧内容物料化与 `anna://` 引用,单独做)。先跑通无附件的报销闭环。
- ERP(财务看板/Associate)是另一套工具,**本次不涉及**;Anna 测试期用本地 demo 连接器顶替,不影响报销真实打通。

---

## 附:常见报错码自查(Anna 侧会显示)

| 你会看到 | 原因 | 处理 |
|---|---|---|
| `mcp_required_tools_missing` | `tools/list` 少工具 | 补齐 6 个名字 |
| `submit_snapshot_contract_missing_fields` | submit 没声明那 2 个 snapshot 字段 | 见门槛 A |
| `unsupported_mcp_required_fields` | draft.required 含未知字段 | 见门槛 B |
| `mcp_response_invalid` | jsonrpc/id 没原样回传,或 result 不是对象 | 见第 1 节硬校验 |
| `mcp_read_probe_validation_failed` | 探针草稿 validate 返回 valid≠true / blocked | 让样例草稿能通过校验 |
| 流程停在创建草稿前 | create_draft 没返回非空 external_reimbursement_id | 见 3.4 |
| HTTP 500 | submit 返回缺 external_status / external_reimbursement_id | 见 3.5 |
