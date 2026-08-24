# 02 · 业务逻辑与会计核算

> 这一层让系统「数字是算出来的,不是写死的」。核心:**每张业务单据过账时生成借贷平衡的总账凭证**;
> 所有财报指标都从总账(GL)聚合而来。Anna 看板/助手读到的每个数字都能追到单据。

---

## 1. 最小会计科目表(Chart of Accounts)

| 编码 | 名称 | 类型 | 正常余额 | 现金类 |
|---|---|---|---|---|
| 1001 | 银行存款 | asset | 借 | ✓ |
| 1122 | 应收账款 | asset | 借 | |
| 1601 | 固定资产 | asset | 借 | |
| 2202 | 应付账款 | liability | 贷 | |
| 2211 | 应付职工薪酬 | liability | 贷 | |
| 4001 | 实收资本 | equity | 贷 | |
| 4104 | 未分配利润 | equity | 贷 | |
| 6001 | 主营业务收入 | revenue | 贷 | |
| 6401 | 主营业务成本(COGS) | expense | 借 | |
| 6601 | 销售费用(含市场/差旅) | expense | 借 | |
| 6602 | 管理费用(含办公/职能薪酬) | expense | 借 | |
| 6604 | 研发费用 | expense | 借 | |

> 演示期可暂不处理增值税(简化);如需,增 `2221 应交税费` 并在开票/采购拆税额。

---

## 2. 过账规则(Posting Templates)——每类单据生成的凭证

> 记法:`Dr 借方科目 金额 / Cr 贷方科目 金额`。每张凭证 Σ借 = Σ贷。

| 业务事件 | 来源单据 | 凭证分录 | CO 维度 |
|---|---|---|---|
| **确认收入(开票)** | sales_invoice | `Dr 1122 应收账款 / Cr 6001 主营业务收入` | dept=销售 |
| **客户收款** | receipt | `Dr 1001 银行存款 / Cr 1122 应收账款` | |
| **采购入账(费用/成本)** | vendor_bill | `Dr 6401/6601/6602/6604(按类别) / Cr 2202 应付账款` | cost_center |
| **付供应商款** | payment | `Dr 2202 应付账款 / Cr 1001 银行存款` | |
| **计提工资(月度)** | manual(月结) | `Dr 6601/6602/6604(按部门) / Cr 2211 应付职工薪酬` | dept |
| **发工资** | payment | `Dr 2211 应付职工薪酬 / Cr 1001 银行存款` | |
| **员工报销付款** | expense_report | `Dr 6601 销售费用(差旅) / Cr 1001 银行存款` | cost_center |
| **服务交付成本** | vendor_bill(cloud/外包) | `Dr 6401 主营业务成本 / Cr 2202 应付账款` | cost_center |

> 费用类别→科目映射:salary→6602/6601/6604(按部门)、marketing→6601、travel→6601、office→6602、rnd→6604、服务交付云资源/外包→6401。

---

## 3. 财务报表与期间汇总的推导(全部从 GL 聚合)

设期间 P,期末日 E = P 月最后一天。`bal(acct)` = 科目累计余额(借方科目=Σ借−Σ贷;贷方科目相反)。

```
revenue(P)            = Σ 6001 当期贷方净额
cogs(P)               = Σ 6401 当期借方净额
opex(P)               = Σ (6601+6602+6604) 当期借方净额
expense_total(P)      = cogs(P) + opex(P)
profit(P)             = revenue(P) − expense_total(P)          ← P&L 利润

ar_balance(E)         = bal(1122) 截至 E                        ← 资产负债:应收
ap_balance(E)         = bal(2202) 截至 E                        ← 资产负债:应付
cash_balance(E)       = bal(1001) 截至 E

operating_cash_flow(P)= 当期 1001 中"经营活动"借贷净额
                      = Σ收款(Dr1001 来源=receipt) − Σ经营付款(Cr1001 来源∈{payment,expense_report,工资})
```

**资产负债恒等式(可作自检)**:`资产(1001+1122+1601) = 负债(2202+2211) + 所有者权益(4001+4104+本期利润累计)`。

**看板 6 指标 = 上面这些**:revenue / expense_total / profit / operating_cash_flow / ar_balance / ap_balance。

---

## 4. 应收账龄(AR Aging)逻辑

对每张 `sales_invoice`,在期末日 E:
```
未收额 outstanding = total_amount − paid_amount   (status ∈ {open, partial})
逾期天数 overdue_days = max(0, E − due_date)
```
分桶:`current(≤0) / 1–30 / 31–60 / 61–90 / >90`。
- `ar_overdue(>30) = Σ outstanding where overdue_days > 30`。
- **看板异常「逾期集中在 A、C」** = 按 customer 聚合逾期额,取 Top2/Top3。
- `erp.finance.get_receivables_aging` 返回的 rows = 各客户逾期额 + aging_days(取该客户最久逾期发票的天数)。

应付账龄(AP)同理,基于 `vendor_bill`。

---

## 5. 业务流程(端到端)

### 5.1 Order-to-Cash(O2C,销售回款)
```
建客户 → 建销售订单(SO) → 确认 → 开销售发票(SINV, 过账 Dr1122/Cr6001, 设 due_date)
→ 到期 → 客户收款(receipt, 过账 Dr1001/Cr1122, 回写 paid_amount/status)
→ 未按期收 → 进入逾期账龄 → 触发催收(见 5.4)
```

### 5.2 Procure-to-Pay(P2P,采购付款)
```
建供应商 → 采购订单(PO) → 供应商账单(VBILL, 过账 Dr费用/成本/Cr2202)
→ 付款(payment, Dr2202/Cr1001)
```

### 5.3 费用报销(Expense,与室友报销系统协作)
```
员工在 Anna 发起差旅报销(带发票) → 室友报销系统建单/审批/OCR
→ 审批通过 → 本系统记 expense_report + 过账(Dr6601差旅/Cr1001) + 回写 external_reimbursement_id
```
> 演示期可手工灌几条 expense_report 让差旅费用在看板/明细里体现。

### 5.4 应收催收(Associate)
```
逾期应收 → Anna Associate 生成回款目标 + 催收任务节点 → 审批
→ 调 erp.collection_task.create_draft(payload=任务内容) → 本系统建 collection_task(status=created)
→ 回 external_task_id → Anna 回读 get_status(状态一致)→ 标记 verified
```
催收状态机:`draft → created → in_progress → done`(可 cancelled)。

### 5.5 期末结账(Period Close)
```
当期凭证全部过账 → 计算 period_summary(§3 公式)→ 物化/缓存
→ Analytics 据此出看板指标 + 跑异常规则(§6)
```

---

## 6. 异常识别规则(看板 anomalies,可配置)

| 异常 | 规则 | 严重度 |
|---|---|---|
| 逾期应收集中 | 逾期>30天 且 Top2 客户占逾期额 >60% | high |
| 费用单月跳增 | 某费用类别环比 >+25% | medium |
| 现金流低于利润 | operating_cash_flow < profit × 0.8 | medium |
| 应收周转放缓 | ar_balance 环比 >+10% 且收款放缓 | low |

每条异常生成 `suggested_actions`(跳转 finance_assistant / associate)。

---

## 7. 一致性不变量(**演示可信度的命门,必须满足**)

1. `profit(P) = revenue(P) − expense_total(P)`。
2. `expense_total(P) = cogs(P) + opex(P)`,且 opex 按类别(人力/市场/差旅/办公/研发)汇总 = 各 6601/6602/6604 明细。
3. `ar_balance(E) = Σ (total−paid) of open/partial sales_invoice`,且 = 看板应收。
4. `ap_balance(E) = Σ (total−paid) of open/partial vendor_bill`,且 = 看板应付。
5. 看板异常「逾期集中的客户」= 账龄按客户聚合的 Top,且 = `get_receivables_aging` 的 rows 主体。
6. 每张 journal_entry:Σ借 = Σ贷;资产 = 负债 + 权益。
7. `get_status` 回读的催收/报销状态,与创建时返回一致(否则 Anna 卡 verify_pending)。
8. 三期间(04/05/06)趋势单调合理,环比百分比与 README §4 一致。

> 建议:写一个 `validate_consistency()` 脚本/SQL,每次灌完种子数据跑一遍,1–8 全过才算数据"对"。
