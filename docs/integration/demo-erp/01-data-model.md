# 01 · 数据模型 / Schema 设计

> 明远 Demo ERP 全实体设计。类型按 SQLite/Postgres 通用写法。金额一律 `DECIMAL(18,2)` CNY,
> 日期 `DATE`,时间戳 `TIMESTAMP`。所有表含 `tenant = 'demo-erp-2026'`(为多租户/迁移预留)。
> 命名:主键 `xxx_id`(业务可读,如 `CUST-DEMO-A`),外键同名。

## 0. ERD 总览(文本)

```
company
  └─ department ──< cost_center
        └─< employee
customer ──< sales_order ──< sales_order_line >── product
   │            └─ sales_invoice ──< receipt
   └─< sales_invoice (period, due_date → 账龄)
   └─< collection_task
supplier ──< purchase_order ──< po_line >── (item)
   └─ vendor_bill ──< payment
gl_account ──< journal_line >── journal_entry   (journal_line.cost_center_id / dept_id)
expense_category ──< expense_report (→ external_reimbursement_id 关联室友报销系统)
period_summary  (派生/物化,来自 GL + AR + AP)
project (customer_id 可选)
```

记账主线:**每一张 sales_invoice / vendor_bill / receipt / payment / expense_report 过账时都生成
一张 journal_entry(借贷平衡)**,总账是所有财务数字的唯一真相源(single source of truth)。

---

## 1. ORG — 组织与主数据

### 1.1 `company`(公司/账套)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| company_id | TEXT | PK | `demo-erp-2026` |
| name | TEXT | | 明远科技服务（上海）有限公司 |
| functional_currency | TEXT | | CNY |
| fiscal_year | INT | | 2026 |
| demo_label | TEXT | | "演示数据"(对外展示标注) |

### 1.2 `department`(部门)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| dept_id | TEXT | PK | DEPT-001 … |
| name | TEXT | | 销售部/市场部/研发部/财务部/采购部/行政部 |
| parent_id | TEXT | FK→department | 可空(组织树) |
| manager_emp_id | TEXT | FK→employee | 负责人 |

### 1.3 `cost_center`(成本中心)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| cc_id | TEXT | PK | CC-001 … |
| name | TEXT | | ACME项目组/平台研发/销售中心/职能 |
| dept_id | TEXT | FK→department | 归属部门 |

### 1.4 `employee`(员工)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| emp_id | TEXT | PK | EMP-001 … |
| name | TEXT | | |
| dept_id | TEXT | FK→department | |
| default_cc_id | TEXT | FK→cost_center | 默认成本中心 |
| email | TEXT | | |
| role | TEXT | | staff/manager/finance |
| status | TEXT | | active/inactive |

### 1.5 `project`(项目,可选维度)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| project_id | TEXT | PK | PROJ-ACME … |
| name | TEXT | | |
| customer_id | TEXT | FK→customer | 可空 |
| status | TEXT | | active/closed |

### 1.6 `gl_account`(会计科目表 Chart of Accounts)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| account_code | TEXT | PK | 1122 等(中国会计准则编码) |
| name | TEXT | | 应收账款 等 |
| type | TEXT | | asset/liability/equity/revenue/expense |
| normal_balance | TEXT | | debit/credit(正常余额方向) |
| is_cash | BOOL | | 现金类(用于现金流) |

> 最小科目集见文档02 §1。

---

## 2. CRM + SD — 客户与销售(Order-to-Cash)

### 2.1 `customer`(客户)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| customer_id | TEXT | PK | CUST-DEMO-A … |
| name | TEXT | | 演示客户A … |
| industry | TEXT | | 制造/零售/金融… |
| credit_limit | DECIMAL | | 授信额度 |
| payment_terms_days | INT | | 账期(如 30/60) |
| owner_emp_id | TEXT | FK→employee | 客户经理 |
| status | TEXT | | active/inactive |

### 2.2 `product`(商品/服务)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| product_id | TEXT | PK | PROD-SAAS-STD … |
| name | TEXT | | 软件订阅(标准版)/实施服务/运维服务 |
| category | TEXT | | saas/service/maintenance |
| unit_price | DECIMAL | | 标准单价 |
| revenue_account | TEXT | FK→gl_account | 收入科目(6001) |

### 2.3 `sales_order`(销售订单)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| so_id | TEXT | PK | SO-2026-0001 |
| customer_id | TEXT | FK→customer | |
| order_date | DATE | | |
| period | TEXT | | YYYY-MM |
| status | TEXT | | draft/confirmed/invoiced/closed |
| total_amount | DECIMAL | | 行合计 |

### 2.4 `sales_order_line`
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| line_id | TEXT | PK | |
| so_id | TEXT | FK→sales_order | |
| product_id | TEXT | FK→product | |
| qty | DECIMAL | | |
| unit_price | DECIMAL | | |
| amount | DECIMAL | | qty×unit_price |

### 2.5 `sales_invoice`(销售发票 → 应收)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| invoice_id | TEXT | PK | SINV-2026-0001 |
| invoice_no | TEXT | | 对外发票号 |
| customer_id | TEXT | FK→customer | |
| so_id | TEXT | FK→sales_order | 可空 |
| invoice_date | DATE | | 开票日(收入确认) |
| due_date | DATE | | =invoice_date+账期 |
| period | TEXT | | YYYY-MM |
| total_amount | DECIMAL | | |
| paid_amount | DECIMAL | | 已收(默认0) |
| status | TEXT | | open/partial/paid/void(逾期由 due_date 派生,见文档02) |

**应收余额 = total_amount − paid_amount**(status≠void)。

### 2.6 `receipt`(收款)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| receipt_id | TEXT | PK | |
| customer_id | TEXT | FK→customer | |
| invoice_id | TEXT | FK→sales_invoice | 核销的发票 |
| receipt_date | DATE | | |
| amount | DECIMAL | | |
| method | TEXT | | bank/cash |

---

## 3. MM — 采购与应付(Procure-to-Pay)

### 3.1 `supplier`(供应商)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| supplier_id | TEXT | PK | SUP-001 |
| name | TEXT | | 演示云服务商 等 |
| category | TEXT | | cloud/outsourcing/marketing/office/travel |
| payment_terms_days | INT | | 账期 |
| expense_account | TEXT | FK→gl_account | 默认费用/成本科目 |

### 3.2 `purchase_order` / `po_line`(结构同销售订单,字段名 po_id/supplier_id)
关键:`po_id, supplier_id, order_date, period, status(draft/confirmed/billed), total_amount`;
`po_line(line_id, po_id, item_name, qty, unit_price, amount, expense_account, cost_center_id)`。

### 3.3 `vendor_bill`(供应商账单 → 应付)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| bill_id | TEXT | PK | VBILL-2026-0001 |
| bill_no | TEXT | | |
| supplier_id | TEXT | FK→supplier | |
| po_id | TEXT | FK→purchase_order | 可空 |
| bill_date | DATE | | 费用/成本发生 |
| due_date | DATE | | |
| period | TEXT | | |
| total_amount | DECIMAL | | |
| paid_amount | DECIMAL | | |
| expense_account | TEXT | FK→gl_account | 入哪个费用/成本科目 |
| cost_center_id | TEXT | FK→cost_center | CO 归集 |
| status | TEXT | | open/partial/paid/void |

### 3.4 `payment`(付款,结构同 receipt:payment_id/supplier_id/bill_id/payment_date/amount)

---

## 4. FI-GL — 总账(复式记账,数字的根)

### 4.1 `journal_entry`(会计凭证)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| je_id | TEXT | PK | JE-2026-000001 |
| je_date | DATE | | |
| period | TEXT | | YYYY-MM |
| source | TEXT | | sales_invoice/receipt/vendor_bill/payment/expense_report/manual |
| source_ref | TEXT | | 来源单据ID(如 SINV-2026-0001) |
| memo | TEXT | | |
| posted | BOOL | | 是否过账 |

### 4.2 `journal_line`(凭证分录行,借贷必平)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| line_id | TEXT | PK | |
| je_id | TEXT | FK→journal_entry | |
| account_code | TEXT | FK→gl_account | |
| debit | DECIMAL | | 借方(>=0) |
| credit | DECIMAL | | 贷方(>=0) |
| dept_id | TEXT | FK→department | 可空 |
| cost_center_id | TEXT | FK→cost_center | 可空(CO 分摊) |

**硬约束**:每张 je 的 Σdebit = Σcredit;单行 debit 与 credit 不可同时>0。

### 4.3 `period_summary`(期间汇总,物化视图/表)
| 字段 | 类型 | 说明 |
|---|---|---|
| period | TEXT(PK) | YYYY-MM |
| revenue | DECIMAL | 收入科目贷方净额 |
| cogs | DECIMAL | 主营成本 |
| opex | DECIMAL | 期间费用(销售/管理/研发) |
| expense_total | DECIMAL | =cogs+opex |
| profit | DECIMAL | =revenue−expense_total |
| operating_cash_flow | DECIMAL | 现金类科目经营活动净流入 |
| ar_balance | DECIMAL | 期末应收余额 |
| ap_balance | DECIMAL | 期末应付余额 |
| ar_overdue | DECIMAL | 逾期应收(>30天) |

> `period_summary` 可由 GL 实时聚合(SQL)或月末物化。文档02给出推导公式;文档03给出三期具体值。

---

## 5. CO + EX — 成本与费用报销

### 5.1 `expense_category`(费用类别)
| 字段 | 类型 | 说明 |
|---|---|---|
| code | TEXT(PK) | salary/marketing/travel/office/rnd |
| name | TEXT | 人力/市场/差旅/办公/研发 |
| gl_account | TEXT(FK) | 对应费用科目 |

### 5.2 `expense_report`(员工费用单,关联室友报销系统)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| er_id | TEXT | PK | ER-2026-0001 |
| employee_id | TEXT | FK→employee | 申请人 |
| dept_id | TEXT | FK→department | |
| cost_center_id | TEXT | FK→cost_center | |
| project_id | TEXT | FK→project | 可空 |
| period | TEXT | | |
| category | TEXT | FK→expense_category | travel 等 |
| amount | DECIMAL | | |
| merchant | TEXT | | 商户 |
| status | TEXT | | draft/submitted/approved/paid |
| external_reimbursement_id | TEXT | | 室友报销系统的单号(如 demo-reimb-0001) |
| invoice_no | TEXT | | 发票号(室友系统 OCR 回填) |

> 报销的**创建/审批/发票OCR**在室友报销系统;本表记录其在本经营系统的**主数据归属 + 费用入账**。
> 演示期可由 Anna 报销流程回写 `external_reimbursement_id`,或手工灌几条。

---

## 6. AR Collections — 应收催收(Associate 写入)

### 6.1 `collection_task`(催收任务)
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| task_id | TEXT | PK | 内部ID |
| external_task_id | TEXT | UNIQUE | 对 Anna 暴露的ID(TASK-2026-000123) |
| customer_id | TEXT | FK→customer | 催收对象 |
| period | TEXT | | |
| target_amount | DECIMAL | | 目标回款额 |
| owner_emp_id | TEXT | FK→employee | 负责人 |
| status | TEXT | | draft/created/in_progress/done/cancelled |
| payload_json | TEXT(JSON) | | Anna 传入的任务内容(SOP/节点/事由) |
| created_at | TIMESTAMP | | |
| updated_at | TIMESTAMP | | |

---

## 7. 枚举与状态机

**sales_invoice.status**:`open →(部分收款)→ partial →(收满)→ paid`;`open/partial` 且 `today>due_date` → **逾期(派生,不存状态)**;`void` 作废。
**vendor_bill.status**:同上(open/partial/paid/void)。
**collection_task.status**:`draft →(create_draft)→ created →(执行)→ in_progress →(完成)→ done`;可 `cancelled`。
**journal_entry.posted**:`false(草稿)→ true(过账,计入 period_summary)`。
**expense_report.status**:`draft → submitted → approved → paid`。

---

## 8. 索引与约束建议(性能 + 一致性)
- `sales_invoice(customer_id, period, due_date, status)`、`vendor_bill(supplier_id, period, due_date, status)` 建索引(账龄/账期查询)。
- `journal_line(account_code, je_id)`、`journal_entry(period, source)` 建索引(财报聚合)。
- 约束:发票/账单 `paid_amount ≤ total_amount`;`collection_task.external_task_id` 唯一非空;每张 je 借贷平衡(应用层或触发器校验)。
- 所有金额非负;`due_date ≥ invoice_date/bill_date`。
