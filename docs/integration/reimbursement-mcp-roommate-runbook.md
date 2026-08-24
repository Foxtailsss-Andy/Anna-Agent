# 报销 MCP 服务器 · 室友执行清单(照做即可)

> 配套规范:`reimbursement-mcp-server-spec.md`(契约细节)。本清单是**按顺序的行动步骤**,每步做完对一下"完成标志"再进下一步。
> 你**不需要懂 MCP**。本质上你只是写一个 HTTP 接口,把 6 个固定的请求,翻译成调用你自己报销系统的 REST API。

---

## Step 0 · 准备(10 分钟)

- [ ] 选一门你最熟的语言/框架(Java/Spring、Node/Express、Go、Python/FastAPI 都行)。
- [ ] 准备一个**沙箱/演示租户**账号(先别用真实生产数据)。
- [ ] 列出你报销系统的 REST 接口:**创建单**、**提交审批**、**查单据状态**(校验、政策可选);记下各自的 URL、入参、出参,以及怎么鉴权。
- [ ] 生成一个随机长字符串当 **Bearer Token**(例:`openssl rand -hex 24`),记下来,最后线下发我。

**完成标志**:你能用 curl/Postman 手动调通自己系统的"创建单/提交/查状态"三个接口。

---

## Step 1 · 起一个 HTTP 端点(15 分钟)

- [ ] 开一个 `POST` 路由,路径定为 `/reimbursement/rpc`。
- [ ] 它接收 JSON,结构固定为:`{ "jsonrpc":"2.0", "id":"...", "method":"...", "params":{...} }`。
- [ ] **校验请求头** `Authorization: Bearer <你的Token>`;不对就返回 HTTP 401。
- [ ] 准备好统一的"回信"工具函数(后面每个工具都用):
  - 成功:`{ "jsonrpc":"2.0", "id": 原样回传, "result": { "structuredContent": {…业务数据…} } }`
  - 失败:`{ "jsonrpc":"2.0", "id": 原样回传, "error": { "code":"…", "message":"…", "retryable":false } }`
  - ★ **`id` 必须原样回传**,`jsonrpc` 必须是字符串 `"2.0"`,否则 Anna 直接判为非法响应。

**完成标志**:用 curl 发任意 body,能拿到 401(不带 token)或一个结构正确的 JSON 回信(带 token)。

---

## Step 2 · 实现 `method == "tools/list"`(15 分钟)

当 `method` 是 `tools/list` 时,固定返回这 6 个工具(**一个都不能少**):

```json
{ "tools": [
  { "name": "reimbursement.get_capabilities" },
  { "name": "reimbursement.get_policy" },
  { "name": "reimbursement.validate_draft" },
  { "name": "reimbursement.create_draft" },
  { "name": "reimbursement.submit",
    "inputSchema": { "type":"object",
      "properties": {
        "external_reimbursement_id":   {"type":"string"},
        "idempotency_key":             {"type":"string"},
        "expected_draft_snapshot":     {"type":"object"},
        "expected_draft_snapshot_hash":{"type":"string"} },
      "required": ["external_reimbursement_id"] } },
  { "name": "reimbursement.get_status" }
] }
```

- [ ] ★ **submit 那段 `inputSchema` 一字不漏照抄**——少了 `expected_draft_snapshot` / `expected_draft_snapshot_hash` 两个字段,Anna 的自检会卡住(这是硬门槛 A)。
- [ ] 其它工具**不要**给 `draft` 声明多余的 `required` 字段(硬门槛 B),省事就别写 inputSchema。

**完成标志**:`tools/list` 能返回上面 6 个工具。

---

## Step 3 · 实现 `method == "tools/call"` 的 6 个工具(主体工作)

当 `method` 是 `tools/call` 时,看 `params.name` 分发。`params.arguments` 里都带 `workspace_id`、`actor_user_id`(下面不再重复)。
**按这个顺序实现**(从易到难,先能跑通只读,再做写入):

### 3.1 `reimbursement.get_capabilities`(最简单,先做)
- 入:无特别参数。出:返回**任意一个 JSON 对象**即可(建议回你支持的类别/币种)。

### 3.2 `reimbursement.validate_draft`(只读,第二做)
- 入:`arguments.draft = {category, amount, currency, expense_date, merchant, reason, department_id, cost_center_id, project_id?}`。
- 做:校验这张草稿(能调你系统的校验接口就调,不能就本地判空)。
- 出:`{ "valid": true, "missing_fields": [], "policy_summary": "校验通过", "risk_level": "low" }`
  - 真缺字段时才把字段名放进 `missing_fields`(如 `["merchant"]`),Anna 会回头找用户补。
  - 不要返回 `blocked:true`,否则 Anna 拒绝继续。

### 3.3 `reimbursement.get_policy`(可选逻辑,第三做)
- 出:`{ "risk_level":"low", "blocked":false, "requires_confirmation":true, "requires_manager_approval":true, "policy_checks":[], "policy_summary":"金额在限额内" }`(没有真实政策就回这种默认)。

### 3.4 `reimbursement.create_draft`(★写入,第四做)
- 入:`arguments.draft` + `idempotency_key`。
- 做:调你系统的**创建单接口**,把 draft 字段映射成你的字段。
- 出:`{ "external_reimbursement_id":"你系统的单号", "external_status":"draft", "created":true, "idempotent_replay":false }`
  - ★ `external_reimbursement_id` **必须非空**(这是这张单的唯一 ID,后面都用它)。
  - ★ **幂等**:同一个 `idempotency_key` 再来一次,**返回同一张单**(`idempotent_replay:true`),不要重复建单。

### 3.5 `reimbursement.submit`(★写入,第五做)
- 入:`external_reimbursement_id` + `idempotency_key`(还有 `expected_draft_snapshot`/`_hash`,可忽略不校验)。
- 做:调你系统的**提交审批接口**。
- 出:`{ "external_reimbursement_id":"同一个单号", "external_status":"submitted", "submitted":true }`
  - ★ `external_reimbursement_id` 和 `external_status` **两个都必须有**(缺了 Anna 会 500)。
  - ★ 幂等同上。

### 3.6 `reimbursement.get_status`(只读,第六做)
- 入:`external_reimbursement_id`。
- 做:调你系统的**查状态接口**。
- 出:`{ "external_reimbursement_id":"同一个单号", "external_status":"submitted" }`
  - ★ 这里的 `external_status` 要和 **3.5 submit 当时返回的那个值一致**(若提交后状态会变成 `in_approval`,那就让 submit 和 get_status 都返回 `in_approval`,两边一致即可),Anna 才会判定本次报销"成功闭环"。

**完成标志**:6 个工具都能返回上面要求的字段。

---

## Step 4 · 本地自测(关键,不要跳!)

我会把探针脚本 `probe-reimbursement-mcp.mjs` 发你(零依赖,Node 18+)。在你本机对自己服务器跑:

```bash
# 1) 只读检查(协议层 + tools/list 隐藏门槛 + validate_draft)
node probe-reimbursement-mcp.mjs http://localhost:你的端口/reimbursement/rpc 你的Token

# 2) 完整建单检查(对沙箱租户,会真建一条单)
node probe-reimbursement-mcp.mjs http://localhost:你的端口/reimbursement/rpc 你的Token --write
```

- [ ] 第 1 条:5 项全部 ✓。
- [ ] 第 2 条:8 项全部 ✓(`EXIT_CODE=0`)。
- 如果脚本里 `SAMPLE_DRAFT` 的字段你系统不收,告诉我,我们调成你系统能通过的样例。

**完成标志**:`--write` 跑出 8/8 全 ✓,且你能在自己后台看到这条测试单。

---

## Step 5 · 部署 + 对外开 HTTPS(运维)

- [ ] 把服务部署到你云端,和报销系统**同机或同内网**(这样调内部 REST 最快最安全)。
- [ ] 对外暴露一个 **HTTPS 域名**(用网关/反代加证书),最终地址形如 `https://你的域名/reimbursement/rpc`。
- [ ] 确认从**外网**能访问到(我这边在另一台机器上)。

**完成标志**:在外网用 curl/探针访问 `https://你的域名/reimbursement/rpc` 仍然全 ✓。

---

## Step 6 · 交付给我(收尾)

把这两样**线下**发我(别发群、别进 git):
1. `https://你的域名/reimbursement/rpc`(完整到 `/rpc`)
2. Bearer Token

之后我在 Anna 侧填配置、重启、做只读自检,然后我们一起走 UI 端到端、去你后台确认单据真实落地。

---

## 一页速查:最容易踩的 5 个坑
1. `id` 没原样回传 / `jsonrpc` 不是字符串 `"2.0"` → Anna 判非法响应。
2. submit 的 `inputSchema` 漏了 `expected_draft_snapshot(_hash)` → 自检 blocked。
3. `create_draft` 没返回非空 `external_reimbursement_id` → 流程卡死。
4. `submit` 漏 `external_status` 或 `external_reimbursement_id` → Anna 500。
5. `get_status` 的状态和 submit 返回的对不上 → 停在 verify_pending,不算成功。
