# Anna 报销发票「读 + 验」对接任务书

> 给报销系统方(室友)。Anna 侧已经把**发票采集 + 安全传输**做完并对真实云端验证通过;
> 这份文档定义你方 MCP 需要补的**发票识别(OCR/读)与查验(验)**能力。
> 不需要改 Anna,不需要改 LinkX ERP MCP。

## 1. 现状(Anna 侧已完成,已对真实云端验证)

- 用户在差旅报销对话框点回形针上传发票(pdf/jpg/png,支持中文名)。
- Anna 存盘 + 算 sha256,在 `reimbursement.create_draft` 时把发票**内容**随草稿发给你方 MCP:

```jsonc
// create_draft.arguments.draft.attachments[i]
{
  "name": "发票-餐饮860.pdf",
  "uri": "anna://attachment/<sha256>/<urlencoded-name>",   // Anna 内部引用,你方可忽略
  "size_bytes": 75455,
  "sha256": "337094c29d9b...0f",                            // 内容指纹,可用于去重
  "content_base64": "JVBERi0xLjQK..."                       // 发票原文件 base64(pdf/图片)
}
```

- 已验证:你方 MCP 当前 `create_draft` **能接收带 attachments 的草稿并成功建单**(8/8 探针不受影响)。
- 但 v1 是「接收但不读不验」。本任务书让你方把发票真正**读出来 + 验一遍**。

## 2. 谁读、谁验(架构约定)

| 职责 | 在哪 | 原因 |
|---|---|---|
| 发票**采集**、指纹、安全传输 | Anna | 已完成 |
| 发票**识别(OCR)**:发票号/金额/日期/销方/税号/税额 | **你方系统** | 发票最终归档在报销系统,OCR 能力与数据在你方 |
| 发票**查验**:真伪(税局查验)、重复报销去重 | **你方系统** | 需要税局接口 + 历史单据库,只有你方有 |
| 发票与报销单**一致性**:金额/日期是否匹配 | **你方 MCP** | 你方是事实源,判定权威 |
| 文件级轻校验:类型/大小/非空 | Anna | 已做 |

Anna 不自己 OCR(避免第二事实源与合规风险);**读和验都在你方**,Anna 只负责把结果展示在对话里、不一致就拦/追问。

## 3. 要交付什么(二选一,推荐 A)

### 方案 A(推荐):新增只读工具 `reimbursement.validate_invoice`

**验在建单之前**:Anna 先用它验票,识别字段回填+核对,不一致就不建单。

入参:

```jsonc
{
  "workspace_id": "...",
  "actor_user_id": "...",
  "invoice": {
    "name": "发票-餐饮860.pdf",
    "sha256": "337094...0f",
    "size_bytes": 75455,
    "content_base64": "JVBERi0xLjQK..."
  },
  "draft": {                       // 当前报销草稿,用于一致性核对
    "category": "meal",
    "amount": 860,
    "currency": "CNY",
    "expense_date": "2026-06-14",
    "merchant": "上海老正兴菜馆",
    "department_id": "DEPT-001",
    "cost_center_id": "CC-001"
  }
}
```

必须返回(放在 `result.structuredContent`):

```jsonc
{
  "valid": true,                   // 发票本身是否可用(能识别+查验通过)
  "blocked": false,                // true 则 Anna 停止建单
  "recognized": {                  // OCR 识别结果
    "invoice_no": "08827193",
    "invoice_code": "031002300114",
    "amount": 860.00,
    "tax_amount": 48.68,
    "date": "2026-06-14",
    "seller": "上海老正兴菜馆",
    "seller_tax_id": "91310101MA1G...",
    "category_hint": "meal"
  },
  "verification": {                // 查验
    "authentic": true,             // 税局查验真伪;无能力可先返回 null
    "duplicate": false,            // 重复报销(按 sha256/发票号去重)
    "status": "verified"           // verified / pending / failed
  },
  "consistency": {                 // 与报销单核对
    "amount_matches": true,        // 发票金额 == 报销金额?
    "date_matches": true,
    "issues": []                   // 例:["发票金额 860 与报销金额 128 不一致"]
  },
  "policy_summary": "发票识别成功,金额一致,查验通过。",
  "risk_level": "low"
}
```

Anna 行为:把 `recognized` + `consistency` 展示在对话里;`blocked=true` 或 `issues` 非空时,停下并提示用户(例如金额不符就让用户换票或改金额)。

### 方案 B(简单):扩展 `create_draft`

`create_draft` 内部对 `draft.attachments[].content_base64` 做 OCR + 落附件表 + 在返回里加 `recognized` / `invoice_verification` 字段。简单,但把「读」和「写」耦合,验票发生在建单之后(不如 A 干净)。

## 4. 错误码建议

| code | retryable | 场景 |
|---|---|---|
| invoice_unreadable | false | 文件损坏/非发票/OCR 失败 |
| invoice_duplicate | false | 重复报销 |
| invoice_amount_mismatch | false | 发票金额与报销不符 |
| invoice_verify_unavailable | true | 税局查验接口暂时不可用 |

## 5. 验收

```text
1. Anna 上传一张真实发票(金额与报销一致)→ validate_invoice 返回 valid=true、字段识别正确、amount_matches=true。
2. 上传金额不符的发票 → consistency.issues 提示不一致 / blocked=true。
3. 同一张发票报两次 → 第二次 verification.duplicate=true。
4. 你方后台能看到发票已识别并归档到对应报销单。
```

## 6. 给你方 Codex 的直接指令

```text
在现有报销 MCP 适配服务里新增只读工具 reimbursement.validate_invoice:
1. 入参含 invoice.content_base64(发票 pdf/图片)+ 当前 draft。
2. 对发票做 OCR,提取发票号/金额/日期/销方/税号/税额。
3. 做查验:税局真伪(有则做,无则 authentic=null)+ 按 sha256/发票号去重。
4. 与 draft 核对金额/日期一致性,产出 consistency.issues。
5. 按本文 §3.A 的结构返回 result.structuredContent。
6. 不要改 Anna,不要把 token/发票内容写进 git 或日志。
完成后用一张真实发票端到端验收,并能在后台查到归档发票。
```
